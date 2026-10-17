/**
 * Dashboard insights service — one aggregated read model for the home dashboard.
 *
 * Everything here is a read-only projection over existing tables (no GL writes):
 *  - KPI cards (fiscal-YTD revenue / net profit via lib/ytd.ts, cash / AR / AP balances)
 *  - A/R aging bucket totals (reuses reportsExtra.arAging)
 *  - A/P due soon (open bills due within the horizon, including already-overdue)
 *  - P&L trend — last 6 calendar months of income / expenses / net
 *  - Top overdue invoices and bills due this week (actionable lists with ids for links)
 *  - Low-stock inventory count (quantityOnHand <= reorderPoint)
 *  - Most recent reconciliation status
 *
 * Served by GET /api/dashboard and rendered server-side by app/dashboard/page.tsx.
 */
import { isAccountsPayable, isAccountsReceivable, isCashAccount } from '@/lib/accountTypes';
import { and, desc, eq, gte, isNotNull, lt, lte, notInArray, sql } from 'drizzle-orm';
import {
  accounts,
  bankAccounts,
  bills,
  customers,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  reconciliations,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { listAccounts } from '@/lib/services/accounts';
import { getCompany } from '@/lib/services/company';
import { notFiscalCloseEntry, profitAndLoss } from '@/lib/services/reports';
import { arAging } from '@/lib/services/reportsExtra';
import { ytdRange } from '@/lib/ytd';
import type { ServiceContext } from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardKpis {
  /** Fiscal year-to-date window actually used (honors settings.fiscalYearEnd). */
  ytdFrom: string;
  ytdTo: string;
  revenueYtd: string;
  netProfitYtd: string;
  cash: string;
  accountsReceivable: string;
  accountsPayable: string;
}

export interface ArAgingSummary {
  current: string;
  days1_30: string;
  days31_60: string;
  days61_90: string;
  days91plus: string;
  total: string;
}

export interface PlTrendPoint {
  /** Calendar month key, e.g. "2026-06". Oldest first. */
  month: string;
  income: string;
  expenses: string;
  net: string;
}

export interface OverdueInvoiceRow {
  id: string;
  invoiceNumber: number;
  customerName: string;
  dueDate: string;
  daysOverdue: number;
  balanceDue: string;
}

export interface BillDueRow {
  id: string;
  billNumber: string | null;
  vendorName: string;
  dueDate: string;
  balanceDue: string;
}

export interface LastReconciliation {
  id: string;
  accountName: string;
  bankName: string;
  statementDate: string;
  status: string;
  completedAt: string | null;
}

export interface DashboardInsights {
  asOf: string;
  kpis: DashboardKpis;
  arAging: ArAgingSummary;
  /** Open A/P due within `horizonDays` of asOf — includes bills already overdue. */
  apDueSoon: { count: number; total: string; horizonDays: number };
  /** Last 6 calendar months (oldest first), including the current month. */
  plTrend: PlTrendPoint[];
  overdueInvoices: OverdueInvoiceRow[];
  overdueInvoiceCount: number;
  overdueInvoiceTotal: string;
  /** Bills coming due in [today, today + 7 days), i.e. not yet overdue. */
  billsDueThisWeek: BillDueRow[];
  billsDueThisWeekCount: number;
  billsDueThisWeekTotal: string;
  lowStockCount: number;
  lastReconciliation: LastReconciliation | null;
}

/** Statuses that mean a document no longer represents an open balance. */
const SETTLED_STATUSES = ['void', 'draft', 'paid', 'closed'] as const;

const DUE_SOON_HORIZON_DAYS = 7;

/**
 * Today's calendar day on this computer, at UTC midnight — the convention stored document dates
 * (due dates, transaction dates) use. Local-midnight bounds would shift every comparison by the
 * UTC offset (e.g. an invoice due today counted as overdue west of UTC).
 */
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** `d` (a UTC-midnight day) plus whole days. */
function addDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

/** "YYYY-MM" of a UTC-midnight date (matches to_char on the stored UTC dates). */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// getDashboardInsights
// ---------------------------------------------------------------------------

export async function getDashboardInsights(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<DashboardInsights> {
  const today = startOfDay(now);
  const weekEnd = addDays(today, DUE_SOON_HORIZON_DAYS);
  /** Last instant of today's calendar day (UTC convention), like the as-of reports. */
  const endOfToday = new Date(addDays(today, 1).getTime() - 1);

  const [kpis, aging, plTrend, overdue, dueThisWeek, lowStockCount, lastReconciliation] =
    await Promise.all([
      kpiCards(ctx, now),
      arAging(ctx, endOfToday),
      profitLossTrend(ctx, now),
      overdueInvoices(ctx, today),
      billsDueThisWeek(ctx, today, weekEnd),
      lowStock(ctx),
      latestReconciliation(ctx),
    ]);

  // A/P due soon = everything overdue + everything coming due within the horizon.
  const apDueSoonRows = await ctx.db
    .select({ balanceDue: bills.balanceDue, exchangeRate: bills.exchangeRate })
    .from(bills)
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        notInArray(bills.status, [...SETTLED_STATUSES]),
        sql`${bills.balanceDue} > 0`,
        isNotNull(bills.dueDate),
        lt(bills.dueDate, weekEnd),
      ),
    );

  return {
    asOf: now.toISOString(),
    kpis,
    arAging: aging.totals,
    apDueSoon: {
      count: apDueSoonRows.length,
      total: homeTotal(apDueSoonRows),
      horizonDays: DUE_SOON_HORIZON_DAYS,
    },
    plTrend,
    overdueInvoices: overdue.top,
    overdueInvoiceCount: overdue.count,
    overdueInvoiceTotal: overdue.total,
    billsDueThisWeek: dueThisWeek.top,
    billsDueThisWeekCount: dueThisWeek.count,
    billsDueThisWeekTotal: dueThisWeek.total,
    lowStockCount,
    lastReconciliation,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The original five KPI tiles. Preserves the fiscal-YTD scoping from lib/ytd.ts
 * (settings.fiscalYearEnd "MM-DD"; defaults to Jan 1).
 */
async function kpiCards(ctx: ServiceContext, now: Date): Promise<DashboardKpis> {
  const company = await getCompany(ctx);
  const ytd = ytdRange(company?.settings?.fiscalYearEnd, now);
  const [pl, accts] = await Promise.all([profitAndLoss(ctx, ytd), listAccounts(ctx)]);

  const sumWhere = (pred: (a: (typeof accts)[number]) => boolean) =>
    toAmountString(Money.add(...accts.filter(pred).map((a) => a.balance)));

  return {
    ytdFrom: ytd.from.toISOString(),
    ytdTo: ytd.to.toISOString(),
    revenueYtd: pl.totalIncome,
    netProfitYtd: pl.netIncome,
    // Cash = bank accounts + Undeposited Funds (lib/accountTypes.ts); prepaids and other
    // current assets are not cash. A/P = Accounts Payable accounts only (not payroll /
    // sales-tax liabilities, which are Other Current Liabilities).
    cash: sumWhere((a) => isCashAccount(a)),
    accountsReceivable: sumWhere((a) => isAccountsReceivable(a)),
    accountsPayable: sumWhere((a) => isAccountsPayable(a)),
  };
}

/**
 * Income/expense/net for the last 6 calendar months (including the current one),
 * from posted journal activity. One grouped query; fiscal-close entries excluded
 * so closed-year history isn't wiped (same rule as profitAndLoss).
 */
async function profitLossTrend(ctx: ServiceContext, now: Date): Promise<PlTrendPoint[]> {
  // UTC bounds over the computer's current calendar month (stored dates are UTC midnight).
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 5, 1));
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1) - 1);

  const rows = await ctx.db
    .select({
      month: sql<string>`to_char(${journalEntries.date}, 'YYYY-MM')`,
      type: accounts.type,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        notFiscalCloseEntry(),
        gte(journalEntries.date, start),
        lte(journalEntries.date, end),
        sql`${accounts.type} IN ('revenue', 'expense')`,
      ),
    )
    .groupBy(sql`to_char(${journalEntries.date}, 'YYYY-MM')`, accounts.type);

  // Materialize all 6 months so the sparkline always has a stable x-axis.
  const byMonth = new Map<string, { income: ReturnType<typeof Money.zero>; expenses: ReturnType<typeof Money.zero> }>();
  for (let i = 5; i >= 0; i--) {
    byMonth.set(monthKey(new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1))), {
      income: Money.zero(),
      expenses: Money.zero(),
    });
  }
  for (const r of rows) {
    const bucket = byMonth.get(r.month);
    if (!bucket) continue; // UTC/local month-boundary stragglers — ignore
    if (r.type === 'revenue') bucket.income = bucket.income.plus(Money.sub(r.credit, r.debit));
    else bucket.expenses = bucket.expenses.plus(Money.sub(r.debit, r.credit));
  }

  return Array.from(byMonth.entries()).map(([month, v]) => ({
    month,
    income: toAmountString(v.income),
    expenses: toAmountString(v.expenses),
    net: toAmountString(v.income.minus(v.expenses)),
  }));
}

