/**
 * Review round 5 — the custom report builder (POST /api/report-builder, memorized "custom"
 * reports) answers bad options with a plain validation message, never a crash (HTTP 500):
 * an unparseable date, account types sent as a string instead of a list, an unknown group.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany } from './company';
import { runReport, type ReportConfig } from './reportBuilder';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-report-builder');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-builder@test.local', name: 'R5 Builder', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Builder Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const bad = async (cfg: unknown) => {
  const err = await runReport(ctx, cfg as ReportConfig).then(() => null, (e) => e);
  expect(err, JSON.stringify(cfg)).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe('VALIDATION');
};

describe('report builder options', () => {
  it('bad dates, account types and grouping are validation errors', async () => {
    await bad({ groupBy: 'account', from: 'not a date' });
    await bad({ groupBy: 'account', to: '2026-13-45' });
    await bad({ groupBy: 'account', accountTypes: 'asset' });
    await bad({ groupBy: 'account', accountTypes: ['asset', 'bogus'] });
    await bad({ groupBy: 'weekday' });
    await bad({ groupBy: 'month', from: '2026-03-01', to: '2026-01-01' });
  });

  it('good options still run', async () => {
    const r = await runReport(ctx, { groupBy: 'type', from: '2026-01-01', to: '2026-12-31', accountTypes: ['asset', 'revenue'] });
    expect(r.totals.debit).toBe('0.00');
  });
});
