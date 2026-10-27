/**
 * GET   /api/employees/[id]  — fetch a single employee (SSN masked to last 4).
 * PATCH /api/employees/[id]  — update employee master data / payroll info, and
 *                              deactivate (isActive:false) / reactivate (true).
 *
 * PATCH body (all fields optional):
 *   { firstName, lastName, email, payType, payRate, ssn, w4, address, isActive }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getEmployee, updateEmployee } from '@/lib/services/payroll';
import { ServiceError } from '@/lib/services/_base';
import { hasFlag } from '@/lib/services/access';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateEmployeeSchema } from '@/lib/validation/employees';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[employees/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * Never send the full SSN to the browser unless the caller's roles grant "view sensitive
 * payroll data" (Users & Roles); everyone else gets the last 4 digits only.
 */
function maskEmployee<T extends { ssn?: string | null; portalPasswordHash?: string | null }>(emp: T, showSsn: boolean) {
  const digits = (emp.ssn ?? '').replace(/\D/g, '');
  // The portal password hash never leaves the server (a bcrypt hash can be cracked offline);
  // the page only needs to know whether portal access is set up.
  const { portalPasswordHash, ...rest } = emp;
  return {
    ...rest,
    hasPortalAccess: Boolean(portalPasswordHash),
    ssn: showSsn ? (emp.ssn ?? null) : undefined,
    ssnLast4: digits.length >= 4 ? digits.slice(-4) : null,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const employee = await getEmployee(ctx, id);
    return NextResponse.json(maskEmployee(employee, hasFlag(ctx, 'sensitivePayroll')));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    // zod strip mode keeps absent keys absent — only provided fields are updated.
    const parsed = updateEmployeeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const updated = await withVersionCheck(ctx, 'employee', id, expectedVersion(req), (c) => updateEmployee(c, id, parsed.data));

    return NextResponse.json(maskEmployee(updated, hasFlag(ctx, 'sensitivePayroll')));
  } catch (err) {
    return errorResponse(err);
  }
}
