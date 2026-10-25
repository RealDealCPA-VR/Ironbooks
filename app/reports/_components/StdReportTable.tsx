'use client';

/**
 * Renders a standard report (lib/reports/types.ts): indented rows, section / subtotal / grand
 * total styling, collapse & expand of sub-account roll-ups and grouped detail (QB "Collapse"),
 * the user's number format (lib/reports/format.ts), and QuickZoom on every row:
 *  - a row / cell with an href opens that report or page,
 *  - a transaction row (entryId) opens the transaction detail (EntryDetailModal).
 * QB list keys move through the rows (useListKeys): Enter QuickZooms the highlighted row, and
 * Ctrl+Y / Ctrl+H show a transaction row's journal / history (components/KeyboardCommands.tsx).
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import EntryDetailModal from '@/components/EntryDetailModal';
import { useListKeys } from '@/lib/shortcuts';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import { FONT_CLASS, FONT_SIZE_CLASS, formatAmount, type NumberFormat } from '@/lib/reports/format';
import { drilldownApiUrl, drilldownHref, isDrilldownReport } from '@/lib/reports/drilldown';
import { formatCurrency } from '@/lib/money';
import AmountExplain from './AmountExplain';

const NUMERIC = new Set(['money', 'number', 'percent']);

/** Explanations for the amounts (reportexplain). */
export interface ExplainContext {
  reportKey: string;
  /** The options the report ran with (they travel in the drill-down URL). */
  params: Record<string, string>;
  /** The report page to come back to. */
  backHref: string;
  /** Called before following a drill-down link (save scroll / collapse state). */
  onNavigate?: () => void;
}

/** Tooltip for one transaction line on a report without server explanations. */
function singleText(r: StdRow): string {
  const c = r.cells;
  const amount = c.amount ?? c.open ?? c.debit ?? c.credit ?? null;
  const what = [c.type, c.num ? `#${String(c.num).replace(/^#/, '')}` : ''].filter(Boolean).join(' ') || 'transaction';
  const who = c.name ? ` with ${c.name}` : '';
  const when = typeof c.date === 'string' && c.date ? ` on ${fmtDate(c.date)}` : '';
  const amt = amount !== null && amount !== '' ? ` for ${formatCurrency(String(amount))}` : '';
  return `One transaction: ${what}${who}${when}${amt}.`;
}

function fmtDate(v: CellValue): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return v == null ? '' : String(v);
  return `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}`;
}

export function useCollapse(report: StdReport | null) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const collapsible = useMemo(
    () => (report?.rows ?? []).filter((r) => r.collapsedCells && (r.collapseKind === 'account' || r.collapseKind === 'group')).map((r) => r.id),
    [report],
  );
  const allCollapsed = collapsible.length > 0 && collapsible.every((id) => collapsed.has(id));
  const collapseAll = () => setCollapsed(new Set(collapsible));
  const expandAll = () => setCollapsed(new Set());
  return { collapsed, setCollapsed, toggle, collapsible, allCollapsed, collapseAll, expandAll };
}

