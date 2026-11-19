/**
 * Security review 2.6 + 2.7:
 *  - a two-factor code is accepted once (the last accepted 30-second step is remembered; the same
 *    code, or an older one, is refused), at sign-in and on the 2FA routes;
 *  - a session is ended on the server once it is older than the sign-in lifetime or unused for the
 *    idle limit (both 30 days, the cookie's own lifetime: nobody is signed out sooner than before);
 *  - signing out of the employee portal really ends the portal session: the same token (or a
 *    copy) no longer works.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-sign-in');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'security1-sign-in-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { employees, userSessions, users } from '@/lib/db/schema';
import { PORTAL_COOKIE, createPortalToken, hashPassword } from '@/lib/auth';
import { generateSecret, generateTotp } from '@/lib/totp';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { createEmployee } from './payroll';
import { resolveAccess } from './access';
import { acceptTotpCode } from './totpCodes';
import { SESSION_IDLE_LIMIT_MS, SESSION_MAX_AGE_MS, startSession, touchSession } from './sessions';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as portalLoginPOST } from '@/app/api/portal/login/route';
import { POST as portalLogoutPOST } from '@/app/api/portal/logout/route';
import { GET as portalMeGET } from '@/app/api/portal/me/route';

let db: DB;
let ownerId: string;
let companyId: string;
let secret: string;

function as(method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
}
function jsonRequest(url: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function resetLimiters() {
  const g = globalThis as unknown as { __bkaLoginLimiter?: unknown; __bkaResetLimiter?: unknown };
  g.__bkaLoginLimiter = undefined;
  g.__bkaResetLimiter = undefined;
}

describe('sign-in hardening (security 2.6, 2.7)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    secret = generateSecret();
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@si.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1'), totpEnabled: true, totpSecret: secret })
      .returning();
    ownerId = u.id;
    companyId = (await createCompany(db, { name: 'Sign-in Co', ownerId })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => resetLimiters());

  describe('two-factor codes are used once', () => {
    it('acceptTotpCode: the same code, or an older one, is refused; the next one works', async () => {
      const [other] = await db
        .insert(users)
        .values({ email: 'totp2@si.local', name: 'T2', passwordHash: 'x', totpEnabled: true, totpSecret: secret })
        .returning();
      const t = Date.now();
      const now = generateTotp(secret, t);
      const earlier = generateTotp(secret, t - 30_000);
      const next = generateTotp(secret, t + 30_000);
      expect(await acceptTotpCode(db, other.id, secret, now, t)).toBe(true);
      expect(await acceptTotpCode(db, other.id, secret, now, t)).toBe(false); // replay
      expect(await acceptTotpCode(db, other.id, secret, earlier, t)).toBe(false); // older step
      expect(await acceptTotpCode(db, other.id, secret, '000000', t)).toBe(false);
      expect(await acceptTotpCode(db, other.id, secret, next, t)).toBe(true); // newer step, within drift
    });

    it('sign-in: a code that already signed someone in is refused the second time', async () => {
      const code = generateTotp(secret, Date.now() + 30_000); // a step no earlier test used
      as('POST', '/api/auth/login');
      const first = await loginPOST(jsonRequest('/api/auth/login', { email: 'owner@si.local', password: 'ownerpass1', totp: code }));
      expect(first.status).toBe(200);
      as('POST', '/api/auth/login');
      const replay = await loginPOST(jsonRequest('/api/auth/login', { email: 'owner@si.local', password: 'ownerpass1', totp: code }));
      expect(replay.status).toBe(401);
      expect((await replay.json()).error).toBe('Invalid authentication code.');
    });
  });

  describe('server-side session lifetime', () => {
    it('a session past the sign-in lifetime is ended on the server', async () => {
      const s = await startSession(db, { userId: ownerId, companyId });
      expect(await touchSession(db, s.id, ownerId)).toBe(true);
      const old = new Date(Date.now() - SESSION_MAX_AGE_MS - 60_000);
      await db.update(userSessions).set({ createdAt: old }).where(eq(userSessions.id, s.id));
      expect(await touchSession(db, s.id, ownerId)).toBe(false);
      const [row] = await db.select().from(userSessions).where(eq(userSessions.id, s.id));
      expect(row.endedAt).not.toBeNull();
      expect(row.endReason).toBe('expired');
    });

    it('a session unused for the idle limit is ended; one used over a long weekend is not', async () => {
      const weekend = await startSession(db, { userId: ownerId, companyId });
      await db
        .update(userSessions)
        .set({ lastSeenAt: new Date(Date.now() - 4 * 24 * 3600_000), createdAt: new Date(Date.now() - 5 * 24 * 3600_000) })
        .where(eq(userSessions.id, weekend.id));
      expect(await touchSession(db, weekend.id, ownerId)).toBe(true);

      const idle = await startSession(db, { userId: ownerId, companyId });
      await db
        .update(userSessions)
        .set({ lastSeenAt: new Date(Date.now() - SESSION_IDLE_LIMIT_MS - 60_000) })
        .where(eq(userSessions.id, idle.id));
      expect(await touchSession(db, idle.id, ownerId)).toBe(false);
      expect((await db.select().from(userSessions).where(eq(userSessions.id, idle.id)))[0].endReason).toBe('expired');
    });

    it('the limits are no shorter than the 30-day sign-in cookie', () => {
      expect(SESSION_MAX_AGE_MS).toBeGreaterThanOrEqual(30 * 24 * 3600_000);
      expect(SESSION_IDLE_LIMIT_MS).toBeGreaterThanOrEqual(30 * 24 * 3600_000);
    });
  });

  describe('employee portal sign-out ends the session', () => {
    let empId: string;

    async function portalLogin(): Promise<string> {
      as('POST', '/api/portal/login');
      const res = await portalLoginPOST(jsonRequest('/api/portal/login', { email: 'emp@si.local', password: 'portalPass1' }));
      expect(res.status).toBe(200);
      return res.cookies.get(PORTAL_COOKIE)!.value;
    }
    async function meWith(token: string) {
      as('GET', '/api/portal/me');
      h.cookies.set(PORTAL_COOKIE, token);
      return portalMeGET();
    }

    beforeAll(async () => {
      const ctx = { db, companyId, userId: ownerId, access: (await resolveAccess(db, companyId, ownerId)).access };
      const emp = await createEmployee(ctx, { firstName: 'Emma', lastName: 'Ployee', email: 'emp@si.local', payType: 'hourly', payRate: '20.00' } as never);
      empId = emp.id;
      await db.update(employees).set({ portalPasswordHash: await hashPassword('portalPass1') }).where(eq(employees.id, empId));
    });

    it('the token used to sign out (and a copy of it) no longer works; signing in again does', async () => {
      const token = await portalLogin();
      const copy = token;
      expect((await meWith(token)).status).toBe(200);
      as('POST', '/api/portal/logout');
      h.cookies.set(PORTAL_COOKIE, token);
      const out = await portalLogoutPOST();
      expect(out.status).toBe(200);
      expect(out.cookies.get(PORTAL_COOKIE)?.value).toBe('');
      expect((await meWith(copy)).status).toBe(401);
      const fresh = await portalLogin();
      expect((await meWith(fresh)).status).toBe(200);
    });

    it('portal sign-ins made before this version (sign-out count 0) keep working until a sign-out', async () => {
      await db.update(employees).set({ portalTokenVersion: 0 }).where(eq(employees.id, empId));
      const [emp] = await db.select().from(employees).where(eq(employees.id, empId));
      const older = createPortalToken(empId, emp.portalPasswordHash!); // minted the old way
      expect((await meWith(older)).status).toBe(200);
      as('POST', '/api/portal/logout');
      h.cookies.set(PORTAL_COOKIE, older);
      await portalLogoutPOST();
      expect((await meWith(older)).status).toBe(401);
    });

    it('a stale copy cannot sign out the session that replaced it', async () => {
      const stale = await portalLogin();
      as('POST', '/api/portal/logout');
      h.cookies.set(PORTAL_COOKIE, stale);
      await portalLogoutPOST();
      const current = await portalLogin();
      as('POST', '/api/portal/logout');
      h.cookies.set(PORTAL_COOKIE, stale);
      await portalLogoutPOST();
      expect((await meWith(current)).status).toBe(200);
    });
  });
});
