import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, ne } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createInvoice, voidInvoice } from './invoices';
import { billRetainage, retainageReport } from './retainage';
import { customerArLedgerBalance } from './statements';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-retainage');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
let otherCustomerId: string;
let incomeId: string;

async function openBalanceDue(cid: string) {
  const rows = await db
    .select({ b: invoices.balanceDue })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, cid), ne(invoices.status, 'void')));
  return rows.reduce((s, r) => s.plus(Money.of(r.b)), Money.zero()).toFixed(2);
}

describe('Retainage billing and report (p1/salesforms)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1ret@t.local', name: 'R', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'P1 Ret Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const seed: Array<[string, string, string, string]> = [
      ['1200', 'A/R', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of seed) {
      const [a] = await db.insert(accounts).values({ companyId: c.id, code, name, type: type as never, subtype: subtype as never }).returning();
      if (code === '4000') incomeId = a.id;
    }
    const [cust] = await db.insert(customers).values({ companyId: c.id, displayName: 'Builder Co' }).returning();
    customerId = cust.id;
    const [other] = await db.insert(customers).values({ companyId: c.id, displayName: 'Other Co' }).returning();
    otherCustomerId = other.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reports nothing when no retainage has been held', async () => {
    const rep = await retainageReport(ctx);
    expect(rep.rows).toEqual([]);
    expect(rep.ties).toBe(true);
    await expect(billRetainage(ctx, { customerId, date: new Date('2026-06-01') })).rejects.toThrow(/no retainage/i);
  });

  it('holds retainage, bills part of it into A/R, and everything ties', async () => {
    await createInvoice(ctx, {
      customerId,
      date: new Date('2026-06-01'),
      lines: [{ description: 'Phase 1', quantity: 1, rate: 10000, accountId: incomeId }],
      retainagePercent: 10,
    });
    await createInvoice(ctx, {
      customerId: otherCustomerId,
      date: new Date('2026-06-02'),
      lines: [{ description: 'Job', quantity: 1, rate: 2000, accountId: incomeId }],
      retainagePercent: 5,
    });

    let rep = await retainageReport(ctx);
    expect(rep.totalHeld).toBe('1100.00');
    expect(rep.totalOpen).toBe('1100.00');
    expect(rep.accountBalance).toBe('1100.00');
    expect(rep.ties).toBe(true);
    const builder = rep.rows.find((r) => r.customerId === customerId)!;
    expect(builder.open).toBe('1000.00');
    expect(builder.glOpen).toBe('1000.00');

    // Bill 400 of the 1000 held.
    const inv = await billRetainage(ctx, { customerId, date: new Date('2026-07-01'), amount: '400' });
    expect(inv.total).toBe('400.00');
    expect(inv.balanceDue).toBe('400.00');
    expect(inv.taxAmount).toBe('0.00');

    rep = await retainageReport(ctx);
    const b2 = rep.rows.find((r) => r.customerId === customerId)!;
    expect(b2.held).toBe('1000.00');
    expect(b2.billed).toBe('400.00');
    expect(b2.open).toBe('600.00');
    expect(b2.glOpen).toBe('600.00');
    expect(rep.accountBalance).toBe('700.00');
    expect(rep.ties).toBe(true);

    // As of before the billing, the full 1000 was still held.
    const before = await retainageReport(ctx, { asOf: new Date('2026-06-30'), customerId });
    expect(before.rows[0].open).toBe('1000.00');

    // A/R ties: open invoice balances == the customer's A/R in the GL (9000 + 400).
    expect(await openBalanceDue(customerId)).toBe('9400.00');
    expect(await customerArLedgerBalance(ctx, customerId)).toBe('9400.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it("refuses to bill more than what is still held", async () => {
    await expect(
      billRetainage(ctx, { customerId, date: new Date('2026-07-02'), amount: '600.01' }),
    ).rejects.toThrow(/Only 600\.00 of retainage/);
  });

  it('defaults to the full open amount, and voiding the bill puts it back in retainage', async () => {
    const inv = await billRetainage(ctx, { customerId, date: new Date('2026-07-03') });
    expect(inv.total).toBe('600.00');
    let rep = await retainageReport(ctx, { customerId });
    expect(rep.rows[0].open).toBe('0.00');
    await expect(billRetainage(ctx, { customerId, date: new Date('2026-07-04') })).rejects.toThrow(/no retainage left/);

    await voidInvoice(ctx, inv.id);
    rep = await retainageReport(ctx, { customerId });
    expect(rep.rows[0].open).toBe('600.00');
    expect(rep.ties).toBe(true);
    expect(await openBalanceDue(customerId)).toBe(await customerArLedgerBalance(ctx, customerId));
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
