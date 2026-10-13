/**
 * Multi-user sessions, "Who is logged in", single-user mode and the gate on admin utilities
 * (condense / restore / rebuild / import) — plus persistence of the Privacy & Network policy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, companies, userCompanies, userSessions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  ACTIVE_WINDOW_MS,
  assertExclusiveAccess,
  assertSessionAllowed,
  endSession,
  enterSingleUserMode,
  exitSingleUserMode,
  getSingleUserMode,
  listActiveSessions,
  listSessionsForAdmin,
  MAX_CONCURRENT_USERS,
  signOutOtherSessions,
  signOutSession,
  startSession,
  touchSession,
} from './sessions';
import { getNetworkPolicy, setNetworkPolicy } from './networkPolicy';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sessions');
let db: DB;
let companyId: string;
let adminId: string;
let clerkId: string;

/** A request context for a signed-in session (what getServerContext would build). */
function ctxFor(userId: string, sessionId: string | undefined, role: ServiceContext['role']): ServiceContext {
  return { db, companyId, userId, role, sessionId };
}

describe('multi-user sessions + single-user mode', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [admin] = await db.insert(users).values({ email: 'admin@test.local', name: 'Ada Admin', passwordHash: 'x' }).returning();
    const [clerk] = await db.insert(users).values({ email: 'clerk@test.local', name: 'Carl Clerk', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Hosted Co', ownerId: admin.id }).returning();
    await db.insert(userCompanies).values([
      { userId: admin.id, companyId: company.id, role: 'owner' },
      { userId: clerk.id, companyId: company.id, role: 'accountant' },
    ]);
    companyId = company.id;
    adminId = admin.id;
    clerkId = clerk.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a session is valid until it ends, and only for its own user', async () => {
    const s = await startSession(db, { userId: clerkId, companyId, remoteAddr: '100.70.1.2', viaHost: true });
    expect(await touchSession(db, s.id, clerkId)).toBe(true);
    expect(await touchSession(db, s.id, adminId)).toBe(false); // token/user mismatch
    expect(await touchSession(db, 'not-a-uuid', clerkId)).toBe(false);
    await endSession(db, s.id);
    expect(await touchSession(db, s.id, clerkId)).toBe(false);
  });

  it('"Who is logged in" lists recent sessions only, and only for admins', async () => {
    const a = await startSession(db, { userId: adminId, companyId });
    const c = await startSession(db, { userId: clerkId, companyId, remoteAddr: '100.70.1.3', viaHost: true });
    const idle = await startSession(db, { userId: clerkId, companyId });
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - ACTIVE_WINDOW_MS - 60_000) })
      .where(eq(userSessions.id, idle.id));

    const list = await listSessionsForAdmin(ctxFor(adminId, a.id, 'owner'));
    const ids = list.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(idle.id);
    expect(list.find((s) => s.id === a.id)?.isCurrent).toBe(true);
    expect(list.find((s) => s.id === c.id)).toMatchObject({ userName: 'Carl Clerk', viaHost: true, remoteAddr: '100.70.1.3' });

    await expect(listSessionsForAdmin(ctxFor(clerkId, c.id, 'accountant'))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Tidy up for the next test.
    await endSession(db, a.id);
    await endSession(db, c.id);
  });

  it('touching an idle session brings it back into the active list', async () => {
    const s = await startSession(db, { userId: clerkId, companyId });
    const old = new Date(Date.now() - ACTIVE_WINDOW_MS - 1000);
    await db.update(userSessions).set({ lastSeenAt: old }).where(eq(userSessions.id, s.id));
    expect((await listActiveSessions(db)).map((x) => x.id)).not.toContain(s.id);
    await touchSession(db, s.id, clerkId);
    expect((await listActiveSessions(db)).map((x) => x.id)).toContain(s.id);
    await endSession(db, s.id);
  });

  it('admin utilities need single-user mode while others are connected', async () => {
    const admin = await startSession(db, { userId: adminId, companyId });
    const adminCtx = ctxFor(adminId, admin.id, 'owner');

    // Alone in the file: allowed without single-user mode.
    await expect(assertExclusiveAccess(adminCtx, 'Condense Data')).resolves.toBeUndefined();

    // Non-admins can never run them.
    const clerk = await startSession(db, { userId: clerkId, companyId, remoteAddr: '100.70.1.4', viaHost: true });
    const clerkCtx = ctxFor(clerkId, clerk.id, 'accountant');
    await expect(assertExclusiveAccess(clerkCtx, 'Rebuild Data')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Someone else is connected: refused, naming who.
    const err = await assertExclusiveAccess(adminCtx, 'Restore').catch((e) => e);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/Restore needs single-user mode/);
    expect(err.message).toMatch(/Carl Clerk/);

    // Switching to single-user mode is refused while they are on…
    await expect(enterSingleUserMode(adminCtx)).rejects.toMatchObject({ code: 'CONFLICT' });
    // …the clerk can't switch at all…
    await expect(enterSingleUserMode(clerkCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // …so the admin signs everyone else out, then switches.
    expect(await signOutOtherSessions(adminCtx)).toBeGreaterThanOrEqual(1);
    expect(await touchSession(db, clerk.id, clerkId)).toBe(false);
    const holder = await enterSingleUserMode(adminCtx);
    expect(holder).toMatchObject({ sessionId: admin.id, userName: 'Ada Admin' });

    // While held: other sessions are refused at the door; the holder is not.
    const clerk2 = await startSession(db, { userId: clerkId, companyId });
    await expect(assertSessionAllowed(db, clerk2.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertSessionAllowed(db, undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertSessionAllowed(db, admin.id)).resolves.toBeUndefined();
    // The holder may run utilities even though a session exists.
    await expect(assertExclusiveAccess(adminCtx, 'Import')).resolves.toBeUndefined();

    // Back to multi-user mode: everyone may work again.
    await exitSingleUserMode(adminCtx);
    expect(await getSingleUserMode(db)).toBeNull();
    await expect(assertSessionAllowed(db, clerk2.id)).resolves.toBeUndefined();

    // The mode changes are in the audit trail.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'single_user_mode'));
    expect(audits.length).toBe(2);

    await endSession(db, admin.id);
    await endSession(db, clerk2.id);
  });

  it('single-user mode lapses when the holder logs out or goes idle', async () => {
    const admin = await startSession(db, { userId: adminId, companyId });
    await enterSingleUserMode(ctxFor(adminId, admin.id, 'owner'));
    expect(await getSingleUserMode(db)).not.toBeNull();
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - ACTIVE_WINDOW_MS - 1000) })
      .where(eq(userSessions.id, admin.id));
    expect(await getSingleUserMode(db)).toBeNull();

    const admin2 = await startSession(db, { userId: adminId, companyId });
    await enterSingleUserMode(ctxFor(adminId, admin2.id, 'owner'));
    await endSession(db, admin2.id); // logout releases it immediately
    expect(await getSingleUserMode(db)).toBeNull();
  });

  it('people can sign out their own session; only admins can sign out others', async () => {
    const admin = await startSession(db, { userId: adminId, companyId });
    const clerk = await startSession(db, { userId: clerkId, companyId });
    await expect(signOutSession(ctxFor(clerkId, clerk.id, 'accountant'), admin.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await signOutSession(ctxFor(adminId, admin.id, 'owner'), clerk.id);
    expect(await touchSession(db, clerk.id, clerkId)).toBe(false);
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, clerk.id));
    expect(row.endReason).toBe('signed_out_by_admin');
    await endSession(db, admin.id);
  });

  it('idle sessions are ended before a utility runs, so they cannot come back mid-operation', async () => {
    const admin = await startSession(db, { userId: adminId, companyId });
    const idle = await startSession(db, { userId: clerkId, companyId });
    await db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - ACTIVE_WINDOW_MS - 1000) })
      .where(eq(userSessions.id, idle.id));
    await assertExclusiveAccess(ctxFor(adminId, admin.id, 'owner'), 'Condense Data');
    expect(await touchSession(db, idle.id, clerkId)).toBe(false);
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, idle.id));
    expect(row.endReason).toBe('expired');
    expect(await touchSession(db, admin.id, adminId)).toBe(true);
    await endSession(db, admin.id);
  });

  it('enforces the 40-user limit for network sign-ins (the host machine always gets in)', async () => {
    await db.update(userSessions).set({ endedAt: new Date() }); // start from an empty file
    const extra: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_USERS; i++) {
      const [u] = await db.insert(users).values({ email: `seat${i}@test.local`, name: `Seat ${i}`, passwordHash: 'x' }).returning();
      extra.push((await startSession(db, { userId: u.id, viaHost: true })).id);
    }
    await expect(startSession(db, { userId: clerkId, viaHost: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const local = await startSession(db, { userId: adminId }); // over the limit, but local
    await endSession(db, extra.pop()!);
    // The host machine's own session takes a seat too, so one more must leave.
    await expect(startSession(db, { userId: clerkId, viaHost: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    await endSession(db, extra.pop()!);
    const clerk = await startSession(db, { userId: clerkId, viaHost: true });
    for (const id of [...extra, local.id, clerk.id]) await endSession(db, id);
  });

describe('several companies in one file', () => {
  let otherCo: string;
  let otherAdmin: string;
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: 'other@test.local', name: 'Olga Other', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'Other Co', ownerId: u.id }).returning();
    await db.insert(userCompanies).values({ userId: u.id, companyId: c.id, role: 'owner' });
    otherCo = c.id;
    otherAdmin = u.id;
  });

  it('per-company utilities ignore other companies; Restore (whole file) counts them without naming them', async () => {
    await db.update(userSessions).set({ endedAt: new Date() });
    const admin = await startSession(db, { userId: adminId, companyId });
    const other = await startSession(db, { userId: otherAdmin, companyId: otherCo });
    const adminCtx = ctxFor(adminId, admin.id, 'owner');
    await expect(assertExclusiveAccess(adminCtx, 'Condense Data')).resolves.toBeUndefined();
    const err = await assertExclusiveAccess(adminCtx, 'Restore', { scope: 'file' }).catch((e) => e);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/1 from other companies/);
    expect(err.message).not.toMatch(/Olga/);
    // Single-user mode for this company doesn't excuse other companies' users from a file restore.
    await enterSingleUserMode(adminCtx);
    await expect(assertSessionAllowed(db, other.id, otherCo)).resolves.toBeUndefined();
    await expect(assertExclusiveAccess(adminCtx, 'Restore', { scope: 'file' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await endSession(db, other.id);
    await expect(assertExclusiveAccess(adminCtx, 'Restore', { scope: 'file' })).resolves.toBeUndefined();
    await exitSingleUserMode(adminCtx);
    await endSession(db, admin.id);
  });
});

describe('Privacy & Network policy persistence', () => {
  it('defaults to tailnet-only, saves (owner/admin only) and audits', async () => {
    const owner = ctxFor(adminId, undefined, 'owner');
    expect(await getNetworkPolicy(owner)).toEqual({
      mode: 'tailnet-only',
      cloudOptIn: { ai: false, email: false, 'bank-feeds': false, updates: true },
    });

    await expect(
      setNetworkPolicy(ctxFor(clerkId, undefined, 'accountant'), { mode: 'allow-cloud', cloudOptIn: { ai: true } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setNetworkPolicy(owner, { mode: 'everything' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const saved = await setNetworkPolicy(owner, { mode: 'allow-cloud', cloudOptIn: { ai: true } });
    expect(saved).toEqual({ mode: 'allow-cloud', cloudOptIn: { ai: true, email: false, 'bank-feeds': false, updates: true } });
    expect(await getNetworkPolicy(owner)).toEqual(saved);

    // Other company settings are untouched.
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect((c.settings as Record<string, unknown>).networkPolicy).toEqual({ ...saved, rev: 2 });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'network_policy'));
    expect(audits.length).toBe(1);

    // Update checks can be turned off, and that choice survives a re-read.
    const off = await setNetworkPolicy(owner, { mode: 'tailnet-only', cloudOptIn: { updates: false } });
    expect(off.cloudOptIn.updates).toBe(false);
    expect((await getNetworkPolicy(owner)).cloudOptIn.updates).toBe(false);

    // A policy saved before update checks were on by default (no rev) reads as updates on.
    await db
      .update(companies)
      .set({ settings: { ...(c.settings as Record<string, unknown>), networkPolicy: { mode: 'tailnet-only', cloudOptIn: { updates: false } } } })
      .where(eq(companies.id, companyId));
    expect((await getNetworkPolicy(owner)).cloudOptIn.updates).toBe(true);
  });
});
});
