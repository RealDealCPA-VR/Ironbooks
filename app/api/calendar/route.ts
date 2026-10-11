/**
 * GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — transactions entered and due, to-dos and
 * scheduled memorized transactions per day (areas the member can't view are left out).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCalendar } from '@/lib/services/calendar';
import { getPreferences } from '@/lib/services/company';
import { todayInTimeZone } from '@/lib/preferences';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { calendarQuerySchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const parsed = calendarQuerySchema.safeParse({ from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined });
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const prefs = await getPreferences(ctx);
    return NextResponse.json(await getCalendar(ctx, { ...parsed.data, today: todayInTimeZone(prefs.timezone) }));
  } catch (err) {
    return routeError(err, 'GET /api/calendar');
  }
}
