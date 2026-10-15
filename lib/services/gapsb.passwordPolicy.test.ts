/**
 * K (gapsb): per-file password policy.
 *  - rules: minimum length (>= 8), letters + numbers (default on), optional symbol, expiry with a
 *    forced change at the next sign-in, no reuse of the last N passwords;
 *  - enforced at sign-up, reset by token, Admin add / reset password and a person's own change;
 *  - only an Admin of the file can change the policy;
 *  - existing users with old (now non-compliant) passwords still sign in; an expired password
 *    signs in but the session can only change the password until it is replaced.
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-gapsb-password-policy');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'gapsb-password-policy-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { passwordHistory, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE, verifyPassword } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  describePasswordPolicy,
  isPasswordExpired,
  normalizePasswordPolicy,
  passwordProblemMessage,
  passwordProblems,
} from '@/lib/passwordPolicy';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { addUser, resetUserPassword } from './users';
import { resolveAccess } from './access';
import {
  assertPasswordAllowed,
  changeOwnPassword,
  getPasswordPolicy,
  passwordStatusAtSignIn,
  updatePasswordPolicy,
} from './passwordPolicy';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as changePOST } from '@/app/api/auth/change-password/route';
import { GET as policyGET } from '@/app/api/auth/password-policy/route';
import { PUT as adminPolicyPUT } from '@/app/api/users/password-policy/route';
import { POST as resetPOST } from '@/app/api/auth/reset/route';

let db: DB;
let ownerId: string;
let companyId: string;
let owner: ServiceContext;

function as(userId: string | null, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user'));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function resetLimiters() {
  const g = globalThis as unknown as { __bkaLoginLimiter?: unknown; __bkaResetLimiter?: unknown };
  g.__bkaLoginLimiter = undefined;
  g.__bkaResetLimiter = undefined;
}
async function setPolicy(p: Partial<typeof DEFAULT_PASSWORD_POLICY>) {
  await updatePasswordPolicy(owner, { ...DEFAULT_PASSWORD_POLICY, ...p });
}
async function userRow(id: string) {
  return (await db.select().from(users).where(eq(users.id, id)))[0];
}
async function login(email: string, password: string) {
  as(null, 'POST', '/api/auth/login');
  const res = await loginPOST(jsonRequest('/api/auth/login', { email, password }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@pp.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
    .returning();
  ownerId = u.id;
  companyId = (await createCompany(db, { name: 'Policy Co', ownerId })).id;
  owner = { db, companyId, userId: ownerId };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => resetLimiters());

describe('password rules (pure)', () => {
  it('defaults: 8+ characters with letters and numbers; symbol optional; no expiry or reuse check', () => {
    expect(DEFAULT_PASSWORD_POLICY).toEqual({
      minLength: 8,
      requireLettersAndNumbers: true,
      requireSymbol: false,
      expiryDays: 0,
      historyCount: 0,
    });
    expect(passwordProblems('short1')).toEqual(['at least 8 characters']);
    expect(passwordProblems('lettersonly')).toEqual(['a number']);
    expect(passwordProblems('12345678')).toEqual(['a letter']);
    expect(passwordProblems('harbor42')).toEqual([]);
    expect(passwordProblems('harbor42', { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true })).toEqual(['a symbol (like ! # or $)']);
    expect(passwordProblems('harbor42!', { ...DEFAULT_PASSWORD_POLICY, requireSymbol: true, minLength: 12 })).toEqual([
      'at least 12 characters',
    ]);
    expect(passwordProblemMessage(['at least 12 characters', 'a number'])).toBe(
      'The password needs at least 12 characters and a number.',
    );
    expect(describePasswordPolicy({ ...DEFAULT_PASSWORD_POLICY, requireSymbol: true })).toBe(
      'At least 8 characters, with letters and numbers and a symbol.',
    );
  });

  it('a stored policy can never go below 8 characters; expiry counts whole days', () => {
    expect(normalizePasswordPolicy({ minLength: 4, expiryDays: -3, historyCount: 99 })).toMatchObject({
      minLength: 8,
      expiryDays: 0,
      historyCount: 24,
    });
    const p = { ...DEFAULT_PASSWORD_POLICY, expiryDays: 90 };
    const now = new Date('2026-10-15T12:00:00Z');
    expect(isPasswordExpired(new Date('2026-07-20T12:00:00Z'), p, now)).toBe(false);
    expect(isPasswordExpired(new Date('2026-07-17T12:00:00Z'), p, now)).toBe(true);
    expect(isPasswordExpired(new Date('2000-01-01'), DEFAULT_PASSWORD_POLICY, now)).toBe(false);
  });
});

describe('policy storage and who may change it', () => {
  it('defaults until saved; only an Admin of the file may save; values are range-checked', async () => {
    expect(await getPasswordPolicy(db)).toEqual(DEFAULT_PASSWORD_POLICY);

    const clerk = await addUser(owner, { name: 'Clerk', login: 'clerk@pp.local', password: 'clerkpass1', roleKeys: ['sales'] });
    const clerkAccess = (await resolveAccess(db, companyId, clerk.userId)).access;
    await expect(
      updatePasswordPolicy({ db, companyId, userId: clerk.userId, access: clerkAccess }, { minLength: 8 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Through the route: Users & Roles modify is not enough either (the clerk has none at all).
    as(clerk.userId, 'PUT', '/api/users/password-policy');
    expect((await adminPolicyPUT(jsonRequest('/api/users/password-policy', { minLength: 10 }, 'PUT'))).status).toBe(403);

    await expect(updatePasswordPolicy(owner, { minLength: 6 })).rejects.toThrow(/Minimum length must be a whole number from 8 to 64/);
    await expect(updatePasswordPolicy(owner, { expiryDays: 1.5 })).rejects.toThrow(/whole number/);

    as(ownerId, 'PUT', '/api/users/password-policy');
    const res = await adminPolicyPUT(jsonRequest('/api/users/password-policy', { minLength: 10, requireSymbol: true }, 'PUT'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ minLength: 10, requireSymbol: true, description: expect.stringMatching(/At least 10/) });

    // The public rules endpoint (for the sign-up / reset forms) shows the same rules.
    as(null, 'GET', '/api/auth/password-policy');
    expect(await (await policyGET()).json()).toMatchObject({ minLength: 10, requireSymbol: true });
    await setPolicy({});
  });
});

describe('enforced wherever a password is set', () => {
  it('Admin add user / reset password follow the rules; reuse of the last N is refused', async () => {
    await setPolicy({ requireSymbol: true, historyCount: 3 });
    await expect(
      addUser(owner, { name: 'Weak', login: 'weak@pp.local', password: 'weakpass1', roleKeys: ['sales'] }),
    ).rejects.toThrow(/needs a symbol/);
    const bob = await addUser(owner, { name: 'Bob', login: 'bob@pp.local', password: 'bobpass1!', roleKeys: ['sales'] });
    expect((await userRow(bob.userId)).passwordChangedAt).toBeInstanceOf(Date);

    await expect(resetUserPassword(owner, bob.userId, 'bobpass1!')).rejects.toThrow(/haven't used for your last 3 passwords/);
    await resetUserPassword(owner, bob.userId, 'bobpass2!');
    await resetUserPassword(owner, bob.userId, 'bobpass3!');
    // bobpass1! is now 3 passwords back (current, previous, the one before) -> still blocked.
    await expect(resetUserPassword(owner, bob.userId, 'bobpass1!')).rejects.toThrow(/last 3/);
    await resetUserPassword(owner, bob.userId, 'bobpass4!');
    await resetUserPassword(owner, bob.userId, 'bobpass1!'); // 4 back now -> allowed
    expect((await db.select().from(passwordHistory).where(eq(passwordHistory.userId, bob.userId))).length).toBe(4);
    // Hashes only — never the password itself.
    for (const row of await db.select().from(passwordHistory)) expect(row.passwordHash).not.toMatch(/bobpass/);

    // "Ask them to choose a new password at their next sign-in".
    await resetUserPassword(owner, bob.userId, 'bobpass5!', { requireChange: true });
    expect((await userRow(bob.userId)).mustChangePassword).toBe(true);
    await setPolicy({});
  });

  it('reset by token follows the rules', async () => {
    const [u] = await db
      .insert(users)
      .values({ email: 'token@pp.local', name: 'Token', passwordHash: await hashPassword('tokenpass1'), resetToken: 't'.repeat(48), resetExpires: new Date(Date.now() + 3600_000) })
      .returning();
    as(null, 'POST', '/api/auth/reset');
    const bad = await resetPOST(jsonRequest('/api/auth/reset', { token: 't'.repeat(48), password: 'onlyletters' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/needs a number/);
    const ok = await resetPOST(jsonRequest('/api/auth/reset', { token: 't'.repeat(48), password: 'newtoken42' }));
    expect(ok.status).toBe(200);
    const row = await userRow(u.id);
    expect(await verifyPassword('newtoken42', row.passwordHash)).toBe(true);
    expect(row.resetToken).toBeNull();
  });

  it('a person changes their own password (current password required, rules apply)', async () => {
    const carl = await addUser(owner, { name: 'Carl', login: 'carl@pp.local', password: 'carlpass1', roleKeys: ['sales'] });
    await expect(changeOwnPassword(db, carl.userId, { currentPassword: 'wrong', newPassword: 'carlpass2' })).rejects.toThrow(
      /current password is not correct/,
    );
    await expect(changeOwnPassword(db, carl.userId, { currentPassword: 'carlpass1', newPassword: 'carlpass' })).rejects.toThrow(
      /needs a number/,
    );
    await expect(changeOwnPassword(db, carl.userId, { currentPassword: 'carlpass1', newPassword: 'carlpass1' })).rejects.toThrow(
      /different from the current one/,
    );
    as(carl.userId, 'POST', '/api/auth/change-password');
    const res = await changePOST(jsonRequest('/api/auth/change-password', { currentPassword: 'carlpass1', newPassword: 'carlpass2' }));
    expect(res.status).toBe(200);
    expect(await verifyPassword('carlpass2', (await userRow(carl.userId)).passwordHash)).toBe(true);
    expect((await login('carl@pp.local', 'carlpass2')).status).toBe(200);
  });
});

describe('existing users and expiry', () => {
  it('an old password that breaks today’s rules still signs in, with nothing forced while it has not expired', async () => {
    const [old] = await db
      .insert(users)
      .values({ email: 'legacy@pp.local', name: 'Legacy', passwordHash: await hashPassword('abc123') }) // 6 chars, pre-policy
      .returning();
    await addUser(owner, { name: 'Legacy', login: 'legacy@pp.local', roleKeys: ['sales'] }); // attach existing login
    await setPolicy({ minLength: 12, requireSymbol: true });
    const r = await login('legacy@pp.local', 'abc123');
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBeUndefined();
    as(old.id, 'GET', '/api/company');
    await expect(getServerContext()).resolves.toMatchObject({ userId: old.id });
    await setPolicy({});
  });

  it('an expired password signs in, but the session can only change the password until it is replaced', async () => {
    await setPolicy({ expiryDays: 90 });
    const [dana] = await db
      .insert(users)
      .values({
        email: 'dana@pp.local',
        name: 'Dana',
        passwordHash: await hashPassword('danapass1'),
        passwordChangedAt: new Date(Date.now() - 120 * 86_400_000),
      })
      .returning();
    await addUser(owner, { name: 'Dana', login: 'dana@pp.local', roleKeys: ['sales'] });

    const r = await login('dana@pp.local', 'danapass1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'expired' });
    expect((await userRow(dana.id)).mustChangePassword).toBe(true);

    as(dana.id, 'GET', '/api/company');
    await expect(getServerContext()).rejects.toMatchObject({ code: 'FORBIDDEN', message: PASSWORD_CHANGE_REQUIRED_MESSAGE });

    as(dana.id, 'POST', '/api/auth/change-password');
    const res = await changePOST(jsonRequest('/api/auth/change-password', { currentPassword: 'danapass1', newPassword: 'danapass2' }));
    expect(res.status).toBe(200);
    const row = await userRow(dana.id);
    expect(row.mustChangePassword).toBe(false);
    expect(Date.now() - row.passwordChangedAt!.getTime()).toBeLessThan(60_000);

    as(dana.id, 'GET', '/api/company');
    await expect(getServerContext()).resolves.toMatchObject({ userId: dana.id });
    const again = await login('dana@pp.local', 'danapass2');
    expect(again.body.mustChangePassword).toBeUndefined();
    await setPolicy({});
  });

  it('a user without a recorded change date counts from when the account was created; expiry 0 never forces', async () => {
    const [eve] = await db
      .insert(users)
      .values({ email: 'eve@pp.local', name: 'Eve', passwordHash: 'x', createdAt: new Date(Date.now() - 400 * 86_400_000) })
      .returning();
    expect(await passwordStatusAtSignIn(db, eve)).toBeNull(); // policy expiry is 0
    await setPolicy({ expiryDays: 365 });
    expect(await passwordStatusAtSignIn(db, eve)).toBe('expired');
    expect(await passwordStatusAtSignIn(db, { ...eve, mustChangePassword: true })).toBe('required');
    await setPolicy({});
  });

  it('sign-up checks the rules before creating anything', async () => {
    await expect(assertPasswordAllowed(db, 'password')).rejects.toThrow(/needs a number/);
    await expect(assertPasswordAllowed(db, 'passw0rd')).resolves.toMatchObject({ minLength: 8 });
  });
});
