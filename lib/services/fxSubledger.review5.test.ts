/**
 * Review round 5 (team fx) — the foreign A/R / A/P subledger on a large company file. With more
 * than 65,535 foreign invoices / bills, one IN (...) list over all of them exceeded Postgres' bind
 * parameter limit, so A/R and A/P aging, the integrity check and Home Currency Adjustment failed
 * ("bind message has N parameter formats but 0 parameters"). Failed before the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { upsertCurrency, setBaseCurrency } from './currencies';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { foreignOpenPayables, foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment } from './homeCurrencyAdjustment';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fxsubledger');
const N = 66_000;
let db: DB;
let ctx: ServiceContext;

describe('review5 fx subledger on a large file', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review5-fxsub@test.local', name: 'R5', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5 Big FX Co', ownerId: u.id });
    ctx = { db, companyId: company.id, userId: u.id };
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const c = await createCustomer(ctx, { displayName: 'Bulk EUR customer' } as never);
    const v = await createVendor(ctx, { displayName: 'Bulk EUR vendor' } as never);
    await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, v.id));
    // Opening open items brought over in bulk (no GL lines: the home open amount falls back to
    // the foreign open amount at the booked rate).
    await db.execute(sql`INSERT INTO invoices (company_id, customer_id, invoice_number, date, status, currency, exchange_rate, subtotal, tax_amount, total, balance_due, amount_paid)
      SELECT ${ctx.companyId}, ${c.id}, g, '2026-01-01', 'open', 'EUR', '1.2', '10', '0', '10', '10', '0' FROM generate_series(1, ${N}) g`);
    await db.execute(sql`INSERT INTO bills (company_id, vendor_id, date, status, currency, exchange_rate, total, balance_due)
      SELECT ${ctx.companyId}, ${v.id}, '2026-01-01', 'open', 'EUR', '1.2', '10', '10' FROM generate_series(1, ${N}) g`);
  }, 300_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('reads every open foreign invoice and bill, and a Home Currency Adjustment can be previewed', async () => {
    const asOf = new Date('2026-12-31T00:00:00Z');
    const recv = await foreignOpenReceivables(ctx, asOf);
    expect(recv.filter((i) => i.kind === 'invoice')).toHaveLength(N);
    const pay = await foreignOpenPayables(ctx, asOf);
    expect(pay.filter((i) => i.kind === 'bill')).toHaveLength(N);
    const p = await previewHomeCurrencyAdjustment(ctx, { date: asOf, rates: { EUR: '1.25' } });
    // EUR 660,000 receivable and payable, each revalued by 0.05.
    expect(p.lines.find((l) => l.kind === 'customer')?.adjustment).toBe('33000.00');
    expect(p.lines.find((l) => l.kind === 'vendor')?.adjustment).toBe('33000.00');
  }, 300_000);

  it('A/R aging as of a date reads every unapplied customer payment (A/R credit subledger)', async () => {
    const { arAging } = await import('./reportsExtra');
    const [cust] = await db.execute(sql`SELECT id FROM customers WHERE company_id = ${ctx.companyId} LIMIT 1`).then((r) => r.rows as Array<{ id: string }>);
    await db.execute(sql`INSERT INTO payments_received (company_id, customer_id, date, method, amount, unapplied, exchange_rate)
      SELECT ${ctx.companyId}, ${cust.id}, '2026-02-01', 'cash', '1', '1', '1' FROM generate_series(1, ${N}) g`);
    const aging = await arAging(ctx, new Date('2026-12-31T00:00:00Z'));
    // EUR 660,000 of invoices at 1.20 (USD 792,000) less USD 66,000 of unapplied payments.
    expect(aging.totals.total).toBe('726000.00');
  }, 300_000);
});