export default function StdReportTable({
  report,
  format,
  collapsed,
  onToggle,
  hiddenColumns,
  explain,
}: {
  report: StdReport;
  format: NumberFormat;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  hiddenColumns?: Set<string>;
  /** Explain every amount (hover / focus tooltip + drill-down). */
  explain?: ExplainContext;
}) {
  const [entryId, setEntryId] = useState<string | null>(null);
  const listKeys = useListKeys<HTMLDivElement>();
  const byId = useMemo(() => new Map(report.rows.map((r) => [r.id, r])), [report]);
  const columns = report.columns.filter((c, i) => i === 0 || !hiddenColumns?.has(c.key));
  const explainAll = !!explain && isDrilldownReport(explain.reportKey);

  const isHidden = (r: StdRow): boolean => {
    if (r.totalOf && collapsed.has(r.totalOf)) return true;
    let p = r.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      if (collapsed.has(p)) return true;
      p = byId.get(p)?.parentId ?? null;
    }
    return false;
  };

  const renderValue = (c: StdColumn, v: CellValue) => {
    if (c.type && NUMERIC.has(c.type)) {
      const f = formatAmount(v, format, c.type);
      return <span className={f.negative && format.redNegatives ? 'text-red-600' : undefined}>{f.text}</span>;
    }
    if (c.type === 'date') return fmtDate(v);
    return v == null ? '' : String(v);
  };

  const rowClass = (r: StdRow) => {
    switch (r.kind) {
      case 'section':
        return 'font-semibold text-navy';
      case 'subtotal':
        return 'font-semibold text-navy/90 border-t border-navy/15';
      case 'total':
        return 'font-bold text-navy border-t border-navy/25 bg-navy/[0.03]';
      case 'grand':
        return 'font-bold text-navy border-t-2 border-navy/40 bg-navy/5';
      default:
        return 'text-navy/90 hover:bg-electric/5';
    }
  };

  return (
    <div className="overflow-x-auto" {...listKeys}>
      <table className={`w-full border-collapse ${FONT_CLASS[format.font]} ${FONT_SIZE_CLASS[format.fontSize]}`}>
        <thead>
          <tr className="border-b-2 border-navy/20">
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={`py-2 px-3 text-xs font-bold uppercase tracking-wide text-navy/60 whitespace-nowrap ${
                  c.type && NUMERIC.has(c.type) ? 'text-right' : 'text-left'
                } ${i === 0 ? 'min-w-[14rem]' : ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="py-12 text-center text-navy/50">
                Nothing to show for these settings.
              </td>
            </tr>
          )}
          {report.rows.map((r) => {
            if (r.kind === 'spacer') return <tr key={r.id} aria-hidden="true"><td colSpan={columns.length} className="py-1" /></tr>;
            if (isHidden(r)) return null;
            const isCollapsed = collapsed.has(r.id);
            const cells = isCollapsed && r.collapsedCells ? r.collapsedCells : r.cells;
            const canToggle = !!r.collapsedCells;
            const openEntry = r.entryId ? () => setEntryId(r.entryId!) : undefined;
            return (
              <tr
                key={r.id}
                className={`border-b border-slate-100 ${rowClass(r)} ${openEntry ? 'cursor-pointer' : ''}`}
                onDoubleClick={openEntry}
                data-journal-entry={r.entryId ?? undefined}
              >
                {columns.map((c, i) => {
                  const v = cells[c.key] ?? null;
                  const content = renderValue(c, v);
                  const numeric = c.type && NUMERIC.has(c.type);
                  const cellHref = r.hrefs?.[c.key] ?? (i === 0 || (numeric && r.kind === 'data') ? r.href : null);
                  let inner: React.ReactNode = content;
                  const explainable = !!explain && numeric && c.type !== 'number' && v !== null && v !== '';
                  if (explainable && explainAll) {
                    // reportexplain: every amount explains itself and drills to its transactions.
                    const cellLabel = `${String(cells[columns[0].key] ?? r.cells.type ?? '')}${c.header ? `, ${c.header}` : ''}`.trim();
                    const single = !!openEntry && c.key !== 'balance';
                    inner = (
                      <AmountExplain
                        apiUrl={drilldownApiUrl(explain!.reportKey, explain!.params, r.id, c.key, true)}
                        href={single ? undefined : drilldownHref(explain!.reportKey, explain!.params, r.id, c.key, explain!.backHref)}
                        onActivate={single ? openEntry : undefined}
                        onNavigate={explain!.onNavigate}
                        label={cellLabel}
                      >
                        {content}
                      </AmountExplain>
                    );
                  } else if (explainable && openEntry) {
                    // Other reports: a transaction line is one transaction — explain it locally.
                    inner = (
                      <AmountExplain onActivate={openEntry} localText={singleText(r)} label={String(r.cells.type ?? 'Transaction')}>
                        {content}
                      </AmountExplain>
                    );
                  } else if (cellHref && content !== '') {
                    inner = (
                      <Link href={cellHref} className="hover:text-electric hover:underline" title="QuickZoom: open the detail behind this amount">
                        {content}
                      </Link>
                    );
                  } else if (openEntry && content !== '' && (i === 0 || numeric || c.key === 'num' || c.key === 'type')) {
                    inner = (
                      <button type="button" onClick={openEntry} className="text-left hover:text-electric hover:underline" title="Open this transaction">
                        {content}
                      </button>
                    );
                  }
                  return (
                    <td
                      key={c.key}
                      className={`py-1.5 px-3 align-top ${numeric ? 'text-right tabular-nums whitespace-nowrap' : ''}`}
                      style={i === 0 ? { paddingLeft: `${12 + r.depth * 18}px` } : undefined}
                    >
                      {i === 0 && canToggle ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onToggle(r.id)}
                            className="print-hidden -ml-5 rounded p-0.5 text-navy/50 hover:text-electric"
                            aria-expanded={!isCollapsed}
                            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${String(r.cells[c.key] ?? '')}`}
                          >
                            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          {inner}
                        </span>
                      ) : (
                        inner
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <EntryDetailModal entryId={entryId} onClose={() => setEntryId(null)} />
    </div>
  );
}
