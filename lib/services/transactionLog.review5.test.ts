/**
 * Round-5 review regression (Transaction Log window): the From / To dates are calendar days on
 * this computer, like everywhere else in the app (and like the Audit Trail window). They were read
 * as UTC days, so in New York a change made at 9:30 pm on Oct 26 was missing from "Oct 26" and
 * listed under Oct 27 instead.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import { writeAudit, type ServiceContext } from './_base';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as txLogGET } from '@/app/api/transaction-log/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-txlog');
let db: DB;
const realTz = process.env.TZ;
const ids = (page: { rows: Array<{ entityId: string | null }> }) => page.rows.map((r) => r.entityId);

describe('transaction log date filter (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@txlog.test', name: 'Tia', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 TxLog', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id, role: 'owner' };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it("A: a change at 9:30 pm in New York is listed under that day, not the next", async () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    const evening = '00000000-0000-4000-8000-000000000026';
    const nextMorning = '00000000-0000-4000-8000-000000000027';
    vi.setSystemTime(new Date('2026-10-27T01:30:00Z')); // Oct 26, 9:30 pm in New York
    await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: evening, newValues: { displayName: 'Evening' } });
    vi.setSystemTime(new Date('2026-10-27T13:00:00Z')); // Oct 27, 9:00 am in New York
    await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: nextMorning, newValues: { displayName: 'Morning' } });

    const day = async (d: string) => (await (await txLogGET(new NextRequest(`http://localhost/api/transaction-log?from=${d}&to=${d}&entityType=customer`))).json());
    expect(ids(await day('2026-10-26'))).toEqual([evening]);
    expect(ids(await day('2026-10-27'))).toEqual([nextMorning]);
  });
});
