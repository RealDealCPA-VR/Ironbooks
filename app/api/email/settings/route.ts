/**
 * Preferences > Send Forms: the company file's mail server (prefsperms).
 *
 * GET    /api/email/settings — the set-up (never the password; `hasPassword` instead), plus
 *                              `hostOnly`: true when the page is used from another computer
 * PUT    /api/email/settings — save it (password sealed with the file's own secret)
 * DELETE /api/email/settings — remove it (sends fall back to the environment, or are off)
 *
 * Needs Company & Preferences > Send Forms (email set-up): view / modify. Saving and removing only
 * from the computer that holds the company file (lib/net/hostOnly.ts): a mail server address
 * typed on another computer would make the host connect to any address on its own network.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getEmailSetup, removeEmailSetup, saveEmailSetup } from '@/lib/services/emailSettings';
import { hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { approveQuietFileHere } from '@/lib/net/fileTrust';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { emailSetupSchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ ...(await getEmailSetup(ctx)), hostOnly: isRemoteRequest(req) });
  } catch (err) {
    return routeError(err, 'GET /api/email/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse();
    const parsed = emailSetupSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    await approveQuietFileHere(ctx, { remote: isRemoteRequest(req) }).catch((err) => console.warn('[file-trust] could not approve the company file on this computer:', (err as Error)?.message ?? err));
    return NextResponse.json({ ...(await saveEmailSetup(ctx, parsed.data)), hostOnly: false });
  } catch (err) {
    return routeError(err, 'PUT /api/email/settings');
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse();
    return NextResponse.json({ ...(await removeEmailSetup(ctx)), hostOnly: false });
  } catch (err) {
    return routeError(err, 'DELETE /api/email/settings');
  }
}
