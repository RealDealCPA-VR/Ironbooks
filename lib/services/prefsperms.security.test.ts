/**
 * prefsperms: review-round-5 security leftovers in Users & Roles and sign-in.
 *
 *  1. An Admin's Reset Password could also turn off the caller's OWN two-factor sign-in (no
 *     current password, no authenticator code), and a non-Admin with Users & Roles: modify could
 *     strip a same-access peer's 2FA and then sign in as them. Only an Admin may turn off someone
 *     else's 2FA; your own needs a code (Security (2FA)) or a recovery code.
 *  3. Adding a user whose login already signs in to another company of the file attaches that
 *     login and keeps its password (changing it from here would be a cross-company takeover);
 *     the typed password used to be ignored silently — the answer now says so.
 *  2. A sole Admin who lost their authenticator could never get back in: two-factor sign-in now
 *     comes with ten one-time recovery codes (shown once when it is turned on, renewable with a
 *     current code). One of them signs in instead of the 6-digit code, and can turn 2FA off.
 *
 * Real route handlers against a temp PGlite dir (`next/headers` mocked), like users.review5.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-security');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'prefsperms-security-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess } from '@/lib/permissions/model';
import { generateSecret, generateTotp } from '@/lib/totp';
import { createCompany } from './company';
import { addUser, createRole } from './users';
import { POST as resetPasswordPOST } from '@/app/api/users/[id]/reset-password/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as usersPOST } from '@/app/api/users/route';
import { POST as enablePOST } from '@/app/api/auth/2fa/enable/route';
import { POST as disablePOST } from '@/app/api/auth/2fa/disable/route';
import { GET as recoveryGET, POST as recoveryPOST } from '@/app/api/auth/2fa/recovery-codes/route';
import { normalizeRecoveryCode } from './recoveryCodes';

let db: DB;
let owner: string;
let companyId: string;

function as(userId: string | null, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const ownerCtx = () => ({ db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const });

async function signIn(login: string, password: string, totp?: string) {
  as(null, 'POST', '/api/auth/login');
  return loginPOST(req('POST', '/api/auth/login', { email: login, password, ...(totp ? { totp } : {}) }));
}
async function turnOn2fa(userId: string) {
  await db.update(users).set({ totpSecret: generateSecret(), totpEnabled: true }).where(eq(users.id, userId));
}
async function totpOn(userId: string) {
  const [row] = await db.select({ on: users.totpEnabled, secret: users.totpSecret }).from(users).where(eq(users.id, userId));
  return Boolean(row?.on && row.secret);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@pps.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Prefsperms Security Co', ownerId: owner })).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Reset Password cannot strip two-factor sign-in from your own account or a peer', () => {
  it("an Admin's own 2FA is not turned off by resetting their own password", async () => {
    await turnOn2fa(owner);
    as(owner, 'POST', `/api/users/${owner}/reset-password`);
    const res = await resetPasswordPOST(
      req('POST', `/api/users/${owner}/reset-password`, { password: 'Hijacked2026', turnOffTwoFactor: true }),
      params({ id: owner }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/your own two-factor/i);
    expect(await totpOn(owner)).toBe(true);
    // The password did not change either: the old one still asks for the code.
    const login = await signIn('owner@pps.local', 'ownerPass123');
    expect(await login.json()).toEqual({ requires2fa: true });
  });

  it('a non-Admin with Users & Roles rights cannot turn off a same-access peer’s 2FA', async () => {
    const role = await createRole(ownerCtx(), {
      name: 'User manager',
      permissions: { users: ['full'], customers: ['view'] },
      flags: {},
    });
    const manager = (await addUser(ownerCtx(), { name: 'Manny', login: 'manny', password: 'mannyPass1234', roleKeys: [role.key] })).userId;
    const peer = (await addUser(ownerCtx(), { name: 'Peer', login: 'peer', password: 'peerPass12345', roleKeys: [role.key] })).userId;
    await turnOn2fa(peer);
    as(manager, 'POST', `/api/users/${peer}/reset-password`);
    const res = await resetPasswordPOST(
      req('POST', `/api/users/${peer}/reset-password`, { password: 'Takeover2026', turnOffTwoFactor: true }),
      params({ id: peer }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only an Admin/);
    expect(await totpOn(peer)).toBe(true);
  });

  it('an Admin can still turn off another user’s 2FA (the way back for a lost phone)', async () => {
    const clerk = (await addUser(ownerCtx(), { name: 'Clerk', login: 'clerk', password: 'clerkPass1234', roleKeys: ['ar_clerk'] })).userId;
    await turnOn2fa(clerk);
    as(owner, 'POST', `/api/users/${clerk}/reset-password`);
    const res = await resetPasswordPOST(
      req('POST', `/api/users/${clerk}/reset-password`, { password: 'Recovered2026', turnOffTwoFactor: true }),
      params({ id: clerk }),
    );
    expect(res.status).toBe(200);
    expect(await totpOn(clerk)).toBe(false);
  });
});

describe('recovery codes: the way back for a sole Admin who lost their authenticator', () => {
  let solo: string;
  let soloCompany: string;
  let secret: string;
  let codes: string[];

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: 'solo@pps.local', name: 'Solo Admin', passwordHash: await hashPassword('soloPass12345') })
      .returning();
    solo = u.id;
    soloCompany = (await createCompany(db, { name: 'Solo Co', ownerId: solo })).id;
    secret = generateSecret();
    await db.update(users).set({ totpSecret: secret }).where(eq(users.id, solo));
  });
  const asSolo = (method: string, routePath: string) => {
    as(solo, method, routePath);
    h.cookies.set(COMPANY_COOKIE, soloCompany);
  };

  it('turning two-factor sign-in on hands out ten recovery codes, once', async () => {
    asSolo('POST', '/api/auth/2fa/enable');
    const res = await enablePOST(req('POST', '/api/auth/2fa/enable', { token: generateTotp(secret, Date.now()) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; recoveryCodes: string[] };
    expect(body.enabled).toBe(true);
    codes = body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    // Only hashes are stored.
    const [row] = await db.select().from(users).where(eq(users.id, solo));
    expect(JSON.stringify(row.totpRecoveryCodes)).not.toContain(codes[0].replace('-', ''));
    asSolo('GET', '/api/auth/2fa/recovery-codes');
    expect(await (await recoveryGET()).json()).toEqual({ enabled: true, remaining: 10 });
  });

  it('a recovery code signs in instead of the 6-digit code, and only once', async () => {
    const first = await signIn('solo@pps.local', 'soloPass12345', codes[0].toLowerCase().replace('-', ' '));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.id).toBe(solo);
    expect(body.recoveryCodeUsed).toBe(true);
    expect(body.recoveryCodesLeft).toBe(9);
    const again = await signIn('solo@pps.local', 'soloPass12345', codes[0]);
    expect(again.status).toBe(401);
    const wrong = await signIn('solo@pps.local', 'soloPass12345', 'ZZZZZ-ZZZZZ');
    expect(wrong.status).toBe(401);
  });

  it('new codes need a current authenticator code and replace the old ones', async () => {
    asSolo('POST', '/api/auth/2fa/recovery-codes');
    const bad = await recoveryPOST(req('POST', '/api/auth/2fa/recovery-codes', { token: '000000' }));
    expect(bad.status).toBe(400);
    asSolo('POST', '/api/auth/2fa/recovery-codes');
    const ok = await recoveryPOST(req('POST', '/api/auth/2fa/recovery-codes', { token: generateTotp(secret, Date.now()) }));
    expect(ok.status).toBe(200);
    const fresh = ((await ok.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    // The old (unused) codes no longer work.
    expect((await signIn('solo@pps.local', 'soloPass12345', codes[1])).status).toBe(401);
    codes = fresh;
  });

  it('a recovery code also turns two-factor sign-in off (to set up a new phone)', async () => {
    asSolo('POST', '/api/auth/2fa/disable');
    const res = await disablePOST(req('POST', '/api/auth/2fa/disable', { token: codes[2] }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, solo));
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.totpRecoveryCodes).toBeNull();
  });

  it('reads codes the way people type them', () => {
    expect(normalizeRecoveryCode(' abcde-12345 ')).toBe('ABCDE12345');
    expect(normalizeRecoveryCode('abcde 12345')).toBe('ABCDE12345');
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });
});

describe('adding a user whose login already signs in to another company of the file', () => {
  it('attaches the login, keeps their password, and says the typed password was not used', async () => {
    const [u] = await db
      .insert(users)
      .values({ email: 'shared@pps.local', name: 'Shared Sam', passwordHash: await hashPassword('samOwnPass123') })
      .returning();
    await createCompany(db, { name: 'Sam Other Co', ownerId: u.id });
    as(owner, 'POST', '/api/users');
    const res = await usersPOST(
      req('POST', '/api/users', { name: 'Sam', login: 'shared@pps.local', password: 'TypedByAdmin2026', roleKeys: ['ar_clerk'] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: string; attachedExistingLogin?: boolean; passwordNotUsed?: boolean; notice?: string };
    expect(body.userId).toBe(u.id);
    expect(body.attachedExistingLogin).toBe(true);
    expect(body.passwordNotUsed).toBe(true);
    expect(body.notice).toMatch(/keeps? (their|the) own password/i);
    // Their own password still signs in; the typed one does not.
    expect((await signIn('shared@pps.local', 'TypedByAdmin2026')).status).toBe(401);
    expect((await signIn('shared@pps.local', 'samOwnPass123')).status).toBe(200);
  });

  it('a brand-new login gets no notice', async () => {
    as(owner, 'POST', '/api/users');
    const res = await usersPOST(req('POST', '/api/users', { name: 'Neo', login: 'neo', password: 'NeoPassword2026', roleKeys: ['ar_clerk'] }));
    const body = (await res.json()) as { attachedExistingLogin?: boolean; notice?: string };
    expect(res.status).toBe(201);
    expect(body.attachedExistingLogin).toBeFalsy();
    expect(body.notice).toBeUndefined();
  });
});
