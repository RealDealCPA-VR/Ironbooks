/**
 * Review round 5 (security) — Users & Roles.
 *
 *  1. Two-factor sign-in had no way back for a person who lost their phone / authenticator app:
 *     only a code from that authenticator turns it off (/api/auth/2fa/disable), and an Admin's
 *     Reset Password left it on, so the user could never sign in again. The Admin's reset can now
 *     turn it off too (audited), and Users & Roles shows who has it on.
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
