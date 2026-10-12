/**
 * PATCH /api/tax-rates/:id — edit a sales tax rate item { name?, rate? (0..1), agencyId?, isActive? }.
 * A new rate applies to new transactions; posted invoices keep the tax they charged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { updateTaxRate } from '@/lib/services/salesTax';
import { taxRatePatchSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = taxRatePatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateTaxRate(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/tax-rates/:id');
  }
}
