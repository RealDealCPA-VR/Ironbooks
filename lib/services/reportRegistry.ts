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
  balanceSheetDetail,
  balanceSheetReport,
  journalReport,
  profitAndLossByClassReport,
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
  return key in REPORT_RUNNERS && key in CATALOG_BY_KEY;
}

/**
 * Run a standard report by key with raw (string) parameters. Checks the report's area
 * permission (view) for the caller, applies catalog defaults, validates parameters.
 */
export async function runStandardReport(
  ctx: ServiceContext,
  key: string,
  rawParams: URLSearchParams | Record<string, unknown>,
): Promise<StdReport> {
  const entry = CATALOG_BY_KEY[key];
  const runner = REPORT_RUNNERS[key];
  if (!entry || !runner) throw notFound('Report');
  requirePermission(ctx, entry.area, 'view');
  const merged: Record<string, unknown> = { ...(entry.defaults ?? {}) };
  const entries = rawParams instanceof URLSearchParams ? [...rawParams.entries()] : Object.entries(rawParams ?? {});
  for (const [k, v] of entries) if (v !== undefined && v !== null && String(v) !== '') merged[k] = v;
  const parsed = parseReportParams(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validation(`${issue?.path?.join('.') || 'Report option'}: ${issue?.message ?? 'invalid value'}`, parsed.error.issues);
  }
  return runner(ctx, parsed.data);
}

/** Catalog keys missing a runner (should be empty — guarded by tests). */
export function catalogKeysWithoutRunner(): string[] {
  return REPORT_CATALOG.map((e) => e.key).filter((k) => !REPORT_RUNNERS[k]);
}
