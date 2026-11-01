/**
 * Review-5 leftover: the dashboard's Cash / A/R / A/P tiles added up the cached account balances
 * (post-dated transactions included) while the A/R aging tile next to them is as of today, so
 * the two disagreed whenever something was dated in the future. The tiles are now as of today,
 * like the aging tile and the year-to-date figures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { postJournalEntry } from './posting';
import { getDashboardInsights } from './dashboard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-dashboard');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date('2026-06-15T15:00:00.000Z');

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'dash-gaps@test.local', name: 'D', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Dash Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const cust = (await createCustomer(ctx, { displayName: 'Acme' } as never)).id;
  // Today: 500 in the bank, a 300 invoice. Post-dated: 1,000 more cash and a 700 invoice next month.
  await postJournalEntry(ctx, { date: d('2026-06-01'), description: 'Owner money', lines: [{ accountId: A['1000'], debit: '500.00' }, { accountId: A['3000'] ?? A['3900'], credit: '500.00' }] });
  await postJournalEntry(ctx, { date: d('2026-07-20'), description: 'Post-dated', lines: [{ accountId: A['1000'], debit: '1000.00' }, { accountId: A['3000'] ?? A['3900'], credit: '1000.00' }] });
  await createInvoice(ctx, { customerId: cust, date: d('2026-06-10'), dueDate: d('2026-07-10'), lines: [{ accountId: A['4000'], quantity: 1, rate: '300.00', taxable: false }] } as never);
  await createInvoice(ctx, { customerId: cust, date: d('2026-07-25'), dueDate: d('2026-08-25'), lines: [{ accountId: A['4000'], quantity: 1, rate: '700.00', taxable: false }] } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('dashboard tiles are as of today', () => {
  it('Cash and A/R leave out post-dated transactions and agree with the aging tile', async () => {
    const dash = await getDashboardInsights(ctx, NOW);
    expect(dash.kpis.cash).toBe('500.00');
    expect(dash.kpis.accountsReceivable).toBe('300.00');
    expect(dash.arAging.total).toBe(dash.kpis.accountsReceivable);
  });
});
