/** POST /api/auth/logout — end the server-side session (multi-user list) and clear the cookie. */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { AGENT_NOT_AVAILABLE_MESSAGE } from '@/lib/agentContext';
import { inServiceScope } from '@/lib/context';
import { endSession } from '@/lib/services/sessions';

export async function POST() {
  // Signing out is a person's own act. Run for an agent (lib/context.ts runWithServiceContext), the
  // session cookie in reach belongs to whoever's request the work runs in, perhaps the person who
  // approved it: never end their session or clear their cookie. Refused before reading anything.
  if (inServiceScope()) {
    return NextResponse.json({ error: AGENT_NOT_AVAILABLE_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    const store = await cookies();
    const token = verifySessionToken(store.get(SESSION_COOKIE)?.value);
    if (token?.sid) await endSession(await getDb(), token.sid, 'logout');
  } catch (err) {
    // Never block logout on bookkeeping; the cookie is cleared regardless.
    console.error('[auth/logout] could not end session:', err);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
