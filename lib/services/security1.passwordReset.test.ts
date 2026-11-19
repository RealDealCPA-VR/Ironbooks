/**
 * Security review 2.3 + 2.9 ("I forgot my password"):
 *  - wrong challenge answers are counted in the company file, with growing lockouts that survive
 *    restarting the app (a new in-memory limiter, a re-opened database); a right answer or a
 *    sign-in with the password clears them;
 *  - a reset done with the challenge question is in the audit trail and leaves a note (a to-do in
 *    Needs attention) for the user and for the Admin;
 *  - a reset token is made only when it is handed back (never for a request from another
 *    machine), is stored only as a fingerprint, is never logged, and a token an older version
 *    stored as plain text no longer works.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-password-reset');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'security1-password-reset-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, todos, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { normalizeChallengeAnswer } from '@/lib/challengeQuestions';
import { REMOTE_ADDR_HEADER } from '@/lib/net/requestInfo';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { addUser } from './users';
import { resolveAccess } from './access';
import { FIRST_CHALLENGE_LOCKOUT_MINUTES, MAX_CHALLENGE_FAILURES } from './challengeLockout';
import { POST as requestResetPOST } from '@/app/api/auth/request-reset/route';
import { POST as resetPOST } from '@/app/api/auth/reset/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';

let db: DB;
let ownerId: string;
let patId: string;
let companyId: string;
const ANSWER = 'Rex the dog';

function as(method: string, routePath: string, remote = false) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (remote) h.headers.set(REMOTE_ADDR_HEADER, '100.64.0.9');
}
function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
/** A restart: the in-memory limiters start empty. */
function restartLimiters() {
  const g = globalThis as unknown as { __bkaLoginLimiter?: unknown; __bkaResetLimiter?: unknown };
  g.__bkaLoginLimiter = undefined;
  g.__bkaResetLimiter = undefined;
}
async function ask(answer: string, opts: { remote?: boolean; login?: string } = {}) {
  as('POST', '/api/auth/request-reset', opts.remote);
  return requestResetPOST(
    jsonRequest('/api/auth/request-reset', { email: opts.login ?? 'pat@pr.local', challengeAnswer: answer }, opts.remote ? { [REMOTE_ADDR_HEADER]: '100.64.0.9' } : {}),
  );
}
async function pat() {
  return (await db.select().from(users).where(eq(users.id, patId)))[0];
}
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

