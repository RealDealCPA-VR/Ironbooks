/**
 * Server-side runners for the standard report catalog (lib/reports/catalog.ts). One entry point,
 * `runStandardReport`, enforces the report's permission area (so a single API route can serve
 * every report, and memorized report groups / schedules can run reports from mixed areas
 * safely), validates the parameters and runs the report.
 */
import type { StdReport } from '@/lib/reports/types';
import { CATALOG_BY_KEY, REPORT_CATALOG } from '@/lib/reports/catalog';
import { parseReportParams, type ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { notFound, validation } from './_base';
import { requirePermission } from './access';
import {
  DATE_MACROS,
  companyFiscalYearEnd,
  dayStr,
  fiscalWindowFor,
  parseDay,
  resolveDateMacro,
  type DateMacro,
} from './reportEngine';
import {
  balanceSheetDetail,
  balanceSheetReport,
  generalLedgerReport,
  journalReport,
  profitAndLossByClassReport,
  profitAndLossByJobReport,
  statementOfCashFlows,
  profitAndLossDetail,
  profitAndLossReport,
  profitAndLossYtdComparison,
  transactionDetailByAccount,
  transactionList,
  trialBalanceReport,
} from './reportsStandard';
import {
  accountListing,
  billsAndAppliedPayments,
  customerBalanceDetail,
  customerBalanceSummary,
  customerContactList,
  expensesByVendorDetail,
  expensesByVendorSummary,
  incomeTaxPreparation,
  incomeTaxReport,
  itemListing,
  itemPriceList,
  openPurchaseOrders,
  purchasesByItemDetail,
  purchasesByItemSummary,
  purchasesByVendorSummary,
  salesByCustomerSummary,
  salesByItemSummary,
  openSalesOrdersByCustomer,
  openSalesOrdersByItem,
  salesByCustomerDetail,
  salesByItemDetail,
  unpaidBillsDetail,
  vendorBalanceDetail,
  vendorBalanceSummary,
  vendorContactList,
} from './reportsLists';
import {
  itemEstimatesVsActuals,
  jobEstimatesVsActuals,
  jobProfitabilityDetail,
  jobProfitabilitySummary,
  mileageReport,
  timeReport,
  unbilledCostsByJob,
} from './reportsJobsTime';
import { budgetOverviewReport, budgetVsActualReport } from './budgets';
import { combinedAging, combinedCashFlow, combinedProfitAndLossByMonth, combinedTrialBalance } from './consolidation';
import {
  apAgingDetailReport,
  apAgingSummaryReport,
  arAgingDetailReport,
  arAgingSummaryReport,
  collectionsStdReport,
  openInvoicesReport,
} from './reportsAging';
import { salesTaxLiabilityStd } from './reportsSalesTax';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

type Runner = (ctx: ServiceContext, p: ReportParams) => Promise<StdReport>;

export const REPORT_RUNNERS: Record<string, Runner> = {
  'profit-loss': (c, p) => profitAndLossReport(c, p),
  'profit-loss-detail': profitAndLossDetail,
  'profit-loss-ytd': profitAndLossYtdComparison,
  'profit-loss-prev-year': (c, p) =>
    profitAndLossReport(c, { ...p, compare: p.compare ?? 'prev_year' }, { key: 'profit-loss-prev-year', title: 'Profit & Loss Prev Year Comparison' }),
  'profit-loss-by-month': (c, p) =>
    profitAndLossReport(c, { ...p, columns: p.columns ?? 'month' }, { key: 'profit-loss-by-month', title: 'Profit & Loss by Month' }),
  'profit-loss-percent': (c, p) =>
    profitAndLossReport(c, p, { percentOfIncome: true, key: 'profit-loss-percent', title: 'Profit & Loss % of Income' }),
  'pl-by-class': profitAndLossByClassReport,
  'profit-loss-by-job': profitAndLossByJobReport,
  'balance-sheet-prev-year': async (c, p) => {
    const r = await balanceSheetReport(c, { ...p, compare: p.compare && p.compare !== 'none' ? p.compare : 'prev_year' });
    return { ...r, key: 'balance-sheet-prev-year', title: 'Balance Sheet Prev Year Comparison' };
  },
  'statement-of-cash-flows': statementOfCashFlows,
  'general-ledger': generalLedgerReport,
  'adjusting-journal-entries': (c, p) => journalReport(c, p, { adjustingOnly: true }),
  'ar-aging-summary': arAgingSummaryReport,
  'ar-aging-detail': arAgingDetailReport,
  'ap-aging-summary': apAgingSummaryReport,
  'ap-aging-detail': apAgingDetailReport,
  'open-invoices': openInvoicesReport,
  'collections-report': collectionsStdReport,
  'sales-by-customer-summary': salesByCustomerSummary,
  'sales-by-item-summary': salesByItemSummary,
  'purchases-by-item-summary': purchasesByItemSummary,
  'purchases-by-vendor-summary': purchasesByVendorSummary,
  'sales-tax-liability': salesTaxLiabilityStd,
  'balance-sheet': (c, p) => balanceSheetReport(c, p),
  'balance-sheet-summary': (c, p) => balanceSheetReport(c, p, { summary: true }),
  'balance-sheet-detail': balanceSheetDetail,
  'balance-sheet-by-period': async (c, p) => {
    const r = await balanceSheetReport(c, { ...p, columns: p.columns && p.columns !== 'total' ? p.columns : 'month' });
    return { ...r, key: 'balance-sheet-by-period', title: 'Balance Sheet by Period' };
  },
  'trial-balance': trialBalanceReport,
  'transaction-detail-by-account': transactionDetailByAccount,
  journal: journalReport,
  'transaction-list-by-date': (c, p) => transactionList(c, p, 'date'),
  'transaction-list-by-customer': (c, p) => transactionList(c, p, 'customer'),
  'transaction-list-by-vendor': (c, p) => transactionList(c, p, 'vendor'),
  'income-tax-preparation': (c, p) => incomeTaxPreparation(c, p),
  'income-tax-summary': (c, p) => incomeTaxReport(c, p, false),
  'income-tax-detail': (c, p) => incomeTaxReport(c, p, true),
  'account-listing': accountListing,
  'customer-balance-summary': customerBalanceSummary,
  'customer-balance-detail': customerBalanceDetail,
  'sales-by-customer-detail': salesByCustomerDetail,
  'sales-by-item-detail': salesByItemDetail,
  'open-sales-orders-by-customer': openSalesOrdersByCustomer,
  'open-sales-orders-by-item': openSalesOrdersByItem,
  'customer-contact-list': (c, p) => customerContactList(c, p),
  'customer-phone-list': (c, p) => customerContactList(c, p, true),
  'item-price-list': (c) => itemPriceList(c),
  'item-listing': (c) => itemListing(c),
  'job-profitability-summary': jobProfitabilitySummary,
  'job-profitability-detail': jobProfitabilityDetail,
  'job-estimates-vs-actuals': jobEstimatesVsActuals,
  'item-estimates-vs-actuals': itemEstimatesVsActuals,
  'unbilled-costs-by-job': unbilledCostsByJob,
  'time-by-job': (c, p) => timeReport(c, p, 'job'),
  'time-by-name': (c, p) => timeReport(c, p, 'name'),
  'time-by-item': (c, p) => timeReport(c, p, 'item'),
  'mileage-by-job': (c, p) => mileageReport(c, p, 'job'),
  'mileage-by-vehicle': (c, p) => mileageReport(c, p, 'vehicle'),
  'vendor-balance-summary': vendorBalanceSummary,
  'vendor-balance-detail': vendorBalanceDetail,
  'unpaid-bills-detail': unpaidBillsDetail,
  'bills-applied-payments': billsAndAppliedPayments,
  'expenses-by-vendor-summary': expensesByVendorSummary,
  'expenses-by-vendor-detail': expensesByVendorDetail,
  'open-purchase-orders': openPurchaseOrders,
  'purchases-by-item-detail': purchasesByItemDetail,
  'vendor-contact-list': (c, p) => vendorContactList(c, p),
  'vendor-phone-list': (c, p) => vendorContactList(c, p, true),
  'budget-overview': budgetOverviewReport,
  'budget-vs-actual-report': budgetVsActualReport,
  'forecast-overview': budgetOverviewReport,
  'combined-trial-balance': combinedTrialBalance,
  'combined-cash-flow': combinedCashFlow,
  'combined-pl-by-month': combinedProfitAndLossByMonth,
  'combined-ar-aging': (c, p) => combinedAging(c, p, 'ar'),
  'combined-ap-aging': (c, p) => combinedAging(c, p, 'ap'),
};

/** True when `key` is a runnable standard report. */
export function isStandardReport(key: string): boolean {
  return typeof key === 'string' && Object.hasOwn(REPORT_RUNNERS, key) && Object.hasOwn(CATALOG_BY_KEY, key);
}

/** Catalog entry for a runnable standard report key (own keys only — never prototype members). */
export function standardReportEntry(key: string) {
  return isStandardReport(key) ? CATALOG_BY_KEY[key] : undefined;
}

/**
 * Run a standard report by key with raw (string) parameters. Checks the report's area
 * permission (view) for the caller, applies catalog defaults, validates parameters.
 */
export async function runStandardReport(
  ctx: ServiceContext,
  key: string,
  rawParams: URLSearchParams | Record<string, unknown>,
  opts?: { now?: Date },
): Promise<StdReport> {
  if (!isStandardReport(key)) throw notFound('Report');
  const entry = CATALOG_BY_KEY[key];
  const runner = REPORT_RUNNERS[key];
  requirePermission(ctx, entry.area, 'view');
  const merged: Record<string, unknown> = { ...(entry.defaults ?? {}) };
  const entries = rawParams instanceof URLSearchParams ? [...rawParams.entries()] : Object.entries(rawParams ?? {});
  for (const [k, v] of entries) if (v !== undefined && v !== null && String(v) !== '') merged[k] = v;
  // Relative dates ("This month to date", …) are resolved now, so memorized and scheduled
  // reports always cover the current period.
  if (typeof merged.dates === 'string' && (DATE_MACROS as readonly string[]).includes(merged.dates)) {
    const r = resolveDateMacro(merged.dates as DateMacro, opts?.now ?? new Date(), await companyFiscalYearEnd(ctx));
    if (merged.dates === 'all') {
      merged.from = '1900-01-01';
    } else if (r.from) merged.from = r.from;
    merged.to = r.to;
    merged.asOf = r.to;
  }
  // QB Preferences > Reports "Summary reports basis": the default for reports offered on both
  // bases. An explicit basis (the toolbar toggle, a memorized or scheduled report) always wins.
  if (entry.basis && merged.basis === undefined) merged.basis = await companyReportBasis(ctx);
  const parsed = parseReportParams(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validation(`${issue?.path?.join('.') || 'Report option'}: ${issue?.message ?? 'invalid value'}`, parsed.error.issues);
  }
  const report = await runner(ctx, parsed.data);
  if (entry.basis) report.basis = parsed.data.basis === 'cash' ? 'cash' : 'accrual';
  report.range = await resolvedRange(ctx, parsed.data);
  return report;
}

/**
 * The dates a run covered, resolved the same way the report runners do (resolveRange /
 * resolveAsOf in reportEngine): no "to" means today; no "from" means the start of the fiscal
 * year containing "to"; "asOf" falls back to "to".
 */
async function resolvedRange(ctx: ServiceContext, p: ReportParams): Promise<StdReport['range']> {
  try {
    const today = dayStr(new Date());
    const to = p.to ?? today;
    const asOf = p.asOf ?? p.to ?? today;
    const from = p.from ?? dayStr(fiscalWindowFor(parseDay(to, true)!, await companyFiscalYearEnd(ctx)).start);
    return { from, to, asOf };
  } catch {
    return undefined;
  }
}

/** The company's default report basis (companies.settings.reportBasis; accrual when unset). */
export async function companyReportBasis(ctx: ServiceContext): Promise<'accrual' | 'cash'> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  return (row?.settings as { reportBasis?: string } | null)?.reportBasis === 'cash' ? 'cash' : 'accrual';
}

/** Catalog keys missing a runner (should be empty — guarded by tests). */
export function catalogKeysWithoutRunner(): string[] {
  return REPORT_CATALOG.map((e) => e.key).filter((k) => !Object.hasOwn(REPORT_RUNNERS, k));
}
