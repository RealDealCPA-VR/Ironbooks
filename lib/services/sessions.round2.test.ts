/**
 * Re-test round 1 (tester): company-scoped "Who is logged in", per-company single-user mode,
 * file-wide vs company-wide exclusive access, idle-session expiry, and the 40-user seat limit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, singleUserMode, userCompanies, userSessions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  ACTIVE_WINDOW_MS,
  MAX_CONCURRENT_USERS,
  assertExclusiveAccess,
  assertSessionAllowed,
  enterSingleUserMode,
  exitSingleUserMode,
  getSingleUserMode,
  listActiveSessions,
  listSessionsForAdmin,
  signOutOtherSessions,
  signOutSession,
  startSession,
  touchSession,
} from './sessions';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sessions-round2');
let db: DB;
let coA: string;
let coB: string;
let adminA: string;
let clerkA: string;
let adminB: string;
let clerkB: string;
let both: string; // member of A and B

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

async function makeIdle(sessionId: string) {
  await db
    .update(userSessions)
    .set({ lastSeenAt: new Date(Date.now() - ACTIVE_WINDOW_MS - 5_000) })
    .where(eq(userSessions.id, sessionId));
}

async function endedReason(sessionId: string) {
  const [r] = await db.select().from(userSessions).where(eq(userSessions.id, sessionId));
  return r.endedAt ? r.endReason : null;
}

describe('sessions — re-test round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const mk = async (email: string, name: string) =>
      (await db.insert(users).values({ email, name, passwordHash: 'x' }).returning())[0].id;
    adminA = await mk('admin-a@r2.local', 'Admin A');
    clerkA = await mk('clerk-a@r2.local', 'Clerk A');
    adminB = await mk('admin-b@r2.local', 'Admin B');
    clerkB = await mk('clerk-b@r2.local', 'Secret Clerk B');
    both = await mk('both@r2.local', 'Both Companies');
    coA = (await db.insert(companies).values({ name: 'R2 Company A', ownerId: adminA }).returning())[0].id;
    coB = (await db.insert(companies).values({ name: 'R2 Company B', ownerId: adminB }).returning())[0].id;
    await db.insert(userCompanies).values([
      { userId: adminA, companyId: coA, role: 'owner' },
      { userId: clerkA, companyId: coA, role: 'accountant' },
      { userId: adminB, companyId: coB, role: 'owner' },
      { userId: clerkB, companyId: coB, role: 'accountant' },
      { userId: both, companyId: coA, role: 'accountant' },
      { userId: both, companyId: coB, role: 'accountant' },
    ]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('both companies can hold single-user mode at the same time, each gating only its own users', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const b = await startSession(db, { userId: adminB, companyId: coB });
    await enterSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    await enterSingleUserMode(ctx(coB, adminB, b.id, 'owner'));
    expect((await getSingleUserMode(db, coA))?.sessionId).toBe(a.id);
    expect((await getSingleUserMode(db, coB))?.sessionId).toBe(b.id);

    // A dual-member user is refused in A and in B (both held), by explicit company scope.
    const d = await startSession(db, { userId: both, companyId: coA });
    await expect(assertSessionAllowed(db, d.id, coA)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertSessionAllowed(db, d.id, coB)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Releasing A leaves B's hold intact.
    await exitSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    expect(await getSingleUserMode(db, coA)).toBeNull();
    expect((await getSingleUserMode(db, coB))?.sessionId).toBe(b.id);
    await expect(assertSessionAllowed(db, d.id, coA)).resolves.toBeUndefined();
    await expect(assertSessionAllowed(db, d.id, coB)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("Company A's admin cannot release Company B's single-user mode", async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const b = await startSession(db, { userId: adminB, companyId: coB });
    await enterSingleUserMode(ctx(coB, adminB, b.id, 'owner'));
    await exitSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    expect((await getSingleUserMode(db, coB))?.sessionId).toBe(b.id);
  });

  it('the holder\'s own company gate falls back to the session\'s sign-in company when no company is passed', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await enterSingleUserMode(ctx(coA, adminA, a.id, 'owner'));
    const cA = await startSession(db, { userId: clerkA, companyId: coA });
    const cB = await startSession(db, { userId: clerkB, companyId: coB });
    await expect(assertSessionAllowed(db, cA.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertSessionAllowed(db, cB.id)).resolves.toBeUndefined();
    // No session and no company: fail closed while anyone holds single-user mode.
    await expect(assertSessionAllowed(db, undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertSessionAllowed(db, 'not-a-uuid')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('sign-out-others in A ends neither B sessions nor B\'s single-user hold', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    const b = await startSession(db, { userId: adminB, companyId: coB });
    const cb = await startSession(db, { userId: clerkB, companyId: coB });
    await enterSingleUserMode(ctx(coB, adminB, b.id, 'owner')).catch(() => undefined);
    // B could not enter while clerk B was on; sign clerk B out from B and retry.
    await signOutSession(ctx(coB, adminB, b.id, 'owner'), cb.id);
    await enterSingleUserMode(ctx(coB, adminB, b.id, 'owner'));

    const n = await signOutOtherSessions(ctx(coA, adminA, a.id, 'owner'));
    expect(n).toBe(1);
    expect(await endedReason(c.id)).toBe('signed_out_by_admin');
    expect(await touchSession(db, b.id, adminB)).toBe(true);
    expect((await getSingleUserMode(db, coB))?.sessionId).toBe(b.id);
  });

  it('cross-company sign-out is NOT_FOUND (no existence oracle) and leaves no audit/side effect', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const cb = await startSession(db, { userId: clerkB, companyId: coB });
    const err = await signOutSession(ctx(coA, adminA, a.id, 'owner'), cb.id).catch((e) => e);
    const missing = await signOutSession(ctx(coA, adminA, a.id, 'owner'), '00000000-0000-4000-8000-000000000000').catch((e) => e);
    expect(err?.code).toBe('NOT_FOUND');
    expect(missing?.code).toBe('NOT_FOUND');
    expect(err.message).toBe(missing.message);
    expect(await endedReason(cb.id)).toBeNull();
  });

  it('"Who is logged in" for A never includes B-only users, even via the raw company-scoped list', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await startSession(db, { userId: clerkB, companyId: coB, remoteAddr: '100.90.1.2', userAgent: 'B-agent', viaHost: true });
    const d = await startSession(db, { userId: both, companyId: coB });
    const admin = await listSessionsForAdmin(ctx(coA, adminA, a.id, 'owner'));
    const raw = await listActiveSessions(db, { companyId: coA });
    for (const list of [admin, raw]) {
      expect(list.map((s) => s.userEmail)).not.toContain('clerk-b@r2.local');
      expect(list.some((s) => s.remoteAddr === '100.90.1.2' || s.userAgent === 'B-agent')).toBe(false);
    }
    // A member of both companies is (legitimately) visible to A's admin.
    expect(admin.map((s) => s.id)).toContain(d.id);
  });

  it('company-scope utilities (Condense) run while another company is busy; file-scope (Restore) does not', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await startSession(db, { userId: clerkB, companyId: coB });
    const actx = ctx(coA, adminA, a.id, 'owner');
    await expect(assertExclusiveAccess(actx, 'Condense Data')).resolves.toBeUndefined();
    const err = await assertExclusiveAccess(actx, 'Restore', { scope: 'file' }).catch((e) => e);
    expect(err?.code).toBe('CONFLICT');
    // Counted, never named.
    expect(err.message).not.toContain('Secret Clerk B');
    expect(err.message).not.toContain('clerk-b@r2.local');
    expect(err.message).toMatch(/1 from other companies/);
    // Holding A's single-user mode does not excuse B's users for a file-wide Restore.
    await enterSingleUserMode(actx);
    await expect(assertExclusiveAccess(actx, 'Restore', { scope: 'file' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a non-admin never passes the gate, in either scope, even when alone', async () => {
    await endAll();
    const c = await startSession(db, { userId: clerkA, companyId: coA });
    await expect(assertExclusiveAccess(ctx(coA, clerkA, c.id, 'accountant'), 'Condense Data')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertExclusiveAccess(ctx(coA, clerkA, c.id, 'accountant'), 'Restore', { scope: 'file' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertExclusiveAccess(ctx(coA, clerkA, c.id, 'viewer'), 'Import')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('passing the company gate ends idle sessions of THIS company only (idle B users keep their sessions)', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    const idleA = await startSession(db, { userId: clerkA, companyId: coA });
    const idleB = await startSession(db, { userId: clerkB, companyId: coB });
    await makeIdle(idleA.id);
    await makeIdle(idleB.id);
    await assertExclusiveAccess(ctx(coA, adminA, a.id, 'owner'), 'Rebuild Data');
    expect(await endedReason(idleA.id)).toBe('expired');
    expect(await endedReason(idleB.id)).toBeNull();
    expect(await endedReason(a.id)).toBeNull();
  });

  it('an idle caller is never expired by their own gate (keepSessionId)', async () => {
    await endAll();
    const a = await startSession(db, { userId: adminA, companyId: coA });
    await makeIdle(a.id);
    await assertExclusiveAccess(ctx(coA, adminA, a.id, 'owner'), 'Restore', { scope: 'file' });
    expect(await endedReason(a.id)).toBeNull();
  });

  // ---- 40-user seat limit (QB Enterprise) ----

  async function fillSeats(n: number): Promise<string[]> {
    const ids: string[] = [];
    const rows = await db
      .insert(users)
      .values(Array.from({ length: n }, (_, i) => ({ email: `seat-${Date.now()}-${i}@r2.local`, name: `Seat ${i}`, passwordHash: 'x' })))
      .returning({ id: users.id });
    for (const r of rows) {
      await startSession(db, { userId: r.id, companyId: coA, viaHost: true });
      ids.push(r.id);
    }
    return ids;
  }

  it('the 41st distinct remote user is refused; a second session for a seated user and the host itself still get in', async () => {
    await endAll();
    const seated = await fillSeats(MAX_CONCURRENT_USERS);
    await expect(startSession(db, { userId: clerkB, companyId: coB, viaHost: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(startSession(db, { userId: seated[0], companyId: coA, viaHost: true })).resolves.toHaveProperty('id');
    await expect(startSession(db, { userId: adminA, companyId: coA, viaHost: false })).resolves.toHaveProperty('id');
  });

  it('idle and ended sessions do not hold a seat', async () => {
    await endAll();
    await fillSeats(MAX_CONCURRENT_USERS);
    const [last] = await db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(and(eq(userSessions.viaHost, true), isNull(userSessions.endedAt)))
      .orderBy(userSessions.createdAt);
    await makeIdle(last.id);
    await expect(startSession(db, { userId: clerkB, companyId: coB, viaHost: true })).resolves.toHaveProperty('id');
  });

  it('two remote users signing in at the same moment cannot both take the last seat', async () => {
    await endAll();
    await fillSeats(MAX_CONCURRENT_USERS - 1);
    const results = await Promise.allSettled([
      startSession(db, { userId: clerkB, companyId: coB, viaHost: true }),
      startSession(db, { userId: both, companyId: coA, viaHost: true }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok, 'only one of the two may take seat #40').toBe(1);
    const distinct = await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`select count(distinct user_id)::int as n from user_sessions where ended_at is null` as any,
    );
    const n = Number((distinct as unknown as { rows: Array<{ n: number }> }).rows[0].n);
    expect(n).toBeLessThanOrEqual(MAX_CONCURRENT_USERS);
  });
});
