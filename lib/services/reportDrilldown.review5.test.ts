/**
 * Review round 5 — report explanations after a year-end close.
 *
 * The closing entry is dated on the fiscal year's last day. On a Balance Sheet as of that day
 * the report still shows the year's Net Income (like QuickBooks) and offsets the closing entry
 * in Retained Earnings; the drill-down of those lines must add up to the very same amounts.
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
import { yearEndClose } from './fiscalClose';
import { runStandardReport } from './reportRegistry';
import { drilldownCell } from './reportDrilldown';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-drilldown');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-drill@test.local', name: 'R5 Drill', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Close Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const je = (date: string, debit: string, credit: string, amount: string) =>
    postJournalEntry(ctx, { date: d(date), description: `je ${date}`, lines: [{ accountId: A[debit], debit: amount }, { accountId: A[credit], credit: amount }] });
  await je('2025-01-02', '1000', '3000', '1000.00'); // owner investment
  await je('2025-03-10', '1000', '4000', '700.00'); // income
  await je('2025-06-10', '6400', '1000', '200.00'); // rent
  await je('2026-02-10', '1000', '4000', '90.00'); // next year
  await yearEndClose(ctx, { fiscalYear: 2025 });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function explain(asOf: string, rowId: string) {
  const r = await drilldownCell(ctx, 'balance-sheet', { asOf }, rowId, 'total');
  return r;
}

describe('balance sheet drill-down after a year-end close', () => {
  it('as of the closed year end: Net Income, Retained Earnings and Total Equity tie', async () => {
    const report = await runStandardReport(ctx, 'balance-sheet', { asOf: '2025-12-31' });
    const ni = report.rows.find((x) => x.id === 'bs:ni')!;
    expect(ni.cells.total).toBe('500.00');
    const niX = await explain('2025-12-31', 'bs:ni');
    expect(niX.total).toBe('500.00');
    expect(niX.ties).toBe(true);

    // The close moved the year into Retained Earnings, offset in prior years' earnings: no line.
    expect(report.rows.find((x) => x.id.endsWith(`:a:${A['3900']}`))).toBeUndefined();

    for (const id of ['bs:equity:total', 'bs:le:total']) {
      const x = await explain('2025-12-31', id);
      expect(x.ties, id).toBe(true);
    }
  });

  it('as of a date in the next year: Retained Earnings (the closed year) and Net Income tie', async () => {
    const report = await runStandardReport(ctx, 'balance-sheet', { asOf: '2026-03-31' });
    const reRow = report.rows.find((x) => x.id.endsWith(`:a:${A['3900']}`))!;
    expect(reRow.cells.total).toBe('500.00');
    const reX = await explain('2026-03-31', reRow.id);
    expect(reX.ties).toBe(true);
    const niX = await explain('2026-03-31', 'bs:ni');
    expect(niX.total).toBe('90.00');
    expect(niX.ties).toBe(true);
  });
});

describe('Sales by Item Summary COGS explanation', () => {
  it('describes the posted cost of each sale, not the average cost', async () => {
    const x = await drilldownCell(ctx, 'sales-by-item-summary', { from: '2025-01-01', to: '2025-12-31' }, 'sbi:grand', 'cogs');
    expect(x.kind).toBe('formula');
    expect(x.formula).not.toMatch(/average cost/i);
    expect(x.formula).toMatch(/when (each|the) sale/i);
  });
});
