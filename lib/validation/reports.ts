/**
 * Zod schemas for the standard report engine (/api/reports/std/[report], memorized reports,
 * memorized report groups, scheduled reports, pivot, graphs).
 *
 * Report parameters travel as strings (query string or a memorized report's saved config), so
 * every field is an optional string validated for shape here; the services turn them into dates /
 * decimals. Unknown keys are dropped.
 */
import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^-?\d{1,13}(\.\d{1,2})?$/;

/** A real calendar date: JS Date rolls 2026-02-30 over to March, so require a round trip. */
function isCalendarDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const zDateStr = z.string().regex(DATE_RE, 'must be a date (YYYY-MM-DD)').refine(isCalendarDate, 'must be a valid date');
const zId = z.string().regex(UUID_RE, 'must be a valid id');
const zAmount = z.string().regex(DECIMAL_RE, 'must be an amount like 100 or 99.95');

export const TXN_TYPE_KEYS = [
  'invoice',
  'payment',
  'sales_receipt',
  'credit_memo',
  'refund',
  'bill',
  'bill_payment',
  'bill_credit',
  'check',
  'deposit',
  'transfer',
  'paycheck',
  'journal',
  'inventory',
  'item_receipt',
  'depreciation',
  'sales_tax_payment',
  'cc_payment',
  'expense_report',
  'opening_balance',
  'other',
] as const;
export type TxnTypeKey = (typeof TXN_TYPE_KEYS)[number];

export const PERIOD_COLUMNS = ['total', 'month', 'quarter', 'year'] as const;
export const SUBTOTAL_BY = ['none', 'account', 'name', 'type', 'month', 'class'] as const;
export const SORT_BY = ['date', 'num', 'name', 'amount', 'account', 'type', 'memo'] as const;

export const reportParamsSchema = z
  .object({
    from: zDateStr.optional(),
    to: zDateStr.optional(),
    asOf: zDateStr.optional(),
    /** Balance sheet comparison: the earlier as-of date (defaults to one year / one month earlier). */
    priorAsOf: zDateStr.optional(),
    accountId: zId.optional(),
    /** Restrict detail to accounts of one P&L / balance-sheet section (sectionForAccount key). */
    section: z.string().max(40).optional(),
    nameId: zId.optional(),
    customerId: zId.optional(),
    vendorId: zId.optional(),
    employeeId: zId.optional(),
    itemId: zId.optional(),
    jobId: zId.optional(),
    classId: zId.optional(),
    budgetId: zId.optional(),
    txnType: z.enum(TXN_TYPE_KEYS).optional(),
    amountMin: zAmount.optional(),
    amountMax: zAmount.optional(),
    cleared: z.enum(['any', 'cleared', 'uncleared']).optional(),
    memo: z.string().max(200).optional(),
    number: z.string().max(100).optional(),
    sortBy: z.enum(SORT_BY).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    subtotalBy: z.enum(SUBTOTAL_BY).optional(),
    columns: z.enum(PERIOD_COLUMNS).optional(),
    /** Comparative reports: add previous period / previous year columns. */
    compare: z.enum(['none', 'prev_period', 'prev_year']).optional(),
    basis: z.enum(['accrual', 'cash']).optional(),
    /** Summary vs detail variants of the same report (e.g. time reports). */
    view: z.enum(['summary', 'detail']).optional(),
    vehicle: z.string().max(100).optional(),
    /** Aging reports: days per aging column (QB "Interval (days)", default 30). */
    interval: z.string().regex(/^[0-9]{1,3}$/, 'must be a whole number of days').refine((v) => +v >= 1 && +v <= 365, 'must be 1 to 365 days').optional(),
    /** Aging reports: last aged column (QB "Through (days past due)", default 90). */
    through: z.string().regex(/^[0-9]{1,4}$/, 'must be a whole number of days').refine((v) => +v >= 1 && +v <= 3650, 'must be 1 to 3650 days').optional(),
    /** Aging reports: age from the due date (QB default) or the transaction date. */
    agingFrom: z.enum(['due_date', 'transaction_date']).optional(),
    /** Open-item reports (unpaid bills / open invoices): only items MORE than N days past due (cmdbar). */
    overDays: z.string().regex(/^[0-9]{1,4}$/, 'must be a whole number of days').optional(),
    /** Relative date range (resolved to from / to / asOf when the report runs). */
    dates: z
      .enum([
        'today', 'this_week', 'this_month', 'this_month_to_date', 'last_month', 'this_quarter',
        'this_quarter_to_date', 'last_quarter', 'this_year', 'this_year_to_date', 'last_year',
        'this_fiscal_year', 'this_fiscal_year_to_date', 'last_fiscal_year', 'all',
      ])
      .optional(),
  })
  .strip()
  .superRefine((p, ctx) => {
    if (p.from && p.to && p.from > p.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The "To" date is before the "From" date.' });
    }
    if (p.interval && p.through && Math.ceil(+p.through / +p.interval) > 24) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interval'], message: 'That makes more than 24 aging columns. Use a longer interval or a shorter "through".' });
    }
    if (p.amountMin && p.amountMax && Number(p.amountMin) > Number(p.amountMax)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountMax'], message: 'Maximum amount is less than the minimum.' });
    }
  });

