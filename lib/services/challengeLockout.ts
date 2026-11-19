/**
 * Wrong answers to the "I forgot my password" challenge question, counted in the company file.
 *
 * The sign-in rate limiter (lib/net/rateLimit.ts) is kept in memory: it is the first line, but
 * restarting the app clears it, and a challenge answer can be short. So every wrong answer is also
 * counted on the user's row: after MAX_CHALLENGE_FAILURES wrong answers no answer is checked for
 * 15 minutes, and each lockout after that lasts twice as long as the one before, up to a day. A
 * right answer, or signing in with the password, clears the count (a person who mistyped twice
 * and then remembered loses nothing).
 */
import { eq, sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { users } from '@/lib/db/schema';

/** Wrong answers that start a lockout. */
export const MAX_CHALLENGE_FAILURES = 5;
/** The first lockout, in minutes; each later one doubles. */
export const FIRST_CHALLENGE_LOCKOUT_MINUTES = 15;
/** The longest lockout, in minutes (one day). */
export const MAX_CHALLENGE_LOCKOUT_MINUTES = 24 * 60;

interface ChallengeCounters {
  id: string;
  challengeFailedAttempts?: number | null;
  challengeLockouts?: number | null;
  challengeLockedUntil?: Date | null;
}

/** Milliseconds until a challenge answer may be checked again for this user (0: now). */
export function challengeLockRemainingMs(user: Pick<ChallengeCounters, 'challengeLockedUntil'>, now: number = Date.now()): number {
  const until = user.challengeLockedUntil?.getTime() ?? 0;
  return until > now ? until - now : 0;
}

/**
 * Count one wrong answer. The count, the lockout and its length are worked out in one UPDATE from
 * the row as it is, so answers racing each other are all counted. Returns the lockout end when this
 * answer started one.
 */
export async function recordChallengeFailure(db: DB, userId: string, now: Date = new Date()): Promise<Date | null> {
  const reached = sql`(${users.challengeFailedAttempts} + 1 >= ${MAX_CHALLENGE_FAILURES})`;
  // 15, 30, 60 … minutes, at most a day (the exponent is capped so power() can never overflow).
  const minutes = sql`LEAST(${FIRST_CHALLENGE_LOCKOUT_MINUTES} * power(2, LEAST(${users.challengeLockouts}, 20)), ${MAX_CHALLENGE_LOCKOUT_MINUTES})`;
  const [row] = await db
    .update(users)
    .set({
      challengeFailedAttempts: sql`CASE WHEN ${reached} THEN 0 ELSE ${users.challengeFailedAttempts} + 1 END`,
      challengeLockouts: sql`CASE WHEN ${reached} THEN ${users.challengeLockouts} + 1 ELSE ${users.challengeLockouts} END`,
      challengeLockedUntil: sql`CASE WHEN ${reached} THEN ${now.toISOString()}::timestamp + (${minutes} * interval '1 minute') ELSE ${users.challengeLockedUntil} END`,
    })
    .where(eq(users.id, userId))
    .returning({ failed: users.challengeFailedAttempts, lockedUntil: users.challengeLockedUntil });
  return row && row.failed === 0 && row.lockedUntil && row.lockedUntil.getTime() > now.getTime() ? row.lockedUntil : null;
}

/** Forget the wrong answers and lockouts (a right answer, or a sign-in with the password). */
export async function clearChallengeFailures(db: DB, user: ChallengeCounters): Promise<void> {
  if (!user.challengeFailedAttempts && !user.challengeLockouts && !user.challengeLockedUntil) return;
  await db
    .update(users)
    .set({ challengeFailedAttempts: 0, challengeLockouts: 0, challengeLockedUntil: null })
    .where(eq(users.id, user.id));
}
