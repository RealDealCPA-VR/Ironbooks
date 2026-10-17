/**
 * Round-3 review regressions (sales / A/R business rules):
 *  1. Credit limit: editing a partly paid invoice counts only what is still open on it.
 *  2. Balance-forward statements: payment-item lines on an invoice reduce the balance.
 *  3. Voiding an invoice made from a sales order gives the order its quantities back
 *     (also after the order or the invoice was edited).
 *  4. Credit limit: open credits (credit memos, unapplied payments) lower the balance checked.
 *  5. An invoice whose retainage was already billed cannot be voided.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, salesOrderLines, salesOrders, creditMemos } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, getInvoice, updateInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { customerStatement, customerArLedgerBalance } from './statements';
import { createSalesOrder, convertToInvoice, getSalesOrder, updateSalesOrder } from './salesOrders';
import { createCreditMemo } from './creditMemos';
import { billRetainage, openRetainage } from './retainage';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-sales');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let serviceItemId: string;
let paymentItemId: string;

async function newCustomer(name: string, creditLimit?: string) {
  const [c] = await db
    .insert(customers)
    .values({ companyId: ctx.companyId, displayName: name, taxable: true, creditLimit: creditLimit ?? null })
    .returning();
  return c.id;
}

async function soState(soId: string) {
  const [order] = await db.select().from(salesOrders).where(eq(salesOrders.id, soId));
  const lines = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, soId));
  return { status: order.status, invoiced: lines.map((l) => Number(l.quantityInvoiced)) };
}

describe('review3 sales', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r3@sales.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review3 Sales', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
    const [svc] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Svc', type: 'service' as never, salesPrice: '100.00', incomeAccountId: acct['4000'] })
      .returning();
    serviceItemId = svc.id;
    const [pi] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Deposit rec', type: 'payment' as never, salesPrice: '0', incomeAccountId: acct['4000'] })
      .returning();
    paymentItemId = pi.id;
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('credit limit: editing a partly paid invoice counts only what is still open on it', async () => {
    const cust = await newCustomer('Limited', '1000.00');
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2026-03-01'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 9, rate: '100.00', taxable: false }],
    });
    await receivePayment(ctx, {
      customerId: cust,
      date: new Date('2026-03-05'),
      method: 'check',
      amount: '800.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '800.00' }],
    });
    await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2026-03-06'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 5, rate: '100.00', taxable: false }],
    });
    // Open A/R is 100 + 500 = 600, under the 1,000 limit: a memo-only edit must not warn.
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId: cust,
        date: new Date('2026-03-01'),
        taxRateId: null,
        memo: 'typo fix',
        lines: [{ itemId: serviceItemId, quantity: 9, rate: '100.00', taxable: false }],
      }),
    ).resolves.toBeTruthy();
    // Raising it by 500 (open would be 1,100) still warns.
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId: cust,
        date: new Date('2026-03-01'),
        taxRateId: null,
        lines: [{ itemId: serviceItemId, quantity: 14, rate: '100.00', taxable: false }],
      }),
    ).rejects.toThrow(/Credit limit exceeded: this customer's balance would be 1100\.00/);
  });

  it('balance-forward statement: payment-item lines on an invoice reduce the balance', async () => {
    const cust = await newCustomer('Deposit payer');
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2026-04-01'),
      taxRateId: null,
      lines: [
        { itemId: serviceItemId, quantity: 1, rate: '500.00', taxable: false },
        { itemId: paymentItemId, quantity: 1, rate: '200.00', taxable: false },
      ],
    });
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('300.00');
    expect(Number(await customerArLedgerBalance(ctx, cust))).toBe(300);
    const stmt = await customerStatement(ctx, cust, { from: new Date('2026-04-01'), to: new Date('2026-04-30') });
    expect(stmt.lines.find((l) => l.type === 'invoice')?.amount).toBe('300.00');
    expect(stmt.closingBalance).toBe('300.00');
    const later = await customerStatement(ctx, cust, { from: new Date('2026-05-01'), to: new Date('2026-05-31') });
    expect(later.openingBalance).toBe('300.00');
  });

  it('voiding an invoice made from a sales order puts the quantity back on the order', async () => {
    const cust = await newCustomer('SO cust');
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: new Date('2026-05-01'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 4, rate: '100.00', taxable: false }],
    });
    const inv = await convertToInvoice(ctx, so.id);
    expect((await soState(so.id)).status).toBe('closed');
    await voidInvoice(ctx, inv.id);
    expect(await soState(so.id)).toEqual({ status: 'open', invoiced: [0] });
    // It can be invoiced again.
    await expect(convertToInvoice(ctx, so.id)).resolves.toBeTruthy();
    expect(await soState(so.id)).toEqual({ status: 'closed', invoiced: [4] });
  });

  it('the release still works after the sales order and the invoice were edited', async () => {
    const cust = await newCustomer('SO edit cust');
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: new Date('2026-05-01'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 4, rate: '100.00', taxable: false }],
    });
    const [line] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    const inv = await convertToInvoice(ctx, so.id, { lines: [{ lineId: line.id, quantity: 2 }] });
    expect(await soState(so.id)).toEqual({ status: 'partial', invoiced: [2] });

    // Edit the order (raise the quantity): the kept line keeps its id and invoiced quantity.
    const current = await getSalesOrder(ctx, so.id);
    await updateSalesOrder(ctx, so.id, {
      customerId: cust,
      date: new Date('2026-05-01'),
      taxRateId: null,
      lines: [{ id: current.lines[0].id, itemId: serviceItemId, quantity: 5, rate: '100.00', taxable: false }],
    });
    const [kept] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    expect(kept.id).toBe(line.id);

    // Edit the invoice (fewer units): the void still releases what the conversion claimed.
    await updateInvoice(ctx, inv.id, {
      customerId: cust,
      date: new Date('2026-05-01'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 1, rate: '100.00', taxable: false }],
    });
    await voidInvoice(ctx, inv.id);
    expect(await soState(so.id)).toEqual({ status: 'open', invoiced: [0] });
  });

  it('credit limit: an open credit memo lowers the balance checked against the limit', async () => {
    const cust = await newCustomer('Has credit', '1000.00');
    await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2026-06-01'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 8, rate: '100.00', taxable: false }],
    });
    await createCreditMemo(ctx, {
      customerId: cust,
      date: new Date('2026-06-02'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 5, rate: '100.00' }],
    } as never);
    const [m] = await db.select().from(creditMemos).where(eq(creditMemos.customerId, cust));
    expect(m.unapplied).toBe('500.00');
    // Balance 800 - 500 = 300; a 600 invoice brings it to 900 (< 1,000).
    await expect(
      createInvoice(ctx, {
        customerId: cust,
        date: new Date('2026-06-03'),
        taxRateId: null,
        lines: [{ itemId: serviceItemId, quantity: 6, rate: '100.00', taxable: false }],
      }),
    ).resolves.toBeTruthy();
    // 900 + 200 = 1,100 is over.
    await expect(
      createInvoice(ctx, {
        customerId: cust,
        date: new Date('2026-06-04'),
        taxRateId: null,
        lines: [{ itemId: serviceItemId, quantity: 2, rate: '100.00', taxable: false }],
      }),
    ).rejects.toThrow(/balance would be 1100\.00/);
  });

  it('an invoice whose retainage was billed cannot be voided until the billing is voided', async () => {
    const cust = await newCustomer('Contractor client');
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2026-07-01'),
      taxRateId: null,
      retainagePercent: 10,
      lines: [{ itemId: serviceItemId, quantity: 10, rate: '100.00', taxable: false }],
    });
    expect(await openRetainage(ctx, cust)).toBe('100.00');
    const billing = await billRetainage(ctx, { customerId: cust, date: new Date('2026-07-15'), amount: '60.00' });
    expect(await openRetainage(ctx, cust)).toBe('40.00');
    await expect(voidInvoice(ctx, inv.id)).rejects.toThrow(/Void the retainage billing invoice first/);
    expect((await getInvoice(ctx, inv.id)).status).not.toBe('void');

    await voidInvoice(ctx, billing.id);
    await voidInvoice(ctx, inv.id);
    expect(await openRetainage(ctx, cust)).toBe('0.00');
  });
});
