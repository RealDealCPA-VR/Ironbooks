'use client';
/**
 * Account register — QB-style "Use Register" grid for a single account.
 *
 * Columns: date / number / payee-description / account (the other side, or
 * "-split-") / memo / payment-deposit (labels adapt to the account class, with
 * the debit / credit side under each) / running balance. Oldest first, newest at
 * the bottom (auto-scrolled into view), with date-range + search filters.
 *
 * The blank row at the bottom (RegisterEntryRow) takes a new transaction without
 * leaving the register: it is saved as a check, deposit, transfer, card charge /
 * credit or journal entry (lib/registerEntryPlan.ts).
 *
 * QuickZoom: clicking a row opens its source document page when the entry has a
 * mapped sourceRef (invoice:/bill:/deposit:/…), otherwise it opens the
 * journal-entry detail modal. A "New Transaction" menu shortcuts to the check,
 * deposit, transfer and journal-entry forms.
 *
 * Keyboard (QB): Up / Down / PgUp / PgDn / Home / End move through the transactions, Enter
 * opens one (QuickZoom), typing a payee jumps to it, Ctrl+Y / Ctrl+H show its Transaction
 * Journal / History (useListKeys + components/KeyboardCommands.tsx).
 */
import { SUBTYPE_LABELS } from '@/lib/accountTypes';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, BookOpen, ChevronDown, Plus, Search } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Spinner,
  Th,
  Td,
  toast,
  useListKeys,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import EntryDetailModal, { sourceRefLink } from '@/components/EntryDetailModal';
import { RegisterEntryRow } from '@/components/RegisterEntryRow';
import WhyChanged from '@/components/WhyChanged';
import { registerBody, showEntryRow } from './registerView';

// ---------------------------------------------------------------------------
// Types (mirror GET /api/registers/[accountId])
// ---------------------------------------------------------------------------

interface RegisterAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  balance: string;
  isActive: boolean;
  currency?: string | null;
}

interface RegisterRow {
  lineId: string;
  journalEntryId: string;
  date: string;
  entryNumber: number;
  reference: string | null;
  description: string;
  memo: string | null;
  sourceRef: string | null;
  debit: string | null;
  credit: string | null;
  runningBalance: string;
  /** The other account on the entry, or "-split-" (id null) for several. */
  otherAccount?: { id: string | null; label: string } | null;
  /** p1 fx: account-currency columns (foreign-currency bank / card accounts only). */
  foreignDebit?: string | null;
  foreignCredit?: string | null;
  foreignRunningBalance?: string;
  exchangeRate?: string | null;
  homeOnly?: boolean;
}

interface RegisterResult {
  account: RegisterAccount;
  openingBalance: string;
  closingBalance: string;
  /** p1 fx: the account's currency (null = home) and balances in it. */
  currency?: string | null;
  homeCurrency?: string | null;
  foreignOpeningBalance?: string | null;
  foreignClosingBalance?: string | null;
  totalRows: number;
  offset: number;
  rows: RegisterRow[];
}

// ---------------------------------------------------------------------------
// Per-account-class column config (QB register conventions)
// ---------------------------------------------------------------------------

type AmountKey = 'increase' | 'decrease';

interface ColumnConfig {
  /** Order + labels of the two amount columns, matching QB per account class. */
  columns: { key: AmountKey; label: string }[];
}

function columnConfig(subtype: string): ColumnConfig {
  switch (subtype) {
    case 'checking':
    case 'savings':
      return {
        columns: [
          { key: 'decrease', label: 'Payment' },
          { key: 'increase', label: 'Deposit' },
        ],
      };
    case 'credit_card':
      return {
        columns: [
          { key: 'increase', label: 'Charge' },
          { key: 'decrease', label: 'Payment' },
        ],
      };
    case 'accounts_receivable':
      return {
        columns: [
          { key: 'increase', label: 'Charge' },
          { key: 'decrease', label: 'Payment' },
        ],
      };
    case 'accounts_payable':
      return {
        columns: [
          { key: 'increase', label: 'Billed' },
          { key: 'decrease', label: 'Paid' },
        ],
      };
    case 'undeposited_funds':
      return {
        columns: [
          { key: 'decrease', label: 'Deposited' },
          { key: 'increase', label: 'Received' },
        ],
      };
    default:
      return {
        columns: [
          { key: 'decrease', label: 'Decrease' },
          { key: 'increase', label: 'Increase' },
        ],
      };
  }
}

