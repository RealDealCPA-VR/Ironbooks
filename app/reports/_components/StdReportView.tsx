'use client';

/**
 * The standard report viewer: runs any report in lib/reports/catalog.ts through
 * GET /api/reports/std/[key], with
 *  - report settings & filters (ReportFilters) kept in the URL, so a report link is shareable
 *    and the browser Back button returns to the previous QuickZoom level,
 *  - Collapse / Expand rows, Fonts & Numbers (number formats), column show/hide,
 *  - Memorize (save with its settings, into a group; or replace an existing memorized report),
 *  - the shared export toolbar (CSV / Excel / PDF / Print / Email).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BarChart2, Bookmark, ChevronsDownUp, ChevronsUpDown, Filter, Type } from 'lucide-react';
import { Button, Card, Input, Label, Modal, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { CATALOG_BY_KEY } from '@/lib/reports/catalog';
import { reportToTable, type StdReport } from '@/lib/reports/types';
import ReportToolbar, { type ExportTable } from './ReportToolbar';
import StdReportTable, { useCollapse } from './StdReportTable';
import ReportFilters, { hasAdvancedFilters, type Params } from './ReportFilters';
import NumberFormatPanel, { useNumberFormat } from './NumberFormatPanel';
import { ReportWhyChanged } from '@/components/WhyChanged';
import ReportSummaryBar from './ReportSummaryBar';
import { clearExplainCache } from './AmountExplain';
import { isSummaryReport } from '@/lib/reports/drilldown';

interface MemorizedRow {
  id: string;
  name: string;
  reportType: string;
  groupId: string | null;
  config: { params?: Params; display?: { numberFormat?: unknown; title?: string } };
}

interface Group {
  id: string;
  name: string;
}

const PARAM_KEYS = [
  'from', 'to', 'asOf', 'priorAsOf', 'accountId', 'section', 'nameId', 'customerId', 'vendorId', 'employeeId', 'itemId', 'jobId',
  'classId', 'budgetId', 'txnType', 'amountMin', 'amountMax', 'cleared', 'memo', 'number', 'sortBy', 'sortDir',
  'subtotalBy', 'columns', 'compare', 'basis', 'view', 'vehicle', 'dates', 'interval', 'through', 'agingFrom',
  'overDays',
];

function paramsFromSearch(sp: URLSearchParams | null): Params {
  const out: Params = {};
  if (!sp) return out;
  for (const k of PARAM_KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v;
  }
  return out;
}

export default function StdReportView({
  reportKey,
  basisNav,
  basis: fixedBasis,
}: {
  reportKey: string;
  /** Accrual / cash toggle for reports with a cash-basis sibling page. */
  basisNav?: { value: 'accrual' | 'cash'; accrualHref: string; cashHref: string };
  /** Always run on this basis (the cash-basis sibling pages). */
  basis?: 'cash';
}) {
  const baseEntry = CATALOG_BY_KEY[reportKey];
  const entry = baseEntry && fixedBasis ? { ...baseEntry, defaults: { ...(baseEntry.defaults ?? {}), basis: fixedBasis } } : baseEntry;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const memorizedId = search?.get('mem') ?? null;
  const [params, setParams] = useState<Params>(() => ({ ...(entry?.defaults ?? {}), ...paramsFromSearch(search) }));
  const [report, setReport] = useState<StdReport | null>(null);
  // Parameters of the last completed run (the report on screen), not the unapplied form.
  const [runParams, setRunParams] = useState<Params>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'filters' | 'format'>('none');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [memorized, setMemorized] = useState<MemorizedRow | null>(null);
  const [format, setFormat] = useNumberFormat(memorized?.config.display?.numberFormat);
  const [memoOpen, setMemoOpen] = useState(false);
  const { collapsed, setCollapsed, toggle, collapsible, allCollapsed, collapseAll, expandAll } = useCollapse(report);

  // Re-read params when the URL changes (QuickZoom Back / Forward).
  const searchKey = search?.toString() ?? '';
  // The report's own options (the summary's "compare with" choice does not re-run the report).
  const optionsKey = (() => {
    const q = new URLSearchParams(searchKey);
    q.delete('summaryVs');
    return q.toString();
  })();
  useEffect(() => {
    setParams({ ...(entry?.defaults ?? {}), ...paramsFromSearch(search) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, reportKey]);

  // reportexplain: the options the report runs with (drill-downs and the summary reuse them).
  const ranParams = useMemo(() => {
    const p: Params = { ...(entry?.defaults ?? {}), ...paramsFromSearch(search) };
    if (fixedBasis) p.basis = fixedBasis;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, reportKey, fixedBasis]);
  const backHref = `${pathname}${searchKey ? `?${searchKey}` : ''}`;
  const viewStateKey = `reportView:${backHref}`;
  const summaryVs = search?.get('summaryVs') === 'prior_year' ? 'prior_year' : 'prior_period';
  // Before a QuickZoom drill-down: remember where the reader was, so Back lands on the same row.
  const saveViewState = () => {
    try {
      sessionStorage.setItem(viewStateKey, JSON.stringify({ scrollY: window.scrollY, collapsed: [...collapsed] }));
    } catch {
      /* storage unavailable: Back still restores the report's options from the URL */
    }
  };
  // After coming Back: restore the scroll position and collapsed rows once the report is drawn.
  useEffect(() => {
    if (loading || !report) return;
    let saved: { scrollY?: number; collapsed?: string[] } | null = null;
    try {
      const raw = sessionStorage.getItem(viewStateKey);
      if (raw) {
        sessionStorage.removeItem(viewStateKey);
        saved = JSON.parse(raw);
      }
    } catch {
      saved = null;
    }
    if (!saved) return;
    if (Array.isArray(saved.collapsed)) setCollapsed(new Set(saved.collapsed.filter((x): x is string => typeof x === 'string')));
    const y = typeof saved.scrollY === 'number' ? saved.scrollY : 0;
    requestAnimationFrame(() => window.scrollTo({ top: y }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, report, viewStateKey]);

  const run = useCallback(async (p: Params) => {
    if (fixedBasis) p = { ...p, basis: fixedBasis };
    clearExplainCache();
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams(p).toString();
      const r = await api.get<StdReport>(`/api/reports/std/${reportKey}${qs ? `?${qs}` : ''}`);
      setReport(r);
      setRunParams(p);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'The report could not be run.';
      setError(msg);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [reportKey, fixedBasis]);

  useEffect(() => {
    run({ ...(entry?.defaults ?? {}), ...paramsFromSearch(search) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, reportKey]);

  useEffect(() => {
    if (!memorizedId) return;
    api
      .get<{ reports: MemorizedRow[] }>('/api/memorized-reports?withGroups=1')
      .then((d) => setMemorized(d.reports.find((r) => r.id === memorizedId) ?? null))
      .catch(() => setMemorized(null));
  }, [memorizedId]);

  const applyParams = (p: Params) => {
    const qs = new URLSearchParams(p);
    if (memorizedId) qs.set('mem', memorizedId);
    if (search?.get('summaryVs')) qs.set('summaryVs', search.get('summaryVs')!);
    const s = qs.toString();
    const target = `${pathname}${s ? `?${s}` : ''}`;
    if (target === `${pathname}${searchKey ? `?${searchKey}` : ''}`) run(p);
    else router.push(target);
  };

  const table: ExportTable | null = useMemo(() => {
    if (!report) return null;
    const t = reportToTable({ ...report, columns: report.columns.filter((c, i) => i === 0 || !hidden.has(c.key)) });
    return {
      filename: reportKey,
      title: memorized?.config.display?.title || memorized?.name || report.title,
      subtitle: report.subtitle,
      columns: t.columns,
      rows: t.rows,
    };
  }, [report, hidden, reportKey, memorized]);

  if (!entry) {
    return (
      <main className="min-h-screen p-8">
        <PageHeader title="Report not found" icon={BarChart2} />
        <Link href="/reports" className="text-electric hover:underline">
          Back to the Report Center
        </Link>
      </main>
    );
  }

  const title = memorized?.name ?? entry.title;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title={title}
        icon={BarChart2}
        action={report?.subtitle ? <span className="text-sm text-navy/60">{report.subtitle}</span> : undefined}
      />
      <p className="text-sm text-navy/60 -mt-4 mb-4 print-hidden">{entry.description}</p>

      <ReportToolbar
        table={table}
        disabled={loading}
        basisNav={basisNav}
        basis={
          !basisNav && !fixedBasis && entry.basis
            ? {
                // With no basis chosen the server uses the Reports preference; show what ran.
                value: (params.basis ?? report?.basis) === 'cash' ? 'cash' : 'accrual',
                onChange: (b) => {
                  // Always explicit, so a memorized report keeps the basis it was saved with.
                  const next: Params = { ...params, basis: b };
                  setParams(next);
                  applyParams(next);
                },
              }
            : undefined
        }
        columnPicker={report?.columns.slice(1).map((c) => ({ key: c.key, label: c.header || c.key, visible: !hidden.has(c.key) }))}
        onToggleColumn={(key) =>
          setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
      />

      <Card className="p-4 mb-4 print-hidden">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyParams(params);
          }}
        >
          <ReportFilters controls={entry.controls} params={params} onChange={setParams} showAdvanced={panel === 'filters'} />
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <Button type="submit" size="sm">
              Run Report
            </Button>
            {hasAdvancedFilters(entry.controls) && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setPanel(panel === 'filters' ? 'none' : 'filters')} aria-expanded={panel === 'filters'}>
                <Filter className="h-4 w-4" />
                {panel === 'filters' ? 'Hide filters' : 'More filters'}
              </Button>
            )}
            {collapsible.length > 0 && (
              <Button type="button" variant="secondary" size="sm" onClick={allCollapsed ? expandAll : collapseAll}>
                {allCollapsed ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
                {allCollapsed ? 'Expand rows' : 'Collapse rows'}
              </Button>
            )}
            <Button type="button" variant="secondary" size="sm" onClick={() => setPanel(panel === 'format' ? 'none' : 'format')} aria-expanded={panel === 'format'}>
              <Type className="h-4 w-4" />
              Fonts &amp; numbers
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setMemoOpen(true)} disabled={!report}>
              <Bookmark className="h-4 w-4" />
              Memorize
            </Button>
            <Link href="/reports/memorized" className="text-sm text-electric hover:underline ml-1">
              Memorized reports
            </Link>
          </div>
        </form>
        {panel === 'format' && (
          <div className="mt-3">
            <NumberFormatPanel format={format} onChange={setFormat} />
          </div>
        )}
      </Card>

      {report && <ReportWhyChanged reportKey={reportKey} params={runParams} basis={report.basis} range={report.range} />}
      {isSummaryReport(reportKey) && !error && (
        <ReportSummaryBar
          reportKey={reportKey}
          params={ranParams}
          vs={summaryVs}
          onVsChange={(v) => {
            const qs = new URLSearchParams(search?.toString() ?? '');
            if (v === 'prior_year') qs.set('summaryVs', v);
            else qs.delete('summaryVs');
            const s = qs.toString();
            router.replace(`${pathname}${s ? `?${s}` : ''}`, { scroll: false });
          }}
        />
      )}

      {report?.balanced === false && (
        <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          This report is out of balance. Open Data Integrity to find the problem entry.
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-navy/50 text-sm">
            <Spinner className="text-electric" />
            Running report…
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => run(params)}>
              Try again
            </Button>
          </div>
        )}
        {!loading && !error && report && (
          <StdReportTable
            report={report}
            format={format}
            collapsed={collapsed}
            onToggle={toggle}
            hiddenColumns={hidden}
            explain={{ reportKey, params: ranParams, backHref, onNavigate: saveViewState }}
          />
        )}
      </Card>
      {report?.notes?.map((n) => (
        <p key={n} className="text-xs text-navy/50 mt-2">
          {n}
        </p>
      ))}
      <p className="text-xs text-navy/40 mt-2 print-hidden">
        Tip: point at (or tab to) an amount to see what it is made of; click it or press Enter to see the transactions behind it (QuickZoom). Double-click a transaction row to open it.
      </p>

      <MemorizeDialog
        open={memoOpen}
        onClose={() => setMemoOpen(false)}
        reportKey={reportKey}
        defaultName={title}
        existing={memorized}
        config={{
          // Memorized reports keep the basis they ran on (QB saves it with the report).
          params: entry.basis && !params.basis && report?.basis ? { ...params, basis: report.basis } : params,
          display: { numberFormat: format, collapsed: allCollapsed },
        }}
        onSaved={(row) => {
          setMemorized(row);
          if (!memorizedId) router.replace(`${pathname}?${new URLSearchParams({ ...params, mem: row.id }).toString()}`);
        }}
      />
    </main>
  );
}

function MemorizeDialog({
  open,
  onClose,
  reportKey,
  defaultName,
  existing,
  config,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  reportKey: string;
  defaultName: string;
  existing: MemorizedRow | null;
  config: Record<string, unknown>;
  onSaved: (row: MemorizedRow) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [groupId, setGroupId] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? defaultName);
    setGroupId(existing?.groupId ?? '');
    api
      .get<Group[]>('/api/memorized-reports/groups')
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [open, existing, defaultName]);

  const save = async (mode: 'new' | 'replace') => {
    setBusy(true);
    try {
      let gid: string | null = groupId || null;
      if (groupId === '__new') {
        if (!newGroup.trim()) throw new Error('Type a name for the new group.');
        const g = await api.post<Group>('/api/memorized-reports/groups', { name: newGroup.trim() });
        gid = g.id;
      }
      const row =
        mode === 'replace' && existing
          ? await api.patch<MemorizedRow>(`/api/memorized-reports/${existing.id}`, { name, config, groupId: gid })
          : await api.post<MemorizedRow>('/api/memorized-reports', { name, reportType: reportKey, config, groupId: gid });
      toast(mode === 'replace' ? 'Memorized report updated.' : 'Report memorized.', 'success');
      onSaved(row);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not memorize the report.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Memorize report"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {existing && (
            <Button variant="secondary" loading={busy} onClick={() => save('replace')}>
              Replace “{existing.name}”
            </Button>
          )}
          <Button loading={busy} onClick={() => save('new')} disabled={!name.trim()}>
            {existing ? 'Save as new' : 'Memorize'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/60 mb-3">
        Saves this report with its dates, filters and number format so you can run it again from Memorized Reports.
        Relative dates are saved as the exact dates shown.
      </p>
      <div className="space-y-3">
        <div>
          <Label htmlFor="mem-name">Name</Label>
          <Input id="mem-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <Label htmlFor="mem-group">Save in group</Label>
          <Select id="mem-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">(no group)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value="__new">New group…</option>
          </Select>
        </div>
        {groupId === '__new' && (
          <div>
            <Label htmlFor="mem-newgroup">New group name</Label>
            <Input id="mem-newgroup" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
          </div>
        )}
      </div>
    </Modal>
  );
}
