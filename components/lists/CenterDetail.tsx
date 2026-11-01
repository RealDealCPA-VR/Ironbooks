'use client';
/**
 * The right-hand side of the Customer and Vendor Centers (QuickBooks layout): the name chosen in
 * the list on the left, its contact details and balance, and its transactions below.
 *
 * Transactions come from the standard Transaction List by Customer / by Vendor report, filtered to
 * the one name (GET /api/reports/std/transaction-list-by-*), so they match what the report shows.
 * The transaction list has the same keys as every other list (useListKeys): arrows move, Enter or
 * a double-click opens the transaction (EntryDetailModal), Ctrl+Y / Ctrl+H work on the
 * highlighted row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Pencil, Plus } from 'lucide-react';
import { Badge, Button, Card, Select, Spinner } from '@/components/ui';
import EntryDetailModal from '@/components/EntryDetailModal';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { LIST_ACTIVE_ATTR, quickReportHref, setActiveListRow, useListKeys } from '@/lib/shortcuts';
import { PREFILL_PATHS, stashPrefill } from '@/lib/commands/prefill';
import type { CellValue, StdReport, StdRow } from '@/lib/reports/types';

export type CenterKind = 'customer' | 'vendor';

export interface CenterRecord {
  id: string;
  displayName: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  balance: string;
  isActive: boolean;
  termsLabel?: string | null;
}

/** The QuickBooks Center "Dates" choices (report date macros). */
export const CENTER_DATE_CHOICES = [
  { value: 'all', label: 'All' },
  { value: 'this_fiscal_year', label: 'This Fiscal Year' },
  { value: 'this_fiscal_year_to_date', label: 'This Fiscal Year-to-date' },
  { value: 'last_fiscal_year', label: 'Last Fiscal Year' },
  { value: 'this_quarter', label: 'This Quarter' },
  { value: 'last_quarter', label: 'Last Quarter' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
] as const;

const COLUMNS: ReadonlyArray<{ key: string; header: string; money?: boolean; date?: boolean }> = [
  { key: 'type', header: 'Type' },
  { key: 'num', header: 'Num' },
  { key: 'date', header: 'Date', date: true },
  { key: 'memo', header: 'Memo' },
  { key: 'account', header: 'Account' },
  { key: 'amount', header: 'Amount', money: true },
];

/** The report URL for one name's transactions over a Center date choice. */
export function centerTransactionsUrl(kind: CenterKind, id: string, dates: string): string {
  const param = kind === 'customer' ? 'customerId' : 'vendorId';
  return `/api/reports/std/transaction-list-by-${kind}?dates=${encodeURIComponent(dates)}&${param}=${encodeURIComponent(id)}`;
}

/** The transaction rows of a by-name transaction list (headings, totals and spacers dropped). */
export function centerTransactionRows(report: StdReport): StdRow[] {
  return report.rows.filter((r) => r.kind === 'data');
}

/** Rows of the Center's name list carry their record id in this attribute. */
export const CENTER_ROW_ATTR = 'data-center-id';

const LAYOUT_KEY = 'ironbooks.centerLayout';
export type CenterLayout = 'center' | 'list';

/**
 * Center layout (name list beside the chosen name's transactions, the QuickBooks default) or the
 * full-width list with every column. The choice is kept on this computer.
 */
export function useCenterLayout(): [CenterLayout, (l: CenterLayout) => void] {
  const [layout, setLayoutState] = useState<CenterLayout>('center');
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LAYOUT_KEY) === 'list') setLayoutState('list');
    } catch {
      /* storage off: keep the default */
    }
  }, []);
  const setLayout = useCallback((l: CenterLayout) => {
    setLayoutState(l);
    try {
      window.localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* storage off: this visit only */
    }
  }, []);
  return [layout, setLayout];
}

/**
 * Which name is chosen in a Center's list: the highlighted row (arrows, type-ahead or a click move
 * it, lib/shortcuts.ts useListKeys). The first row is chosen when the list loads, as QuickBooks
 * does. Spread `ref` on an element that is always rendered around the list.
 */
export function useCenterSelection(ids: readonly string[], enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const idsKey = ids.join(',');

  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const read = () => {
      const row = root.querySelector<HTMLElement>(`[${LIST_ACTIVE_ATTR}][${CENTER_ROW_ATTR}]`);
      if (row) setSelectedId(row.getAttribute(CENTER_ROW_ATTR));
    };
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: [LIST_ACTIVE_ATTR] });
    read();
    return () => observer.disconnect();
  }, [enabled]);

  // A new list (first load, Show inactive, a name added or removed): keep the chosen name when
  // it is still there, else choose the first.
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(`tr[${CENTER_ROW_ATTR}]`));
    if (!rows.length) {
      setSelectedId(null);
      return;
    }
    const keep = rows.find((r) => r.getAttribute(CENTER_ROW_ATTR) === selectedId) ?? rows[0];
    const list = keep.closest<HTMLElement>('[data-list]');
    if (list) setActiveListRow(list, keep, false);
    setSelectedId(keep.getAttribute(CENTER_ROW_ATTR));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, enabled]);

  return { ref, selectedId };
}

function fmtDate(v: CellValue): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return v == null ? '' : String(v);
  return `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}`;
}

