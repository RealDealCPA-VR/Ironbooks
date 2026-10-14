/**
 * Auth security fixes (audit round):
 *  1. Offline (desktop) self-service password reset only hands out the token on a single-user
 *     company file; with several users it refuses (ask an Admin). Both reset routes are
 *     rate-limited, and a successful reset ends the user's existing sessions.
 *  2. Malformed JSON bodies answer 400 VALIDATION (not 500); portal-password maps FORBIDDEN.
 *  3. Employee portal sessions are revocable: deactivating the employee or changing/removing
 *     their portal password invalidates existing portal tokens; legacy tokens are refused.
 *  4. The session-signing secret fails closed (no well-known fallback).
 *  5. One shared minimum password length (8).
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-auth-security-fixes');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'auth-security-fixes-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { employees, userSessions, users } from '@/lib/db/schema';
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  PORTAL_COOKIE,
  SESSION_COOKIE,
} from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { routeError } from '@/lib/routeErrors';
import { createCompany } from './company';
import { createEmployee, updateEmployee } from './payroll';
import { startSession } from './sessions';
import { addUser } from './users';
import { POST as requestResetPOST } from '@/app/api/auth/request-reset/route';
import { POST as resetPOST } from '@/app/api/auth/reset/route';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as portalLoginPOST } from '@/app/api/portal/login/route';
import { GET as portalMeGET } from '@/app/api/portal/me/route';
import { GET as paystubGET } from '@/app/api/payroll/paystub/route';
import { POST as portalPasswordPOST } from '@/app/api/employees/[id]/portal-password/route';

let db: DB;
let ownerId: string;
let companyId: string;

function as(userId: string | null, method: string, routePath: string, sid?: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user', sid));
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
function rawRequest(url: string, raw: string) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}
function resetLimiters() {
  (globalThis as unknown as { __bkaResetLimiter?: unknown }).__bkaResetLimiter = undefined;
}

describe('auth security fixes', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@sec.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    ownerId = u.id;
    companyId = (await createCompany(db, { name: 'Sec Co', ownerId })).id;
  });

  afterAll(async () => {
    delete process.env.BKA_OFFLINE;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => resetLimiters());

  // -------------------------------------------------------------------------
  describe('malformed JSON -> 400', () => {
    it('routeError maps a SyntaxError to 400 VALIDATION', async () => {
      const res = routeError(new SyntaxError('Unexpected token'), 'test');
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'Invalid JSON body', code: 'VALIDATION' });
    });

    it('auth routes answer 400 on a malformed body', async () => {
      as(null, 'POST', '/api/auth/signup');
      expect((await signupPOST(rawRequest('/api/auth/signup', '{nope'))).status).toBe(400);
      as(null, 'POST', '/api/auth/request-reset');
      expect((await requestResetPOST(rawRequest('/api/auth/request-reset', '{nope'))).status).toBe(400);
      as(null, 'POST', '/api/auth/reset');
      expect((await resetPOST(rawRequest('/api/auth/reset', 'not json'))).status).toBe(400);
      // A JSON array / null is not a valid body either.
      expect((await resetPOST(rawRequest('/api/auth/reset', 'null'))).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('password minimum is shared (8)', () => {
    it('reset and signup refuse passwords shorter than 8', async () => {
      expect(MIN_PASSWORD_LENGTH).toBe(8);
      as(null, 'POST', '/api/auth/reset');
      const r = await resetPOST(jsonRequest('/api/auth/reset', { token: 'x'.repeat(48), password: 'short7c' }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/min 8/);
      as(null, 'POST', '/api/auth/signup');
      const s = await signupPOST(
        jsonRequest('/api/auth/signup', { name: 'N', email: 'n@sec.local', password: 'seven77' }),
      );
      expect(s.status).toBe(400);
      expect((await s.json()).error).toMatch(/min 8/);
    });
  });

  // -------------------------------------------------------------------------
  describe('offline self-service reset', () => {
    beforeAll(() => {
      process.env.BKA_OFFLINE = '1';
    });

    it('single-user file: token is returned, reset works, and existing sessions are ended', async () => {
      const session = await startSession(db, { userId: ownerId, companyId, remoteAddr: 'local', userAgent: null, viaHost: false });
      as(null, 'POST', '/api/auth/request-reset');
      const r1 = await requestResetPOST(jsonRequest('/api/auth/request-reset', { email: 'owner@sec.local' }));
      expect(r1.status).toBe(200);
      const { token } = await r1.json();
      expect(typeof token).toBe('string');

      as(null, 'POST', '/api/auth/reset');
      const r2 = await resetPOST(jsonRequest('/api/auth/reset', { token, password: 'brandNewPass1' }));
      expect(r2.status).toBe(200);
      const [row] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(await verifyPassword('brandNewPass1', row.passwordHash)).toBe(true);
      expect(row.resetToken).toBeNull();
      const [s] = await db.select().from(userSessions).where(eq(userSessions.id, session.id));
      expect(s.endedAt).not.toBeNull();
      expect(s.endReason).toBe('password_reset');
      // The old session cookie no longer authenticates.
      as(ownerId, 'GET', '/api/accounts', session.id);
      await expect(getServerContext()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('wrong reset tokens are rate-limited', async () => {
      as(null, 'POST', '/api/auth/reset');
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await resetPOST(jsonRequest('/api/auth/reset', { token: `bad-${i}`, password: 'whatever123' }));
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });

    it('reset requests are rate-limited', async () => {
      as(null, 'POST', '/api/auth/request-reset');
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await requestResetPOST(jsonRequest('/api/auth/request-reset', { email: 'nobody@sec.local' }))).status);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    });

    it('multi-user file: refuses (ask an Admin) and issues no token, even for the owner', async () => {
      // Owner logs in and adds a restricted clerk.
      as(ownerId, 'POST', '/api/users');
      const admin = await getServerContext();
      await addUser(admin, { name: 'Clerk', login: 'clerk@sec.local', password: 'clerkpass1', roleKeys: ['sales'] });

      as(null, 'POST', '/api/auth/request-reset'); // the clerk, at the same machine, unauthenticated
      const r = await requestResetPOST(jsonRequest('/api/auth/request-reset', { email: 'owner@sec.local' }));
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.token).toBeUndefined();
      expect(body.error).toMatch(/ask an admin/i);
      const [row] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(row.resetToken).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('employee portal sessions are revocable', () => {
    let empId: string;

    async function portalLogin(password: string): Promise<string> {
      as(null, 'POST', '/api/portal/login');
      const res = await portalLoginPOST(jsonRequest('/api/portal/login', { email: 'pat@sec.local', password }));
      expect(res.status).toBe(200);
      return res.cookies.get(PORTAL_COOKIE)!.value;
    }
    async function meWith(token: string) {
      as(null, 'GET', '/api/portal/me');
      h.cookies.set(PORTAL_COOKIE, token);
      return portalMeGET();
    }

    beforeAll(async () => {
      as(ownerId, 'POST', '/api/employees');
      const ctx = await getServerContext();
      const emp = await createEmployee(ctx, {
        firstName: 'Pat',
        lastName: 'Lee',
        email: 'pat@sec.local',
        payType: 'salary',
        payRate: '50000.00',
      } as never);
      empId = emp.id;
      await db.update(employees).set({ portalPasswordHash: await hashPassword('portalPass1') }).where(eq(employees.id, empId));
    });

    it('a valid portal token works; a legacy token without a password version does not', async () => {
      const token = await portalLogin('portalPass1');
      expect((await meWith(token)).status).toBe(200);
      expect((await meWith(createSessionToken(empId, 'portal'))).status).toBe(401);
    });

    it('changing the portal password invalidates existing portal tokens', async () => {
      const token = await portalLogin('portalPass1');
      as(ownerId, 'POST', `/api/employees/${empId}/portal-password`);
      const r = await portalPasswordPOST(
        jsonRequest(`/api/employees/${empId}/portal-password`, { password: 'portalPass2' }),
        { params: Promise.resolve({ id: empId }) },
      );
      expect(r.status).toBe(200);
      expect((await meWith(token)).status).toBe(401);
      // The stale portal cookie alone no longer reaches a pay stub either (no main session).
      as(null, 'GET', '/api/payroll/paystub');
      h.cookies.set(PORTAL_COOKIE, token);
      const stub = await paystubGET(
        new NextRequest('http://127.0.0.1/api/payroll/paystub?paycheckId=00000000-0000-0000-0000-000000000000'),
      );
      expect(stub.status).toBe(403);
      expect((await meWith(await portalLogin('portalPass2'))).status).toBe(200);
    });

    it('deactivating the employee or removing the portal password ends portal sessions', async () => {
      const token = await portalLogin('portalPass2');
      as(ownerId, 'PATCH', `/api/employees/${empId}`);
      await updateEmployee(await getServerContext(), empId, { isActive: false } as never);
      expect((await meWith(token)).status).toBe(401);
      await db.update(employees).set({ isActive: true }).where(eq(employees.id, empId));
      expect((await meWith(token)).status).toBe(200);
      await db.update(employees).set({ portalPasswordHash: null }).where(eq(employees.id, empId));
      expect((await meWith(token)).status).toBe(401);
    });

    it('portal-password: bad JSON -> 400, short password -> 400, missing permission -> 403 (not 500)', async () => {
      const call = (body: string) =>
        portalPasswordPOST(rawRequest(`/api/employees/${empId}/portal-password`, body), {
          params: Promise.resolve({ id: empId }),
        });
      as(ownerId, 'POST', `/api/employees/${empId}/portal-password`);
      expect((await call('{bad')).status).toBe(400);
      expect((await call(JSON.stringify({ password: 'seven77' }))).status).toBe(400);
      const [clerk] = await db.select().from(users).where(eq(users.email, 'clerk@sec.local'));
      as(clerk.id, 'POST', `/api/employees/${empId}/portal-password`);
      expect((await call(JSON.stringify({ password: 'longEnough1' }))).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe('session-signing secret fails closed', () => {
    it('throws instead of falling back to a constant secret when .auth-secret is unavailable', () => {
      const savedSecret = process.env.BKA_AUTH_SECRET;
      const savedDir = process.env.BKA_DATA_DIR;
      // A data dir *under a regular file* can be neither read nor created.
      const blocker = path.resolve(process.cwd(), '.bookkeeper-data', 'test-auth-secret-blocker');
      fs.mkdirSync(path.dirname(blocker), { recursive: true });
      fs.writeFileSync(blocker, 'x');
      try {
        delete process.env.BKA_AUTH_SECRET;
        process.env.BKA_DATA_DIR = path.join(blocker, 'data');
        expect(() => createSessionToken('u1')).toThrow(/session-signing secret/);
      } finally {
        process.env.BKA_AUTH_SECRET = savedSecret;
        process.env.BKA_DATA_DIR = savedDir;
        fs.rmSync(blocker, { force: true });
      }
    });
  });
});
