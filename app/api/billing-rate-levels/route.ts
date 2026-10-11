/**
 * GET  /api/billing-rate-levels — Billing Rate Level list (?includeInactive=true)
 * POST /api/billing-rate-levels — add { name, type: fixed_rate|custom, fixedRate?, items?: [{itemId, rate}] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createBillingRateLevel, listBillingRateLevels } from '@/lib/services/lists/billingRates';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true';
    return NextResponse.json({ levels: await listBillingRateLevels(ctx, { includeInactive }) });
  } catch (err) {
    return routeError(err, 'GET /api/billing-rate-levels');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await createBillingRateLevel(ctx, await req.json().catch(() => ({}))), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/billing-rate-levels');
  }
}