function cellText(c: (typeof COLUMNS)[number], v: CellValue): string {
  if (v == null || v === '') return '';
  if (c.money) return formatCurrency(String(v));
  if (c.date) return fmtDate(v);
  return String(v);
}

export default function CenterDetail({
  kind,
  record,
  onEdit,
}: {
  kind: CenterKind;
  record: CenterRecord | null;
  onEdit: (id: string) => void;
}) {
  const router = useRouter();
  const [dates, setDates] = useState<string>('all');
  const [rows, setRows] = useState<StdRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const listKeys = useListKeys<HTMLDivElement>();
  const recordId = record?.id ?? null;

  useEffect(() => {
    if (!recordId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<StdReport>(centerTransactionsUrl(kind, recordId, dates))
      .then((report) => {
        if (cancelled) return;
        setRows(centerTransactionRows(report));
        setTruncated(!!report.truncated);
      })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setError(
          err instanceof ApiError && err.status === 403
            ? 'You do not have access to these reports, so the transactions cannot be shown.'
            : err instanceof Error
              ? err.message
              : 'Could not load the transactions.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, recordId, dates]);

  if (!record) {
    return (
      <Card className="flex min-h-[16rem] items-center justify-center p-6 text-sm text-navy/50">
        Choose a {kind} on the left to see its transactions.
      </Card>
    );
  }

  const noun = kind === 'customer' ? 'Customer' : 'Vendor';
  const newForm = kind === 'customer' ? { label: 'New Invoice', kind: 'invoice' as const } : { label: 'Enter Bill', kind: 'bill' as const };

  function startForm() {
    if (!record) return;
    const prefill = kind === 'customer'
      ? { kind: newForm.kind, customerId: record.id, lines: [] }
      : { kind: newForm.kind, vendorId: record.id, lines: [] };
    stashPrefill(window.sessionStorage, prefill);
    router.push(PREFILL_PATHS[newForm.kind]);
  }

  return (
    <Card className="flex flex-col p-0 overflow-hidden" aria-label={`${noun} information`}>
      <div className="border-b border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy" data-center-name>
              {record.displayName}
            </h2>
            {record.companyName && <p className="text-sm text-navy/60">{record.companyName}</p>}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              {record.phone && (
                <>
                  <dt className="text-navy/50">Phone</dt>
                  <dd className="text-navy">{record.phone}</dd>
                </>
              )}
              {record.email && (
                <>
                  <dt className="text-navy/50">Email</dt>
                  <dd className="truncate">
                    <a href={`mailto:${record.email}`} className="text-electric hover:underline">
                      {record.email}
                    </a>
                  </dd>
                </>
              )}
              {record.termsLabel && (
                <>
                  <dt className="text-navy/50">Terms</dt>
                  <dd className="text-navy">{record.termsLabel}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="text-right">
            <p className="text-xs text-navy/50">Open balance</p>
            <p className="text-xl font-semibold tabular-nums text-navy" data-center-balance>
              {formatCurrency(record.balance)}
            </p>
            {!record.isActive && <Badge tone="neutral">Inactive</Badge>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(record.id)} title={`Edit ${noun.toLowerCase()} (Ctrl+E)`}>
            <Pencil className="h-3.5 w-3.5" /> Edit {noun}
          </Button>
          {record.isActive && (
            <Button size="sm" variant="secondary" onClick={startForm} title={`${newForm.label} for this ${noun.toLowerCase()} (Ctrl+U)`}>
              <Plus className="h-3.5 w-3.5" /> {newForm.label}
            </Button>
          )}
          <Link href={quickReportHref(kind, record.id)}>
            <Button size="sm" variant="secondary" title="QuickReport (Ctrl+Q)">
              <FileText className="h-3.5 w-3.5" /> QuickReport
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2">
        <h3 className="text-sm font-semibold text-navy">Transactions</h3>
        <label className="flex items-center gap-2 text-xs text-navy/60">
          Dates
          <Select
            aria-label="Transaction dates"
            className="w-auto py-1 text-xs"
            value={dates}
            onChange={(e) => setDates(e.target.value)}
          >
            {CENTER_DATE_CHOICES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-navy/40">
          <Spinner className="h-5 w-5" />
        </div>
      ) : error ? (
        <p className="p-4 text-sm text-red-600">{error}</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-navy/50">No transactions for these dates.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto" aria-label="Transactions" {...listKeys}>
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-white">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`border-b border-slate-200 px-3 py-1.5 text-xs font-semibold text-navy/55 ${c.money ? 'text-right' : 'text-left'}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-slate-100 text-navy hover:bg-electric/[.04] ${r.entryId ? 'cursor-pointer' : ''}`}
                  data-journal-entry={r.entryId ?? undefined}
                  onDoubleClick={r.entryId ? () => setEntryId(r.entryId!) : undefined}
                >
                  {COLUMNS.map((c) => (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap px-3 py-1 ${c.money ? 'text-right tabular-nums' : ''} ${c.key === 'memo' ? 'max-w-[14rem] truncate' : ''}`}
                    >
                      {cellText(c, r.cells[c.key] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {truncated && (
            <p className="p-3 text-xs text-navy/60">Only the first part of the list is shown. Narrow the dates to see everything.</p>
          )}
        </div>
      )}
      <EntryDetailModal entryId={entryId} onClose={() => setEntryId(null)} />
    </Card>
  );
}
