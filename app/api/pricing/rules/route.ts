/**
 * GET  /api/pricing/rules — price rules (priority order)
 * POST /api/pricing/rules — create a rule (conditions + adjustment + tiers + rounding + dates)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createPriceRule, listPriceRules } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { priceRuleSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ rules: await listPriceRules(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/pricing/rules');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = priceRuleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createPriceRule(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/pricing/rules');
  }
}
