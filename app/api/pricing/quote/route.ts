/**
 * POST /api/pricing/quote — server-side price lookup for document lines (advanced pricing).
 * Body: { customerId?, date, classId?, salesRepId?, jobId?, lines: [{ itemId, quantity }] }
 * Returns { quotes: PriceQuote[] } — price, which rule/level applied, and every candidate.
 * The document services re-run the same engine on save, so a quote is advisory only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { quotePrices } from '@/lib/services/pricing';
import { zodErrorBody } from '@/lib/validation/helpers';
import { quoteSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = quoteSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { lines, ...header } = parsed.data;
    const quotes = await quotePrices(ctx, header, lines);
    return NextResponse.json({ quotes });
  } catch (err) {
    return routeError(err, 'POST /api/pricing/quote');
  }
}
