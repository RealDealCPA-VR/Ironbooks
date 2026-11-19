/**
 * POST /api/email/test — Preferences > Send Forms > Test (prefsperms).
 *
 * Body: { to?: string, draft?: <the mail server form> }. Without `draft` the saved settings are
 * tested (and the result remembered); with it the typed, not yet saved settings are (needs Send
 * Forms set-up: modify). Anyone without the set-up right can test the saved settings, to their own
 * address only. Answers 200 { ok, message, to, from } — a failed test is a plain explanation, not
 * an error. The network policy applies like for any email.
 *
 * Typed settings are tested only from the computer that holds the company file
 * (lib/net/hostOnly.ts): a mail server typed on another computer would make the host connect to
 * any address on its own network and send the error back. The saved settings (set up on the host)
 * can be tested from anywhere.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { sendTestEmail } from '@/lib/services/emailSettings';
import { HOST_ONLY_ACTION_MESSAGE, hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { emailTestSchema } from '@/lib/validation/prefs';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = emailTestSchema.safeParse(await requireJsonObject(req, { optional: true }));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    if (parsed.data.draft && isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    return NextResponse.json(await sendTestEmail(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/email/test');
  }
}
