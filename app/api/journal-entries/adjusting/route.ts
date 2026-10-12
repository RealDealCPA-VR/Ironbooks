/**
 * GET /api/journal-entries/adjusting?from=YYYY-MM-DD&to=YYYY-MM-DD[&includeVoid=true]
 *   — Adjusting Journal Entries report data (getAdjustingEntries).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getAdjustingEntries } from '@/lib/services/journal';

function parseDate(v: string | null): Date | undefined | null {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const from = parseDate(sp.get('from'));
    const to = parseDate(sp.get('to'));
    if (from === null || to === null) {
      return NextResponse.json({ error: 'from / to must be valid dates.' }, { status: 400 });
    }
    // An inclusive "to" date covers the whole day.
    const toEnd = to ? new Date(to.getTime() + 86_399_999) : undefined;
    return NextResponse.json(
      await getAdjustingEntries(ctx, { from, to: toEnd, includeVoid: sp.get('includeVoid') === 'true' }),
    );
  } catch (err) {
    return routeError(err, 'journal-entries/adjusting');
  }
}
