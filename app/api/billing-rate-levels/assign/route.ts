/**
 * POST /api/billing-rate-levels/assign — { employeeId | vendorId | otherNameId, levelId | null }
 * Assigning edits the person's record, so the handler also checks that record's area
 * (payroll for employees, vendors for vendors, lists for other names).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { requirePermission } from '@/lib/services/access';
import { assignBillingRateLevel } from '@/lib/services/lists/billingRates';
import { zodErrorBody, zUuid } from '@/lib/validation/helpers';

const schema = z.object({
  employeeId: zUuid.optional(),
  vendorId: zUuid.optional(),
  otherNameId: zUuid.optional(),
  levelId: zUuid.nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { levelId, ...person } = parsed.data;
    if (person.employeeId) requirePermission(ctx, 'payroll', 'modify');
    else if (person.vendorId) requirePermission(ctx, 'vendors', 'modify');
    return NextResponse.json(await assignBillingRateLevel(ctx, person, levelId));
  } catch (err) {
    return routeError(err, 'POST /api/billing-rate-levels/assign');
  }
}
