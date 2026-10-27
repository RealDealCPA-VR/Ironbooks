/**
 * Review round 5 (security) — opening a company file that has a file password (POST /api/unlock).
 *
 * The unlock screen asks the server with an EMPTY password every time it loads (that is how a
 * file without a password opens straight through). On a protected file each of those probes was
 * counted as a wrong password by the sign-in rate limiter, so a few page loads (a reload, two
 * windows, the app bouncing back to /unlock) locked the person out before they had typed anything
 * — and the screen then said "Incorrect password" for the right one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-unlock');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-unlock-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword, UNLOCK_COOKIE } from '@/lib/auth';
import { createCompany } from './company';
import { setFilePassword } from './fileLock';
import { POST as unlockPOST } from '@/app/api/unlock/route';

let db: DB;

function unlock(password: string | undefined) {
  return unlockPOST(
    new NextRequest('http://127.0.0.1/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password === undefined ? {} : { password }),
    }),
  );
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@unlock5.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  await createCompany(db, { name: 'Unlock Co', ownerId: u.id });
  await setFilePassword(db, 'open-sesame');
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('review5: the unlock screen probe is not a wrong password', () => {
  it('ten empty-password probes still answer "protected" (401) and never lock the person out', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await unlock(i % 2 ? '' : undefined);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, enabled: true, companyName: 'Unlock Co' });
    }
    const ok = await unlock('open-sesame');
    expect(ok.status).toBe(200);
    expect(ok.cookies.get(UNLOCK_COOKIE)?.value).toBeTruthy();
  });

  it('wrong passwords are still rate-limited, and the 429 says so (not "incorrect password")', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await unlock(`guess-${i}`)).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    const limited = await unlock('open-sesame');
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/too many/i);
  });
});
