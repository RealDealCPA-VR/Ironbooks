/**
 * GET /api/reports/1099
 *
 * Query params:
 *   year       (required) — 4-digit calendar year, e.g. 2025.
 *   worksheet  (optional) — when "1", returns the account-mapped NEC + MISC
 *               worksheet ({ year, mapped, rows }) instead of the legacy
 *               Vendor1099Row[] (NEC-only, >= $600) array.
 *
 * The legacy array shape is kept as the default for existing consumers
 * (1099 e-file page, XML/PDF exports).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { vendor1099Report, vendor1099Worksheet } from '@/lib/services/statements';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[1099] Unexpected error', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const yearParam = searchParams.get('year');
    if (!yearParam) {
      return NextResponse.json({ error: 'year query parameter is required.' }, { status: 400 });
    }

    const year = parseInt(yearParam, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year value.' }, { status: 400 });
    }

    if (searchParams.get('worksheet') === '1') {
      const worksheet = await vendor1099Worksheet(ctx, { year });
      return NextResponse.json(worksheet);
    }

    const rows = await vendor1099Report(ctx, { year });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
