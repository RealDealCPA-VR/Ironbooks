/**
 * GET   /api/pricing/settings — advanced pricing preferences
 * PATCH /api/pricing/settings — { enabled?, conflictMode?: 'lowest'|'priority', defaultRounding? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getPricingSettings, updatePricingSettings } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { pricingSettingsSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getPricingSettings(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/pricing/settings');
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = pricingSettingsSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updatePricingSettings(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/pricing/settings');
  }
}
