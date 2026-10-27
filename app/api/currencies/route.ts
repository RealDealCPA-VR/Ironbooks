/**
 * GET  /api/currencies   — list all currencies for the current company
 * POST /api/currencies   — upsert a currency (insert or update rate)
 *                          body: { code, name, rateToBase, isBase? }
 *                          If isBase is true, delegates to setBaseCurrency (rate is forced to 1).
 *                          The home currency can't change once foreign-currency data exists.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listCurrencies, setBaseCurrency, upsertCurrency } from '@/lib/services/currencies';
import { routeError, requireJsonObject } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await listCurrencies(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    return routeError(err, 'GET /api/currencies');
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
      return NextResponse.json({ error: 'code is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 400 });
    }

    // The services validate the code (3 letters), the name and the rate (plain 400s).
    if (isBase === true) {
      const row = await setBaseCurrency(ctx, { code, name });
      return NextResponse.json(row, { status: 200 });
    }

    if (rateToBase === undefined || rateToBase === null || rateToBase === '') {
      return NextResponse.json({ error: 'rateToBase is required for non-base currencies', code: 'VALIDATION' }, { status: 400 });
    }

    const row = await upsertCurrency(ctx, { code, name, rateToBase });
    return NextResponse.json(row, { status: 200 });
  } catch (err) {
    return routeError(err, 'POST /api/currencies');
  }
}
