/**
 * Adversarial QA for multi-user sessions + single-user mode (tester pass): role bypasses,
 * cross-company isolation when one company file holds several companies, malformed ids,
 * and the single-user gate's behaviour for idle / revoked holders.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, singleUserMode, userCompanies, userSessions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  ACTIVE_WINDOW_MS,
  assertExclusiveAccess,
  assertSessionAllowed,
  endSession,
  enterSingleUserMode,
  exitSingleUserMode,
  getSingleUserMode,
  listSessionsForAdmin,
  signOutOtherSessions,
  signOutSession,
  startSession,
  touchSession,
} from './sessions';
import { getNetworkPolicy, setNetworkPolicy } from './networkPolicy';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sessions-adversarial');
let db: DB;
let coA: string;
let coB: string;
let adminA: string;
let clerkA: string;
let viewerA: string;
let adminB: string;

const ctx = (companyId: string, userId: string, sessionId: string | undefined, role: ServiceContext['role']): ServiceContext => ({
  db,
  companyId,
  userId,
  sessionId,
  role,
});

async function endAll() {
  await db.update(userSessions).set({ endedAt: new Date() });
  await db.delete(singleUserMode);
}

describe('sessions — adversarial', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const mk = async (email: string, name: string) =>
      (await db.insert(users).values({ email, name, passwordHash: 'x' }).returning())[0].id;
    adminA = await mk('admin-a@adv.local', 'Admin A');
    clerkA = await mk('clerk-a@adv.local', 'Clerk A');
    viewerA = await mk('viewer-a@adv.local', 'Viewer A');
    adminB = await mk('admin-b@adv.local', 'Admin B');
    coA = (await db.insert(companies).values({ name: 'Company A', ownerId: adminA }).returning())[0].id;
    coB = (await db.insert(companies).values({ name: 'Company B', ownerId: adminB }).returning())[0].id;
    await db.insert(userCompanies).values([
      { userId: adminA, companyId: coA, role: 'owner' },
      { userId: clerkA, companyId: coA, role: 'accountant' },
      { userId: viewerA, companyId: coA, role: 'viewer' },
      { userId: adminB, companyId: coB, role: 'owner' },
    ]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('non-admin roles cannot use any admin session control', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    const v = await startSession(db, { userId: viewerA, companyId: coA });
    const clerk = ctx(coA, clerkA, c.id, 'accountant');
    const viewer = ctx(coA, viewerA, v.id, 'viewer');
    for (const who of [clerk, viewer]) {
      await expect(listSessionsForAdmin(who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(signOutOtherSessions(who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(signOutSession(who, a.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(enterSingleUserMode(who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const util of ['Condense Data', 'Restore', 'Rebuild Data', 'Import']) {
        await expect(assertExclusiveAccess(who, util)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      await expect(setNetworkPolicy(who, { mode: 'allow-cloud', cloudOptIn: { ai: true } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    // Nobody got signed out by the attempts above.
    expect(await touchSession(db, a.id, adminA)).toBe(true);
    expect((await getNetworkPolicy({ db, companyId: coA })).mode).toBe('tailnet-only');
  });

  it('a non-admin cannot release an admin-held single-user mode', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await enterSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    await expect(exitSingleUserMode(ctx(coA, clerkA, c.id, 'accountant'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getSingleUserMode(db))?.sessionId).toBe(a.id);
    await expect(assertSessionAllowed(db, c.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a revoked (signed-out) holder cannot keep the file locked, and their cookie is dead', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await enterSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    // Holder is signed out by another admin path (e.g. ended directly).
    await endSession(db, a.id, 'signed_out_by_admin');
    expect(await getSingleUserMode(db)).toBeNull();
    expect(await touchSession(db, a.id, adminA)).toBe(false);
  });

  it('a stolen session id cannot be used under a different user id', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    expect(await touchSession(db, a.id, clerkA)).toBe(false);
    expect(await touchSession(db, a.id.toUpperCase(), adminA)).toBe(true); // uuid case-insensitive, same row
    for (const bad of ['', 'x', "' OR 1=1 --", `${a.id} `, `${a.id}x`]) {
      expect(await touchSession(db, bad, adminA)).toBe(false);
    }
    await expect(signOutSession(ctx(coA, adminA, a.id, 'owner'), "'; DROP TABLE users; --")).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('an idle holder (past the active window) loses single-user mode and others get in', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await enterSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    await expect(assertSessionAllowed(db, c.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - ACTIVE_WINDOW_MS - 5_000) })
      .where(eq(userSessions.id, a.id));
    await expect(assertSessionAllowed(db, c.id)).resolves.toBeUndefined();
  });

  // ---- Cross-company isolation (one company file may hold several companies: see
  // /api/companies/select). Admin powers in Company A must not reach Company B. ----

  it('"Who is logged in" for Company A does not list Company B users (names, emails, addresses)', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await startSession(db, { userId: adminB, companyId: coB, remoteAddr: '100.90.1.1', viaHost: true });
    const list = await listSessionsForAdmin(ctx(coA, adminA, a.id, 'owner'));
    expect(list.map((s) => s.userEmail)).not.toContain('admin-b@adv.local');
  });

  it("Company A's admin cannot sign out Company B's sessions", async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const b = await startSession(db, { userId: adminB, companyId: coB });
    await expect(signOutSession(ctx(coA, adminA, a.id, 'owner'), b.id)).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/),
    });
    await signOutOtherSessions(ctx(coA, adminA, a.id, 'owner')).catch(() => 0);
    expect(await touchSession(db, b.id, adminB)).toBe(true);
  });

  it("Company B's admin holding single-user mode does not lock Company A users out", async () => {
    await endAll();
    const b = await startSession(db, { userId: adminB, companyId: coB });
    await enterSingleUserMode(ctx(coB, adminB, b.id, 'owner'));
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    await expect(assertSessionAllowed(db, c.id)).resolves.toBeUndefined();
  });
});
