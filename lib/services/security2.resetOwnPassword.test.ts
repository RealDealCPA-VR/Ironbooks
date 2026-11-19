/**
 * Security package G2 — POST /api/users/[id]/reset-password passes `currentPassword` on
 * (security 2.9 follow-up).
 *
 * resetUserPassword needs the current password when someone resets their OWN password (the
 * Change Password rule); the route's schema dropped the field, so that reset could never succeed
 * through the route. Resetting someone else's password is unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { resetPasswordSchema } from '@/lib/validation/users';
import type { ServiceContext } from './_base';
import { resolveAccess } from './access';
import { createCompany } from './company';
import { addUser, OWN_PASSWORD_RESET_MESSAGE } from './users';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as resetPOST } from '@/app/api/users/[id]/reset-password/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-g2-reset-own-password');
let db: DB;
let ownerId: string;
let admin: ServiceContext;

const reset = (id: string, body: unknown) =>
  resetPOST(
    new NextRequest(`http://localhost/api/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

async function passwordIs(userId: string, pw: string) {
  const [row] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId));
  return verifyPassword(pw, row.h);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@g2.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
    .returning();
  ownerId = u.id;
  const companyId = (await createCompany(db, { name: 'Reset Co', ownerId })).id;
  admin = { db, companyId, userId: ownerId, access: (await resolveAccess(db, companyId, ownerId)).access, role: 'owner' };
  routeCtx = admin;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
});

describe('reset-password route: your own password', () => {
  it('the schema keeps currentPassword (it used to be stripped)', () => {
    const parsed = resetPasswordSchema.safeParse({ password: 'newpass123', currentPassword: 'ownerpass1' });
    expect(parsed.success && parsed.data.currentPassword).toBe('ownerpass1');
    expect(resetPasswordSchema.safeParse({ password: 'newpass123', currentPassword: 7 }).success).toBe(false);
  });

  it('without the current password: refused, with the Change Password message', async () => {
    const res = await reset(ownerId, { password: 'takeover123' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(OWN_PASSWORD_RESET_MESSAGE);
    const wrong = await reset(ownerId, { password: 'takeover123', currentPassword: 'not-it' });
    expect(wrong.status).toBe(403);
    expect(await passwordIs(ownerId, 'ownerpass1')).toBe(true);
  });

  it('with it: the route resets your own password', async () => {
    const res = await reset(ownerId, { password: 'ownerpass2', currentPassword: 'ownerpass1' });
    expect(res.status).toBe(200);
    expect(await passwordIs(ownerId, 'ownerpass2')).toBe(true);
  });

  it("someone else's password still needs no current password", async () => {
    const clerk = await addUser(admin, { name: 'Clerk', login: 'clerk@g2.local', password: 'clerkpass1', roleKeys: ['bookkeeper'] });
    const res = await reset(clerk.userId, { password: 'clerkpass2' });
    expect(res.status).toBe(200);
    expect(await passwordIs(clerk.userId, 'clerkpass2')).toBe(true);
  });
});
