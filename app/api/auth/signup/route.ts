/**
 * POST /api/auth/signup — create the company file's Admin (first owner user) + their company,
 * then start a session.
 * Body: { name, email, password, companyName, challengeQuestion?, challengeAnswer? } — `email` is
 * the login: a user name such as "Admin" or an email address (no spaces).
 *
 * Users live inside the company file, and only its Admin adds more (Users & Roles), so self
 * sign-up is only open while the file has no real user yet (the seeded demo user, whose
 * password hash is the sentinel 'dev', doesn't count). The file password still applies.
 * The challenge question (QuickBooks parity) is what "I forgot my password" asks before it
 * resets the Admin's password (app/api/auth/request-reset).
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createCompany, NEW_COMPANY_SETTINGS } from '@/lib/services/company';
import {
  hashPassword,
  createSessionToken,
  hasValidUnlockCookie,
  SESSION_COOKIE,
  MIN_PASSWORD_LENGTH,
} from '@/lib/auth';
import { invalidJsonBody, readJsonObject } from '@/lib/routeErrors';
import { getPasswordPolicy } from '@/lib/services/passwordPolicy';
import { passwordProblemMessage, passwordProblems } from '@/lib/passwordPolicy';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { COMPANY_COOKIE, isLoopbackHostHeader } from '@/lib/context';
import { logTransaction } from '@/lib/services/transactionLog';
import { startSession } from '@/lib/services/sessions';
import { cookieSecure, originFromHeaders } from '@/lib/net/requestInfo';
import { MIN_CHALLENGE_ANSWER, isKnownChallengeQuestion, normalizeChallengeAnswer } from '@/lib/challengeQuestions';

/**
 * True when the browser sent no Origin (same-origin navigation / non-browser clients) or an
 * Origin whose host matches the request's Host header. A cross-site page posting to
 * 127.0.0.1 sends its own Origin.
 */
function isSameOriginOrNone(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.get('host') ?? '').toLowerCase();
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return invalidJsonBody();
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = str(body.name);
  const email = str(body.email);
  const password = str(body.password);
  const companyName = str(body.companyName);
  const challengeQuestion = str(body.challengeQuestion);
  const challengeAnswer = str(body.challengeAnswer);
  if (!name.trim() || !email.trim() || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Your name, a user name and a password (min ${MIN_PASSWORD_LENGTH} chars) are required.`, code: 'VALIDATION' },
      { status: 400 },
    );
  }
  if (/\s/.test(email.trim())) {
    return NextResponse.json({ error: 'The user name cannot contain spaces.', code: 'VALIDATION' }, { status: 400 });
  }
  // Optional for older clients; when given, both parts must be usable.
  const wantsChallenge = Boolean(challengeQuestion || challengeAnswer);
  if (wantsChallenge && (!isKnownChallengeQuestion(challengeQuestion) || normalizeChallengeAnswer(challengeAnswer).length < MIN_CHALLENGE_ANSWER)) {
    return NextResponse.json(
      { error: `Pick a challenge question and give an answer of at least ${MIN_CHALLENGE_ANSWER} characters.`, code: 'VALIDATION' },
      { status: 400 },
    );
  }
  const db = await getDb();
  // Multi-user hosting: people connecting from other machines can never self-register into the
  // hosted company file (not even the first account — that would let a tailnet peer claim a
  // file whose owner works without sign-in). An admin adds them under Users instead.
  const origin = originFromHeaders(req.headers);
  // DNS-rebinding / CSRF guard (same rule as the session-less fallback in lib/context.ts): the
  // first account owns the file, so only a request addressed to a loopback host, and not sent
  // by a page from another site, may create it.
  if (!isLoopbackHostHeader(req.headers.get('host')) || !isSameOriginOrNone(req)) {
    return NextResponse.json(
      { error: 'Open Ironbooks on this computer to create the first account.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  if (origin.remote) {
    return NextResponse.json(
      { error: 'Ask an administrator of this company file to add you as a user.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  const lock = await getFileLockStatus(db);
  if (lock.enabled && !(await hasValidUnlockCookie())) {
    return NextResponse.json(
      { error: 'This company file is locked. Unlock it to continue.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }
  const [realUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(ne(users.passwordHash, 'dev'))
    .limit(1);
  if (realUser) {
    return NextResponse.json(
      {
        error:
          'This company file already has users. Ask your administrator to add you in Users & Roles.',
        code: 'FORBIDDEN',
      },
      { status: 403 },
    );
  }
  // gapsb K: the file's password policy (defaults: 8+ characters with letters and numbers).
  const problems = passwordProblems(password, await getPasswordPolicy(db));
  if (problems.length) {
    return NextResponse.json({ error: passwordProblemMessage(problems), code: 'VALIDATION' }, { status: 400 });
  }
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (existing.length) {
    return NextResponse.json({ error: 'An account with that email already exists.', code: 'CONFLICT' }, { status: 409 });
  }

  const [user] = await db
    .insert(users)
    .values({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      ...(wantsChallenge
        ? { challengeQuestion, challengeAnswerHash: await hashPassword(normalizeChallengeAnswer(challengeAnswer)) }
        : {}),
    })
    .returning();
  await logTransaction(db, {
    userId: user.id,
    action: 'create',
    entityType: 'user',
    entityId: user.id,
    summary: `Created user "${user.name}" (${user.email})`,
    data: { new: { name: user.name, email: user.email } },
  });

  const company = await createCompany(db, {
    name: companyName.trim() || `${name}'s Company`,
    ownerId: user.id,
    settings: { ...NEW_COMPANY_SETTINGS },
  });

  const res = NextResponse.json({ id: user.id, name: user.name, email: user.email, companyId: company.id }, { status: 201 });
  const session = await startSession(db, {
    userId: user.id,
    companyId: company.id,
    remoteAddr: origin.addr,
    userAgent: origin.userAgent,
    viaHost: origin.remote,
  });
  const opts = { httpOnly: true, secure: cookieSecure(origin), sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 * 30 };
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, 'user', session.id), opts);
  res.cookies.set(COMPANY_COOKIE, company.id, opts);
  return res;
}
