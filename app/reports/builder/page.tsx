'use client';
/**
 * Custom Report Builder page.
 * - Configure date range, account type checkboxes, and groupBy dimension.
 * - "Run" fetches POST /api/report-builder and displays a result table with totals.
 * - "Save" prompts for a name, POSTs to /api/memorized-reports.
 * - "Load Saved" lists memorized reports from GET /api/memorized-reports and re-runs one.
 * - "Download CSV" exports the visible table.
 */
import { useState, useEffect, useCallback } from 'react';
import { Wrench } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Table,
  Th,
  Td,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import type { ReportConfig, ReportResult } from '@/lib/services/reportBuilder';
import { csvMinimal } from '@/lib/csv';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemorizedReport {
  id: string;
  name: string;
  reportType: string;
  config: ReportConfig;
  createdAt: string;
}

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Formula-safe CSV cell (lib/csv.ts). */
function csvCell(val: string | number | null | undefined): string {
  return csvMinimal(val);
}

function buildCsv(result: ReportResult): string {
  const header = [csvCell('Key'), csvCell('Label'), csvCell('Debit'), csvCell('Credit'), csvCell('Net (Debit-Credit)')].join(',');
  const dataRows = result.rows.map((r) =>
    [
      csvCell(r.key),
      csvCell(r.label),
      csvCell(r.debit),
      csvCell(r.credit),
      csvCell(r.net),
    ].join(','),
  );
  const totals = [
    csvCell('TOTALS'),
    csvCell(''),
    csvCell(result.totals.debit),
    csvCell(result.totals.credit),
    csvCell(result.totals.net),
  ].join(',');
  return [header, ...dataRows, totals].join('\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ReportBuilderPage() {
  // --- Config state ---
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<Set<AccountType>>(new Set());
  const [groupBy, setGroupBy] = useState<ReportConfig['groupBy']>('type');

  // --- Report result ---
  const [result, setResult] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);

  // --- Saved reports ---
  const [saved, setSaved] = useState<MemorizedReport[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Load saved reports
  const loadSaved = useCallback(async () => {
    try {
      const rows = await api.get<MemorizedReport[]>('/api/memorized-reports');
      setSaved(rows.filter((r) => r.reportType === 'custom'));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadSaved();
  }, [loadSaved]);

  // Toggle account type checkbox
  function toggleType(t: AccountType) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  // Build config object from UI state
  function buildConfig(): ReportConfig {
    return {
      groupBy,
      from: from || undefined,
      to: to || undefined,
      accountTypes: selectedTypes.size > 0 ? [...selectedTypes] : undefined,
      status: 'posted',
    };
  }

  // Run report
  async function handleRun() {
    setRunning(true);
    setResult(null);
    try {
      const data = await api.post<ReportResult>('/api/report-builder', buildConfig());
      setResult(data);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to run report.', 'danger');
    } finally {
      setRunning(false);
    }
  }

  // Save as memorized report (name collected via the Save modal)
  async function handleSave() {
    const name = saveName.trim();
    if (!name) {
      toast('Please enter a name for the saved report.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/memorized-reports', {
        name,
        reportType: 'custom',
        config: buildConfig(),
      });
      toast(`Report "${name}" saved.`, 'success');
      setSaveOpen(false);
      setSaveName('');
      await loadSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to save report.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  // Load a memorized report config and re-run
  async function handleLoadSaved(saved: MemorizedReport) {
    const cfg = saved.config;
    setGroupBy(cfg.groupBy ?? 'type');
    setFrom(cfg.from ?? '');
    setTo(cfg.to ?? '');
    setSelectedTypes(new Set((cfg.accountTypes ?? []) as AccountType[]));
    setSavedOpen(false);

    // Run immediately with the loaded config
    setRunning(true);
    setResult(null);
    try {
      const data = await api.post<ReportResult>('/api/report-builder', cfg);
      setResult(data);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to run saved report.', 'danger');
    } finally {
      setRunning(false);
    }
  }

  // CSV download
  function handleDownload() {
    if (!result) return;
    const label = `CustomReport_${groupBy}_${new Date().toISOString().slice(0, 10)}`;
    downloadCsv(buildCsv(result), `${label}.csv`);
    toast('CSV downloaded.', 'success');
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Custom Report Builder"
        icon={Wrench}
        action={
          <div className="flex gap-2">
            {saved.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setSavedOpen((o) => !o)}>
                {savedOpen ? 'Hide Saved' : `Load Saved (${saved.length})`}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSaveOpen(true)}
              disabled={!result}
            >
              Save Report
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDownload}
              disabled={!result}
            >
              Download CSV
            </Button>
          </div>
        }
      />

      {/* Saved reports panel */}
      {savedOpen && saved.length > 0 && (
        <Card className="p-4 mb-4">
          <p className="text-sm font-semibold text-navy/70 mb-3">Saved Reports</p>
          <div className="flex flex-wrap gap-2">
            {saved.map((s) => (
              <button
                key={s.id}
                onClick={() => handleLoadSaved(s)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-electric/5 text-sm text-navy transition-colors"
              >
                {s.name}
                <span className="ml-2 text-navy/40 text-xs">
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Config card */}
      <Card className="p-5 mb-6">
        <div className="flex flex-wrap gap-6 items-end">
          {/* Date range */}
          <div className="flex gap-4 items-end">
            <div>
              <Label htmlFor="rb-from">From</Label>
              <Input
                id="rb-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="rb-to">To</Label>
              <Input
                id="rb-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>

          {/* Account types */}
          <div>
            <Label>Account Types</Label>
            <div className="flex flex-wrap gap-3 mt-1.5">
              {ACCOUNT_TYPES.map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-1.5 cursor-pointer select-none text-sm text-navy"
                >
                  <input
                    type="checkbox"
                    checked={selectedTypes.has(t)}
                    onChange={() => toggleType(t)}
                    className="rounded border-slate-300 text-electric focus:ring-electric"
                  />
                  <span className="capitalize">{t}</span>
                </label>
              ))}
            </div>
            {selectedTypes.size === 0 && (
              <p className="text-xs text-navy/40 mt-1">All types included</p>
            )}
          </div>

          {/* Group by */}
          <div className="min-w-[160px]">
            <Label htmlFor="rb-groupby">Group By</Label>
            <Select
              id="rb-groupby"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as ReportConfig['groupBy'])}
            >
              <option value="type">Account Type</option>
              <option value="account">Account</option>
              <option value="month">Month</option>
            </Select>
          </div>

          <Button onClick={handleRun} disabled={running}>
            {running ? 'Running…' : 'Run Report'}
          </Button>
        </div>
      </Card>

      {/* Results */}
      <Card className="p-0 overflow-hidden">
        {running && (
          <div className="py-16 text-center text-navy/40">Running report…</div>
        )}

        {!running && !result && (
          <div className="py-16 text-center text-navy/40">
            Configure your filters above and click Run Report.
          </div>
        )}

        {!running && result && result.rows.length === 0 && (
          <div className="py-16 text-center text-navy/40">
            No posted transactions match the selected filters.
          </div>
        )}

        {!running && result && result.rows.length > 0 && (
          <>
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <span className="text-sm text-navy/50">
                {result.rows.length} group{result.rows.length !== 1 ? 's' : ''} — generated{' '}
                {new Date(result.generatedAt).toLocaleString()}
              </span>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>{groupBy === 'account' ? 'Account' : groupBy === 'type' ? 'Type' : 'Month'}</Th>
                  <Th className="text-right">Debit</Th>
                  <Th className="text-right">Credit</Th>
                  <Th className="text-right">Net (Dr - Cr)</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => {
                  const net = Number(row.net);
                  return (
                    <Tr key={row.key}>
                      <Td>
                        <span className="font-medium text-navy">{row.label}</span>
                        {groupBy !== 'month' && (
                          <span className="ml-2 text-navy/40 text-xs">{row.key}</span>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {Number(row.debit) !== 0 ? formatCurrency(row.debit) : '—'}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {Number(row.credit) !== 0 ? formatCurrency(row.credit) : '—'}
                      </Td>
                      <Td
                        className={`text-right tabular-nums font-semibold ${
                          net < 0 ? 'text-red-600' : net > 0 ? 'text-navy' : 'text-navy/40'
                        }`}
                      >
                        {formatCurrency(row.net)}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/20 bg-slate-50">
                  <td className="py-3 px-4 font-extrabold text-navy">Totals</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-navy">
                    {formatCurrency(result.totals.debit)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-navy">
                    {formatCurrency(result.totals.credit)}
                  </td>
                  <td
                    className={`py-3 px-4 text-right tabular-nums font-extrabold text-lg ${
                      Number(result.totals.net) < 0 ? 'text-red-600' : 'text-emerald'
                    }`}
                  >
                    {formatCurrency(result.totals.net)}
                  </td>
                </tr>
              </tfoot>
            </Table>
          </>
        )}
      </Card>

      {/* Save Report modal */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save Report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button loading={saving} onClick={handleSave}>
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <Label htmlFor="save-report-name">Report Name</Label>
          <Input
            id="save-report-name"
            autoFocus
            placeholder="e.g. Monthly expense breakdown"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
          />
        </form>
      </Modal>
    </main>
  );
}
