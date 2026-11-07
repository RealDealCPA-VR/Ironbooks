/**
 * "Forgot the file password?" (POST /api/unlock/admin, app/unlock/page.tsx).
 *
 * A forgotten company-file password must not lock the file's own Admin out of their books: an
 * Admin of every company in the file signs in with their own user name and password, and the file
 * password is removed (the unlock screen then opens straight through). Nobody else can, a wrong
 * password is rate-limited like sign-in, and a teammate connected over the network can't do it.
 * The unlock screen learns which way back in the file offers from /api/unlock's `recovery`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, type NextResponse } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-unlock-admin');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'unlock-admin-secret';
delete process.env.BKA_INTERNAL_TOKEN;
delete process.env.BKA_COMPANY_SEALED;

import { closeDb, getDb, type DB } from '@/lib/db';
import { userCompanies, users } from '@/lib/db/schema';
import { hashPassword, UNLOCK_COOKIE } from '@/lib/auth';
import { REMOTE_ADDR_HEADER } from '@/lib/net/requestInfo';
import { createCompany } from './company';
import { getFileLockStatus, setFilePassword } from './fileLock';
import { POST as unlockPOST } from '@/app/api/unlock/route';
import { POST as adminPOST } from '@/app/api/unlock/admin/route';

let db: DB;
let companyId: string;

function post(handler: (req: NextRequest) => Promise<NextResponse>, url: string, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new NextRequest(`http://127.0.0.1${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}
const adminUnlock = (body: unknown, headers?: Record<string, string>) => post(adminPOST, '/api/unlock/admin', body, headers);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db
    .insert(users)
    .values({ email: 'owner', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  const company = await createCompany(db, { name: 'Forgot Co', ownerId: owner.id });
  companyId = company.id;
  const [clerk] = await db
    .insert(users)
    .values({ email: 'clerk', name: 'Clerk', passwordHash: await hashPassword('clerkPass123') })
    .returning();
  await db.insert(userCompanies).values({ userId: clerk.id, companyId, role: 'viewer' });
  await setFilePassword(db, 'forgotten-one');
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('forgotten company-file password', () => {
  it('the unlock screen is told an Admin can remove it (the file is not encrypted)', async () => {
    const res = await post(unlockPOST, '/api/unlock', {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ enabled: true, recovery: 'admin' });
  });

  it('a user who is not an Admin of the file cannot remove it', async () => {
    const res = await adminUnlock({ login: 'clerk', password: 'clerkPass123' });
    expect(res.status).toBe(403);
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });

  it('a wrong Admin password does not remove it', async () => {
    const res = await adminUnlock({ login: 'owner', password: 'not-it' });
    expect(res.status).toBe(403);
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });

  it('never for a teammate connected over the network', async () => {
    const res = await adminUnlock({ login: 'owner', password: 'ownerPass123' }, { [REMOTE_ADDR_HEADER]: '100.64.0.9' });
    expect(res.status).toBe(403);
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });

  it("the Admin's own sign-in removes it and unlocks the file", async () => {
    const res = await adminUnlock({ login: 'Owner', password: 'ownerPass123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, companyName: 'Forgot Co' });
    expect(res.cookies.get(UNLOCK_COOKIE)?.value).toBeTruthy();
    expect((await getFileLockStatus(db)).enabled).toBe(false);
    // The unlock screen now opens straight through.
    expect((await post(unlockPOST, '/api/unlock', {})).status).toBe(200);
  });
});