const TOP_N = 5;

/**
 * Home-currency total of open document balances. A foreign invoice / bill keeps balanceDue in its
 * own currency; the KPI totals are home currency (like the A/R aging tile), so each foreign
 * balance counts at the rate it was booked at.
 */
function homeTotal(rows: Array<{ balanceDue: string; exchangeRate: string | null }>): string {
  return toAmountString(
    Money.add(
      ...rows.map((r) =>
        r.exchangeRate && !Money.eq(Money.of(r.exchangeRate), 1)
          ? Money.round2(Money.of(r.balanceDue).times(Money.of(r.exchangeRate)))
          : Money.of(r.balanceDue),
      ),
    ),
  );
}

async function overdueInvoices(ctx: ServiceContext, today: Date) {
  const rows = await ctx.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerName: customers.displayName,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
      exchangeRate: invoices.exchangeRate,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        notInArray(invoices.status, [...SETTLED_STATUSES]),
        sql`${invoices.balanceDue} > 0`,
        isNotNull(invoices.dueDate),
        lt(invoices.dueDate, today),
      ),
    )
    .orderBy(invoices.dueDate);

  const top: OverdueInvoiceRow[] = rows.slice(0, TOP_N).map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    customerName: r.customerName,
    dueDate: r.dueDate!.toISOString(),
    // Whole calendar days (UTC convention) from the due day to today; time of day ignored.
    daysOverdue: Math.round((today.getTime() - addDays(r.dueDate!, 0).getTime()) / 86_400_000),
    balanceDue: toAmountString(r.balanceDue),
  }));

  return {
    top,
    count: rows.length,
    total: homeTotal(rows),
  };
}

