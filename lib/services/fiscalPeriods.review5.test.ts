/**
 * Round-5 review regression (fiscal periods): closing a period with a date that does not exist
 * (Feb 30) is refused with 400. `new Date('2026-02-30')` rolled over to March 2, so the closed
 * period silently started two days late and February 29 / March 1 postings stayed open.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { listPeriods } from './fiscalPeriods';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as periodsPOST } from '@/app/api/fiscal-periods/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fiscal-periods');
let db: DB;
const post = (body: unknown) =>
  periodsPOST(
    new NextRequest('http://localhost/api/fiscal-periods', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('fiscal periods (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@periods.test', name: 'Pia', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 Periods', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: an impossible period date is a 400 and closes nothing', async () => {
    for (const body of [
      { periodStart: '2026-02-30', periodEnd: '2026-03-31' },
      { periodStart: '2026-02-01', periodEnd: '2026-02-31' },
      { periodStart: '2026-13-01', periodEnd: '2026-12-31' },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await listPeriods(ctx)).toHaveLength(0);
    // A real period still closes.
    const ok = await post({ periodStart: '2026-02-01', periodEnd: '2026-02-28' });
    expect(ok.status).toBe(201);
  });
});
