/**
 * Review round 5 (security): setting up a new company file's Admin (POST /api/auth/signup).
 *
 * Sign-up is only open while the file has no real user. It inserted the user first and created
 * the company afterwards, outside a transaction, so:
 *  1. a company name (or, with no company name, a person's name) longer than the column made the
 *     company insert fail AFTER the user was saved: the request answered HTTP 500 and the file was
 *     left with an Admin who belongs to no company — sign-up closed for good ("This company file
 *     already has users") and nobody could ever open the books;
 *  2. two sign-ups at once (a double-click on Create, two windows) both saw an empty file and
 *     both made an owner and a company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { ne } from 'drizzle-orm';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-signup');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-signup-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, userCompanies, userSessions, users } from '@/lib/db/schema';
import { POST as signupPOST } from '@/app/api/auth/signup/route';

let db: DB;

function signup(body: Record<string, unknown>) {
  return signupPOST(
    new NextRequest('http://127.0.0.1/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pat Owner', email: 'admin', password: 'harbor42go', companyName: 'Signup Co', ...body }),
    }),
  );
}

async function counts() {
  return {
    realUsers: (await db.select({ id: users.id }).from(users).where(ne(users.passwordHash, 'dev'))).length,
    companies: (await db.select({ id: companies.id }).from(companies)).length,
    memberships: (await db.select({ id: userCompanies.userId }).from(userCompanies)).length,
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

describe('sign-up never leaves a half-made company file', () => {
  beforeEach(async () => {
    // Every case starts from a brand-new, empty company file.
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    expect(await counts()).toEqual({ realUsers: 0, companies: 0, memberships: 0, sessions: 0 });
  });

  it('a company name longer than 255 characters is a plain 400 and saves nothing; the Admin can then be set up', async () => {
    const res = await signup({ companyName: 'Acme '.repeat(60) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/company name/i);
    expect(await counts()).toEqual({ realUsers: 0, companies: 0, memberships: 0, sessions: 0 });

    const ok = await signup({ companyName: 'Acme Plumbing' });
    expect(ok.status).toBe(201);
    expect(await counts()).toEqual({ realUsers: 1, companies: 1, memberships: 1, sessions: 1 });
  });

  it('a name longer than 255 characters is a plain 400 (not HTTP 500) and saves nothing', async () => {
    const res = await signup({ name: 'Bartholomew '.repeat(30) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION');
    expect(await counts()).toEqual({ realUsers: 0, companies: 0, memberships: 0, sessions: 0 });
  });

  it('a long name with no company name still makes the company ("<name>\'s Company" is shortened to fit)', async () => {
    const name = 'B'.repeat(250);
    const res = await signup({ name, companyName: '' });
    expect(res.status).toBe(201);
    const [c] = await db.select({ name: companies.name }).from(companies);
    expect(c.name.length).toBeLessThanOrEqual(255);
    expect(c.name.startsWith('BBBB')).toBe(true);
    expect(await counts()).toEqual({ realUsers: 1, companies: 1, memberships: 1, sessions: 1 });
  });

  it('two sign-ups at once make exactly one Admin and one company', async () => {
    const [a, b] = await Promise.all([
      signup({ email: 'admin', companyName: 'First Co' }),
      signup({ email: 'other', companyName: 'Second Co' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(await counts()).toEqual({ realUsers: 1, companies: 1, memberships: 1, sessions: 1 });
  });
});