export type ReportParams = z.infer<typeof reportParamsSchema>;

/** Parse URLSearchParams (or a plain object) into ReportParams; empty strings are ignored. */
export function parseReportParams(input: URLSearchParams | Record<string, unknown>) {
  const obj: Record<string, string> = {};
  const entries: [string, unknown][] =
    input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input ?? {});
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') obj[k] = s;
  }
  return reportParamsSchema.safeParse(obj);
}

/** Saved formatting / display options stored with a memorized report. */
export const reportDisplaySchema = z
  .object({
    numberFormat: z.record(z.unknown()).optional(),
    collapsed: z.boolean().optional(),
    title: z.string().max(200).optional(),
    subtitle: z.string().max(300).optional(),
    hiddenColumns: z.array(z.string().max(60)).max(64).optional(),
  })
  .strip();

export const memorizeReportSchema = z.object({
  name: z.string().trim().min(1, 'Report name is required').max(255),
  reportType: z.string().trim().min(1, 'Report type is required').max(100),
  config: z.record(z.unknown()).default({}),
  groupId: zId.nullable().optional(),
});

export const updateMemorizedReportSchema = z.object({
  name: z.string().trim().min(1, 'Report name is required').max(255).optional(),
  config: z.record(z.unknown()).optional(),
  groupId: zId.nullable().optional(),
});

export const memorizedGroupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(255),
});

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

export const reportScheduleSchema = z
  .object({
    name: z.string().trim().min(1, 'Schedule name is required').max(255),
    memorizedReportId: zId.nullable().optional(),
    groupId: zId.nullable().optional(),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    /** First run (YYYY-MM-DD); defaults to today. */
    startDate: zDateStr.optional(),
    format: z.enum(['csv', 'xlsx']).default('csv'),
    /** Sub-folder name inside the company's report-export folder. */
    folder: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9 _.-]*$/, 'Folder name may only contain letters, numbers, spaces, dots, dashes and underscores')
      .refine((s) => !s.includes('..'), 'Folder name may not contain ".."')
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine((s) => !!s.memorizedReportId !== !!s.groupId, {
    message: 'Choose either one memorized report or one report group.',
    path: ['memorizedReportId'],
  });

export const updateReportScheduleSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  frequency: z.enum(SCHEDULE_FREQUENCIES).optional(),
  isActive: z.boolean().optional(),
  format: z.enum(['csv', 'xlsx']).optional(),
});

export const PIVOT_DIMENSIONS = ['account', 'accountType', 'class', 'customer', 'vendor', 'name', 'item', 'month', 'quarter', 'year', 'txnType'] as const;
export const PIVOT_MEASURES = ['amount', 'debit', 'credit', 'count', 'quantity'] as const;

export const pivotSchema = z.object({
  rows: z.enum(PIVOT_DIMENSIONS),
  cols: z.enum(PIVOT_DIMENSIONS).optional(),
  measure: z.enum(PIVOT_MEASURES).default('amount'),
  source: z.enum(['gl', 'sales']).default('gl'),
  from: zDateStr.optional(),
  to: zDateStr.optional(),
  section: z.string().max(40).optional(),
});
