/**
 * Review round 5 (security) — Users & Roles.
 *
 *  1. Two-factor sign-in had no way back for a person who lost their phone / authenticator app:
 *     only a code from that authenticator turns it off (/api/auth/2fa/disable), and an Admin's
 *     Reset Password left it on, so the user could never sign in again. The Admin's reset can now
 *     turn it off too (audited), and Users & Roles shows who has it on.
 *  2. Single-user mode keeps everyone else out of the company — except through the company-file
 *     routes that act on a company named in the URL: another Admin could rename or archive the
 *     company while the first one was doing maintenance in single-user mode.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-users');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-users-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { auditLogs, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess } from '@/lib/permissions/model';
import { generateSecret } from '@/lib/totp';
import { createCompany } from './company';
import { addUser } from './users';
import { POST as resetPasswordPOST } from '@/app/api/users/[id]/reset-password/route';
import { GET as usersGET } from '@/app/api/users/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { DELETE as companyIdDELETE, PATCH as companyIdPATCH } from '@/app/api/companies/[id]/route';
import { companies } from '@/lib/db/schema';
import { endUserSessions, enterSingleUserMode, exitSingleUserMode, startSession } from './sessions';

let db: DB;
let owner: string;
let clerk: string;
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

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@review5u.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Review5 Users Co', ownerId: owner })).id;
  const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
  clerk = (await addUser(ownerCtx, { name: 'AR Clerk', login: 'arclerk5', password: 'clerkPass123', roleKeys: ['ar_clerk'] })).userId;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function signIn(login: string, password: string) {
  as(null, 'POST', '/api/auth/login');
  return loginPOST(req('POST', '/api/auth/login', { email: login, password }));
}

describe('review5: an Admin can help a user who lost their authenticator', () => {
  it('Users & Roles shows who has two-factor sign-in on', async () => {
    await db.update(users).set({ totpSecret: generateSecret(), totpEnabled: true }).where(eq(users.id, clerk));
    as(owner, 'GET', '/api/users');
    const res = await usersGET();
    expect(res.status).toBe(200);
    const list = (await res.json()) as { userId: string; twoFactor?: boolean }[];
    expect(list.find((u) => u.userId === clerk)?.twoFactor).toBe(true);
    expect(list.find((u) => u.userId === owner)?.twoFactor).toBe(false);
  });

  it('a plain reset keeps two-factor sign-in on (the code is still asked)', async () => {
    as(owner, 'POST', `/api/users/${clerk}/reset-password`);
    const res = await resetPasswordPOST(
      req('POST', `/api/users/${clerk}/reset-password`, { password: 'NewClerk2026', requireChange: false }),
      params({ id: clerk }),
    );
    expect(res.status).toBe(200);
    const login = await signIn('arclerk5', 'NewClerk2026');
    expect(await login.json()).toEqual({ requires2fa: true });
  });

  it('a reset with "turn off two-factor sign-in" lets the user sign in with just the new password', async () => {
    as(owner, 'POST', `/api/users/${clerk}/reset-password`);
    const res = await resetPasswordPOST(
      req('POST', `/api/users/${clerk}/reset-password`, {
        password: 'Recovered2026',
        requireChange: false,
        turnOffTwoFactor: true,
      }),
      params({ id: clerk }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, clerk));
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();

    const login = await signIn('arclerk5', 'Recovered2026');
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.requires2fa).toBeUndefined();
    expect(body.id).toBe(clerk);

    // Audited, never with the password or the secret.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, clerk)));
    const last = audits.map((a) => JSON.stringify(a.newValues)).join('\n');
    expect(last).toContain('twoFactorTurnedOff');
    expect(last).not.toContain('Recovered2026');
  });
});

describe('review5: single-user mode also covers renaming and archiving the company', () => {
  it("another Admin can't rename or archive the company while it is in single-user mode", async () => {
    const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
    const admin2 = (await addUser(ownerCtx, { name: 'Second Admin', login: 'admin2r5', password: 'adminPass1234', roleKeys: ['admin'] })).userId;
    // Nobody else is signed in when the owner switches to single-user mode; Admin 2 signs in after.
    await endUserSessions(db, clerk, 'logout');
    const ownerSession = await startSession(db, { userId: owner, companyId });
    // Admin 2 also has another company, so archiving this one would otherwise be allowed.
    const other = await createCompany(db, { name: 'Other Co', ownerId: admin2 });
    expect(other.id).toBeTruthy();

    const signedIn = (userId: string, sid: string, method: string, url: string) => {
      as(null, method, url);
      h.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user', sid));
      h.cookies.set(COMPANY_COOKIE, companyId);
    };

    await enterSingleUserMode({ ...ownerCtx, sessionId: ownerSession.id });
    const adminSession = await startSession(db, { userId: admin2, companyId });
    try {
      signedIn(admin2, adminSession.id, 'PATCH', `/api/companies/${companyId}`);
      const rename = await companyIdPATCH(req('PATCH', `/api/companies/${companyId}`, { name: 'Renamed Behind Your Back' }), params({ id: companyId }));
      expect(rename.status).toBe(403);
      expect((await rename.json()).error).toMatch(/single-user mode/i);

      signedIn(admin2, adminSession.id, 'DELETE', `/api/companies/${companyId}`);
      const archive = await companyIdDELETE(
        req('DELETE', `/api/companies/${companyId}?confirm=${encodeURIComponent('Review5 Users Co')}`),
        params({ id: companyId }),
      );
      expect(archive.status).toBe(403);
      const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(row.name).toBe('Review5 Users Co');
      expect((row.settings as Record<string, unknown> | null)?.archived).not.toBe(true);

      // The person holding single-user mode can still rename it.
      signedIn(owner, ownerSession.id, 'PATCH', `/api/companies/${companyId}`);
      const own = await companyIdPATCH(req('PATCH', `/api/companies/${companyId}`, { name: 'Review5 Users Co' }), params({ id: companyId }));
      expect(own.status).toBe(200);
    } finally {
      await exitSingleUserMode({ ...ownerCtx, sessionId: ownerSession.id });
    }
  });
});
