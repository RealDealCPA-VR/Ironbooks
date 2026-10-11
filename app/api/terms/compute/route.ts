/**
 * GET /api/terms/compute?terms=<id|code|name>&date=<ISO>&payDate=<ISO>&amount=<decimal>
 * Due date, early-payment discount and a plain-language description for a Terms list entry.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { previewTerms } from '@/lib/services/lists/terms';

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const terms = sp.get('terms');
    const date = parseDate(sp.get('date')) ?? new Date();
    if (!terms) return NextResponse.json({ error: 'terms is required', code: 'VALIDATION' }, { status: 400 });
    const amount = sp.get('amount');
    if (amount && !/^-?\d+(\.\d+)?$/.test(amount)) {
      return NextResponse.json({ error: 'amount must be a number', code: 'VALIDATION' }, { status: 400 });
    }
    const ctx = await getServerContext();
    return NextResponse.json(await previewTerms(ctx, terms, date, parseDate(sp.get('payDate')), amount));
  } catch (err) {
    return routeError(err, 'GET /api/terms/compute');
  }
}
