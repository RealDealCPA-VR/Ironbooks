/**
 * GET  /api/currencies   — list all currencies for the current company
 * POST /api/currencies   — upsert a currency (insert or update rate)
 *                          body: { code, name, rateToBase, isBase? }
 *                          If isBase is true, delegates to setBaseCurrency (rate is forced to 1).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listCurrencies, setBaseCurrency, upsertCurrency } from '@/lib/services/currencies';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[currencies] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await listCurrencies(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { code, name, rateToBase, isBase } = body as {
      code: string;
      name: string;
      rateToBase?: string | number;
      isBase?: boolean;
    };

    if (!code) {
      return NextResponse.json({ error: 'code is required' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (isBase) {
      const row = await setBaseCurrency(ctx, { code, name });
      return NextResponse.json(row, { status: 200 });
    }

    if (rateToBase === undefined || rateToBase === null || rateToBase === '') {
      return NextResponse.json({ error: 'rateToBase is required for non-base currencies' }, { status: 400 });
    }

    const row = await upsertCurrency(ctx, { code, name, rateToBase });
    return NextResponse.json(row, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
