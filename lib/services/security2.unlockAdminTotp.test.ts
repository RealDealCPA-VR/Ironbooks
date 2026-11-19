/**
 * Security package G2 — two-factor codes are single use in "Forgot the file password?" too
 * (POST /api/unlock/admin, security 2.6 follow-up).
 *
 * Sign-in accepts an authenticator code once (lib/services/totpCodes.ts acceptTotpCode); the Admin
 * unlock still checked codes with verifyTotp, so a code seen over someone's shoulder (with the
 * Admin's password) could remove a file password again within the code's 90 seconds.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-g2-unlock-admin-totp');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'g2-unlock-admin-secret';
delete process.env.BKA_INTERNAL_TOKEN;
delete process.env.BKA_COMPANY_SEALED;

import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import { generateSecret, generateTotp } from '@/lib/totp';
import { createCompany } from './company';
import { getFileLockStatus, setFilePassword } from './fileLock';
import { POST as adminPOST } from '@/app/api/unlock/admin/route';

let db: DB;
const secret = generateSecret();

const adminUnlock = (body: unknown) =>
  adminPOST(
    new NextRequest('http://127.0.0.1/api/unlock/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db
    .insert(users)
    .values({ email: 'owner', name: 'Owner', passwordHash: await hashPassword('ownerPass123'), totpEnabled: true, totpSecret: secret })
    .returning();
  await createCompany(db, { name: 'Two Step Co', ownerId: owner.id });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Admin unlock with two-step sign-in', () => {
  it('asks for the code, then accepts it once: the same code cannot unlock twice', async () => {
    (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    await setFilePassword(db, 'forgotten-one');
    expect(await (await adminUnlock({ login: 'owner', password: 'ownerPass123' })).json()).toEqual({ requires2fa: true });

    const code = generateTotp(secret, Date.now());
    const first = await adminUnlock({ login: 'owner', password: 'ownerPass123', totp: code });
    expect(first.status).toBe(200);
    expect((await getFileLockStatus(db)).enabled).toBe(false);

    // A file password set again; the same code, replayed within its 90 seconds, is refused.
    await setFilePassword(db, 'another-one');
    const replay = await adminUnlock({ login: 'owner', password: 'ownerPass123', totp: code });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ error: 'Invalid authentication code.', code: 'FORBIDDEN' });
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });

  it('a wrong code keeps the same message', async () => {
    (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    if (!(await getFileLockStatus(db)).enabled) await setFilePassword(db, 'third-one');
    // A code from ten minutes ahead: well outside the ±30-second window.
    const res = await adminUnlock({ login: 'owner', password: 'ownerPass123', totp: generateTotp(secret, Date.now() + 10 * 60_000) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Invalid authentication code.');
    expect((await getFileLockStatus(db)).enabled).toBe(true);
  });
});
