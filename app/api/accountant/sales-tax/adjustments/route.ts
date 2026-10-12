/**
 * POST /api/accountant/sales-tax/adjustments — Sales Tax Adjustment (discount, rounding,
 * penalty, interest) posted against an agency's liability. Body: salesTaxAdjustmentSchema.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createSalesTaxAdjustment } from '@/lib/services/accountant/salesTaxTools';
import { zodErrorBody } from '@/lib/validation/helpers';
import { salesTaxAdjustmentSchema } from '@/lib/validation/accountant';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = salesTaxAdjustmentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createSalesTaxAdjustment(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/adjustments');
  }
}
