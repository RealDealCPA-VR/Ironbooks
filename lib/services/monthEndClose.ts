/**
 * Guided month-end close (QB Accountant: Client Data Review + Set Closing Date, as one wizard).
 *
 * For a chosen period end the checklist is COMPUTED LIVE from the books every time it is read:
 *
 *   reconcile      every bank / credit card account reconciled through the period end
 *   bank_feed      downloaded bank transactions still waiting to be categorized or matched
 *   uncategorized  uncategorized income / expense and suspense accounts that still hold a balance
 *   undeposited    payments sitting in Undeposited Funds, aged at the period end
 *   receivables    A/R aging total ties to the A/R control account(s)
 *   payables       A/P aging total ties to the A/P control account(s)
 *   payroll        payroll liabilities still owed at the period end
 *   error_scan     the error scan (AI Review rules) + Verify Data results
 *   open_items     open purchase orders and unbilled time / costs (optional, information only)
 *
 * Each step is 'done', 'attention' (needs attention) or 'skipped' (with a reason: automatic, e.g.
 * "payroll is turned off", or chosen by a person). People can mark a step reviewed (with a note)
 * or skip it with a reason; that progress persists per company + period end (month_end_closes,
 * drizzle/0051_monthend.sql), versioned for record locking and audited.
 *
 * The last step sets the company closing date to the period end through the existing closing-date
 * service (setClosingDate: permission 'closing: modify', optional closing-date password) once every
 * required step is done, skipped or reviewed. `buildMonthEndReportPack` then renders the PDF pack
 * (P&L, Balance Sheet, Trial Balance, A/R + A/P aging summaries, reconciliation summaries) from the
 * standard report services with pdf-lib.
 *
 * Nothing here posts to the ledger and nothing calls an AI provider: the error scan is the
 * rules-based detector behind AI Review, so the whole wizard works with AI switched off.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import {
  accounts,
  auditLogs,
  bankAccounts,
  bankTransactions,
  billLines,
  bills,
  expenseLines,
  expenses,
  journalEntries,
  journalEntryLines,
  monthEndCloses,
  paychecks,
  purchaseOrders,
  reconciliations,
  timeEntries,
  users,
  type MonthEndStepState,
} from '@/lib/db/schema';
import { Money, type MoneyInput, toAmountString } from '@/lib/money';
import { reportToTable, type StdReport } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import { buildReportPdf, type PdfCell } from '@/lib/export/reportPdf';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertWrite } from './rbac';
import { requireEffectivePermission } from './access';
import { getClosingDateSettings, getCompany, getPreferences, setClosingDate } from './company';
import { listUndepositedPayments } from './deposits';
import { agingSummary, daysBetween } from './reportsAging';
import { payrollLiabilityBalances } from './payrollReports';
import { verifyIntegrity } from './integrity';
import { detectErrors, listErrors } from './errorDetection';
import { listUnbilled } from './billables';
import { balanceSheetReport, profitAndLossReport, trialBalanceReport } from './reportsStandard';
import { getReconciliationReport } from './reconcile';

// ---------------------------------------------------------------------------
// Step catalogue
// ---------------------------------------------------------------------------

export const MONTH_END_STEPS = [
  {
    key: 'reconcile',
    title: 'Reconcile bank and credit card accounts',
    why: 'Compare each account with its statement so the balance in your books matches the bank.',
    optional: false,
  },
  {
    key: 'bank_feed',
    title: 'Review downloaded bank transactions',
    why: 'Transactions downloaded from the bank are not in your books until you add or match them.',
    optional: false,
  },
  {
    key: 'uncategorized',
    title: 'Clear uncategorized and suspense accounts',
    why: 'Money parked in "Uncategorized" or suspense accounts makes your reports wrong. Move it to the right account.',
    optional: false,
  },
  {
    key: 'undeposited',
    title: 'Deposit payments waiting in Undeposited Funds',
    why: 'Payments you received but have not recorded as a bank deposit. Old ones are often duplicates or forgotten deposits.',
    optional: false,
  },
  {
    key: 'receivables',
    title: 'Review money customers owe you',
    why: 'Check the customer balances (A/R aging) and that they add up to the Accounts Receivable account.',
    optional: false,
  },
  {
    key: 'payables',
    title: 'Review bills you owe',
    why: 'Check the unpaid bills (A/P aging) and that they add up to the Accounts Payable account.',
    optional: false,
  },
  {
    key: 'payroll',
    title: 'Pay payroll taxes that are due',
    why: 'Withheld taxes and deductions you still owe to tax agencies and benefit providers.',
    optional: false,
  },
  {
    key: 'error_scan',
    title: 'Check the books for errors',
    why: 'Runs the error scan (duplicates, unbalanced or odd entries) and Verify Data on your company file.',
    optional: false,
  },
  {
    key: 'open_items',
    title: 'Look over open purchase orders and unbilled time',
    why: 'For your information: orders not yet received or billed, and time or costs not yet billed to customers.',
    optional: true,
  },
] as const;

export type MonthEndStepKey = (typeof MONTH_END_STEPS)[number]['key'];
export const MONTH_END_STEP_KEYS: MonthEndStepKey[] = MONTH_END_STEPS.map((s) => s.key);

export type StepStatus = 'done' | 'attention' | 'skipped';

/** One line inside a step (an account, an item, a check result …). */
export interface StepRow {
  label: string;
  detail?: string;
  amount?: string;
  status?: StepStatus;
  href?: string;
  hrefLabel?: string;
}

export interface StepFigure {
  label: string;
  value: string;
  /** 'money' values are 2dp strings; 'text' is shown as is. */
  kind: 'money' | 'text';
}

export interface MonthEndStep {
  key: MonthEndStepKey;
  title: string;
  why: string;
  optional: boolean;
  /** What the books say (before anyone reviewed or skipped it). */
  computedStatus: StepStatus;
  /** What the checklist shows: a person's skip wins over the computed status. */
  status: StepStatus;
  /** One-line plain-language result. */
  summary: string;
  /** Why the step is skipped (automatic or typed by the person who skipped it). */
  statusReason: string | null;
  skippedByUser: boolean;
  rows: StepRow[];
  figures: StepFigure[];
  /** Where to go to fix it. */
  action: { href: string; label: string } | null;
  reviewed: boolean;
  reviewedByName: string | null;
  reviewedAt: string | null;
  note: string | null;
  /** Done, skipped, reviewed, or optional — nothing stops the close. */
  resolved: boolean;
}

