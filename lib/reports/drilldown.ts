/**
 * Report explanations — shared, PURE module (client + server).
 *
 *  - Which standard reports explain every amount (the hover / focus tooltip "made of N
 *    transactions, largest $X (payee, date)" and the QuickZoom drill-down list behind a number).
 *  - Which reports get the one-line summary at the top (vs the previous period / last year).
 *  - The shapes the explanation APIs return, and the URL helpers that keep every report option
 *    in the URL so the browser Back button returns to the report exactly as it was.
 *
 * The server side lives in lib/services/reportDrilldown.ts and lib/services/reportSummary.ts.
 */

/** Reports whose every amount cell is explained by GET /api/reports/drilldown/[report]. */
export const DRILLDOWN_REPORTS: readonly string[] = [
  // Profit & Loss family
  'profit-loss',
  'profit-loss-prev-year',
  'profit-loss-by-month',
  'profit-loss-percent',
  'profit-loss-ytd',
  'pl-by-class',
  'profit-loss-by-job',
  // Balance sheet family
  'balance-sheet',
  'balance-sheet-prev-year',
  'balance-sheet-summary',
  'balance-sheet-by-period',
  // Accountant
  'trial-balance',
  'general-ledger',
  // Receivables / payables
  'ar-aging-summary',
  'ar-aging-detail',
  'ap-aging-summary',
  'ap-aging-detail',
  'open-invoices',
  'collections-report',
  // Sales / expense summaries
  'sales-by-customer-summary',
  'sales-by-item-summary',
  'expenses-by-vendor-summary',
];

/** Reports with the one-line "what changed" summary at the top. */
export const SUMMARY_REPORTS: readonly string[] = [
  'profit-loss',
  'profit-loss-prev-year',
  'profit-loss-by-month',
  'profit-loss-percent',
  'profit-loss-ytd',
  'pl-by-class',
  'profit-loss-by-job',
  'balance-sheet',
  'balance-sheet-prev-year',
  'balance-sheet-summary',
  'balance-sheet-by-period',
  'sales-by-customer-summary',
  'sales-by-item-summary',
  'expenses-by-vendor-summary',
];

export const isDrilldownReport = (key: string) => DRILLDOWN_REPORTS.includes(key);
export const isSummaryReport = (key: string) => SUMMARY_REPORTS.includes(key);

/** One transaction (or open document) behind a report number. */
export interface DrillTransaction {
  /** Stable key (journal entry, document, or settlement). */
  key: string;
  /** Journal entry to open in the QuickZoom transaction view (null when there is none). */
  entryId: string | null;
  /** Source document reference ("invoice:<id>") for the "open the document" link. */
  sourceRef: string | null;
  /** YYYY-MM-DD */
  date: string;
  type: string;
  num: string;
  /** Payee / customer / vendor. */
  name: string;
  memo: string;
  /** Account(s) the amount sits in. */
  account: string;
  /** This transaction's share of the number (2dp string; signs as the report shows them). */
  amount: string;
}

export interface CellDrilldown {
  report: string;
  rowId: string;
  column: string;
  rowLabel: string;
  columnLabel: string;
  /**
   * 'transactions': the number is the sum of `transactions` (ties === true unless the ledger
   * changed between the two reads). 'formula': the number is calculated (an average, a margin,
   * cost × quantity) — `formula` says how, and `transactions` are the ones it is based on.
   */
  kind: 'transactions' | 'formula';
  formula?: string;
  /** The number exactly as the report shows it. */
  cell: string | null;
  /** Sum of the transactions' amounts. */
  total: string;
  ties: boolean;
  /** Number of transactions behind the number. */
  count: number;
  largest: DrillTransaction | null;
  /** The transactions, by date (capped at `limit`; `truncated` says when more exist). */
  transactions: DrillTransaction[];
  truncated: boolean;
  /** Plain-language one-liner for the tooltip. */
  explanation: string;
  /** What the number covers ("Rent · 01/01/2026 – 03/31/2026 · Cash basis"). */
  scope: string;
  basis?: 'accrual' | 'cash';
}

export interface SummaryComparison {
  label: string;
  /** Period or date compared with. */
  range: string;
  value: string;
  change: string;
  /** Percent change (2dp string) or null when the earlier value is zero. */
  changePct: string | null;
}

export interface SummaryMover {
  id: string;
  label: string;
  current: string;
  prior: string;
  change: string;
}

export interface ReportSummaryFacts {
  report: string;
  metric: string;
  current: { range: string; value: string };
  priorPeriod: SummaryComparison;
  priorYear: SummaryComparison;
  vs: 'prior_period' | 'prior_year';
  movers: SummaryMover[];
  moverNoun: string;
  basis?: 'accrual' | 'cash';
}

export interface ReportSummaryResult {
  facts: ReportSummaryFacts;
  /** The deterministic one-line summary (always present; works with AI off). */
  text: string;
  /** True when an AI model is configured and allowed for this company. */
  aiAvailable: boolean;
  /** Set when phrasing with AI was asked for and a model answered with a valid sentence. */
  ai?: { text: string; providerId: string; locality: 'local' | 'cloud'; redacted: boolean };
  /** Why the AI phrasing was not used (no model, a failure, or a reply that changed the numbers). */
  aiNotice?: string;
}

/** Report option keys carried in the URL (mirrors StdReportView's PARAM_KEYS). */
export const REPORT_PARAM_KEYS = [
  'from', 'to', 'asOf', 'priorAsOf', 'accountId', 'section', 'nameId', 'customerId', 'vendorId', 'employeeId', 'itemId', 'jobId',
  'classId', 'budgetId', 'txnType', 'amountMin', 'amountMax', 'cleared', 'memo', 'number', 'sortBy', 'sortDir',
  'subtotalBy', 'columns', 'compare', 'basis', 'view', 'vehicle', 'dates', 'interval', 'through', 'agingFrom',
] as const;

/** Only the report options from a params object (drops row / col / back and anything unknown). */
export function reportOptions(params: Record<string, string | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of REPORT_PARAM_KEYS) {
    const v = params[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * QuickZoom page for one report number. The report's options travel in the URL so the drill-down
 * reproduces them exactly, and `back` is the report page to return to.
 */
export function drilldownHref(
  report: string,
  params: Record<string, string | undefined | null>,
  rowId: string,
  column: string,
  back?: string,
): string {
  const qs = new URLSearchParams({ report, row: rowId, col: column, ...reportOptions(params) });
  if (back) qs.set('back', back);
  return `/reports/drilldown?${qs.toString()}`;
}

/** API URL for one number's explanation (`brief` = tooltip: count + largest only). */
export function drilldownApiUrl(
  report: string,
  params: Record<string, string | undefined | null>,
  rowId: string,
  column: string,
  brief = false,
): string {
  const qs = new URLSearchParams({ ...reportOptions(params), row: rowId, col: column });
  if (brief) qs.set('brief', '1');
  return `/api/reports/drilldown/${encodeURIComponent(report)}?${qs.toString()}`;
}

/** A safe in-app "back" target (relative path only — never an absolute or protocol URL). */
export function safeBackHref(back: string | null | undefined): string | null {
  if (!back || !back.startsWith('/') || back.startsWith('//') || back.includes('\\')) return null;
  return back;
}