/** Map a row's debit/credit to increase/decrease per the account's normal side. */
function amountFor(row: RegisterRow, accountType: string, key: AmountKey, foreign = false): string | null {
  const debitNormal = accountType === 'asset' || accountType === 'expense';
  const dr = foreign ? (row.foreignDebit ?? null) : row.debit;
  const cr = foreign ? (row.foreignCredit ?? null) : row.credit;
  const increase = debitNormal ? dr : cr;
  const decrease = debitNormal ? cr : dr;
  return key === 'increase' ? increase : decrease;
}

/** "Debit" / "Credit": the side of this account an amount column posts to. */
function sideLabel(accountType: string, key: AmountKey): string {
  const debitNormal = accountType === 'asset' || accountType === 'expense';
  return (key === 'increase') === debitNormal ? 'Debit' : 'Credit';
}

function subtypeLabel(subtype: string): string {
  return SUBTYPE_LABELS[subtype as keyof typeof SUBTYPE_LABELS] ?? subtype;
}

// ---------------------------------------------------------------------------
// "New Transaction" shortcut menu
// ---------------------------------------------------------------------------

const NEW_TRANSACTION_LINKS = [
  { href: '/expenses', label: 'Write Check' },
  { href: '/deposits', label: 'Make Deposit' },
  { href: '/transfers', label: 'Transfer Funds' },
  { href: '/journal', label: 'Journal Entry' },
];

function NewTransactionMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen((v) => !v)}>
        <Plus className="h-4 w-4" /> New Transaction <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl bg-white shadow-xl border border-slate-100 py-1.5 z-20">
          {NEW_TRANSACTION_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-navy hover:bg-electric/5 hover:text-electric transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register page
// ---------------------------------------------------------------------------

function RegisterPageInner() {
  const { accountId } = useParams<{ accountId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');
  const [search, setSearch] = useState('');

  const [result, setResult] = useState<RegisterResult | null>(null);
  /** The 'from' the current result was loaded with (drives the opening-balance row). */
  const [resultFrom, setResultFrom] = useState('');
  /** The 'to' and search the current result was loaded with (the entry row and its reload). */
  const [resultTo, setResultTo] = useState('');
  const [resultSearch, setResultSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const listKeys = useListKeys({ ref: scrollRef });

  const load = useCallback(
    async (fromDate: string, toDate: string, q: string) => {
      if (!accountId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (fromDate) params.set('from', fromDate);
        if (toDate) params.set('to', toDate);
        if (q.trim()) params.set('search', q.trim());
        const qs = params.toString();
        const data = await api.get<{ register: RegisterResult }>(
          `/api/registers/${accountId}${qs ? `?${qs}` : ''}`,
        );
        setResult(data.register);
        setResultFrom(fromDate);
        setResultTo(toDate);
        setResultSearch(q);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load register.', 'danger');
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );

  // Initial load (honors ?from=&to= QuickZoom links from reports).
  useEffect(() => {
    load(from, to, search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Newest at bottom: keep the register scrolled to the latest transaction.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [result]);

  const handleRowClick = (row: RegisterRow) => {
    const source = sourceRefLink(row.sourceRef);
    if (source) {
      router.push(source.href);
    } else {
      setDetailId(row.journalEntryId);
    }
  };

  const account = result?.account ?? null;
  const config = columnConfig(account?.subtype ?? '');
  // p1 fx: a foreign-currency bank / card register is shown in the account's currency.
  const fxCur = result?.currency ?? null;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title={account ? `Register: ${account.name}` : 'Account Register'}
        icon={BookOpen}
        action={<NewTransactionMenu />}
      />

      {/* Account summary line */}
      <div className="flex items-center gap-3 mb-4 text-sm">
        <Link
          href="/registers"
          className="inline-flex items-center gap-1 text-electric font-medium hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All registers
        </Link>
        {account && (
          <>
            <span className="text-navy/30">|</span>
            <span className="text-navy/70 font-medium">
              {account.code} — {account.name}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-electric/10 text-electric text-xs">
              {subtypeLabel(account.subtype)}
            </span>
            <span className="ml-auto text-navy/70">
              Current balance:{' '}
              <span
                className={`font-bold tabular-nums ${
                  Number(account.balance) < 0 ? 'text-red-600' : 'text-navy'
                }`}
              >
                {formatCurrency(account.balance)}
              </span>{' '}
              <WhyChanged
                title={`the ${account.name} balance`}
                label="Why did it change?"
                query={{ accounts: [account.id] }}
                storageKey={`account:${account.id}`}
              />
            </span>
          </>
        )}
      </div>

      {/* Filters */}
      <Card className="p-5 mb-6 flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[150px]">
          <Label htmlFor="reg-from">From</Label>
          <Input id="reg-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[150px]">
          <Label htmlFor="reg-to">To</Label>
          <Input id="reg-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex-[2] min-w-[220px]">
          <Label htmlFor="reg-search">Search</Label>
          <div className="relative">
            <Search className="h-4 w-4 text-navy/30 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              id="reg-search"
              className="pl-9"
              placeholder="Payee, description, ref, memo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') load(from, to, search);
              }}
            />
          </div>
        </div>
        <Button onClick={() => load(from, to, search)} loading={loading}>
          Apply
        </Button>
      </Card>

      {/* Register grid */}
      <Card className="p-0 overflow-hidden">
        {registerBody(loading, !!result) === 'spinner' && (
          <div className="py-16 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        )}

        {registerBody(loading, !!result) === 'unavailable' && (
          <div className="py-16 text-center text-navy/40">
            Could not load this register.{' '}
            <Link href="/registers" className="text-electric font-medium hover:underline">
              Choose another account
            </Link>
          </div>
        )}

        {result && (
          <>
            <div {...listKeys} className="max-h-[60vh] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-white z-10">
                  <tr>
                    <Th>Date</Th>
                    <Th>Number</Th>
                    <Th>Payee / Description</Th>
                    <Th>Account</Th>
                    <Th>Memo</Th>
                    {config.columns.map((col) => (
                      <Th key={col.key} numeric>
                        {col.label}
                        {fxCur ? ` (${fxCur})` : ''}
                        <span className="block text-[10px] font-normal normal-case tracking-normal text-navy/40">
                          {sideLabel(result.account.type, col.key)}
                        </span>
                      </Th>
                    ))}
                    <Th numeric>Balance{fxCur ? ` (${fxCur})` : ''}</Th>
                    {fxCur && <Th numeric>Balance ({result.homeCurrency ?? 'home'})</Th>}
                  </tr>
                </thead>
                <tbody>
                  {resultFrom && (
                    <tr className="bg-slate-50">
                      <Td className="whitespace-nowrap text-navy/60">{formatDate(resultFrom)}</Td>
                      <Td />
                      <Td className="italic text-navy/60">Opening Balance</Td>
                      <Td />
                      <Td />
                      <Td />
                      <Td />
                      <Td
                        numeric
                        className={`font-semibold ${
                          Number(fxCur ? result.foreignOpeningBalance : result.openingBalance) < 0 ? 'text-red-600' : 'text-navy'
                        }`}
                      >
                        {fxCur ? formatCurrency(result.foreignOpeningBalance ?? '0', fxCur) : formatCurrency(result.openingBalance)}
                      </Td>
                      {fxCur && <Td numeric className="text-navy/60">{formatCurrency(result.openingBalance)}</Td>}
                    </tr>
                  )}

                  {result.rows.length === 0 && (
                    <tr>
                      <Td colSpan={fxCur ? 9 : 8} className="py-12 text-center text-navy/40">
                        No transactions in this register for the selected filters.
                      </Td>
                    </tr>
                  )}

                  {result.rows.map((row) => {
                    const source = sourceRefLink(row.sourceRef);
                    return (
                      <tr
                        key={row.lineId}
                        onClick={() => handleRowClick(row)}
                        className="hover:bg-electric/5 cursor-pointer"
                        title={source ? `Open ${source.label}` : 'View journal entry'}
                        data-journal-entry={row.journalEntryId}
                        data-list-label={row.description}
                      >
                        <Td className="whitespace-nowrap">{formatDate(row.date)}</Td>
                        <Td className="text-navy/60 text-xs font-mono whitespace-nowrap">
                          {row.reference ?? `#${row.entryNumber}`}
                        </Td>
                        <Td className="max-w-xs">
                          <span className="block truncate" title={row.description}>
                            {row.description}
                          </span>
                          {source && (
                            <span className="text-[10px] uppercase tracking-wide text-electric/80 font-semibold">
                              {source.label}
                            </span>
                          )}
                        </Td>
                        <Td className="text-navy/70 text-xs max-w-[200px] truncate" title={row.otherAccount?.label ?? ''}>
                          {row.otherAccount?.label ?? ''}
                        </Td>
                        {/* A line memo that only repeats the description (checks write "Check — payee") adds nothing. */}
                        <Td className="text-navy/50 text-xs max-w-[180px] truncate" title={row.memo ?? ''}>
                          {row.memo && row.memo !== row.description ? row.memo : ''}
                        </Td>
                        {config.columns.map((col) => {
                          const amount = amountFor(row, result.account.type, col.key, !!fxCur);
                          return (
                            <Td key={col.key} numeric>
                              {amount ? formatCurrency(amount, fxCur ?? undefined) : ''}
                              {fxCur && row.homeOnly && col.key === 'increase' && (
                                <span className="block text-[10px] text-navy/40">Home currency adjustment</span>
                              )}
                            </Td>
                          );
                        })}
                        <Td
                          numeric
                          className={`font-semibold ${
                            Number(fxCur ? row.foreignRunningBalance : row.runningBalance) < 0 ? 'text-red-600' : 'text-navy'
                          }`}
                        >
                          {fxCur ? formatCurrency(row.foreignRunningBalance ?? '0', fxCur) : formatCurrency(row.runningBalance)}
                        </Td>
                        {fxCur && (
                          <Td numeric className="text-navy/60" title={row.exchangeRate ? `Rate ${Number(row.exchangeRate)}` : undefined}>
                            {formatCurrency(row.runningBalance)}
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                  {showEntryRow(resultSearch) && (
                    <RegisterEntryRow
                      register={result.account}
                      columns={config.columns}
                      colSpanAfter={fxCur ? 2 : 1}
                      onSaved={() => load(resultFrom, resultTo, resultSearch)}
                    />
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer: ending balance for the selected range */}
            <div className="flex items-center justify-between px-4 py-3 border-t-2 border-navy/20 bg-slate-50">
              <span className="text-xs text-navy/50">
                {result.totalRows} transaction{result.totalRows === 1 ? '' : 's'}
                {resultSearch.trim() ? ' (filtered)' : ''}
              </span>
              <span className="font-bold text-navy">
                Ending Balance:{' '}
                <span
                  className={`tabular-nums text-lg ${
                    Number(result.closingBalance) < 0 ? 'text-red-600' : 'text-emerald'
                  }`}
                >
                  {fxCur ? formatCurrency(result.foreignClosingBalance ?? '0', fxCur) : formatCurrency(result.closingBalance)}
                </span>
                {fxCur && (
                  <span className="ml-3 text-sm font-semibold text-navy/60">
                    ({formatCurrency(result.closingBalance)} {result.homeCurrency ?? ''})
                  </span>
                )}
              </span>
            </div>
          </>
        )}
      </Card>

      <EntryDetailModal entryId={detailId} onClose={() => setDetailId(null)} />
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-offwhite p-8 font-sans">
          <div className="py-16 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        </main>
      }
    >
      <RegisterPageInner />
    </Suspense>
  );
}
