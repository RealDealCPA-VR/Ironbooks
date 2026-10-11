/**
 * GET /api/preferences — the resolved Preferences for the signed-in member:
 *   { company: CompanyPreferences, my: MyPreferences }
 * Company preferences are saved through PATCH /api/company { settings } (Company & Preferences:
 * modify); My Preferences through PATCH /api/preferences/my.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getAllPreferences } from '@/lib/services/preferences';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getAllPreferences(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/preferences');
  }
}
