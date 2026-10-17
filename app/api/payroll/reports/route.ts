/**
 * GET /api/payroll/reports?from=YYYY-MM-DD&to=YYYY-MM-DD[&employeeId=<uuid>]
 *
 * Returns the three after-the-fact payroll reports in one payload:
 *   { summary, detail, liabilities }
 *
 * - summary:     payroll summary by employee (gross, each tax, deductions,
 *                employer accruals, net) for the range.
 * - detail:      one row per posted, non-void paycheck in the range.
 * - liabilities: liability balance by item (withheld + employer accruals minus
 *                payments against 2300) as of the range end date.
 *
 * Defaults: from = Jan 1 of the current year, to = today (UTC).
 *
 * ?report=earnings-summary | item-detail | transactions-by-payee | workers-comp returns that
 * single report instead (Employee Earnings Summary, Payroll Item Detail, Payroll Transactions
 * by Payee, Workers Comp Summary).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  employeeEarningsSummary,
  payrollItemDetail,
  payrollSummary,
  payrollDetail,
  payrollLiabilityBalances,
  payrollTransactionsByPayee,
  workersCompSummary,
} from '@/lib/services/payrollReports';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[payroll/reports] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const employeeId = searchParams.get('employeeId') ?? undefined;

    if (fromParam && !DATE_RE.test(fromParam)) {
      return NextResponse.json(
        { error: 'from must be YYYY-MM-DD', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (toParam && !DATE_RE.test(toParam)) {
      return NextResponse.json(
        { error: 'to must be YYYY-MM-DD', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    // Pay dates are stored as UTC midnight ('YYYY-MM-DD' parses as UTC), so build
    // the default bounds in UTC too.
    const now = new Date();
    const from = fromParam
      ? new Date(fromParam)
      : new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const to = toParam
      ? new Date(toParam)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Single-report mode (QB report parity): ?report=earnings-summary | item-detail |
    // transactions-by-payee | workers-comp  (item-detail also takes ?item=<name>).
    const report = searchParams.get('report');
    if (report) {
      const range = { from, to, employeeId };
      switch (report) {
        case 'earnings-summary':
          return NextResponse.json(await employeeEarningsSummary(ctx, range));
        case 'item-detail':
          return NextResponse.json(await payrollItemDetail(ctx, { ...range, item: searchParams.get('item') ?? undefined }));
        case 'transactions-by-payee':
          return NextResponse.json(await payrollTransactionsByPayee(ctx, range));
        case 'workers-comp':
          return NextResponse.json(await workersCompSummary(ctx, range));
        default:
          return NextResponse.json({ error: 'Unknown report', code: 'VALIDATION' }, { status: 400 });
      }
    }

    const [summary, detail, liabilities] = await Promise.all([
      payrollSummary(ctx, { from, to, employeeId }),
      payrollDetail(ctx, { from, to, employeeId }),
      payrollLiabilityBalances(ctx, { asOf: to }),
    ]);

    return NextResponse.json({ summary, detail, liabilities });
  } catch (err) {
    return errorResponse(err);
  }
}
