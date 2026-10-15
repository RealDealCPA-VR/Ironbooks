'use client';
/**
 * "Why did this number change?" (ux/undo).
 *
 * A small button placed next to a report total (Balance Sheet, Profit & Loss, Trial Balance) or
 * an account balance (Chart of Accounts, account registers). It opens a window listing every
 * transaction that was added, changed, voided or deleted since a moment the user picks — and
 * that moved this number — with the amount before and after, who did it and when
 * (GET /api/why-changed, built from the ledger and the audit trail).
 *
 * "Since" defaults to the last time this person looked at this number on this computer
 * (remembered in the browser; 24 hours ago the first time), so "what changed since I last looked"
 * is one click.
 */
import * as React from 'react';
import Link from 'next/link';
import { HelpCircle, History } from 'lucide-react';
import { Badge, Button, Input, Label, Modal, Spinner, Table, Td, Th, Tr } from '@/components/ui';
import EntryDetailModal, { sourceRefLink } from '@/components/EntryDetailModal';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

export interface WhyChangedQuery {
  /** Report total: assets | liabilities | equity | income | expenses | net_income | all */
  preset?: string;
  /** Account balance(s). */
  accounts?: string[];
  /** Include sub-accounts of `accounts`. */
  subaccounts?: boolean;
  /** The number's transaction-date window (YYYY-MM-DD); omit for all dates. */
  from?: string | null;
  to?: string | null;
  /** With no `from`: the fiscal year to date (the Profit & Loss default range). */
  fiscalYearToDate?: boolean;
}

interface Change {
  key: string;
  kind: 'created' | 'edited' | 'voided' | 'deleted';
  type: string;
  label: string;
  date: string;
  entryId: string;
  entryNumber: number;
  sourceRef: string | null;
  before: string;
  after: string;
  delta: string;
  who: string | null;
  when: string;
}

interface Result {
  since: string;
  measure: 'natural' | 'credit' | 'debit' | 'gross';
  accounts: Array<{ id: string; code: string; name: string }>;
  totalNow: string;
  totalThen: string;
  totalDelta: string;
  changes: Change[];
  truncated: boolean;
}

const SEEN_PREFIX = 'bka:whySeen:';
const KIND_LABEL: Record<Change['kind'], { text: string; tone: 'success' | 'info' | 'void' | 'danger' }> = {
  created: { text: 'Added', tone: 'success' },
  edited: { text: 'Changed', tone: 'info' },
  voided: { text: 'Voided', tone: 'void' },
  deleted: { text: 'Deleted', tone: 'danger' },
};

/** Value for <input type="datetime-local"> in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readSeen(key: string): Date | null {
  try {
    const v = window.localStorage.getItem(SEEN_PREFIX + key);
    const d = v ? new Date(v) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function writeSeen(key: string, d: Date): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + key, d.toISOString());
  } catch {
    /* storage blocked: the default falls back to 24 hours ago */
  }
}

