/**
 * GET /api/journal-entries/adjusting?from=YYYY-MM-DD&to=YYYY-MM-DD[&includeVoid=true]
 *   — Adjusting Journal Entries report data (getAdjustingEntries).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getAdjustingEntries } from '@/lib/services/journal';
import { queryDate } from '@/lib/validation/helpers';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    // Real calendar days only (VALIDATION -> 400): new Date('2026-02-30') rolled over to March 2.
    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');
    // An inclusive "to" date covers the whole day.
    const toEnd = to ? new Date(to.getTime() + 86_399_999) : undefined;
    return NextResponse.json(
      await getAdjustingEntries(ctx, { from, to: toEnd, includeVoid: sp.get('includeVoid') === 'true' }),
    );
  } catch (err) {
    return routeError(err, 'journal-entries/adjusting');
  }
}
