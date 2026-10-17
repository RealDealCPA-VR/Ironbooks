/**
 * /api/payroll/accruals — sick & vacation accrual balances.
 *
 * GET  [?employeeId=<uuid>] → SickVacationBalanceRow[]
 *        Derived balances (policy + accrual over posted paychecks) for one or
 *        all employees.
 *
 * PUT  body { employeeId: string, policy: EmployeeAccrualPolicyInput | null }
 *        Sets (replaces) the employee's accrual policy; null clears it.
 *        → updated SickVacationBalanceRow.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import {
  sickVacationBalances,
  setEmployeeAccrualPolicy,
  type EmployeeAccrualPolicyInput,
} from '@/lib/services/payrollReports';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/payroll/accruals]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const employeeId = req.nextUrl.searchParams.get('employeeId') ?? undefined;
    const rows = await sickVacationBalances(ctx, { employeeId });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as {
      employeeId?: string;
      policy?: EmployeeAccrualPolicyInput | null;
    };

    if (!body.employeeId || typeof body.employeeId !== 'string') {
      return NextResponse.json(
        { error: 'employeeId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const row = await setEmployeeAccrualPolicy(ctx, body.employeeId, body.policy ?? null);
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}
