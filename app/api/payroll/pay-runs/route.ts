/**
 * GET  /api/payroll/pay-runs — past pay runs, newest first, each with paychecks.
 * POST /api/payroll/pay-runs — create a batch pay run:
 *
 *   {
 *     payDate, periodStart?, periodEnd?, memo?, periodsPerYear?,
 *     employees: [{
 *       employeeId,
 *       hours?,            // hourly default (80 if omitted)
 *       amount?,           // gross override
 *       deductions?,       // [{ kind:'deduction', name, amount, payrollItemId? }]
 *       timeEntryIds?,     // pulled time entries (hours = sum x employee rate)
 *     }]
 *   }
 *
 * NOT all-or-nothing: per-employee failures are recorded in results[] with
 * ok:false + error, while the rest of the run posts. Returns 201 with
 * { payRun, results }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createPayRun, listPayRuns } from '@/lib/services/payroll';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createPayRunSchema } from '@/lib/validation/payroll';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    // details.results: each employee's outcome when no paycheck could be created (lib/services/payroll.ts createPayRun).
    return NextResponse.json({ error: err.message, code: err.code, details: err.details ?? null }, { status });
  }
  console.error('[payroll/pay-runs] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listPayRuns(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createPayRunSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const result = await createPayRun(ctx, {
      ...parsed.data,
      employees: parsed.data.employees.map((e) => ({
        ...e,
        deductions: e.deductions ?? [],
        timeEntryIds: e.timeEntryIds ?? [],
      })),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
