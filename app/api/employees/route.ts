/**
 * GET  /api/employees  — list employees for the active company.
 * POST /api/employees  — create a new employee.
 *
 * Query params for GET:
 *   ?includeInactive=true  — include deactivated employees.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listEmployees, createEmployee } from '@/lib/services/payroll';
import { ServiceError } from '@/lib/services/_base';
import { hasFlag } from '@/lib/services/access';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createEmployeeSchema } from '@/lib/validation/employees';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[employees] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * Never send the full SSN to the browser unless the caller's roles grant "view sensitive
 * payroll data" (Users & Roles); everyone else gets the last 4 digits only.
 */
function maskEmployee<T extends { ssn?: string | null }>(emp: T, showSsn: boolean) {
  const digits = (emp.ssn ?? '').replace(/\D/g, '');
  return {
    ...emp,
    ssn: showSsn ? (emp.ssn ?? null) : undefined,
    ssnLast4: digits.length >= 4 ? digits.slice(-4) : null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const list = await listEmployees(ctx, { includeInactive });
    const showSsn = hasFlag(ctx, 'sensitivePayroll');
    return NextResponse.json(list.map((e) => maskEmployee(e, showSsn)));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createEmployeeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const employee = await createEmployee(ctx, parsed.data);
    return NextResponse.json(maskEmployee(employee, hasFlag(ctx, 'sensitivePayroll')), {
      status: 201,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
