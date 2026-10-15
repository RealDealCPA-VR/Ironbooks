/**
 * K (gapsb): the sign-up ROUTE (app/api/auth/signup/route.ts) enforces the file's password
 * policy itself (passwordProblems + getPasswordPolicy) before it creates anything. Sign-up is only
 * open while the file has no real user, so this runs against its own empty company file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { ne } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-gapsb-signup-policy');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'gapsb-signup-policy-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, userSessions, users } from '@/lib/db/schema';
import { DEFAULT_PASSWORD_POLICY } from '@/lib/passwordPolicy';
import { POST as signupPOST } from '@/app/api/auth/signup/route';

let db: DB;

function signup(password: string, email = 'first@su.local') {
  return signupPOST(
    new NextRequest('http://127.0.0.1/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'First Owner', email, password, companyName: 'Signup Co' }),
    }),
  );
}
async function counts() {
  return {
    users: (await db.select({ id: users.id }).from(users)).length,
    realUsers: (await db.select({ id: users.id }).from(users).where(ne(users.passwordHash, 'dev'))).length,
    companies: (await db.select({ id: companies.id }).from(companies)).length,
    sessions: (await db.select({ id: userSessions.id }).from(userSessions)).length,
  };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sign-up route enforces the password policy before creating anything', () => {
  it('default rules: a password with no number is refused with the plain message; no user, company or session', async () => {
    const before = await counts();
    expect(before).toEqual({ users: 0, realUsers: 0, companies: 0, sessions: 0 });
    const res = await signup('lettersonly'); // long enough for the basic check, breaks "letters and numbers"
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The password needs a number.', code: 'VALIDATION' });
    expect(await counts()).toEqual(before);
    expect(res.cookies.get('bka_session')).toBeUndefined();
  });

  it("a stricter policy saved in the file (e.g. a seeded demo file's) is the one applied", async () => {
    // The seeded demo user (sentinel hash 'dev') doesn't close sign-up; its company carries a policy.
    const [demo] = await db.insert(users).values({ email: 'demo@su.local', name: 'Demo', passwordHash: 'dev' }).returning();
    await db.insert(companies).values({
      name: 'Demo Co',
      ownerId: demo.id,
      settings: { passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, minLength: 12, requireSymbol: true } },
    });
    const before = await counts();
    const res = await signup('harbor42'); // fine under the defaults
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The password needs at least 12 characters and a symbol (like ! # or $).');
    expect(await counts()).toEqual(before);

    // A compliant password goes through and creates the owner + company + session.
    const ok = await signup('harbor42-harbor!');
    expect(ok.status).toBe(201);
    const after = await counts();
    expect(after).toMatchObject({ realUsers: 1, companies: before.companies + 1, sessions: before.sessions + 1 });
  });
});
