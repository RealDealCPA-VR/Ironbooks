/**
 * Report gaps round — review-round-5 leftover: id lookups with more ids than Postgres can bind.
 *
 * Postgres / PGlite bind at most 65,535 parameters per statement and `inArray` binds one per id,
 * so Check Detail over 66,000 checks threw "bind message has … parameter formats but 0
 * parameters" (a 500). The same pattern was in Check Detail's bill payments, Deposit Detail, Bills
 * & Applied Payments and the cash-basis sales scope. They now pass the ids as ONE parameter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createVendor } from './vendors';
import { checkDetail, depositDetail } from './reportsExtra';
import { salesLines } from './reportsLists';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-bulk');
const N = 66_000;
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
let vendorId = '';

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'gaps-bulk@test.local', name: 'Bulk', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Bulk Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  vendorId = (await createVendor(ctx, { displayName: 'Bulk Vendor' } as never)).id;
  const c = company.id;
  // Document rows only (the reports read the document tables): bulk-loaded in SQL.
  await db.execute(sql`INSERT INTO expenses (company_id, date, method, reference, payment_account_id, payee_name, total)
    SELECT ${c}, timestamp '2026-07-01' + (g % 28) * interval '1 day', 'check', g::text, ${A['1000']}, 'Payee ' || g, 1.00 FROM generate_series(1, ${N}) g`);
  await db.execute(sql`INSERT INTO bill_payments (company_id, vendor_id, date, method, reference, payment_account_id, amount)
    SELECT ${c}, ${vendorId}, timestamp '2026-07-01' + (g % 28) * interval '1 day', 'check', (100000 + g)::text, ${A['1000']}, 1.00 FROM generate_series(1, ${N}) g`);
  await db.execute(sql`INSERT INTO deposits (company_id, deposit_account_id, date, total)
    SELECT ${c}, ${A['1000']}, timestamp '2026-07-01' + (g % 28) * interval '1 day', 1.00 FROM generate_series(1, ${N}) g`);
  await db.execute(sql`INSERT INTO bills (company_id, vendor_id, date, bill_number, total, balance_due)
    SELECT ${c}, ${vendorId}, timestamp '2026-07-01' + (g % 28) * interval '1 day', 'B' || g, 1.00, 1.00 FROM generate_series(1, ${N}) g`);
}, 600_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reports over more documents than one statement can bind', () => {
  it('Check Detail (all dates) lists 66,000 checks and 66,000 bill payments', async () => {
    const r = await checkDetail(ctx, {});
    expect(r.rows.filter((x) => x.source === 'expense')).toHaveLength(N);
    expect(r.rows.filter((x) => x.source === 'bill_payment')).toHaveLength(N);
    expect(r.total).toBe((2 * N).toFixed(2));
  }, 600_000);

  it('Deposit Detail lists 66,000 deposits', async () => {
    const r = await depositDetail(ctx, {});
    expect(r.rows).toHaveLength(N);
  }, 600_000);

  it('Bills & Applied Payments runs over 66,000 bills', async () => {
    const r = await runStandardReport(ctx, 'bills-applied-payments', { from: '2026-07-01', to: '2026-07-31' });
    expect(r.rows.filter((x) => x.cells.type === 'Bill')).toHaveLength(N);
  }, 600_000);

  it('the cash-basis sales scope takes 66,000 invoice and credit memo ids', async () => {
    const ids = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const lines = await salesLines(ctx, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T23:59:59Z') }, {}, { invoiceIds: ids, creditMemoIds: ids });
    expect(lines).toEqual([]);
  }, 600_000);
});
