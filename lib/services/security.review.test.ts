/**
 * Security review regressions:
 *  1. An Admin password reset ends the user's existing sessions (an Admin resetting their own
 *     password keeps the session they did it from).
 *  2. Archived companies are never the active company: not from a stale cookie, not as the
 *     fallback, not at sign-in, not via /api/companies/select. A user whose only companies are
 *     archived is refused cleanly (ARCHIVED_ONLY_MESSAGE), not crashed.
 *  3. /api/auth/2fa/disable rate-limits wrong codes.
 *  4. The session-less first-run owner fallback only answers loopback Host headers (DNS rebinding).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review-security');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review-security-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { userSessions, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import {
  ARCHIVED_ONLY_MESSAGE,
  COMPANY_COOKIE,
  getServerContext,
  isLoopbackHostHeader,
} from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { generateSecret } from '@/lib/totp';
import { createCompany } from './company';
import { startSession } from './sessions';
import { addUser, resetUserPassword } from './users';
import { archiveCompany } from '@/app/api/companies/[id]/manage';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as selectPOST } from '@/app/api/companies/select/route';
import { POST as disable2faPOST } from '@/app/api/auth/2fa/disable/route';

let db: DB;
let ownerId: string;
let companyA: string;
let companyB: string;

function as(userId: string | null, method: string, routePath: string, sid?: string, company?: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) h.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user', sid));
  if (company) h.cookies.set(COMPANY_COOKIE, company);
}
function jsonRequest(url: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function login(email: string, password: string) {
  as(null, 'POST', '/api/auth/login');
  return loginPOST(jsonRequest('/api/auth/login', { email, password }));
}
async function session(userId: string, companyId: string) {
  return startSession(db, { userId, companyId, remoteAddr: 'local', userAgent: null, viaHost: false });
}

describe('security review regressions', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@rev.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    ownerId = u.id;
    companyA = (await createCompany(db, { name: 'Alpha Co', ownerId })).id;
    companyB = (await createCompany(db, { name: 'Beta Co', ownerId })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('admin password reset', () => {
    it('signs the user out of existing sessions', async () => {
      as(ownerId, 'GET', '/api/accounts', undefined, companyA);
      const clerk = await addUser(await getServerContext(), {
        name: 'Clerk',
        login: 'clerk@rev.local',
        password: 'clerkpass1',
        roleKeys: ['admin'],
      });
      const s = await session(clerk.userId, companyA);
      as(clerk.userId, 'GET', '/api/accounts', s.id, companyA);
      await expect(getServerContext()).resolves.toBeTruthy();

      as(ownerId, 'POST', `/api/users/${clerk.userId}/reset-password`, undefined, companyA);
      await resetUserPassword(await getServerContext(), clerk.userId, 'newClerkPass9');

      as(clerk.userId, 'GET', '/api/accounts', s.id, companyA);
      await expect(getServerContext()).rejects.toThrow(/Authentication required/);
      const [row] = await db.select().from(userSessions).where(eq(userSessions.id, s.id));
      expect(row.endReason).toBe('password_reset');
    });

    it("keeps the Admin's own session when they reset their own password", async () => {
      const mine = await session(ownerId, companyA);
      const other = await session(ownerId, companyA);
      as(ownerId, 'POST', `/api/users/${ownerId}/reset-password`, mine.id, companyA);
      await resetUserPassword(await getServerContext(), ownerId, 'ownerpass2');
      as(ownerId, 'GET', '/api/accounts', mine.id, companyA);
      await expect(getServerContext()).resolves.toBeTruthy();
      as(ownerId, 'GET', '/api/accounts', other.id, companyA);
      await expect(getServerContext()).rejects.toThrow(/Authentication required/);
    });
  });

  describe('archived companies', () => {
    let memberId: string;

    beforeAll(async () => {
      // A member who belongs ONLY to Alpha (which is about to be archived).
      as(ownerId, 'GET', '/api/accounts', undefined, companyA);
      memberId = (
        await addUser(await getServerContext(), {
          name: 'Alpha Only',
          login: 'alpha-only@rev.local',
          password: 'alphapass1',
          roleKeys: ['admin'],
        })
      ).userId;
      await archiveCompany(db, ownerId, companyA, 'Alpha Co');
    });

    it('is skipped by the fallback and by a stale cookie', async () => {
      as(ownerId, 'GET', '/api/accounts');
      expect((await getServerContext()).companyId).toBe(companyB);
      as(ownerId, 'GET', '/api/accounts', undefined, companyA);
      expect((await getServerContext()).companyId).toBe(companyB);
    });

    it('is not where sign-in lands', async () => {
      const res = await login('owner@rev.local', 'ownerpass2');
      expect(res.status).toBe(200);
      expect((await res.json()).companyId).toBe(companyB);
    });

    it('cannot be selected (404)', async () => {
      as(ownerId, 'POST', '/api/companies/select');
      const res = await selectPOST(jsonRequest('/api/companies/select', { companyId: companyA }));
      expect(res.status).toBe(404);
      as(ownerId, 'POST', '/api/companies/select');
      const ok = await selectPOST(jsonRequest('/api/companies/select', { companyId: companyB }));
      expect(ok.status).toBe(200);
    });

    it('a user whose only company is archived is refused cleanly', async () => {
      as(memberId, 'GET', '/api/accounts', undefined, companyA);
      await expect(getServerContext()).rejects.toThrow(ARCHIVED_ONLY_MESSAGE);
      const res = await login('alpha-only@rev.local', 'alphapass1');
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(ARCHIVED_ONLY_MESSAGE);
    });
  });

  describe('2FA disable', () => {
    it('rate-limits wrong codes', async () => {
      (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
      const [u] = await db
        .insert(users)
        .values({
          email: 'totp@rev.local',
          name: 'Totp',
          passwordHash: await hashPassword('totppass1'),
          totpEnabled: true,
          totpSecret: generateSecret(),
        })
        .returning();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        as(u.id, 'POST', '/api/auth/2fa/disable');
        statuses.push((await disable2faPOST(jsonRequest('/api/auth/2fa/disable', { token: '000000' }))).status);
      }
      expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
      expect(statuses).toContain(429);
      const [after] = await db.select().from(users).where(eq(users.id, u.id));
      expect(after.totpEnabled).toBe(true);
      (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    });
  });

  describe('first-run fallback Host guard', () => {
    it('recognises loopback Host headers only', () => {
      for (const ok of ['127.0.0.1:51234', 'localhost:3000', 'LOCALHOST', '[::1]:8080', '127.0.0.1', null]) {
        expect(isLoopbackHostHeader(ok)).toBe(true);
      }
      for (const bad of ['evil.example:51234', '100.101.102.103:47800', '192.168.1.5', 'localhost.evil.com', '[::2]:80']) {
        expect(isLoopbackHostHeader(bad)).toBe(false);
      }
    });

    it('refuses the session-less fallback for a rebinding Host', async () => {
      const prev = process.env.BKA_ALLOW_DEV_FALLBACK;
      process.env.BKA_ALLOW_DEV_FALLBACK = '1'; // reach the fallback even though users exist
      try {
        as(null, 'GET', '/api/accounts');
        h.headers.set('host', 'rebind.attacker.example:51234');
        await expect(getServerContext()).rejects.toThrow(/Authentication required/);
        as(null, 'GET', '/api/accounts');
        h.headers.set('host', '127.0.0.1:51234');
        await expect(getServerContext()).resolves.toBeTruthy();
      } finally {
        if (prev === undefined) delete process.env.BKA_ALLOW_DEV_FALLBACK;
        else process.env.BKA_ALLOW_DEV_FALLBACK = prev;
      }
    });
  });
});
