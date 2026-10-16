'use client';
/**
 * EntryDetailModal — QuickZoom journal-entry detail view.
 *
 * Given a journalEntryId, fetches GET /api/journal-entries/<id> and shows the
 * entry header (number, date, status, reference, description), its lines
 * (account, memo, debit, credit) with totals, the void status, and — when the
 * entry's sourceRef maps to a known document type — a link to the source page.
 *
 * Also exports `sourceRefLink`, the shared sourceRef → route mapping used by
 * register/report rows to decide between "open source document" and "open this
 * modal".
 *
 * History section (txn-history): fetches GET /api/journal-entries/<id>/history
 * and renders the QB "Transaction History" linked-transactions tree — e.g. an
 * invoice with its estimate source, payments applied (and the deposits that
 * banked them), credit memos, and COGS entries; manual entries show
 * reversal/replacement links.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CornerDownRight, ExternalLink, History } from 'lucide-react';
import { Badge, Button, Modal, Table, Th, Td, Tr } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';

// ---------------------------------------------------------------------------
// sourceRef → route mapping (QuickZoom to the source document)
// ---------------------------------------------------------------------------

const SOURCE_ROUTES: Record<string, { href: string; label: string }> = {
  invoice: { href: '/invoices', label: 'Invoice' },
  bill: { href: '/bills', label: 'Bill' },
  deposit: { href: '/deposits', label: 'Deposit' },
  expense: { href: '/expense-reports', label: 'Expense' },
  expense_report: { href: '/expense-reports', label: 'Expense Report' },
  credit_memo: { href: '/credit-memos', label: 'Credit Memo' },
  vendor_credit: { href: '/vendor-credits', label: 'Vendor Credit' },
  salesreceipt: { href: '/sales-receipts', label: 'Sales Receipt' },
  sales_receipt: { href: '/sales-receipts', label: 'Sales Receipt' },
  paycheck: { href: '/pay-stubs', label: 'Paycheck' },
  bank_transaction: { href: '/bank-review', label: 'Bank Transaction' },
  item: { href: '/items', label: 'Item Adjustment' },
  fixed_asset: { href: '/fixed-assets', label: 'Fixed Asset' },
  customer: { href: '/payments', label: 'Payment Received' },
  vendor: { href: '/bills', label: 'Bill Payment' },
  account: { href: '/accounts', label: 'Account Opening Balance' },
  transfer: { href: '/transfers', label: 'Transfer' },
};

/**
 * Map a journal entry sourceRef (e.g. "invoice:<id>") to the page that hosts the
 * source document. Returns null for manual/unknown refs — callers should open
 * the journal-entry detail modal instead.
 */
export function sourceRefLink(
  sourceRef: string | null | undefined,
): { href: string; label: string } | null {
  if (!sourceRef || sourceRef === 'manual') return null;
  const prefix = sourceRef.split(':')[0];
  return SOURCE_ROUTES[prefix] ?? null;
}

// ---------------------------------------------------------------------------
// Types (mirror GET /api/journal-entries/[id])
// ---------------------------------------------------------------------------

interface EntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  classId: string | null;
  className: string | null;
}

interface EntryDetail {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  sourceRef: string | null;
  createdAt: string;
  voidedAt: string | null;
  lines: EntryLine[];
}