async function billsDueThisWeek(ctx: ServiceContext, today: Date, weekEnd: Date) {
  const rows = await ctx.db
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      vendorName: vendors.displayName,
      dueDate: bills.dueDate,
      balanceDue: bills.balanceDue,
      exchangeRate: bills.exchangeRate,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        notInArray(bills.status, [...SETTLED_STATUSES]),
        sql`${bills.balanceDue} > 0`,
        isNotNull(bills.dueDate),
        gte(bills.dueDate, today),
        lt(bills.dueDate, weekEnd),
      ),
    )
    .orderBy(bills.dueDate);

  const top: BillDueRow[] = rows.slice(0, TOP_N).map((r) => ({
    id: r.id,
    billNumber: r.billNumber,
    vendorName: r.vendorName,
    dueDate: r.dueDate!.toISOString(),
    balanceDue: toAmountString(r.balanceDue),
  }));

  return {
    top,
    count: rows.length,
    total: homeTotal(rows),
  };
}

/** Active inventory items at or below their reorder point. */
async function lowStock(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(items)
    .where(
      and(
        eq(items.companyId, ctx.companyId),
        eq(items.isActive, true),
        eq(items.type, 'inventory'),
        isNotNull(items.reorderPoint),
        sql`${items.quantityOnHand} <= ${items.reorderPoint}`,
      ),
    );
  return row?.count ?? 0;
}

/** Most recent reconciliation for any of this company's bank accounts. */
async function latestReconciliation(ctx: ServiceContext): Promise<LastReconciliation | null> {
  const [row] = await ctx.db
    .select({
      id: reconciliations.id,
      accountName: accounts.name,
      bankName: bankAccounts.bankName,
      statementDate: reconciliations.statementDate,
      status: reconciliations.status,
      completedAt: reconciliations.completedAt,
    })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(bankAccounts.companyId, ctx.companyId))
    .orderBy(desc(reconciliations.createdAt))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    accountName: row.accountName,
    bankName: row.bankName,
    statementDate: row.statementDate.toISOString(),
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
