/**
 * Home Currency Adjustment (p1 fx — QB Company > Manage Currency > Home Currency Adjustment).
 *
 * GET  /api/currencies/home-currency-adjustment            — past adjustments, newest first
 * POST /api/currencies/home-currency-adjustment
 *   { date, rates?: { EUR: "1.12", ... }, memo?, preview?: boolean, updateCurrencyList?: boolean }
 *   preview=true returns what would be posted (nothing is written); otherwise posts the
 *   adjustment (+ its next-day reversal for A/R, A/P and loans) and returns it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import {
  createHomeCurrencyAdjustment,
  listHomeCurrencyAdjustments,
  previewHomeCurrencyAdjustment,
} from '@/lib/services/homeCurrencyAdjustment';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listHomeCurrencyAdjustments(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/currencies/home-currency-adjustment');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as {
      date?: string;
      rates?: Record<string, string | number>;
      memo?: string | null;
      preview?: boolean;
      updateCurrencyList?: boolean;
    };
    if (!body.date || isNaN(new Date(body.date).getTime())) {
      return NextResponse.json({ error: 'Pick the date of the adjustment.', code: 'VALIDATION' }, { status: 400 });
    }
    if (body.rates != null && (typeof body.rates !== 'object' || Array.isArray(body.rates))) {
      return NextResponse.json({ error: 'rates must map currency codes to rates.', code: 'VALIDATION' }, { status: 400 });
    }
    const input = {
      date: new Date(body.date),
      rates: body.rates ?? undefined,
      memo: body.memo ?? null,
      updateCurrencyList: body.updateCurrencyList,
    };
    if (body.preview) return NextResponse.json(await previewHomeCurrencyAdjustment(ctx, input));
    return NextResponse.json(await createHomeCurrencyAdjustment(ctx, input), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/currencies/home-currency-adjustment');
  }
}