const money = (v: string) => formatCurrency(v);
const signed = (v: string) => (Number(v) > 0 ? `+${money(v)}` : money(v));
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function WhyChanged({
  title,
  query,
  storageKey,
  label = 'Why did this change?',
  compact = false,
  className,
}: {
  /** What the number is, e.g. "Total Assets" or "Checking balance". */
  title: string;
  query: WhyChangedQuery;
  /** Remembers when this number was last looked at (per browser). */
  storageKey: string;
  label?: string;
  /** Icon-only button (table rows). */
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [since, setSince] = React.useState('');
  const [result, setResult] = React.useState<Result | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState<string | null>(null);
  const lastSeen = React.useRef<Date | null>(null);

  // Remember when this number was viewed; the previous visit becomes the default "since".
  React.useEffect(() => {
    lastSeen.current = readSeen(storageKey);
    writeSeen(storageKey, new Date());
  }, [storageKey]);

  const qs = React.useCallback(
    (sinceIso: string) => {
      const p = new URLSearchParams({ since: sinceIso });
      if (query.preset) p.set('preset', query.preset);
      if (query.accounts?.length) p.set('accounts', query.accounts.join(','));
      if (query.subaccounts) p.set('subaccounts', '1');
      if (query.from) p.set('from', query.from);
      if (query.to) p.set('to', query.to);
      if (query.fiscalYearToDate) p.set('fytd', '1');
      return p.toString();
    },
    [query.preset, query.accounts, query.subaccounts, query.from, query.to, query.fiscalYearToDate],
  );

  const run = React.useCallback(
    async (localValue: string) => {
      const d = new Date(localValue);
      if (!localValue || isNaN(d.getTime())) {
        setError('Pick a date and time.');
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setResult(await api.get<Result>(`/api/why-changed?${qs(d.toISOString())}`));
      } catch (err) {
        setResult(null);
        setError(err instanceof ApiError ? err.friendly.message || err.message : 'Could not look up the changes.');
      } finally {
        setLoading(false);
      }
    },
    [qs],
  );

  const openModal = () => {
    const def = lastSeen.current ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const v = toLocalInput(def);
    setSince(v);
    setOpen(true);
    void run(v);
  };

  const quick = (ms: number | 'today') => {
    const d = ms === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)) : new Date(Date.now() - ms);
    const v = toLocalInput(d);
    setSince(v);
    void run(v);
  };

  const gross = result?.measure === 'gross';
  const windowText =
    query.from && query.to
      ? `transactions dated ${day(query.from)} to ${day(query.to)}`
      : query.to && query.fiscalYearToDate
        ? `transactions dated from the start of the fiscal year to ${day(query.to)}`
        : query.to
          ? `transactions dated on or before ${day(query.to)}`
          : 'transactions of any date';

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        title={`${label} (${title})`}
        aria-label={compact ? `Why did ${title} change?` : undefined}
        className={cn(
          'inline-flex items-center gap-1 rounded-md text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 print-hidden',
          compact ? 'p-0.5' : 'text-sm font-medium',
          className,
        )}
      >
        <History className="h-4 w-4" aria-hidden="true" />
        {!compact && label}
      </button>

      <Modal open={open && !zoom} onClose={() => setOpen(false)} title={`Why did ${title} change?`} size="xl">
        <p className="text-sm text-navy/70 mb-4">
          Every transaction that was added, changed, voided or deleted since the time you pick, and how much each one
          moved this number. Only {windowText} count, because only they are in this number.
        </p>
        <form
          className="flex flex-wrap items-end gap-2 mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(since);
          }}
        >
          <div>
            <Label htmlFor={`why-since-${storageKey}`}>Changes since</Label>
            <Input
              id={`why-since-${storageKey}`}
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" loading={loading}>
            Show changes
          </Button>
          <span className="text-sm text-navy/60 ml-2">Quick:</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => quick(60 * 60 * 1000)}>
            Last hour
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => quick('today')}>
            Today
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => quick(7 * 24 * 60 * 60 * 1000)}>
            Last 7 days
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => quick(30 * 24 * 60 * 60 * 1000)}>
            Last 30 days
          </Button>
        </form>

        {error && (
          <p role="alert" className="text-sm text-red-600 mb-3">
            {error}
          </p>
        )}
        {loading && !result && (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-navy/60">
            <Spinner className="text-electric" /> Looking up changes…
          </div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4" aria-live="polite">
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-navy/60">Then ({when(result.since)})</div>
                <div className="text-lg font-semibold tabular-nums">{money(result.totalThen)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-navy/60">Now</div>
                <div className="text-lg font-semibold tabular-nums">{money(result.totalNow)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs text-navy/60">Change</div>
                <div
                  className={cn(
                    'text-lg font-semibold tabular-nums',
                    Number(result.totalDelta) > 0 ? 'text-emerald' : Number(result.totalDelta) < 0 ? 'text-red-600' : '',
                  )}
                >
                  {signed(result.totalDelta)}
                </div>
              </div>
            </div>
            {gross && (
              <p className="text-xs text-navy/60 mb-3 flex items-start gap-1">
                <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                For the Trial Balance total, each row shows how much the transaction moves (its debits), before and
                after.
              </p>
            )}
            {result.changes.length === 0 ? (
              <p className="text-sm text-navy/70 py-6 text-center">
                Nothing changed this number since {when(result.since)}.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>What happened</Th>
                    <Th>Transaction</Th>
                    <Th numeric>Before</Th>
                    <Th numeric>After</Th>
                    <Th numeric>Change</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.changes.map((c) => {
                    const link = sourceRefLink(c.sourceRef);
                    const k = KIND_LABEL[c.kind];
                    return (
                      <Tr key={c.key}>
                        <Td className="whitespace-nowrap text-sm">{when(c.when)}</Td>
                        <Td className="text-sm">{c.who ?? '—'}</Td>
                        <Td>
                          <Badge tone={k.tone}>{k.text}</Badge>
                        </Td>
                        <Td className="text-sm">
                          <div className="font-medium">
                            {c.type[0]?.toUpperCase()}
                            {c.type.slice(1)} · {day(c.date)}
                          </div>
                          <div className="text-navy/70">
                            <button
                              type="button"
                              onClick={() => setZoom(c.entryId)}
                              className="text-left text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
                            >
                              {c.label || `Entry #${c.entryNumber}`}
                            </button>
                            {link && (
                              <>
                                {' · '}
                                <Link href={link.href} className="text-electric hover:underline">
                                  Open {link.label}
                                </Link>
                              </>
                            )}
                          </div>
                        </Td>
                        <Td numeric>{money(c.before)}</Td>
                        <Td numeric>{money(c.after)}</Td>
                        <Td
                          numeric
                          className={cn('font-semibold', Number(c.delta) > 0 ? 'text-emerald' : Number(c.delta) < 0 ? 'text-red-600' : '')}
                        >
                          {signed(c.delta)}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
            {result.truncated && (
              <p className="text-xs text-navy/60 mt-2">
                Only the 1,000 most recent changes are shown. Pick a later time to see fewer.
              </p>
            )}
          </>
        )}
      </Modal>
      {zoom && <EntryDetailModal entryId={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}

/** The report totals each financial report offers "Why did this change?" for. */
const REPORT_LINES: Record<string, Array<{ title: string; preset: string }>> = {
  'balance-sheet': [
    { title: 'Total Assets', preset: 'assets' },
    { title: 'Total Liabilities', preset: 'liabilities' },
    { title: 'Total Equity', preset: 'equity' },
  ],
  'profit-loss': [
    { title: 'Total Income', preset: 'income' },
    { title: 'Total Expenses', preset: 'expenses' },
    { title: 'Net Income', preset: 'net_income' },
  ],
  'trial-balance': [{ title: 'Trial Balance total', preset: 'all' }],
};

/**
 * The strip of "Why did this change?" buttons under a Balance Sheet / Profit & Loss / Trial
 * Balance (rendered by app/reports/_components/StdReportView). Uses the report's own dates.
 * Hidden for cash-basis runs and class-filtered runs, whose totals the ledger view can't explain.
 */
export function ReportWhyChanged({
  reportKey,
  params,
  basis,
}: {
  reportKey: string;
  params: Record<string, string | undefined>;
  basis?: 'accrual' | 'cash';
}) {
  const lines = REPORT_LINES[reportKey];
  if (!lines || basis === 'cash' || params.basis === 'cash' || params.classId) return null;
  const today = new Date().toISOString().slice(0, 10);
  const isRange = reportKey === 'profit-loss';
  const from = isRange ? params.from || null : null;
  const to = isRange ? params.to || today : params.asOf || params.to || today;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-white/70 px-4 py-2 print-hidden">
      <span className="text-sm text-navy/70">Why did a total change?</span>
      {lines.map((l) => (
        <WhyChanged
          key={l.preset}
          title={l.title}
          label={l.title}
          query={{ preset: l.preset, from, to, fiscalYearToDate: isRange && !from }}
          storageKey={`report:${reportKey}:${l.preset}`}
        />
      ))}
    </div>
  );
}
