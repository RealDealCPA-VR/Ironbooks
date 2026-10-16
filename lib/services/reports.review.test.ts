/**
 * Regression: report / dashboard date bounds are UTC, matching stored document dates (UTC
 * midnight of the calendar day). Pinned to a US time zone, where local-midnight bounds used to
 * move each month's first-day activity into the previous month, drop Jan 1 from the dashboard
 * YTD KPIs, and show an invoice due today as overdue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { bills, companies, customers, invoices, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { profitAndLossByMonth } from './reportsComparative';
import { getDashboardInsights } from './dashboard';
import { runReport } from './reportBuilder';
import { ytdRange } from '@/lib/ytd';

// Deterministic: this file always runs in a time zone west of UTC (Date reads TZ at call time).
const origTz = process.env.TZ;
process.env.TZ = 'America/New_York';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-review');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'rev@rep.test', name: 'O', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Rev Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
  A.bank = (await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset' as never, subtype: 'checking' })).id;
  A.sales = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue' as never, subtype: 'sales' })).id;
  for (const [date, amt] of [['2025-01-01', '100'], ['2025-02-01', '50']] as const) {
    await postJournalEntry(ctx, {
      date: utc(date),
      description: 'sale',
      lines: [{ accountId: A.bank, debit: amt }, { accountId: A.sales, credit: amt }],
    });
  }
  // A late-in-the-day (UTC) entry on Jan 31, like the 23:59:59Z year-end closing entry.
  await postJournalEntry(ctx, {
    date: new Date('2025-01-31T23:59:59.000Z'),
    description: 'late sale',
    lines: [{ accountId: A.bank, debit: '7' }, { accountId: A.sales, credit: '7' }],
  });
});

afterAll(async () => {
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reports: UTC date bounds (US time zone)', () => {
  it('profitAndLossByMonth puts UTC-midnight entries in their own month', async () => {
    const r = await profitAndLossByMonth(ctx, 2025);
    expect(r.monthlyTotalIncome[0]).toBe('107.00'); // Jan 1 + Jan 31 23:59Z
    expect(r.monthlyTotalIncome[1]).toBe('50.00'); // Feb 1
    expect(r.totalIncome).toBe('157.00');
  });

  it('ytdRange starts at UTC midnight of the fiscal year start and runs through today', () => {
    const { from, to } = ytdRange('12-31', new Date(2025, 2, 15, 21, 0)); // 9pm local Mar 15
    expect(from.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2025-03-15T23:59:59.999Z');
    const fy = ytdRange('06-30', new Date(2025, 2, 15, 9, 0));
    expect(fy.from.toISOString()).toBe('2024-07-01T00:00:00.000Z');
  });

  it('report builder "to" day includes entries late in that UTC day', async () => {
    const r = await runReport(ctx, { from: '2025-01-01', to: '2025-01-31', groupBy: 'type', accountTypes: ['revenue'] });
    expect(r.totals.credit).toBe('107.00');
  });

  it('dashboard: YTD includes Jan 1; due-today invoice is not overdue; due-today bill is due this week', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Due Today Co' }).returning();
    await db.insert(invoices).values({
      companyId: ctx.companyId, customerId: cust.id, invoiceNumber: 9001, date: utc('2025-03-01'),
      dueDate: utc('2025-03-15'), status: 'open', total: '40.00', balanceDue: '40.00',
    });
    const [vend] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Due Today Vendor' }).returning();
    await db.insert(bills).values({
      companyId: ctx.companyId, vendorId: vend.id, billNumber: 'BT-1', date: utc('2025-03-01'),
      dueDate: utc('2025-03-15'), status: 'open', total: '25.00', balanceDue: '25.00',
    });
    const d = await getDashboardInsights(ctx, new Date(2025, 2, 15, 10, 0)); // 10am local Mar 15
    expect(d.kpis.revenueYtd).toBe('157.00');
    expect(d.overdueInvoices.find((i) => i.invoiceNumber === 9001)).toBeUndefined();
    expect(d.billsDueThisWeek.map((b) => b.billNumber)).toContain('BT-1');
    expect(d.arAging.current).toBe('40.00');
  });
});
