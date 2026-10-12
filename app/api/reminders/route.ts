/**
 * GET /api/reminders — the Reminders list (Preferences > Reminders decides what shows and how):
 *   { asOf, sections: [{ key, label, mode: 'summary'|'list', count, total, href, items }] }
 * Categories outside the member's permissions are left out by the service.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getReminders } from '@/lib/services/reminders';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getReminders(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/reminders');
  }
}
