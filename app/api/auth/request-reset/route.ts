/**
 * POST /api/auth/request-reset — issue a password-reset token ("I forgot my password").
 * Body: { email, challengeAnswer? } — `email` is the login (user name or email address).
 *
 * The desktop app has no mail server, so in the offline desktop build the token is returned
 * directly — as self-recovery that proves who is asking:
 *  - a user with a challenge question (QuickBooks parity, set with the password) must answer it;
 *    first call without an answer returns { challengeQuestion } so the screen can ask it;
 *  - a user without one (files from before challenge questions) keeps the older single-user
 *    rule: only when the file has exactly one user.
 * Company files are portable (file server, USB drive, an accountant), so a copy of the file must
 * not be openable by anyone who can guess the Admin's user name. Otherwise always 200 with a
 * generic message to avoid user-name enumeration.
 *
 * A company file protected with passwords (lib/services/fileProtection.ts): the challenge answer
 * has its own key slot, so the answer is what opens the file here too — before the sign-in, while
 * the server is sealed (lib/db/sealed.ts), the question comes from the file's slots and the right
 * answer decrypts the file; then the reset goes on as usual (and the new password gets its slot).
 * Without a challenge question, a protected file can only be reopened by an Admin resetting the
 * password or with the recovery key (/api/auth/recover) — never by the single-user rule.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { eq, ne } from 'drizzle-orm';
import { needsSignInToRecover, recoverSealedWorkingCopy } from '@/lib/services/workingCopyRecovery';
import { getDb, resolveDataDir, sealedMode, withSealedAccess } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hasValidUnlockCookie, verifyPassword } from '@/lib/auth';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { GLOBAL_KEY_WEIGHT, attemptKeys, resetLimiter, tooManyResets } from '@/lib/net/rateLimit';
import { invalidJsonBody, readJsonObject } from '@/lib/routeErrors';
import { normalizeChallengeAnswer } from '@/lib/challengeQuestions';
import {
  finishKeyUnseal,
  loadKeyFromChallenge,
  readProtection,
  sealedChallengeQuestion,
  unlockFromFile,
  unsealCompanyFile,
} from '@/lib/services/fileProtection';

const PROTECTED_NO_CHALLENGE_MESSAGE =
  'This company file is protected with passwords, and this user has no challenge question that opens it. Ask an Admin to reset your password, or use the recovery key.';
const WRONG_ANSWER_MESSAGE = "That answer doesn't match. Answers are not case-sensitive; check the spelling.";

const MULTI_USER_RESET_MESSAGE =
  'This company file has more than one user, so passwords cannot be reset from this screen. ' +
  'Ask an Admin to reset your password in Users & Roles.';

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const challengeAnswer = typeof body.challengeAnswer === 'string' ? body.challengeAnswer : '';
  const generic = { ok: true, message: 'If that account exists, a reset token has been generated.' };
  if (!email) return NextResponse.json(generic);

  // Rate limit (per account, per address, and globally): every request that proves nothing counts —
  // a wrong answer, a refusal, an unknown user, a token from the single-user rule. Asking for a
  // user's question does not count, and the right answer clears the account's count, so two typos
  // don't lock a person out of their own books.
  const origin = originFromHeaders(req.headers);
  const limiter = resetLimiter();
  const keys = attemptKeys('reset-request', email, origin.addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const { body: tooMany, retryAfter } = tooManyResets(gate.retryAfterMs);
    return NextResponse.json(tooMany, { status: 429, headers: { 'Retry-After': retryAfter } });
  }
  let counted = false; // at most once per request
  const fail = () => {
    if (counted) return;
    counted = true;
    limiter.recordFailure(keys, Date.now(), weights);
  };
  try {
    const offlineLocal = process.env.BKA_OFFLINE === '1' && !origin.remote;
    let sealed = sealedMode();
    let db;
    /**
     * Not decrypted yet (or the working copy here will not start): the question is in the file's
     * challenge slot, and only the answer that opens the company file goes on. Returns the key, or
     * the answer to send back.
     */
    const keyFromFileChallenge = async (): Promise<{ key: Buffer } | { response: NextResponse }> => {
      if (!offlineLocal) {
        fail();
        return { response: NextResponse.json(generic) };
      }
      const question = sealedChallengeQuestion(email);
      if (!question) {
        fail();
        await unlockFromFile({ kind: 'challenge', login: email, secret: challengeAnswer || 'x' }); // same work either way
        return { response: NextResponse.json({ error: PROTECTED_NO_CHALLENGE_MESSAGE, code: 'FORBIDDEN' }, { status: 403 }) };
      }
      if (!challengeAnswer.trim()) return { response: NextResponse.json({ ok: false, challengeQuestion: question }) };
      const key = await unlockFromFile({ kind: 'challenge', login: email, secret: challengeAnswer });
      if (!key) {
        fail();
        return { response: NextResponse.json({ error: WRONG_ANSWER_MESSAGE, code: 'FORBIDDEN', challengeQuestion: question }, { status: 403 }) };
      }
      return { key };
    };
    if (sealed === 'key') {
      try {
        db = await withSealedAccess(() => getDb());
      } catch (err) {
        if (!needsSignInToRecover(err)) throw err;
        // The working copy here will not start: once the answer has opened the company file, set
        // the copy aside and reopen the file's last save (lib/services/workingCopyRecovery.ts).
        const got = await keyFromFileChallenge();
        if ('response' in got) return got.response;
        sealed = await recoverSealedWorkingCopy(got.key);
        if (sealed === 'extract' || sealed === 'conflict') {
          await unsealCompanyFile(got.key);
          limiter.recordSuccess(keys.slice(0, -1));
          db = await getDb();
        } else {
          db = await withSealedAccess(() => getDb()); // it started after all
        }
      }
    } else if (sealed === 'extract' || sealed === 'conflict') {
      const got = await keyFromFileChallenge();
      if ('response' in got) return got.response;
      await unsealCompanyFile(got.key);
      limiter.recordSuccess(keys.slice(0, -1));
      db = await getDb();
    } else {
      db = await getDb();
    }

    // The file password (if set) gates everything in the file, password resets included.
    const lock = await getFileLockStatus(db);
    if (lock.enabled && !(await hasValidUnlockCookie())) {
      fail();
      return NextResponse.json(
        { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    // SECURITY: the offline desktop build (BKA_OFFLINE=1, server on 127.0.0.1) hands the token
    // straight back. That is only safe as single-user self-recovery: on a file with several
    // users, anyone at this machine (e.g. a restricted clerk) could otherwise reset the owner's
    // password. With more than one real user, an Admin resets passwords in Users & Roles
    // (/api/users/[id]/reset-password, which enforces assertCanManageUser).
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const hasChallenge = Boolean(user?.challengeQuestion && user?.challengeAnswerHash);
    if (offlineLocal && hasChallenge) {
      // Self-recovery by challenge question: ask it, then check the answer (the rate limit above
      // counts every attempt, so the answer can't be guessed quickly).
      if (!challengeAnswer.trim()) {
        return NextResponse.json({ ok: false, challengeQuestion: user!.challengeQuestion });
      }
      if (!(await verifyPassword(normalizeChallengeAnswer(challengeAnswer), user!.challengeAnswerHash!))) {
        fail();
        return NextResponse.json(
          { error: WRONG_ANSWER_MESSAGE, code: 'FORBIDDEN', challengeQuestion: user!.challengeQuestion },
          { status: 403 },
        );
      }
      // The working copy already on this computer (sealed 'key'): the answer's slot unlocks the file key.
      if (sealed === 'key') {
        if (!(await loadKeyFromChallenge(db, resolveDataDir(), user!.id, challengeAnswer))) {
          fail();
          return NextResponse.json({ error: PROTECTED_NO_CHALLENGE_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
        }
        await finishKeyUnseal(db);
      }
      limiter.recordSuccess(keys.slice(0, -1));
    } else if (offlineLocal && (sealed === 'key' || (await readProtection(db)))) {
      // A protected file is never reopened by the single-user rule: only a secret that opens it.
      fail();
      return NextResponse.json({ error: PROTECTED_NO_CHALLENGE_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
    } else if (offlineLocal) {
      const realUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(ne(users.passwordHash, 'dev'))
        .limit(2);
      fail(); // the single-user rule proves nothing
      if (realUsers.length > 1) {
        return NextResponse.json({ error: MULTI_USER_RESET_MESSAGE, code: 'FORBIDDEN' }, { status: 403 });
      }
    }

    // The seeded demo user (sentinel hash 'dev') is not a real account and can't be "recovered".
    if (!user || user.passwordHash === 'dev') {
      if (!offlineLocal || !hasChallenge) fail();
      return NextResponse.json(generic);
    }

    const token = crypto.randomBytes(24).toString('hex');
    await db
      .update(users)
      .set({ resetToken: token, resetExpires: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(users.id, user.id));

    // SECURITY: never return the reset token in the HTTP response on a networked deployment —
    // anyone who knows an email could take over the account. The token is logged server-side so
    // a local operator can retrieve it; a hosted deployment should email a reset link instead.
    console.log(`[auth/request-reset] reset token for ${user.email}: ${token}`);
    // Multi-user hosting: a request relayed from another machine is NOT local, so it never gets
    // the token even in the desktop build (anyone on the tailnet could otherwise take over).
    if (offlineLocal) return NextResponse.json({ ...generic, token });
    fail();
    return NextResponse.json(generic);
  } finally {
    gate.release();
  }
}
