/**
 * Carry a file-password unlock across a sandbox switch ("Try it on a copy").
 *
 * The unlock cookie (lib/auth.ts createUnlockToken) is bound to the ACTIVE data directory, so
 * switching the server into the sandbox copy (or back to the real file) would otherwise send a
 * user of a password-protected file back to the unlock screen. The copy is a copy of the file
 * the caller already unlocked (same file password), and leaving is only allowed to an Admin of
 * the real file, so the sandbox routes re-issue the unlock for the new directory, but ONLY
 * when the request carried a valid unlock for the directory it started on.
 *
 * Desktop: the shell relaunches the server into the other folder with a fresh per-launch
 * nonce, which voids every unlock cookie, so there the file password is asked again.
 */
import type { NextResponse } from 'next/server';
import { UNLOCK_COOKIE, createUnlockToken, hasValidUnlockCookie } from '@/lib/auth';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';

type HeaderSource = { get(name: string): string | null };

/** Call BEFORE switching: true when the request holds a valid unlock for the current file. */
export function heldUnlock(): Promise<boolean> {
  return hasValidUnlockCookie();
}

/** Call AFTER switching: re-issue the unlock for the now-active data directory. */
export function reissueUnlockCookie(
  res: NextResponse,
  held: boolean,
  headers: HeaderSource,
): NextResponse {
  if (!held) return res;
  res.cookies.set(UNLOCK_COOKIE, createUnlockToken(), {
    httpOnly: true,
    secure: cookieSecure(originFromHeaders(headers)),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return res;
}
