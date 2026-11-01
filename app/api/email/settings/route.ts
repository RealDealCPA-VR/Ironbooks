/**
 * Preferences > Send Forms: the company file's mail server (prefsperms).
 *
 * GET    /api/email/settings — the set-up (never the password; `hasPassword` instead)
 * PUT    /api/email/settings — save it (password sealed with the file's own secret)
 * DELETE /api/email/settings — remove it (sends fall back to the environment, or are off)
 *
 * Needs Company & Preferences > Send Forms (email set-up): view / modify.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getEmailSetup, removeEmailSetup, saveEmailSetup } from '@/lib/services/emailSettings';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { emailSetupSchema } from '@/lib/validation/prefs';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getEmailSetup(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/email/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = emailSetupSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await saveEmailSetup(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'PUT /api/email/settings');
  }
}

export async function DELETE() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await removeEmailSetup(ctx));
  } catch (err) {
    return routeError(err, 'DELETE /api/email/settings');
  }
}
