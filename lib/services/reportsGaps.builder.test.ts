/**
 * Review-5 leftover: the Report Builder added up every matching ledger line in memory. It now
 * groups in the database; the totals per account, type and month are the same as the ledger's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { runReport } from './reportBuilder';
import { activityByAccount } from './reportEngine';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-builder');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'builder-gaps@test.local', name: 'B', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Builder Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const post = (date: string, amt: string, exp: string) =>
    postJournalEntry(ctx, { date: d(date), description: 'x', lines: [{ accountId: A[exp], debit: amt }, { accountId: A['1000'], credit: amt }] });
  await post('2026-01-10', '10.10', '6300');
  await post('2026-01-20', '20.20', '6300');
  await post('2026-02-05', '5.05', '6600');
  await post('2026-03-31', '7.00', '6300');
  await postJournalEntry(ctx, { date: d('2026-02-15'), description: 'sale', lines: [{ accountId: A['1000'], debit: '100.00' }, { accountId: A['4000'], credit: '100.00' }] });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Report Builder totals (grouped in the database)', () => {
  it('by account: each account’s debits and credits, as the ledger has them', async () => {
    const r = await runReport(ctx, { groupBy: 'account', from: '2026-01-01', to: '2026-12-31' });
    const act = await activityByAccount(ctx, { from: d('2026-01-01'), to: new Date('2026-12-31T23:59:59.999Z') });
    for (const a of act) {
      const row = r.rows.find((x) => x.key === a.accountId)!;
      expect(row.debit).toBe(Number(a.debit).toFixed(2));
      expect(row.credit).toBe(Number(a.credit).toFixed(2));
    }
    expect(r.rows.find((x) => x.key === A['6300'])!.label).toMatch(/^6300 — /);
    expect(r.totals.debit).toBe(r.totals.credit);
    expect(r.totals.debit).toBe('142.35');
  });

  it('by type and by month', async () => {
    const t = await runReport(ctx, { groupBy: 'type', from: '2026-01-01', to: '2026-12-31' });
    expect(t.rows.find((x) => x.key === 'expense')).toMatchObject({ label: 'Expense', debit: '42.35', credit: '0.00', net: '42.35' });
    expect(t.rows.find((x) => x.key === 'revenue')).toMatchObject({ credit: '100.00' });
    const m = await runReport(ctx, { groupBy: 'month', accountTypes: ['expense'] });
    expect(m.rows.map((x) => [x.key, x.label, x.debit])).toEqual([
      ['2026-01', 'January 2026', '30.30'],
      ['2026-02', 'February 2026', '5.05'],
      ['2026-03', 'March 2026', '7.00'],
    ]);
  });
});
