/**
 * POST /api/portal/logout — end the employee portal session: on the server (the employee's portal
 * sign-out count goes up, so this token and any copy of it stop working, lib/auth.ts
 * endPortalSessions) and in this browser (the cookie is cleared).
 */
import { NextResponse } from 'next/server';
import { PORTAL_COOKIE, endPortalSessions } from '@/lib/auth';

export async function POST() {
  try {
    await endPortalSessions();
  } catch (err) {
    // Signing out of this browser always works, even if the company file can't be reached.
    console.warn('[portal/logout] could not end the portal session on the server:', (err as Error)?.message ?? err);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PORTAL_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
