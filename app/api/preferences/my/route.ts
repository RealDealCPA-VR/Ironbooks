/**
 * GET   /api/preferences/my — the signed-in member's own preferences ("My Preferences")
 * PATCH /api/preferences/my — save some of them (only affects this person)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getMyPreferences, updateMyPreferences } from '@/lib/services/preferences';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { myPreferencesSchema } from '@/lib/validation/prefs';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getMyPreferences(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/preferences/my');
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = myPreferencesSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateMyPreferences(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/preferences/my');
  }
}
