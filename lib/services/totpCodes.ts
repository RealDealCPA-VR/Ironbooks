/**
 * Two-factor codes are used once.
 *
 * An authenticator code is valid for about 90 seconds (its own 30-second step and one either side
 * for clock drift, lib/totp.ts). Without a memory, a code seen over someone's shoulder, or read
 * from a request, could sign in again within that time. The step of the last code accepted for a
 * user is kept on their row (users.totp_last_step); a code is accepted only for a NEWER step, and
 * the check-and-store is one UPDATE, so two requests racing with the same code can't both pass.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { matchTotpStep } from '@/lib/totp';

/**
 * True when `code` is a current code for `secret` (RFC 6238, ±1 step) that has not been used
 * before for this user; it is then marked used. False for a wrong code or a code (or an older one)
 * already accepted.
 */
export async function acceptTotpCode(
  db: DB,
  userId: string,
  secret: string,
  code: string,
  timeMs: number = Date.now(),
): Promise<boolean> {
  const step = matchTotpStep(secret, String(code ?? ''), timeMs);
  if (step === null) return false;
  const marked = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id });
  return marked.length > 0;
}
