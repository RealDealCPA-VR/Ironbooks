/**
 * Round-5 review regression (report date filters): the Audit Trail and Adjusting Journal Entries
 * routes read From / To with `new Date(...)`, which silently rolls a day that does not exist over
 * (2026-02-30 became March 2) and answered with a report for other dates. Both now refuse it
 * with a 400 like every other date filter (lib/validation/helpers.ts queryDate); real days and
 * the exact instants the Audit Trail window sends keep working.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as auditGET } from '@/app/api/audit-trail/route';
import { GET as adjustingGET } from '@/app/api/journal-entries/adjusting/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-audit-dates');
let db: DB;
const get = (url: string) => new NextRequest(`http://localhost${url}`);

describe('report date filters refuse days that do not exist (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@audit.dates', name: 'Aud', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 Audit dates', ownerId: user.id }).returning();
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

  it('Audit Trail: 2026-02-30 is a 400; a real day and an exact instant are fine', async () => {
    expect((await auditGET(get('/api/audit-trail?from=2026-02-30'))).status).toBe(400);
    expect((await auditGET(get('/api/audit-trail?to=2026-04-31'))).status).toBe(400);
    expect((await auditGET(get('/api/audit-trail?from=2026-02-28&to=2026-03-01'))).status).toBe(200);
    expect((await auditGET(get('/api/audit-trail?from=2026-02-28T05:00:00.000Z&to=2026-03-01T04:59:59.999Z'))).status).toBe(200);
  });

  it('Adjusting Journal Entries: 2026-02-30 is a 400; real days are fine', async () => {
    expect((await adjustingGET(get('/api/journal-entries/adjusting?from=2026-02-30'))).status).toBe(400);
    expect((await adjustingGET(get('/api/journal-entries/adjusting?to=2026-02-31'))).status).toBe(400);
    expect((await adjustingGET(get('/api/journal-entries/adjusting?from=2026-01-01&to=2026-02-28'))).status).toBe(200);
  });
});
