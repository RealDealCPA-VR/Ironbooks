/**
 * PATCH /api/pricing/customers/:id — assign a customer's type and/or price level
 * Body: { customerTypeId?: uuid|null, priceLevelId?: uuid|null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assignCustomerPricing } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { customerPricingAssignSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = customerPricingAssignSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await assignCustomerPricing(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/pricing/customers/:id');
  }
}