export interface MonthEndChecklist {
  periodEnd: string;
  periodStart: string;
  /** 'closed' once the closing date was set to (or past) this period end through the wizard. */
  status: 'open' | 'closed';
  closedAt: string | null;
  closedByName: string | null;
  /** Record-locking version of the saved progress (null = nothing saved yet). */
  version: string | null;
  closingDate: string | null;
  hasClosingPassword: boolean;
  /** Whether the signed-in user may set the closing date (Closing Date / Periods: modify). */
  canClose: boolean;
  scanRanAt: string | null;
  steps: MonthEndStep[];
  progress: { resolved: number; total: number };
  /** Required steps that still need attention and were not reviewed or skipped. */
  outstanding: MonthEndStepKey[];
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a 'YYYY-MM-DD' period end (a real calendar date). */
export function parsePeriodEnd(periodEnd: unknown): string {
  if (typeof periodEnd !== 'string' || !DAY_RE.test(periodEnd)) {
    throw validation('Choose the period end as a date (YYYY-MM-DD).');
  }
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== periodEnd) {
    throw validation(`${periodEnd} is not a real date.`);
  }
  return periodEnd;
}

/** First day of the period end's month — the period the report pack covers. */
export function periodStartFor(periodEnd: string): string {
  return `${periodEnd.slice(0, 7)}-01`;
}

