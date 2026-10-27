/**
 * GET /api/payroll/unpaid-time?employeeId=&periodStart=&periodEnd=
 *
 * Time entries for an employee in the pay period that have NOT been consumed by
 * a paycheck yet (no `[payroll:<paycheckId>]` tag in the description). Used by
 * the pay-run page's "Pull time" action. Returns { entries, totalHours }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { unpaidTimeForPayroll } from '@/lib/services/payroll';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[payroll/unpaid-time] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const employeeId = searchParams.get('employeeId');
    const periodStart = searchParams.get('periodStart');
    const periodEnd = searchParams.get('periodEnd');

    if (!employeeId || !periodStart || !periodEnd) {
      return NextResponse.json(
        { error: 'employeeId, periodStart and periodEnd are required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    // Real calendar days only (`new Date('2026-02-30')` rolls over to March 2).
    const start = parseDateInput(periodStart);
    const end = parseDateInput(periodEnd);
    if (!start || !end) {
      return NextResponse.json(
        { error: 'periodStart/periodEnd must be valid dates', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const result = await unpaidTimeForPayroll(ctx, {
      employeeId,
      periodStart: start,
      periodEnd: end,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
