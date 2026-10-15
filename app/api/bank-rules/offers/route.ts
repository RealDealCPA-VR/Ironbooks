/**
 * GET  /api/bank-rules/offers → { offers: RuleOffer[] } — "Always categorize SHELL OIL as Fuel?"
 * POST /api/bank-rules/offers
 *   { action: 'accept', pattern, accountId, direction, mode? } → 201 BankRule (learned rule)
 *   { action: 'dismiss', pattern, accountId, direction }        → { ok: true } (never ask again)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { acceptOffer, dismissOffer, ruleOffers } from '@/lib/services/bankRules';
import { offerActionSchema } from '@/lib/bankRules/schemas';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ offers: await ruleOffers(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/bank-rules/offers');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = offerActionSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const b = parsed.data;
    if (b.action === 'accept') {
      const rule = await acceptOffer(ctx, {
        pattern: b.pattern,
        accountId: b.accountId,
        direction: b.direction,
        mode: b.mode,
      });
      return NextResponse.json(rule, { status: 201 });
    }
    await dismissOffer(ctx, { pattern: b.pattern, accountId: b.accountId, direction: b.direction });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'POST /api/bank-rules/offers');
  }
}