describe('forgot-password hardening (security 2.3, 2.9)', () => {
  beforeAll(async () => {
    process.env.BKA_OFFLINE = '1';
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@pr.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    ownerId = u.id;
    companyId = (await createCompany(db, { name: 'Reset Co', ownerId })).id;
    const admin = { db, companyId, userId: ownerId, access: (await resolveAccess(db, companyId, ownerId)).access };
    patId = (await addUser(admin, { name: 'Pat', login: 'pat@pr.local', password: 'patpass123', roleKeys: ['bookkeeper'] })).userId;
    await db
      .update(users)
      .set({ challengeQuestion: 'Name of your first pet', challengeAnswerHash: await hashPassword(normalizeChallengeAnswer(ANSWER)) })
      .where(eq(users.id, patId));
  });

  afterAll(async () => {
    delete process.env.BKA_OFFLINE;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    restartLimiters();
    await db
      .update(users)
      .set({ challengeFailedAttempts: 0, challengeLockouts: 0, challengeLockedUntil: null, resetToken: null, resetExpires: null })
      .where(eq(users.id, patId));
  });

  it('a lockout from wrong answers survives a restart (new limiter, re-opened file)', async () => {
    for (let i = 0; i < MAX_CHALLENGE_FAILURES; i++) {
      restartLimiters(); // the in-memory count alone would never get there
      expect((await ask(`wrong ${i}`)).status).toBe(403);
    }
    const locked = await pat();
    expect(locked.challengeLockouts).toBe(1);
    const minutes = (locked.challengeLockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(FIRST_CHALLENGE_LOCKOUT_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(FIRST_CHALLENGE_LOCKOUT_MINUTES);

    // Restart: new limiter, database closed and opened again. The RIGHT answer is still refused.
    restartLimiters();
    await closeDb(TEST_DIR);
    db = await getDb(TEST_DIR);
    const res = await ask(ANSWER);
    expect(res.status).toBe(429);
    expect((await res.json()).token).toBeUndefined();
    expect((await pat()).resetToken).toBeNull();

    // Once the lockout is over, the right answer works and clears the count.
    await db.update(users).set({ challengeLockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, patId));
    restartLimiters();
    const ok = await ask(ANSWER);
    expect(ok.status).toBe(200);
    expect(typeof (await ok.json()).token).toBe('string');
    const after = await pat();
    expect(after.challengeFailedAttempts).toBe(0);
    expect(after.challengeLockouts).toBe(0);
    expect(after.challengeLockedUntil).toBeNull();
  });

  it('each later lockout lasts twice as long', async () => {
    await db.update(users).set({ challengeLockouts: 1 }).where(eq(users.id, patId));
    for (let i = 0; i < MAX_CHALLENGE_FAILURES; i++) {
      restartLimiters();
      await ask(`wrong ${i}`);
    }
    const row = await pat();
    expect(row.challengeLockouts).toBe(2);
    const minutes = (row.challengeLockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(2 * FIRST_CHALLENGE_LOCKOUT_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(2 * FIRST_CHALLENGE_LOCKOUT_MINUTES);
  });

  it('signing in with the password clears the count and any lockout', async () => {
    await db
      .update(users)
      .set({ challengeFailedAttempts: 3, challengeLockouts: 2, challengeLockedUntil: new Date(Date.now() + 3600_000) })
      .where(eq(users.id, patId));
    as('POST', '/api/auth/login');
    const res = await loginPOST(jsonRequest('/api/auth/login', { email: 'pat@pr.local', password: 'patpass123' }));
    expect(res.status).toBe(200);
    const row = await pat();
    expect(row.challengeFailedAttempts).toBe(0);
    expect(row.challengeLockouts).toBe(0);
    expect(row.challengeLockedUntil).toBeNull();
  });

  it('the token is stored only as a fingerprint, and a challenge reset is audited and noted', async () => {
    const res = await ask(ANSWER);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const row = await pat();
    expect(row.resetToken).not.toContain(token);
    expect(row.resetToken).toBe(`challenge:${sha256(token)}`);

    as('POST', '/api/auth/reset');
    const done = await resetPOST(jsonRequest('/api/auth/reset', { token, password: 'brandNewPat1' }));
    expect(done.status).toBe(200);
    expect(await verifyPassword('brandNewPat1', (await pat()).passwordHash)).toBe(true);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'user'), eq(auditLogs.entityId, patId)));
    expect(audit.some((a) => (a.newValues as { resetWith?: string } | null)?.resetWith === 'challenge_question')).toBe(true);

    const notes = await db.select().from(todos).where(eq(todos.companyId, companyId));
    const mine = notes.find((n) => n.assignedUserId === patId);
    const admins = notes.find((n) => n.assignedUserId === ownerId);
    expect(mine?.title).toMatch(/^Your password was reset with your challenge question on /);
    expect(admins?.title).toMatch(/^Pat's password was reset with their challenge question on /);
    expect(mine?.status).toBe('open');
    // Passive: shown in Needs attention / Reminders from today, nothing more.
    expect(mine?.remindOn).toBe(mine?.dueDate);
  });

  it('a request from another machine makes no token, keeps a pending one, and nothing is logged', async () => {
    const pending = `challenge:${sha256('pending-token')}`;
    await db.update(users).set({ resetToken: pending, resetExpires: new Date(Date.now() + 3600_000) }).where(eq(users.id, patId));
    const logs = vi.spyOn(console, 'log');
    try {
      const res = await ask(ANSWER, { remote: true });
      expect(res.status).toBe(200);
      expect((await res.json()).token).toBeUndefined();
      expect((await pat()).resetToken).toBe(pending);
      // The single-user rule from another machine (owner has no challenge question) — no token either.
      const owner = await ask('', { remote: true, login: 'owner@pr.local' });
      expect((await owner.json()).token).toBeUndefined();
      const [o] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(o.resetToken).toBeNull();
      expect(logs.mock.calls.flat().join(' ')).not.toMatch(/reset token/i);
    } finally {
      logs.mockRestore();
    }
  });

  it('a token an older version stored as plain text no longer works', async () => {
    const plain = 'a1'.repeat(24);
    await db.update(users).set({ resetToken: plain, resetExpires: new Date(Date.now() + 3600_000) }).where(eq(users.id, patId));
    as('POST', '/api/auth/reset');
    const res = await resetPOST(jsonRequest('/api/auth/reset', { token: plain, password: 'anotherPass1' }));
    expect(res.status).toBe(400);
    expect(await verifyPassword('anotherPass1', (await pat()).passwordHash)).toBe(false);
  });
});