const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`);
const startOfDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Sep 30, 2026' — plain, locale-independent. */
export function prettyDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;
}

/** 1234.5 → '1,234.50' (negative keeps its minus sign). Money only — never floats. */
export function fmtMoney(v: MoneyInput): string {
  const s = toAmountString(v ?? 0);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Posted ledger activity per account through `asOf`: debit − credit and line count. */
async function ledgerAsOf(ctx: ServiceContext, asOf: Date) {
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      lines: sql<number>`COUNT(*)::int`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.date, asOf),
      ),
    )
    .groupBy(journalEntryLines.accountId);
  return new Map(rows.map((r) => [r.accountId, { net: Money.sub(r.debit, r.credit), lines: Number(r.lines) }]));
}

type AccountRow = { id: string; code: string; name: string; type: string; subtype: string; isActive: boolean };
type Ledger = Awaited<ReturnType<typeof ledgerAsOf>>;

/** Natural-side balance (positive = normal) of an account from the ledger map. */
function naturalBalance(a: Pick<AccountRow, 'id' | 'type'>, ledger: Ledger) {
  const net = ledger.get(a.id)?.net ?? Money.zero();
  return a.type === 'asset' || a.type === 'expense' ? net : net.negated();
}

const UNCATEGORIZED_RE = /uncategori[sz]ed|suspense|ask my accountant/i;

/** Uncategorized income / expense, suspense and "Ask My Accountant" accounts. */
export function isUncategorizedAccount(a: Pick<AccountRow, 'code' | 'name'>): boolean {
  return UNCATEGORIZED_RE.test(a.name) || /suspense/i.test(a.code);
}

// ---------------------------------------------------------------------------
// Step computations
// ---------------------------------------------------------------------------

interface Computed {
  status: StepStatus;
  summary: string;
  reason?: string;
  rows: StepRow[];
  figures?: StepFigure[];
  action?: { href: string; label: string } | null;
}

interface StepInput {
  ctx: ServiceContext;
  periodEnd: string;
  asOf: Date;
  accounts: AccountRow[];
  ledger: Ledger;
  scanRanAt: Date | null;
}

const RECONCILABLE_SUBTYPES = new Set(['checking', 'savings', 'credit_card']);

async function stepReconcile({ ctx, periodEnd, asOf, accounts: accts, ledger }: StepInput): Promise<Computed> {
  const banks = await ctx.db
    .select({
      id: bankAccounts.id,
      accountId: bankAccounts.accountId,
      bankName: bankAccounts.bankName,
      lastReconciledDate: bankAccounts.lastReconciledDate,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.companyId, ctx.companyId));
  const open = banks.length
    ? await ctx.db
        .select({ bankAccountId: reconciliations.bankAccountId })
        .from(reconciliations)
        .where(and(inArray(reconciliations.bankAccountId, banks.map((b) => b.id)), eq(reconciliations.status, 'in_progress')))
    : [];
  const inProgress = new Set(open.map((r) => r.bankAccountId));
  const byId = new Map(accts.map((a) => [a.id, a]));
  const rows: StepRow[] = [];
  let done = 0;
  let considered = 0;

  for (const b of banks) {
    const gl = byId.get(b.accountId);
    if (!gl) continue;
    const name = `${gl.code} · ${gl.name}`;
    const kind = gl.subtype === 'credit_card' || gl.type === 'liability' ? 'credit card' : 'bank account';
    const last = dayOf(b.lastReconciledDate);
    const activity = (ledger.get(gl.id)?.lines ?? 0) > 0;
    const href = `/reconcile?bankAccountId=${b.id}&statementDate=${periodEnd}`;
    if (last && last >= periodEnd) {
      considered++;
      done++;
      rows.push({ label: name, detail: `Reconciled through ${prettyDay(last)}.`, status: 'done' });
    } else if (!activity && !last) {
      rows.push({ label: name, detail: `No activity on this ${kind} yet, nothing to reconcile.`, status: 'skipped' });
    } else if (!gl.isActive && naturalBalance(gl, ledger).isZero()) {
      rows.push({ label: name, detail: 'Inactive account with no balance, nothing to reconcile.', status: 'skipped' });
    } else {
      considered++;
      const where = last ? `Last reconciled through ${prettyDay(last)}.` : 'Never reconciled.';
      const extra = inProgress.has(b.id) ? ' A reconciliation is in progress — finish it.' : '';
      rows.push({
        label: name,
        detail: `${where}${extra} Reconcile it with the statement ending ${prettyDay(periodEnd)}.`,
        status: 'attention',
        href,
        hrefLabel: inProgress.has(b.id) ? 'Finish reconciling' : 'Reconcile',
      });
    }
  }

  // Bank / card accounts in the chart of accounts that were never set up for reconciling.
  const linked = new Set(banks.map((b) => b.accountId));
  for (const a of accts) {
    if (linked.has(a.id) || !RECONCILABLE_SUBTYPES.has(a.subtype)) continue;
    if ((ledger.get(a.id)?.lines ?? 0) === 0) continue;
    considered++;
    rows.push({
      label: `${a.code} · ${a.name}`,
      detail: 'Has transactions but is not set up for reconciling yet. Add it under Bank accounts, then reconcile it.',
      status: 'attention',
      href: '/banking',
      hrefLabel: 'Set up account',
    });
  }

  if (rows.length === 0) {
    return { status: 'skipped', reason: 'You have no bank or credit card accounts to reconcile.', summary: 'No bank or credit card accounts.', rows };
  }
  if (considered === 0) {
    return { status: 'skipped', reason: 'None of your bank or credit card accounts has any activity yet.', summary: 'No activity to reconcile.', rows };
  }
  const attention = rows.filter((r) => r.status === 'attention').length;
  return {
    status: attention ? 'attention' : 'done',
    summary: attention
      ? `${done} of ${plural(considered, 'account')} reconciled through ${prettyDay(periodEnd)}; ${attention} still to do.`
      : `All ${plural(considered, 'account')} reconciled through ${prettyDay(periodEnd)}.`,
    rows,
    action: { href: '/reconcile', label: 'Open Reconcile' },
  };
}

async function stepBankFeed({ ctx, periodEnd, asOf }: StepInput): Promise<Computed> {
  const [any] = await ctx.db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(bankTransactions)
    .where(eq(bankTransactions.companyId, ctx.companyId));
  if (!any || Number(any.n) === 0) {
    return { status: 'skipped', reason: 'You have not downloaded or imported any bank transactions.', summary: 'No bank feed in use.', rows: [] };
  }
  const pending = await ctx.db
    .select({
      bankAccountId: bankTransactions.bankAccountId,
      bankName: bankAccounts.bankName,
      code: accounts.code,
      name: accounts.name,
      n: sql<number>`COUNT(*)::int`,
      total: sql<string>`COALESCE(SUM(ABS(${bankTransactions.amount})), 0)`,
      oldest: sql<string>`MIN(${bankTransactions.date})`,
    })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankTransactions.bankAccountId, bankAccounts.id))
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.matched, false),
        eq(bankTransactions.excluded, false),
        lte(bankTransactions.date, asOf),
      ),
    )
    .groupBy(bankTransactions.bankAccountId, bankAccounts.bankName, accounts.code, accounts.name);
  const count = pending.reduce((s, p) => s + Number(p.n), 0);
  if (count === 0) {
    return { status: 'done', summary: `Every downloaded transaction through ${prettyDay(periodEnd)} is added, matched or excluded.`, rows: [] };
  }
  return {
    status: 'attention',
    summary: `${plural(count, 'downloaded transaction')} through ${prettyDay(periodEnd)} still to add or match.`,
    rows: pending.map((p) => ({
      label: `${p.code} · ${p.name}`,
      detail: `${plural(Number(p.n), 'transaction')} waiting, oldest from ${prettyDay(new Date(p.oldest).toISOString().slice(0, 10))}.`,
      amount: toAmountString(p.total),
      status: 'attention' as const,
      href: '/bank-review',
      hrefLabel: 'Review',
    })),
    figures: [{ label: 'Transactions waiting', value: String(count), kind: 'text' }],
    action: { href: '/bank-review', label: 'Review bank transactions' },
  };
}

async function stepUncategorized({ periodEnd, accounts: accts, ledger }: StepInput): Promise<Computed> {
  const candidates = accts.filter(isUncategorizedAccount);
  const rows: StepRow[] = [];
  for (const a of candidates) {
    const bal = naturalBalance(a, ledger);
    if (bal.isZero()) continue;
    rows.push({
      label: `${a.code} · ${a.name}`,
      detail: `Balance on ${prettyDay(periodEnd)}. Reclassify these transactions to the right account.`,
      amount: toAmountString(bal),
      status: 'attention',
      href: `/registers/${a.id}`,
      hrefLabel: 'Open register',
    });
  }
  if (!rows.length) {
    return {
      status: 'done',
      summary: candidates.length
        ? 'Uncategorized and suspense accounts are empty.'
        : 'You have no uncategorized or suspense accounts.',
      rows: [],
    };
  }
  return {
    status: 'attention',
    summary: `${plural(rows.length, 'account')} still ${rows.length === 1 ? 'holds' : 'hold'} uncategorized money.`,
    rows,
    action: { href: '/accountant', label: 'Reclassify transactions' },
  };
}

const UF_BUCKETS = [
  { label: '0 - 7 days', min: Number.NEGATIVE_INFINITY, max: 7 },
  { label: '8 - 30 days', min: 8, max: 30 },
  { label: 'Over 30 days', min: 31, max: Number.POSITIVE_INFINITY },
];

async function stepUndeposited({ ctx, periodEnd, asOf, accounts: accts, ledger }: StepInput): Promise<Computed> {
  let items: Awaited<ReturnType<typeof listUndepositedPayments>>;
  try {
    items = await listUndepositedPayments(ctx);
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NOT_FOUND') {
      return { status: 'skipped', reason: 'This company has no Undeposited Funds account.', summary: 'No Undeposited Funds account.', rows: [] };
    }
    throw err;
  }
  const inPeriod = items.filter((i) => i.date.getTime() <= asOf.getTime());
  const totals = UF_BUCKETS.map(() => Money.zero());
  const rows: StepRow[] = [];
  let stale = 0;
  for (const i of inPeriod) {
    const age = daysBetween(i.date, periodEnd);
    const b = UF_BUCKETS.findIndex((k) => age >= k.min && age <= k.max);
    totals[b] = totals[b].plus(Money.of(i.amount));
    if (age > 7) stale++;
    rows.push({
      label: `${i.customerName ?? 'Walk-in customer'}: ${i.kind === 'payment' ? 'payment' : 'sales receipt'} of ${prettyDay(dayOf(i.date)!)}`,
      detail: `${plural(age, 'day')} old on ${prettyDay(periodEnd)}${i.currency ? ` (${i.currency})` : ''}.`,
      amount: toAmountString(i.amount),
      status: age > 7 ? 'attention' : 'done',
    });
  }
  const uf = accts.find((a) => a.subtype === 'undeposited_funds' || a.code === '1050');
  const figures: StepFigure[] = UF_BUCKETS.map((k, idx) => ({ label: k.label, value: toAmountString(totals[idx]), kind: 'money' as const }));
  if (uf) figures.push({ label: `Undeposited Funds balance on ${prettyDay(periodEnd)}`, value: toAmountString(naturalBalance(uf, ledger)), kind: 'money' });
  const total = totals.reduce((s, t) => s.plus(t), Money.zero());
  if (!inPeriod.length) {
    return { status: 'done', summary: 'Nothing is waiting in Undeposited Funds.', rows, figures };
  }
  return {
    status: stale ? 'attention' : 'done',
    summary: stale
      ? `${plural(stale, 'payment')} older than a week ${stale === 1 ? 'is' : 'are'} still waiting to be deposited (${fmtMoney(total)} in total).`
      : `${plural(inPeriod.length, 'recent payment')} (${fmtMoney(total)}) waiting — deposit ${inPeriod.length === 1 ? 'it' : 'them'} when ${inPeriod.length === 1 ? 'it reaches' : 'they reach'} the bank.`,
    rows: rows.slice(0, 50),
    figures,
    action: { href: '/deposits', label: 'Make deposits' },
  };
}

async function stepAging(side: 'ar' | 'ap', { ctx, periodEnd, accounts: accts, ledger }: StepInput): Promise<Computed> {
  const report = await agingSummary(ctx, { asOf: periodEnd } as ReportParams, side);
  const grand = report.rows.find((r) => r.id === 'ag:grand');
  const agingTotal = Money.of((grand?.cells.total as string | null) ?? 0);
  const subtype = side === 'ar' ? 'accounts_receivable' : 'accounts_payable';
  const control = accts
    .filter((a) => a.subtype === subtype)
    .reduce((s, a) => s.plus(naturalBalance(a, ledger)), Money.zero());
  const who = side === 'ar' ? 'Customers' : 'Vendors';
  const acctName = side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable';
  const moneyCols = report.columns.filter((c) => c.type === 'money');
  const figures: StepFigure[] = moneyCols.map((c) => ({
    label: c.key === 'total' ? 'Aging total' : c.header,
    value: toAmountString((grand?.cells[c.key] as string | null) ?? 0),
    kind: 'money' as const,
  }));
  figures.push({ label: `${acctName} account balance`, value: toAmountString(control), kind: 'money' });
  const overKey = moneyCols.find((c) => c.header.startsWith('>'))?.key;
  const over = overKey ? Money.of((grand?.cells[overKey] as string | null) ?? 0) : Money.zero();
  const rows: StepRow[] = report.rows
    .filter((r) => r.kind === 'data')
    .map((r) => ({ label: String(r.cells.label ?? ''), amount: toAmountString((r.cells.total as string | null) ?? 0), href: r.href ?? undefined, hrefLabel: 'Details' }))
    .sort((a, b) => Money.of(b.amount).abs().comparedTo(Money.of(a.amount).abs()))
    .slice(0, 15);
  const reportHref = `/reports/std/${side === 'ar' ? 'ar-aging-summary' : 'ap-aging-summary'}?asOf=${periodEnd}`;
  if (!agingTotal.equals(control)) {
    const diff = control.minus(agingTotal);
    return {
      status: 'attention',
      summary: `The aging total (${fmtMoney(agingTotal)}) does not match the ${acctName} account (${fmtMoney(control)}); difference ${fmtMoney(diff)}.`,
      rows: [
        {
          label: 'Aging does not tie to the control account',
          detail: `A journal entry or transfer that hits ${acctName} without a ${side === 'ar' ? 'customer' : 'vendor'}, or a transaction dated differently, usually causes this. Run Verify Data and look at the ${acctName} register.`,
          amount: toAmountString(diff),
          status: 'attention',
          href: reportHref,
          hrefLabel: 'Open aging report',
        },
        ...rows,
      ],
      figures,
      action: { href: reportHref, label: 'Open aging report' },
    };
  }
  const summary = agingTotal.isZero()
    ? `${who === 'Customers' ? 'No customer owes you money' : 'You owe no vendor money'} on ${prettyDay(periodEnd)}; ${acctName} is zero.`
    : `${who} ${side === 'ar' ? 'owe you' : 'are owed'} ${fmtMoney(agingTotal)}${over.isZero() ? '' : ` (${fmtMoney(over)} more than 90 days overdue)`}; it matches the ${acctName} account.`;
  return { status: 'done', summary, rows, figures, action: { href: reportHref, label: 'Open aging report' } };
}

async function stepPayroll({ ctx, periodEnd, asOf }: StepInput): Promise<Computed> {
  if (!(await canAccess(ctx, 'payroll', 'view'))) {
    const reason = 'You do not have access to payroll; ask someone who does to review this step.';
    return { status: 'skipped', reason, summary: reason, rows: [] };
  }
  const prefs = await getPreferences(ctx);
  if (prefs.payrollEnabled === false) {
    return { status: 'skipped', reason: 'Payroll is turned off in Preferences.', summary: 'Payroll is turned off.', rows: [] };
  }
  const [pc] = await ctx.db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(paychecks)
    .where(and(eq(paychecks.companyId, ctx.companyId), lte(paychecks.payDate, asOf)));
  if (!pc || Number(pc.n) === 0) {
    return { status: 'skipped', reason: `No payroll was run on or before ${prettyDay(periodEnd)}.`, summary: 'No payroll yet.', rows: [] };
  }
  const bal = await payrollLiabilityBalances(ctx, { asOf });
  const owed = bal.items.filter((i) => Money.gt(i.balance, 0));
  const figures: StepFigure[] = [
    { label: 'Accrued', value: bal.totalAccrued, kind: 'money' },
    { label: 'Paid', value: bal.totalPaid, kind: 'money' },
    { label: 'Still owed', value: bal.balance, kind: 'money' },
  ];
  if (!Money.gt(bal.balance, 0)) {
    return { status: 'done', summary: `No payroll taxes or deductions are owed on ${prettyDay(periodEnd)}.`, rows: [], figures };
  }
  return {
    status: 'attention',
    summary: `${fmtMoney(bal.balance)} in payroll taxes and deductions is still owed on ${prettyDay(periodEnd)}.`,
    rows: owed.map((i) => ({
      label: i.name,
      detail: i.kind === 'tax' ? 'Payroll tax' : i.kind === 'deduction' ? 'Deduction' : 'Employer contribution',
      amount: i.balance,
      status: 'attention' as const,
      href: '/pay-liabilities',
      hrefLabel: 'Pay',
    })),
    figures,
    action: { href: '/pay-liabilities', label: 'Pay payroll taxes' },
  };
}

async function stepErrorScan({ ctx, scanRanAt }: StepInput): Promise<Computed> {
  // Verify Data belongs to File Utilities (/api/integrity); people without it see only the scan.
  const showIntegrity = await canAccess(ctx, 'file_utilities', 'view');
  const integrity = showIntegrity ? await verifyIntegrity(ctx) : { allOk: true, checks: [] as Awaited<ReturnType<typeof verifyIntegrity>>['checks'] };
  const open = await listErrors(ctx, { resolved: false });
  const rows: StepRow[] = integrity.checks.map((c) => ({
    label: `Verify Data: ${c.name}`,
    detail: c.detail,
    status: c.ok ? ('done' as const) : ('attention' as const),
    ...(c.ok ? {} : { href: '/integrity', hrefLabel: 'Open Data Integrity' }),
  }));
  for (const e of open.slice(0, 25)) {
    rows.push({ label: `Possible error (${e.severity})`, detail: e.description, status: 'attention', href: '/errors', hrefLabel: 'Review' });
  }
  const figures: StepFigure[] = [
    ...(showIntegrity
      ? [{ label: 'Verify Data', value: integrity.allOk ? 'No problems found' : `${integrity.checks.filter((c) => !c.ok).length} problem(s)`, kind: 'text' as const }]
      : []),
    { label: 'Open possible errors', value: String(open.length), kind: 'text' },
    { label: 'Error scan last run', value: scanRanAt ? scanRanAt.toISOString() : 'Not run for this period', kind: 'text' },
  ];
  const action = { href: '/errors', label: 'Open AI Review' };
  if (!integrity.allOk) {
    return { status: 'attention', summary: 'Verify Data found problems in the company file.', rows, figures, action };
  }
  if (open.length) {
    return { status: 'attention', summary: `${plural(open.length, 'possible error')} to look at.`, rows, figures, action };
  }
  if (!scanRanAt) {
    const summary = showIntegrity ? 'Verify Data found no problems. Run the error scan for this period.' : 'Run the error scan for this period.';
    return { status: 'attention', summary, rows, figures, action };
  }
  const summary = showIntegrity ? 'The error scan and Verify Data found no problems.' : 'The error scan found no problems.';
  return { status: 'done', summary, rows, figures, action };
}

async function stepOpenItems({ ctx, periodEnd, asOf }: StepInput): Promise<Computed> {
  const prefs = await getPreferences(ctx);
  const poOn = prefs.purchaseOrdersEnabled !== false;
  const timeOn = prefs.timeTrackingEnabled !== false;
  const rows: StepRow[] = [];
  const figures: StepFigure[] = [];

  if (poOn) {
    const [po] = await ctx.db
      .select({ n: sql<number>`COUNT(*)::int`, total: sql<string>`COALESCE(SUM(${purchaseOrders.total}), 0)` })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.companyId, ctx.companyId),
          inArray(purchaseOrders.status, ['open', 'partial']),
          lte(purchaseOrders.date, asOf),
        ),
      );
    const n = Number(po?.n ?? 0);
    figures.push({ label: 'Open purchase orders', value: String(n), kind: 'text' });
    if (n) {
      rows.push({
        label: `${plural(n, 'open purchase order')}`,
        detail: 'Ordered but not yet fully received or billed. Close the ones you no longer expect.',
        amount: toAmountString(po!.total),
        status: 'attention',
        href: '/purchase-orders',
        hrefLabel: 'Open purchase orders',
      });
    }
  }

  // Unbilled time and reimbursable costs through the period end, per customer.
  const custIds = new Set<string>();
  const costCust = await ctx.db
    .selectDistinct({ id: billLines.customerId })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(and(eq(bills.companyId, ctx.companyId), isNotNull(billLines.customerId), isNull(billLines.billedInvoiceId), lte(bills.date, asOf)));
  const expCust = await ctx.db
    .selectDistinct({ id: expenseLines.customerId })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(and(eq(expenses.companyId, ctx.companyId), isNotNull(expenseLines.customerId), isNull(expenseLines.billedInvoiceId), lte(expenses.date, asOf)));
  const timeCust = timeOn
    ? await ctx.db
        .selectDistinct({ id: timeEntries.customerId })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.companyId, ctx.companyId),
            isNotNull(timeEntries.customerId),
            eq(timeEntries.billable, true),
            isNull(timeEntries.invoicedInvoiceId),
            lte(timeEntries.date, asOf),
          ),
        )
    : [];
  for (const r of [...costCust, ...expCust, ...timeCust]) if (r.id) custIds.add(r.id);
  let hours = Money.zero();
  let timeAmount = Money.zero();
  let costAmount = Money.zero();
  let timeCount = 0;
  let costCount = 0;
  for (const id of custIds) {
    const u = await listUnbilled(ctx, id);
    for (const t of u.time) {
      if (!timeOn || t.date.getTime() > asOf.getTime()) continue;
      timeCount++;
      hours = hours.plus(Money.of(t.hours));
      timeAmount = timeAmount.plus(Money.of(t.amount));
    }
    for (const c of u.costs) {
      if (c.date.getTime() > asOf.getTime()) continue;
      costCount++;
      costAmount = costAmount.plus(Money.of(c.amount));
    }
  }
  if (timeOn) figures.push({ label: 'Unbilled hours', value: hours.toFixed(2), kind: 'text' });
  figures.push({ label: 'Unbilled time and costs', value: toAmountString(timeAmount.plus(costAmount)), kind: 'money' });
  if (timeCount) {
    rows.push({
      label: `${plural(timeCount, 'unbilled time entry', 'unbilled time entries')} (${hours.toFixed(2)} hours)`,
      detail: 'Billable time not yet on an invoice.',
      amount: toAmountString(timeAmount),
      status: 'attention',
      href: '/invoices?new=1',
      hrefLabel: 'Invoice for time',
    });
  }
  if (costCount) {
    rows.push({
      label: `${plural(costCount, 'unbilled cost')}`,
      detail: 'Billable expenses not yet charged to the customer.',
      amount: toAmountString(costAmount),
      status: 'attention',
      href: '/invoices?new=1',
      hrefLabel: 'Invoice for costs',
    });
  }
  if (!poOn && !timeOn && !costCount) {
    return { status: 'skipped', reason: 'Purchase orders and time tracking are turned off.', summary: 'Nothing to look at.', rows: [], figures };
  }
  if (!rows.length) {
    return { status: 'done', summary: `No open purchase orders or unbilled time on ${prettyDay(periodEnd)}.`, rows, figures };
  }
  return {
    status: 'attention',
    summary: 'For your information — this does not stop the close.',
    rows,
    figures,
    action: { href: '/income-tracker', label: 'Open Money coming in' },
  };
}

const COMPUTE: Record<MonthEndStepKey, (i: StepInput) => Promise<Computed>> = {
  reconcile: stepReconcile,
  bank_feed: stepBankFeed,
  uncategorized: stepUncategorized,
  undeposited: stepUndeposited,
  receivables: (i) => stepAging('ar', i),
  payables: (i) => stepAging('ap', i),
  payroll: stepPayroll,
  error_scan: stepErrorScan,
  open_items: stepOpenItems,
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type CloseRow = typeof monthEndCloses.$inferSelect;

async function loadRow(ctx: ServiceContext, periodEnd: string): Promise<CloseRow | null> {
  const [row] = await ctx.db
    .select()
    .from(monthEndCloses)
    .where(and(eq(monthEndCloses.companyId, ctx.companyId), eq(monthEndCloses.periodEnd, periodEnd)))
    .limit(1);
  return row ?? null;
}

async function userName(ctx: ServiceContext, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const [u] = await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
  return u?.name ?? null;
}

/** Record locking: refuse a save made against an older version of the saved progress. */
async function assertVersion(ctx: ServiceContext, row: CloseRow | null, version: string | null | undefined) {
  if (version === undefined) return;
  const current = row ? row.updatedAt.toISOString() : null;
  const t = version ? new Date(version) : null;
  if (t && Number.isNaN(t.getTime())) throw validation('This checklist is out of date. Reload and try again.');
  const want = t ? t.toISOString() : null;
  if (current === want) return;
  const by = row ? await lastChangedBy(ctx, row.id) : null;
  throw new ServiceError(
    'CONFLICT',
    `This checklist was changed by ${by ?? 'another user'}${row ? ` at ${row.updatedAt.toISOString()}` : ''}. Reload to see the latest.`,
    {
      staleVersion: true,
      entity: 'month_end_close',
      id: row?.id ?? null,
      currentUpdatedAt: current,
      changedBy: by,
      changedAt: current,
    },
  );
}

async function lastChangedBy(ctx: ServiceContext, rowId: string): Promise<string | null> {
  const [a] = await ctx.db
    .select({ name: users.name })
    .from(auditLogs)
    .innerJoin(users, eq(auditLogs.userId, users.id))
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'month_end_close'), eq(auditLogs.entityId, rowId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return a?.name ?? null;
}

/** Insert or update the saved progress for a period (inside the caller's transaction). */
async function saveRow(
  ctx: ServiceContext,
  periodEnd: string,
  existing: CloseRow | null,
  patch: Partial<Pick<CloseRow, 'steps' | 'scanRanAt' | 'status' | 'closedAt' | 'closedBy'>>,
): Promise<CloseRow> {
  // Bump the version past the previous one even inside the same millisecond.
  const now = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1));
  if (existing) {
    const [row] = await ctx.db
      .update(monthEndCloses)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(monthEndCloses.id, existing.id), eq(monthEndCloses.companyId, ctx.companyId)))
      .returning();
    return row;
  }
  const [row] = await ctx.db
    .insert(monthEndCloses)
    .values({
      companyId: ctx.companyId,
      periodEnd,
      steps: {},
      createdBy: ctx.userId,
      ...patch,
      updatedAt: now,
    })
    .returning();
  return row;
}

/** True when the user has the permission; false (not an error) when they lack it. */
async function canAccess(
  ctx: ServiceContext,
  area: Parameters<typeof requireEffectivePermission>[1],
  level: Parameters<typeof requireEffectivePermission>[2],
): Promise<boolean> {
  try {
    await requireEffectivePermission(ctx, area, level);
    return true;
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'FORBIDDEN') return false;
    throw err;
  }
}

function canSetClosingDate(ctx: ServiceContext): Promise<boolean> {
  return canAccess(ctx, 'closing', 'modify');
}

function effectiveStatus(row: CloseRow | null, closingDate: string | null, periodEnd: string): 'open' | 'closed' {
  return row?.status === 'closed' && !!closingDate && closingDate >= periodEnd ? 'closed' : 'open';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The live checklist for a period end, with the saved review progress. Read-only. */
export async function getMonthEndChecklist(ctx: ServiceContext, periodEndInput: string): Promise<MonthEndChecklist> {
  const periodEnd = parsePeriodEnd(periodEndInput);
  const asOf = endOfDay(periodEnd);
  const [row, closing, accts, ledger] = await Promise.all([
    loadRow(ctx, periodEnd),
    getClosingDateSettings(ctx),
    ctx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype, isActive: accounts.isActive })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId)),
    ledgerAsOf(ctx, asOf),
  ]);
  const input: StepInput = { ctx, periodEnd, asOf, accounts: accts as AccountRow[], ledger, scanRanAt: row?.scanRanAt ?? null };
  const saved = (row?.steps ?? {}) as Record<string, MonthEndStepState>;

  const steps: MonthEndStep[] = [];
  for (const def of MONTH_END_STEPS) {
    const c = await COMPUTE[def.key](input);
    const s = saved[def.key] ?? {};
    const skipReason = s.skipReason?.trim() ? s.skipReason.trim() : null;
    const status: StepStatus = skipReason ? 'skipped' : c.status;
    const reviewed = s.reviewed === true;
    steps.push({
      key: def.key,
      title: def.title,
      why: def.why,
      optional: def.optional,
      computedStatus: c.status,
      status,
      summary: c.summary,
      statusReason: skipReason ?? (c.status === 'skipped' ? c.reason ?? null : null),
      skippedByUser: !!skipReason,
      rows: c.rows,
      figures: c.figures ?? [],
      action: c.action ?? null,
      reviewed,
      reviewedByName: reviewed ? s.reviewedByName ?? null : null,
      reviewedAt: reviewed ? s.reviewedAt ?? null : null,
      note: s.note ?? null,
      resolved: status !== 'attention' || reviewed || def.optional,
    });
  }
  const outstanding = steps.filter((s) => !s.resolved).map((s) => s.key);
  const status = effectiveStatus(row, closing.closingDate, periodEnd);
  return {
    periodEnd,
    periodStart: periodStartFor(periodEnd),
    status,
    closedAt: status === 'closed' && row?.closedAt ? row.closedAt.toISOString() : null,
    closedByName: status === 'closed' ? await userName(ctx, row?.closedBy) : null,
    version: row ? row.updatedAt.toISOString() : null,
    closingDate: closing.closingDate,
    hasClosingPassword: closing.hasPassword,
    canClose: await canSetClosingDate(ctx),
    scanRanAt: row?.scanRanAt ? row.scanRanAt.toISOString() : null,
    steps,
    progress: { resolved: steps.filter((s) => s.resolved).length, total: steps.length },
    outstanding,
    ready: outstanding.length === 0,
  };
}

export interface MonthEndHistoryRow {
  periodEnd: string;
  status: 'open' | 'closed';
  closedAt: string | null;
  closedByName: string | null;
  updatedAt: string;
}

/** Periods this company has worked on in the wizard, newest first. */
export async function listMonthEndCloses(ctx: ServiceContext, limit = 24): Promise<MonthEndHistoryRow[]> {
  const [rows, closing] = await Promise.all([
    ctx.db
      .select({ row: monthEndCloses, closedByName: users.name })
      .from(monthEndCloses)
      .leftJoin(users, eq(monthEndCloses.closedBy, users.id))
      .where(eq(monthEndCloses.companyId, ctx.companyId))
      .orderBy(desc(monthEndCloses.periodEnd))
      .limit(Math.max(1, Math.min(limit, 120))),
    getClosingDateSettings(ctx),
  ]);
  return rows.map(({ row, closedByName }) => {
    const status = effectiveStatus(row, closing.closingDate, row.periodEnd);
    return {
      periodEnd: row.periodEnd,
      status,
      closedAt: status === 'closed' && row.closedAt ? row.closedAt.toISOString() : null,
      closedByName: status === 'closed' ? closedByName ?? null : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export type StepAction = 'review' | 'unreview' | 'skip' | 'unskip';

export interface UpdateStepInput {
  periodEnd: string;
  stepKey: string;
  action: StepAction;
  /** Optional note kept with a review. */
  note?: string | null;
  /** Required when skipping: why this step does not apply this month. */
  reason?: string | null;
  /** Version (`checklist.version`) the screen loaded; a stale one is refused (record locking). */
  version?: string | null;
}

/** Mark a step reviewed / not reviewed, or skip / un-skip it with a reason. Audited. */
export async function updateMonthEndStep(ctx: ServiceContext, input: UpdateStepInput): Promise<MonthEndChecklist> {
  assertWrite(ctx);
  const periodEnd = parsePeriodEnd(input.periodEnd);
  if (!(MONTH_END_STEP_KEYS as string[]).includes(input.stepKey)) {
    throw validation(`Unknown checklist step "${input.stepKey}".`);
  }
  const key = input.stepKey as MonthEndStepKey;
  const note = input.note?.trim() || null;
  const reason = input.reason?.trim() || null;
  if (note && note.length > 1000) throw validation('Keep the note under 1,000 characters.');
  if (input.action === 'skip') {
    if (!reason) throw validation('Say why you are skipping this step.');
    if (reason.length > 500) throw validation('Keep the reason under 500 characters.');
  }
  const closing = await getClosingDateSettings(ctx);

  await inTransaction(ctx, async (tx) => {
    const row = await loadRow(tx, periodEnd);
    await assertVersion(tx, row, input.version);
    if (effectiveStatus(row, closing.closingDate, periodEnd) === 'closed') {
      throw validation(`The books are already closed through ${prettyDay(closing.closingDate!)}. Move the closing date back to change this checklist.`);
    }
    const steps = { ...((row?.steps ?? {}) as Record<string, MonthEndStepState>) };
    const before = steps[key] ?? {};
    const next: MonthEndStepState = { ...before };
    if (input.action === 'review') {
      next.reviewed = true;
      next.reviewedBy = tx.userId;
      next.reviewedByName = await userName(tx, tx.userId);
      next.reviewedAt = new Date().toISOString();
      next.note = note;
    } else if (input.action === 'unreview') {
      next.reviewed = false;
      next.reviewedBy = null;
      next.reviewedByName = null;
      next.reviewedAt = null;
    } else if (input.action === 'skip') {
      next.skipReason = reason;
    } else if (input.action === 'unskip') {
      next.skipReason = null;
    } else {
      throw validation('action must be review, unreview, skip or unskip.');
    }
    steps[key] = next;
    const saved = await saveRow(tx, periodEnd, row, { steps });
    await writeAudit(tx, {
      action: row ? 'update' : 'create',
      entityType: 'month_end_close',
      entityId: saved.id,
      oldValues: { periodEnd, step: key, ...before },
      newValues: { periodEnd, step: key, action: input.action, ...next },
    });
  });
  return getMonthEndChecklist(ctx, periodEnd);
}

/** Run the error scan (AI Review rules — no AI provider involved) and remember when it ran. */
export async function runMonthEndErrorScan(
  ctx: ServiceContext,
  input: { periodEnd: string },
): Promise<{ found: number; checklist: MonthEndChecklist }> {
  assertWrite(ctx);
  const periodEnd = parsePeriodEnd(input.periodEnd);
  const closedMsg = (d: string) => `The books are already closed through ${prettyDay(d)}. Move the closing date back to run the scan for this period.`;
  const closing = await getClosingDateSettings(ctx);
  if (effectiveStatus(await loadRow(ctx, periodEnd), closing.closingDate, periodEnd) === 'closed') {
    throw validation(closedMsg(closing.closingDate!));
  }
  const created = await detectErrors(ctx);
  await inTransaction(ctx, async (tx) => {
    const row = await loadRow(tx, periodEnd);
    const nowClosing = await getClosingDateSettings(tx);
    if (effectiveStatus(row, nowClosing.closingDate, periodEnd) === 'closed') throw validation(closedMsg(nowClosing.closingDate!));
    const saved = await saveRow(tx, periodEnd, row, { scanRanAt: new Date() });
    await writeAudit(tx, {
      action: row ? 'update' : 'create',
      entityType: 'month_end_close',
      entityId: saved.id,
      newValues: { periodEnd, errorScan: { found: created.length } },
    });
  });
  return { found: created.length, checklist: await getMonthEndChecklist(ctx, periodEnd) };
}

export interface CloseMonthInput {
  periodEnd: string;
  /**
   * Closing-date password (the existing Set Closing Date flow): a string sets / replaces it,
   * null or '' removes it, undefined keeps the current one.
   */
  password?: string | null;
  version?: string | null;
}

export interface CloseMonthResult {
  closingDate: string;
  hasPassword: boolean;
  checklist: MonthEndChecklist;
}

/**
 * Final step: set the company closing date to the period end. Only for people allowed to set the
 * closing date (Closing Date / Periods: modify), only for a period that has ended, never moving
 * an existing later closing date backwards, and only when every required step is done, skipped
 * or reviewed.
 */
export async function closeMonth(ctx: ServiceContext, input: CloseMonthInput): Promise<CloseMonthResult> {
  await requireEffectivePermission(ctx, 'closing', 'modify');
  const periodEnd = parsePeriodEnd(input.periodEnd);
  const today = new Date().toISOString().slice(0, 10);
  if (periodEnd > today) {
    throw validation(`${prettyDay(periodEnd)} has not happened yet. You can close a period once it has ended.`);
  }
  if (input.password != null && input.password.length > 200) throw validation('The closing date password is too long.');
  const current = await getClosingDateSettings(ctx);
  if (current.closingDate && current.closingDate > periodEnd) {
    throw validation(
      `The books are already closed through ${prettyDay(current.closingDate)}, which is later than ${prettyDay(periodEnd)}. Nothing to do.`,
    );
  }
  const checklist = await getMonthEndChecklist(ctx, periodEnd);
  if (!checklist.ready) {
    const titles = checklist.steps.filter((s) => !s.resolved).map((s) => s.title);
    throw new ServiceError(
      'VALIDATION',
      `Finish, review or skip these steps first: ${titles.join('; ')}.`,
      { outstanding: checklist.outstanding },
    );
  }

  const settings = await inTransaction(ctx, async (tx) => {
    const row = await loadRow(tx, periodEnd);
    await assertVersion(tx, row, input.version);
    // Re-check readiness against the progress as saved now (a concurrent un-review / un-skip
    // between the check above and this transaction must not let the close through).
    const savedSteps = (row?.steps ?? {}) as Record<string, MonthEndStepState>;
    const stillOpen = checklist.steps.filter((st) => {
      const state = savedSteps[st.key] ?? {};
      const status: StepStatus = state.skipReason?.trim() ? 'skipped' : st.computedStatus;
      return !(status !== 'attention' || state.reviewed === true || st.optional);
    });
    if (stillOpen.length) {
      throw new ServiceError(
        'VALIDATION',
        `Finish, review or skip these steps first: ${stillOpen.map((st) => st.title).join('; ')}.`,
        { outstanding: stillOpen.map((st) => st.key) },
      );
    }
    const s = await setClosingDate(tx, { closingDate: periodEnd, password: input.password });
    const saved = await saveRow(tx, periodEnd, row, { status: 'closed', closedAt: new Date(), closedBy: tx.userId });
    await writeAudit(tx, {
      action: row ? 'update' : 'create',
      entityType: 'month_end_close',
      entityId: saved.id,
      oldValues: { periodEnd, status: row?.status ?? null, closingDate: current.closingDate },
      newValues: { periodEnd, status: 'closed', closingDate: s.closingDate, hasPassword: s.hasPassword },
    });
    return s;
  });
  return {
    closingDate: settings.closingDate!,
    hasPassword: settings.hasPassword,
    checklist: await getMonthEndChecklist(ctx, periodEnd),
  };
}

// ---------------------------------------------------------------------------
// Report pack (PDF)
// ---------------------------------------------------------------------------

export interface ReportPack {
  bytes: Uint8Array;
  /** Section titles in order (cover page first). */
  sections: string[];
  filename: string;
}

function stdToPdfRows(report: StdReport): { columns: { header: string; numeric?: boolean }[]; rows: PdfCell[][] } {
  const table = reportToTable(report);
  const moneyIdx = new Set(report.columns.map((c, i) => (c.type === 'money' ? i : -1)).filter((i) => i >= 0));
  return {
    columns: table.columns,
    rows: table.rows.map((r) =>
      r.map((v, i) => (moneyIdx.has(i) && v !== null && v !== '' && !Number.isNaN(Number(v)) ? fmtMoney(String(v)) : v)),
    ),
  };
}

async function reconciliationSummary(ctx: ServiceContext, periodStart: string, periodEnd: string) {
  const banks = await ctx.db
    .select({ id: bankAccounts.id, code: accounts.code, name: accounts.name, last: bankAccounts.lastReconciledDate })
    .from(bankAccounts)
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(bankAccounts.companyId, ctx.companyId))
    .orderBy(accounts.code);
  const rows: PdfCell[][] = [];
  for (const b of banks) {
    const recs = await ctx.db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.bankAccountId, b.id),
          eq(reconciliations.status, 'completed'),
          sql`${reconciliations.statementDate} >= ${startOfDay(periodStart)}`,
          lte(reconciliations.statementDate, endOfDay(periodEnd)),
        ),
      )
      .orderBy(reconciliations.statementDate);
    const label = `${b.code} ${b.name}`;
    if (!recs.length) {
      const last = dayOf(b.last);
      rows.push([label, '', '', '', '', '', '', last ? `Not reconciled this period (last: ${prettyDay(last)})` : 'Never reconciled']);
      continue;
    }
    for (const r of recs) {
      const rep = await getReconciliationReport(ctx, r.id);
      rows.push([
        label,
        prettyDay(dayOf(rep.statementDate)!),
        fmtMoney(rep.beginningBalance),
        `${fmtMoney(rep.depositsTotal)} (${rep.depositsCount})`,
        `${fmtMoney(rep.paymentsTotal)} (${rep.paymentsCount})`,
        fmtMoney(rep.statementBalance),
        fmtMoney(rep.difference),
        rep.discrepancies.length ? `Reconciled; ${rep.discrepancies.length} changed since` : 'Reconciled',
      ]);
    }
  }
  if (!rows.length) rows.push(['No bank or credit card accounts are set up for reconciling.', '', '', '', '', '', '', '']);
  return rows;
}

/**
 * The month-end report pack: cover page, Profit & Loss for the month, Balance Sheet, Trial
 * Balance, A/R and A/P aging summaries as of the period end, and the reconciliation summaries for
 * the period — one PDF built from the standard report services with pdf-lib.
 */
export async function buildMonthEndReportPack(ctx: ServiceContext, periodEndInput: string): Promise<ReportPack> {
  const periodEnd = parsePeriodEnd(periodEndInput);
  // The pack carries customer and vendor balances too, so it needs those report areas as well.
  await requireEffectivePermission(ctx, 'reports_financial', 'print');
  await requireEffectivePermission(ctx, 'reports_sales', 'view');
  await requireEffectivePermission(ctx, 'reports_purchases', 'view');
  const periodStart = periodStartFor(periodEnd);
  const company = await getCompany(ctx);
  if (!company) throw notFound('company');
  const closing = await getClosingDateSettings(ctx);

  const range = { from: periodStart, to: periodEnd } as ReportParams;
  const asOf = { asOf: periodEnd } as ReportParams;
  const std: StdReport[] = [
    await profitAndLossReport(ctx, range),
    await balanceSheetReport(ctx, asOf),
    await trialBalanceReport(ctx, asOf),
    await agingSummary(ctx, asOf, 'ar'),
    await agingSummary(ctx, asOf, 'ap'),
  ];
  const reconTitle = 'Reconciliation Summary';
  const reconRows = await reconciliationSummary(ctx, periodStart, periodEnd);

  const coverTitle = 'Month-End Report Pack';
  const sections = [coverTitle, ...std.map((r) => r.title), reconTitle];
  const parts: Uint8Array[] = [];
  parts.push(
    await buildReportPdf({
      title: coverTitle,
      company: company.name,
      subtitle: `Period ${prettyDay(periodStart)} - ${prettyDay(periodEnd)}. ${
        closing.closingDate && closing.closingDate >= periodEnd
          ? `Books closed through ${prettyDay(closing.closingDate)}.`
          : 'Books not yet closed for this period.'
      }`,
      columns: [{ header: 'Report' }, { header: 'Covers' }],
      rows: [
        ...std.map((r) => [r.title, r.subtitle ?? ''] as PdfCell[]),
        [reconTitle, `Statements ending ${prettyDay(periodStart)} - ${prettyDay(periodEnd)}`],
      ],
    }),
  );
  for (const r of std) {
    const t = stdToPdfRows(r);
    parts.push(
      await buildReportPdf({
        title: r.title,
        company: company.name,
        subtitle: r.subtitle,
        columns: t.columns,
        rows: t.rows,
        landscape: t.columns.length > 4,
      }),
    );
  }
  parts.push(
    await buildReportPdf({
      title: reconTitle,
      company: company.name,
      subtitle: `Bank and credit card statements ending ${prettyDay(periodStart)} - ${prettyDay(periodEnd)}`,
      columns: [
        { header: 'Account' },
        { header: 'Statement date' },
        { header: 'Beginning', numeric: true },
        { header: 'Cleared in', numeric: true },
        { header: 'Cleared out', numeric: true },
        { header: 'Ending', numeric: true },
        { header: 'Difference', numeric: true },
        { header: 'Status' },
      ],
      rows: reconRows,
      landscape: true,
    }),
  );

  const pack = await PDFDocument.create();
  pack.setTitle(`${company.name} - ${coverTitle} - ${periodEnd}`);
  pack.setSubject(sections.join('; '));
  pack.setKeywords(sections);
  pack.setProducer('Ironbooks');
  pack.setCreator('Ironbooks month-end close');
  for (const bytes of parts) {
    const doc = await PDFDocument.load(bytes);
    const pages = await pack.copyPages(doc, doc.getPageIndices());
    for (const p of pages) pack.addPage(p);
  }
  return { bytes: await pack.save(), sections, filename: `month-end-${periodEnd}.pdf` };
}
