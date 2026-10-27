/**
 * Review round 5 — the Consolidated Reports page (GET /api/reports/consolidated).
 *
 * The page sends no dates, and the route then ran the consolidated Profit & Loss over ALL
 * history (every year's income added together) and the Balance Sheet over every posting,
 * including post-dated ones — with no period shown. Like every other P&L / balance sheet, no
 * dates now means fiscal year to date / as of today, and the response says which.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { localToday } from './reportEngine';

const hold = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => hold.ctx) }));
import { GET } from '@/app/api/reports/consolidated/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-consolidated');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-cons@test.local', name: 'R5 Cons', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Cons Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  hold.ctx = ctx;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const today = localToday();
  const year = Number(today.slice(0, 4));
  const sale = (date: string, amount: string) =>
    postJournalEntry(ctx, { date: new Date(`${date}T00:00:00.000Z`), description: 'sale', lines: [{ accountId: A['1000'], debit: amount }, { accountId: A['4000'], credit: amount }] });
  await sale(`${year - 2}-03-01`, '1000.00'); // two years ago
  await sale(`${year}-01-02`, '100.00'); // this fiscal year
  await sale(`${year + 1}-06-01`, '7.00'); // post-dated
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('consolidated reports without dates', () => {
  it('Profit & Loss is fiscal year to date, not all history', async () => {
    const res = await GET(new NextRequest('http://localhost/api/reports/consolidated?type=pl'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.consolidated.totalIncome).toBe('100.00');
    expect(body.consolidated.from.slice(0, 10)).toBe(`${localToday().slice(0, 4)}-01-01`);
    expect(body.consolidated.to.slice(0, 10)).toBe(localToday());
  });

  it('Balance Sheet is as of today (a post-dated entry is left out)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/reports/consolidated?type=bs'));
    const body = await res.json();
    expect(body.consolidated.totalAssets).toBe('1100.00');
    expect(body.consolidated.asOf.slice(0, 10)).toBe(localToday());
  });

  it('explicit dates still win', async () => {
    const y = Number(localToday().slice(0, 4));
    const res = await GET(new NextRequest(`http://localhost/api/reports/consolidated?type=pl&from=${y - 2}-01-01&to=${y - 2}-12-31`));
    expect((await res.json()).consolidated.totalIncome).toBe('1000.00');
  });
});
