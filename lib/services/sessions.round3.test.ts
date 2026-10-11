/**
 * Re-test round 2 (tester): the 40-seat limit under concurrent sign-ins (advisory-lock fix),
 * rollback of refused sign-ins, and that the lock never wedges later sign-ins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, isNull, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { userSessions, users } from '@/lib/db/schema';
import { MAX_CONCURRENT_USERS, startSession } from './sessions';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sessions-round3');
let db: DB;
let seq = 0;

async function mkUsers(n: number): Promise<string[]> {
  const rows = await db
    .insert(users)
    .values(
      Array.from({ length: n }, () => {
        seq++;
        return { email: `r3-${Date.now()}-${seq}@r3.local`, name: `R3 ${seq}`, passwordHash: 'x' };
      }),
    )
    .returning({ id: users.id });
  return rows.map((r) => r.id);
}

async function endAll() {
  await db.update(userSessions).set({ endedAt: new Date() }).where(isNull(userSessions.endedAt));
}

async function seated(): Promise<number> {
  const res = await db.execute(sql`select count(distinct user_id)::int as n from user_sessions where ended_at is null`);
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}

async function fill(n: number): Promise<string[]> {
  const ids = await mkUsers(n);
  for (const id of ids) await startSession(db, { userId: id, viaHost: true });
  return ids;
}

describe('sessions — re-test round 2 (seat limit under concurrency)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('ten remote users racing for the last three seats: exactly three get in, the rest get CONFLICT', async () => {
    await endAll();
    await fill(MAX_CONCURRENT_USERS - 3);
    const racers = await mkUsers(10);
    const results = await Promise.allSettled(racers.map((userId) => startSession(db, { userId, viaHost: true })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'CONFLICT' });
    }
    expect(await seated()).toBe(MAX_CONCURRENT_USERS);
  });

  it('a refused sign-in leaves no session row behind (the transaction rolls back)', async () => {
    await endAll();
    await fill(MAX_CONCURRENT_USERS);
    const [late] = await mkUsers(1);
    await expect(startSession(db, { userId: late, viaHost: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const rows = await db.select().from(userSessions).where(eq(userSessions.userId, late));
    expect(rows).toHaveLength(0);
  });

  it('the same user opening two sessions concurrently when the file is full does not need a new seat', async () => {
    await endAll();
    const ids = await fill(MAX_CONCURRENT_USERS);
    const results = await Promise.allSettled([
      startSession(db, { userId: ids[5], viaHost: true }),
      startSession(db, { userId: ids[5], viaHost: true }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await seated()).toBe(MAX_CONCURRENT_USERS);
  });

  it('a host-machine sign-in racing remote ones always gets in; remote users never exceed the limit', async () => {
    await endAll();
    await fill(MAX_CONCURRENT_USERS - 1);
    const [hostUser] = await mkUsers(1);
    const remote = await mkUsers(3);
    const results = await Promise.allSettled([
      startSession(db, { userId: hostUser, viaHost: false }),
      ...remote.map((userId) => startSession(db, { userId, viaHost: true })),
    ]);
    expect(results[0].status).toBe('fulfilled');
    const remoteOk = results.slice(1).filter((r) => r.status === 'fulfilled').length;
    expect(remoteOk).toBeLessThanOrEqual(1);
    // Host session may push the count to 41 (host always gets in), never further.
    expect(await seated()).toBeLessThanOrEqual(MAX_CONCURRENT_USERS + 1);
  });

  it('after a refusal the advisory lock is released: a seat freed later can be taken immediately', async () => {
    await endAll();
    const ids = await fill(MAX_CONCURRENT_USERS);
    const [late] = await mkUsers(1);
    await expect(startSession(db, { userId: late, viaHost: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.update(userSessions).set({ endedAt: new Date() }).where(eq(userSessions.userId, ids[0]));
    const started = await Promise.race([
      startSession(db, { userId: late, viaHost: true }).then(() => 'ok'),
      new Promise((r) => setTimeout(() => r('timeout'), 5_000)),
    ]);
    expect(started).toBe('ok');
  });

  it('long remoteAddr / userAgent are truncated, not rejected', async () => {
    await endAll();
    const [u] = await mkUsers(1);
    const s = await startSession(db, { userId: u, remoteAddr: 'x'.repeat(500), userAgent: 'y'.repeat(5000) });
    const [row] = await db.select().from(userSessions).where(eq(userSessions.id, s.id));
    expect(row.remoteAddr).toHaveLength(100);
    expect(row.userAgent).toHaveLength(500);
  });
});
