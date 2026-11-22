/**
 * POST /api/billing-rate-levels/assign — { employeeId | vendorId | otherNameId, levelId | null }
 * Assigning edits the person's record, so the handler also checks that record's area
 * (payroll for employees, vendors for vendors, lists for other names).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { requirePermission } from '@/lib/services/access';
import { assignBillingRateLevel } from '@/lib/services/lists/billingRates';
import { zodErrorBody } from '@/lib/validation/helpers';
import { assignBillingRateLevelSchema } from '@/lib/validation/lists';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = assignBillingRateLevelSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { levelId, ...person } = parsed.data;
    if (person.employeeId) requirePermission(ctx, 'payroll.employees', 'modify');
    else if (person.vendorId) requirePermission(ctx, 'vendors.center', 'modify');
    return NextResponse.json(await assignBillingRateLevel(ctx, person, levelId));
  } catch (err) {
    return routeError(err, 'POST /api/billing-rate-levels/assign');
  }
}
