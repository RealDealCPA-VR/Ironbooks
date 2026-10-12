/**
 * GET /api/ai/prefill?vendorId=<uuid>  or  ?payee=<name>[&amount=<decimal>]
 *   → PrefillResult { source: 'vendor-default'|'last-used'|'learned'|'none', lines[] }
 * QB "pre-fill accounts for vendor" for Bills / Write Checks / Expenses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { vendorPrefill } from '@/lib/services/aiCategorizer';
import { aiErrorResponse } from '../_errors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const vendorId = sp.get('vendorId') || null;
    const payee = sp.get('payee')?.slice(0, 255) || null;
    const amount = sp.get('amount');
    if (vendorId && !z.string().uuid().safeParse(vendorId).success) {
      return NextResponse.json({ error: 'vendorId must be a uuid.' }, { status: 400 });
    }
    if (!vendorId && !payee) return NextResponse.json({ source: 'none', lines: [] });
    const safeAmount = amount && /^-?\d+(\.\d{1,2})?$/.test(amount) ? amount : null;
    return NextResponse.json(await vendorPrefill(ctx, { vendorId, payee, amount: safeAmount }));
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/prefill');
  }
}
