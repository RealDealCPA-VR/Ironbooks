/**
 * Passwords at the company-file level (QuickBooks parity):
 *  - in the desktop app a sign-in lasts for one open of the company file: a session (or file
 *    unlock) made under one launch is refused under the next, like QuickBooks asking for the
 *    password every time the file is opened;
 *  - the Admin set up for a new file (/signup) can use a user name ("Admin"), and picks a
 *    challenge question;
 *  - "I forgot my password" asks that question before a reset token is issued — a copy of the
 *    file can't be opened by someone who only guesses the user name — while files from before
 *    challenge questions keep the older single-user rule;
 *  - the challenge question can be set later with the current password (/api/auth/challenge).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-company-file-login');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'company-file-login-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import {
  SESSION_COOKIE,
  createSessionToken,
  createUnlockToken,
  verifyPassword,
  verifySessionToken,
  verifyUnlockToken,
} from '@/lib/auth';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as requestResetPOST } from '@/app/api/auth/request-reset/route';
import { GET as challengeGET, POST as challengePOST } from '@/app/api/auth/challenge/route';

let db: DB;

function as(userId: string | null, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.headers.set('host', '127.0.0.1');
  h.cookies.clear();
  if (userId) h.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user'));
}
function post(url: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify(body),
  });
}
function resetLimiters() {
  const g = globalThis as unknown as { __bkaResetLimiter?: unknown; __bkaLoginLimiter?: unknown };
  g.__bkaResetLimiter = undefined;
  g.__bkaLoginLimiter = undefined;
}

describe('company-file sign-in', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  });
  afterAll(async () => {
    delete process.env.BKA_OFFLINE;
    delete process.env.BKA_INTERNAL_TOKEN;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
  beforeEach(() => resetLimiters());

  it('a desktop sign-in lasts for one open of the company file', () => {
    process.env.BKA_INTERNAL_TOKEN = 'launch-one';
    const token = createSessionToken('00000000-0000-4000-8000-000000000001');
    const unlock = createUnlockToken();
    expect(verifySessionToken(token)?.userId).toBe('00000000-0000-4000-8000-000000000001');
    expect(verifyUnlockToken(unlock)).toBe(true);
    // The cookie never carries the shell's token itself.
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(payload).not.toContain('launch-one');
    expect(Buffer.from(unlock.split('.')[0], 'base64url').toString('utf8')).not.toContain('launch-one');

    process.env.BKA_INTERNAL_TOKEN = 'launch-two'; // closed and opened again
    expect(verifySessionToken(token)).toBeNull();
    expect(verifyUnlockToken(unlock)).toBe(false);
    delete process.env.BKA_INTERNAL_TOKEN;
  });

  it('sets up the Admin with a user name and a challenge question', async () => {
    as(null, 'POST', '/api/auth/signup');
    const bad = await signupPOST(post('/api/auth/signup', { name: 'Pat', email: 'Front Desk', password: 'adminpass1' }));
    expect(bad.status).toBe(400); // no spaces in a user name
    as(null, 'POST', '/api/auth/signup');
    const weak = await signupPOST(
      post('/api/auth/signup', { name: 'Pat', email: 'Admin', password: 'adminpass1', challengeQuestion: 'Pick anything', challengeAnswer: 'x' }),
    );
    expect(weak.status).toBe(400);
    as(null, 'POST', '/api/auth/signup');
    const res = await signupPOST(
      post('/api/auth/signup', {
        name: 'Pat Owner',
        email: 'Admin',
        password: 'adminpass1',
        companyName: 'Acme Plumbing',
        challengeQuestion: 'Name of your first pet',
        challengeAnswer: '  Rex  The DOG ',
      }),
    );
    expect(res.status).toBe(201);
    const [u] = await db.select().from(users).where(eq(users.email, 'admin'));
    expect(u.challengeQuestion).toBe('Name of your first pet');
    expect(u.challengeAnswerHash).not.toContain('Rex');
    expect(await verifyPassword('rex the dog', u.challengeAnswerHash!)).toBe(true);
  });

  it('"I forgot my password" asks the challenge question before it issues a token', async () => {
    process.env.BKA_OFFLINE = '1';
    as(null, 'POST', '/api/auth/request-reset');
    const ask = await (await requestResetPOST(post('/api/auth/request-reset', { email: 'Admin' }))).json();
    expect(ask).toMatchObject({ challengeQuestion: 'Name of your first pet' });
    expect(ask.token).toBeUndefined();

    as(null, 'POST', '/api/auth/request-reset');
    const wrong = await requestResetPOST(post('/api/auth/request-reset', { email: 'Admin', challengeAnswer: 'Fido' }));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).token).toBeUndefined();
    const [row] = await db.select().from(users).where(eq(users.email, 'admin'));
    expect(row.resetToken).toBeNull();

    as(null, 'POST', '/api/auth/request-reset');
    const right = await (await requestResetPOST(post('/api/auth/request-reset', { email: 'admin', challengeAnswer: 'REX the dog' }))).json();
    expect(right.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('a teammate connected through multi-user hosting never gets a token here', async () => {
    process.env.BKA_OFFLINE = '1';
    as(null, 'POST', '/api/auth/request-reset');
    h.headers.set('x-bka-remote-addr', '192.168.1.20');
    const req = new NextRequest('http://127.0.0.1/api/auth/request-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bka-remote-addr': '192.168.1.20' },
      body: JSON.stringify({ email: 'admin', challengeAnswer: 'rex the dog' }),
    });
    const body = await (await requestResetPOST(req)).json();
    expect(body.token).toBeUndefined();
  });

  it('the challenge question can be set later with the current password', async () => {
    const [u] = await db.select().from(users).where(eq(users.email, 'admin'));
    await db.update(users).set({ challengeQuestion: null, challengeAnswerHash: null }).where(eq(users.id, u.id));
    as(u.id, 'GET', '/api/auth/challenge');
    expect(await (await challengeGET()).json()).toEqual({ question: null });

    as(u.id, 'POST', '/api/auth/challenge');
    const wrongPw = await challengePOST(
      post('/api/auth/challenge', { currentPassword: 'nope', question: 'Street you grew up on', answer: 'Elm Street' }),
    );
    expect(wrongPw.status).toBe(403);

    as(u.id, 'POST', '/api/auth/challenge');
    const ok = await challengePOST(
      post('/api/auth/challenge', { currentPassword: 'adminpass1', question: 'Street you grew up on', answer: 'Elm Street' }),
    );
    expect(ok.status).toBe(200);
    as(u.id, 'GET', '/api/auth/challenge');
    expect(await (await challengeGET()).json()).toEqual({ question: 'Street you grew up on' });
  });
});
