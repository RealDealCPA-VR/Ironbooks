/**
 * The signed-in person's challenge question for "I forgot my password" (QuickBooks parity).
 *  GET  /api/auth/challenge  -> { question: string | null }
 *  POST /api/auth/challenge  { currentPassword, question, answer } -> { ok: true, question }
 *
 * Setting it needs the current password (like changing the password), rate-limited like sign-in.
 * The answer is stored hashed (lib/challengeQuestions.ts normalizes case and spacing). Acts on
 * the USER, so it goes through getSessionGate ('self' in lib/permissions/routes.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSessionGate } from '@/lib/context';
import { users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { MIN_CHALLENGE_ANSWER, isKnownChallengeQuestion, normalizeChallengeAnswer } from '@/lib/challengeQuestions';
import { logTransaction } from '@/lib/services/transactionLog';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { readJsonObject, invalidJsonBody, routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const { db, userId } = await getSessionGate();
    if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
    const [u] = await db.select({ q: users.challengeQuestion, h: users.challengeAnswerHash }).from(users).where(eq(users.id, userId));
    return NextResponse.json({ question: u?.q && u?.h ? u.q : null });
  } catch (err) {
    return routeError(err, 'GET /api/auth/challenge');
  }
}

export async function POST(req: NextRequest) {
  try {
    const { db, userId } = await getSessionGate();
    if (!userId) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const question = body.question;
    const answer = typeof body.answer === 'string' ? body.answer : '';
    if (!isKnownChallengeQuestion(question) || normalizeChallengeAnswer(answer).length < MIN_CHALLENGE_ANSWER) {
      return NextResponse.json(
        { error: `Pick a question and give an answer of at least ${MIN_CHALLENGE_ANSWER} characters.`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const origin = originFromHeaders(req.headers);
    const limiter = loginLimiter();
    const keys = attemptKeys('challenge', userId, origin.addr);
    const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
    const attempt = limiter.begin(keys, Date.now(), weights);
    if (!attempt.allowed) {
      const { body: tooMany, retryAfter } = tooManyAttempts(attempt.retryAfterMs);
      return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
    }
    try {
      const [u] = await db.select({ hash: users.passwordHash, name: users.name }).from(users).where(eq(users.id, userId));
      if (!u || !(await verifyPassword(currentPassword, u.hash))) {
        limiter.recordFailure(keys, Date.now(), weights);
        return NextResponse.json({ error: 'The current password is not correct.', code: 'FORBIDDEN' }, { status: 403 });
      }
      limiter.recordSuccess(keys.slice(0, -1));
      await db
        .update(users)
        .set({ challengeQuestion: question, challengeAnswerHash: await hashPassword(normalizeChallengeAnswer(answer)), updatedAt: new Date() })
        .where(eq(users.id, userId));
      await logTransaction(db, {
        userId,
        action: 'update',
        entityType: 'user',
        entityId: userId,
        summary: `Set the challenge question for "${u.name}"`,
        data: { new: { challengeQuestion: question } }, // never the answer
      });
      return NextResponse.json({ ok: true, question });
    } finally {
      attempt.release();
    }
  } catch (err) {
    return routeError(err, 'POST /api/auth/challenge');
  }
}
