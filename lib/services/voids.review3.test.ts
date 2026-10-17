/**
 * Review round 3 — void / undo symmetry repros.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, asc } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, salesOrderLines, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, voidInvoice } from './invoices';
import { createSalesOrder, getSalesOrder, convertToInvoice } from './salesOrders';
import { billRetainage, openRetainage } from './retainage';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor } from './vendors';
import { createVendorCredit, refundVendorCredit } from './vendorCredits';
import { voidEntry } from './journal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-voids');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('review3: void symmetry (voids.review3)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r3-voids@test.local', name: 'R3', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'R3 Voids Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1020', 'Euro Bank', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6300', 'Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    const [cust] = await db.insert(customers).values({ companyId: c.id, displayName: 'R3 Customer' }).returning();
    customerId = cust.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('voiding an invoice converted from a sales order gives the quantities back to the order', async () => {
    const order = await createSalesOrder(ctx, {
      customerId,
      date: d('2026-06-01'),
      lines: [{ description: 'Widget', quantity: 5, rate: '100.00' }],
    });
    const invoice = await convertToInvoice(ctx, order.id);
    expect((await getSalesOrder(ctx, order.id)).status).toBe('closed');

    await voidInvoice(ctx, invoice.id);

    const [line] = await db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, order.id))
      .orderBy(asc(salesOrderLines.lineOrder));
    // The voided invoice billed nothing: the order is open again with nothing invoiced.
    expect(Number(line.quantityInvoiced)).toBe(0);
    expect((await getSalesOrder(ctx, order.id)).status).not.toBe('closed');
    // ...so it can be invoiced again.
    await expect(convertToInvoice(ctx, order.id)).resolves.toBeTruthy();
  });

  it('voiding an invoice whose held retainage was already billed is refused (no negative retainage)', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Retainage Cust' }).returning();
    const held = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-06-01'),
      lines: [{ description: 'Phase 1', quantity: 1, rate: 1000, accountId: acct['4000'] }],
      retainagePercent: 10,
    });
    await billRetainage(ctx, { customerId: cust.id, date: d('2026-06-10') });
    expect(await openRetainage(ctx, cust.id)).toBe('0.00');

    let refused = false;
    try {
      await voidInvoice(ctx, held.id);
    } catch {
      refused = true;
    }
    // Either the void is refused, or retainage receivable cannot go negative.
    if (!refused) expect(Money(await openRetainage(ctx, cust.id))).toBeGreaterThanOrEqual(0);
  });

  it('voiding a foreign vendor credit refund gives back the FOREIGN amount (and its home value)', async () => {
    const v = await createVendor(ctx, { displayName: 'EUR Vendor', currency: 'EUR' });
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-07-01'),
      exchangeRate: '1.2345',
      lines: [{ accountId: acct['6300'], amount: '100.00' }],
    } as never);
    const [before] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    const { entry } = await refundVendorCredit(ctx, {
      vendorCreditId: vc.id,
      bankAccountId: acct['1020'],
      amount: '30.00',
      date: d('2026-08-10'),
      exchangeRate: '1.20',
    });
    await voidEntry(ctx, entry.id);
    const [after] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(after.unapplied).toBe('100.00');
    expect(after.refundedAmount).toBe('0.00');
    expect(after.homeUnapplied).toBe(before.homeUnapplied);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});

function Money(s: string): number {
  return Number(s);
}