/** Mirrors lib/services/linkedTransactions.ts LinkedTransaction. */
interface LinkedTransaction {
  kind: string;
  id: string;
  label: string;
  date: string;
  amount: string;
  route: string;
  children?: LinkedTransaction[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function statusTone(status: string): 'success' | 'void' | 'neutral' {
  if (status === 'posted') return 'success';
  if (status === 'void') return 'void';
  return 'neutral';
}

// Entry dates are calendar days: formatDate (lib/format.ts) shows them without the UTC
// off-by-one that `new Date(iso).toLocaleDateString()` had in US time zones.

export interface EntryDetailModalProps {
  /** Journal entry to show; null hides the modal. */
  entryId: string | null;
  onClose: () => void;
}

/** One row in the History tree: indented label link + date + amount. */
function HistoryRow({ node, depth }: { node: LinkedTransaction; depth: number }) {
  return (
    <>
      <div
        className="flex items-center gap-3 py-1.5 border-b border-navy/5 last:border-b-0 text-sm"
        style={{ paddingLeft: `${depth * 20}px` }}
      >
        {depth > 0 && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-navy/30" />}
        <Link
          href={node.route}
          className="text-electric font-medium hover:underline truncate"
          title={node.label}
        >
          {node.label}
        </Link>
        <span className="text-xs text-navy/40 whitespace-nowrap">{formatDate(node.date)}</span>
        <span className="ml-auto tabular-nums text-navy/70">{formatCurrency(node.amount)}</span>
      </div>
      {(node.children ?? []).map((c) => (
        <HistoryRow key={`${c.kind}:${c.id}`} node={c} depth={depth + 1} />
      ))}
    </>
  );
}

export default function EntryDetailModal({ entryId, onClose }: EntryDetailModalProps) {
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LinkedTransaction | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!entryId) {
      setEntry(null);
      setError(null);
      setHistory(null);
      setHistoryError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntry(null);
    api
      .get<{ entry: EntryDetail }>(`/api/journal-entries/${entryId}`)
      .then((data) => {
        if (!cancelled) setEntry(data.entry);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load journal entry.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Linked-transactions history (independent of the entry fetch; failure here
    // should not block the entry detail).
    setHistoryLoading(true);
    setHistoryError(null);
    setHistory(null);
    api
      .get<{ history: LinkedTransaction }>(`/api/journal-entries/${entryId}/history`)
      .then((data) => {
        if (!cancelled) setHistory(data.history);
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryError(
            err instanceof ApiError ? err.message : 'Failed to load transaction history.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const totalDebit = (entry?.lines ?? []).reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
  const totalCredit = (entry?.lines ?? []).reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
  const source = sourceRefLink(entry?.sourceRef);

  return (
    <Modal
      open={!!entryId}
      onClose={onClose}
      size="lg"
      title={entry ? `Journal Entry #${entry.entryNumber}` : 'Journal Entry'}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading && <div className="py-10 text-center text-navy/40 text-sm">Loading entry…</div>}

      {error && !loading && (
        <div className="py-10 text-center text-red-500 text-sm">{error}</div>
      )}

      {entry && !loading && (
        <>
          {/* Header */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5 text-sm">
            <div>
              <div className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Date</div>
              <div className="text-navy">{formatDate(entry.date)}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Status</div>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(entry.status)}>
                  {entry.status === 'void' ? 'Voided' : entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}
                </Badge>
                {entry.voidedAt && (
                  <span className="text-xs text-navy/40">on {formatDate(entry.voidedAt)}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Reference</div>
              <div className="text-navy">{entry.reference ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Source</div>
              {source ? (
                <Link
                  href={source.href}
                  className="inline-flex items-center gap-1 text-electric font-medium hover:underline"
                >
                  {source.label}
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <span className="text-navy/60">
                  {entry.sourceRef === 'manual' || !entry.sourceRef ? 'Manual entry' : entry.sourceRef}
                </span>
              )}
            </div>
            <div className="col-span-2">
              <div className="text-xs font-semibold text-navy/50 uppercase tracking-wide">Description</div>
              <div className="text-navy">{entry.description}</div>
            </div>
          </div>

          {/* Lines */}
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Memo</Th>
                <Th>Class</Th>
                <Th numeric>Debit</Th>
                <Th numeric>Credit</Th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((l) => (
                <Tr key={l.id}>
                  <Td className="text-sm">
                    <span className="font-mono text-xs text-navy/50 mr-1.5">{l.accountCode}</span>
                    {l.accountName}
                  </Td>
                  <Td className="text-sm text-navy/60">{l.memo ?? ''}</Td>
                  <Td className="text-sm text-navy/60">{l.className ?? ''}</Td>
                  <Td numeric className="text-sm">
                    {l.debit ? formatCurrency(l.debit) : ''}
                  </Td>
                  <Td numeric className="text-sm">
                    {l.credit ? formatCurrency(l.credit) : ''}
                  </Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy/20">
                <td className="py-2 px-4 font-bold text-navy text-sm" colSpan={3}>
                  Totals
                </td>
                <td className="py-2 px-4 text-right tabular-nums font-bold text-navy text-sm">
                  {formatCurrency(totalDebit)}
                </td>
                <td className="py-2 px-4 text-right tabular-nums font-bold text-navy text-sm">
                  {formatCurrency(totalCredit)}
                </td>
              </tr>
            </tfoot>
          </Table>

          {/* History — QB linked-transactions tree */}
          <div className="mt-6">
            <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-navy/50 uppercase tracking-wide">
              <History className="h-3.5 w-3.5" />
              History
            </div>
            {historyLoading && (
              <div className="py-3 text-sm text-navy/40">Loading transaction history…</div>
            )}
            {historyError && !historyLoading && (
              <div className="py-3 text-sm text-red-500">{historyError}</div>
            )}
            {history && !historyLoading && !historyError && (
              <div className="rounded-lg border border-navy/10 px-3 py-1">
                <HistoryRow node={history} depth={0} />
                {(history.children ?? []).length === 0 && (
                  <div className="py-1.5 text-sm text-navy/40">
                    No linked transactions.
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
