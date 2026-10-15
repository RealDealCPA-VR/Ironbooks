/**
 * Integration tests for the Sales Receipts service.
 *
 * Boots a throwaway PGlite database, seeds the minimum accounts/items, creates
 * sales receipts, and asserts that:
 *   - Money lands in the deposit account (Undeposited Funds by default).
 *   - Income and sales tax payable are credited correctly.
 *   - Inventory lines relieve stock and post COGS (average cost AND FIFO).
 *   - Voiding reverses every GL entry and restores stock.
 *   - Receipt numbers are sequential per company.
 *   - Trial balance remains balanced after every operation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  items,
  taxAgencies,
  taxRates,
  journalEntries,
  classes,
  salesReceipts,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { adjustInventory } from './inventory';
import { receiveStock } from './fifo';
import { Money } from '@/lib/money';
import {
  createSalesReceipt,
  getSalesReceipt,
  listSalesReceipts,
  updateSalesReceipt,
  voidSalesReceipt,
} from './salesReceipts';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-receipts');

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;
let taxRateId: string;
let avgItemId: string; // average-cost inventory item
let fifoItemId: string; // FIFO-tracked inventory item
let serviceItemId: string; // service item (no COGS)

async function balanceOf(accountId: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return row.balance;
}

describe('Sales Receipts service (end-to-end)', () => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@salesreceipts.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Sales Receipt Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4100', 'Service Income', 'revenue', 'service_revenue'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Customer (optional on receipts, but used in some tests).
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Counter Customer', taxable: true })
      .returning();
    customerId = cust.id;

    // Tax agency + 10% rate (easy math).
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'State Board', liabilityAccountId: acct['2200'] })
      .returning();
    const [tr] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id, isActive: true })
      .returning();
    taxRateId = tr.id;

    // Average-cost inventory item: receive 10 @ $6 (avgCost 6.00).
    const [avgItem] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Avg Widget',
        sku: 'AVG-1',
        type: 'inventory',
        salesPrice: '20.00',
        incomeAccountId: acct['4000'],
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();
    avgItemId = avgItem.id;
    await adjustInventory(ctx, {
      itemId: avgItemId,
      quantityChange: 10,
      unitCost: 6,
      date: new Date('2025-01-01'),
    });

    // FIFO inventory item: two layers — 5 @ $4, then 5 @ $5.
    const [fifoItem] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'FIFO Gadget',
        sku: 'FIF-1',
        type: 'inventory',
        salesPrice: '15.00',
        incomeAccountId: acct['4000'],
        quantityOnHand: '0',
      })
      .returning();
    fifoItemId = fifoItem.id;
    await receiveStock(ctx, { itemId: fifoItemId, quantity: 5, unitCost: 4, date: new Date('2025-01-02') });
    await receiveStock(ctx, { itemId: fifoItemId, quantity: 5, unitCost: 5, date: new Date('2025-01-03') });

    // Service item — must not trigger COGS.
    const [svcItem] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Tune-up Service',
        type: 'service',
        salesPrice: '99.00',
        incomeAccountId: acct['4100'],
      })
      .returning();
    serviceItemId = svcItem.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: simple counter sale, no customer, defaults to Undeposited Funds
  // -------------------------------------------------------------------------
  it('creates a walk-in receipt and debits Undeposited Funds by default', async () => {
    const ufBefore = await balanceOf(acct['1050']);

    const receipt = await createSalesReceipt(ctx, {
      date: new Date('2025-03-01'),
      lines: [
        { accountId: acct['4000'], description: 'Counter sale', quantity: 2, rate: 50 },
        { accountId: acct['4100'], description: 'Quick fix', quantity: 1, rate: 75 },
      ],
    });

    expect(receipt.receiptNumber).toBe(1);
    expect(receipt.customerId).toBeNull();
    expect(receipt.subtotal).toBe('175.00');
    expect(receipt.taxAmount).toBe('0.00');
    expect(receipt.total).toBe('175.00');
    expect(receipt.status).toBe('paid');
    expect(receipt.method).toBe('cash');
    expect(receipt.depositAccountId).toBe(acct['1050']);
    expect(receipt.postedEntryId).toBeTruthy();

    // Money landed in Undeposited Funds; income credited.
    const ufAfter = await balanceOf(acct['1050']);
    expect(ufAfter).toBe(Money.of(ufBefore).plus(175).toFixed(2));

    // sourceRef traceability on the posted entry.
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, receipt.postedEntryId!));
    expect(entry.sourceRef).toBe(`salesreceipt:${receipt.id}`);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: sales tax — taxable vs non-taxable lines
  // -------------------------------------------------------------------------
  it('credits Sales Tax Payable for taxable lines only', async () => {
    const taxBefore = await balanceOf(acct['2200']);

    const receipt = await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2025-03-02'),
      taxRateId,
      lines: [
        { accountId: acct['4000'], description: 'Taxable goods', quantity: 1, rate: 100, taxable: true },
        { accountId: acct['4100'], description: 'Exempt service', quantity: 1, rate: 50, taxable: false },
      ],
    });

    // taxable base 100 @ 10% = 10.00; total = 150 + 10 = 160
    expect(receipt.subtotal).toBe('150.00');
    expect(receipt.taxAmount).toBe('10.00');
    expect(receipt.total).toBe('160.00');

    const taxAfter = await balanceOf(acct['2200']);
    expect(taxAfter).toBe(Money.of(taxBefore).plus(10).toFixed(2));

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: deposit directly to a bank account
  // -------------------------------------------------------------------------
  it('deposits straight to a bank account when one is selected', async () => {
    const bankBefore = await balanceOf(acct['1000']);

    const receipt = await createSalesReceipt(ctx, {
      date: new Date('2025-03-03'),
      depositAccountId: acct['1000'],
      method: 'credit_card',
      lines: [{ accountId: acct['4000'], description: 'Card sale', quantity: 1, rate: 80 }],
    });

    expect(receipt.depositAccountId).toBe(acct['1000']);
    expect(receipt.method).toBe('credit_card');

    const bankAfter = await balanceOf(acct['1000']);
    expect(bankAfter).toBe(Money.of(bankBefore).plus(80).toFixed(2));
  });

  // -------------------------------------------------------------------------
  // Test 4: rejects a non-asset deposit account
  // -------------------------------------------------------------------------
  it('rejects depositing to a non-asset account', async () => {
    await expect(
      createSalesReceipt(ctx, {
        date: new Date('2025-03-03'),
        depositAccountId: acct['4000'], // revenue account
        lines: [{ accountId: acct['4000'], quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // Test 5: average-cost inventory line posts COGS and relieves stock
  // -------------------------------------------------------------------------
  it('posts COGS and decrements stock for an average-cost inventory item', async () => {
    const cogsBefore = await balanceOf(acct['5000']);
    const invBefore = await balanceOf(acct['1300']);

    // Sell 4 Avg Widgets @ $20 (avgCost $6 → COGS $24). Item supplies income acct 4000.
    const receipt = await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2025-03-04'),
      lines: [{ itemId: avgItemId, quantity: 4, rate: 20 }],
    });

    expect(receipt.total).toBe('80.00');

    const cogsAfter = await balanceOf(acct['5000']);
    const invAfter = await balanceOf(acct['1300']);
    expect(cogsAfter).toBe(Money.of(cogsBefore).plus(24).toFixed(2));
    expect(invAfter).toBe(Money.of(invBefore).minus(24).toFixed(2));

    const [item] = await db.select().from(items).where(eq(items.id, avgItemId));
    expect(Money.of(item.quantityOnHand).toFixed(4)).toBe('6.0000');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 6: FIFO inventory line consumes layers in order
  // -------------------------------------------------------------------------
  it('consumes FIFO layers and posts exact layered COGS', async () => {
    const cogsBefore = await balanceOf(acct['5000']);

    // Sell 7 FIFO Gadgets: 5 @ $4 + 2 @ $5 = $30 COGS.
    const receipt = await createSalesReceipt(ctx, {
      date: new Date('2025-03-05'),
      lines: [{ itemId: fifoItemId, quantity: 7, rate: 15 }],
    });
    expect(receipt.total).toBe('105.00');

    const cogsAfter = await balanceOf(acct['5000']);
    expect(cogsAfter).toBe(Money.of(cogsBefore).plus(30).toFixed(2));

    const [item] = await db.select().from(items).where(eq(items.id, fifoItemId));
    expect(Money.of(item.quantityOnHand).toFixed(4)).toBe('3.0000');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: service items never post COGS
  // -------------------------------------------------------------------------
  it('does not post COGS for service items', async () => {
    const cogsBefore = await balanceOf(acct['5000']);

    await createSalesReceipt(ctx, {
      date: new Date('2025-03-06'),
      lines: [{ itemId: serviceItemId, quantity: 1, rate: 99 }],
    });

    const cogsAfter = await balanceOf(acct['5000']);
    expect(cogsAfter).toBe(cogsBefore);
  });

  // -------------------------------------------------------------------------
  // Test 8: insufficient stock rolls the whole receipt back
  // -------------------------------------------------------------------------
  it('rejects a receipt that oversells stock and persists nothing', async () => {
    const before = await listSalesReceipts(ctx);
    const ufBefore = await balanceOf(acct['1050']);

    await expect(
      createSalesReceipt(ctx, {
        date: new Date('2025-03-07'),
        lines: [{ itemId: avgItemId, quantity: 999, rate: 20 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const after = await listSalesReceipts(ctx);
    expect(after.length).toBe(before.length);
    expect(await balanceOf(acct['1050'])).toBe(ufBefore);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: get + list
  // -------------------------------------------------------------------------
  it('getSalesReceipt returns header + lines; list enriches customer names', async () => {
    const created = await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2025-03-08'),
      lines: [
        { accountId: acct['4000'], description: 'Line 1', quantity: 1, rate: 10 },
        { accountId: acct['4100'], description: 'Line 2', quantity: 2, rate: 5 },
      ],
    });

    const fetched = await getSalesReceipt(ctx, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.lines).toHaveLength(2);
    expect(fetched.lines[0].description).toBe('Line 1');
    expect(fetched.lines[1].description).toBe('Line 2');

    const list = await listSalesReceipts(ctx);
    const row = list.find((r) => r.id === created.id);
    expect(row?.customerName).toBe('Counter Customer');
    for (const r of list) expect(r.companyId).toBe(ctx.companyId);
  });

  // -------------------------------------------------------------------------
  // Test 10: void reverses GL and restores inventory (average cost)
  // -------------------------------------------------------------------------
  it('voiding a receipt reverses income, deposit, tax AND restores stock', async () => {
    const ufBefore = await balanceOf(acct['1050']);
    const cogsBefore = await balanceOf(acct['5000']);
    const invBefore = await balanceOf(acct['1300']);
    const taxBefore = await balanceOf(acct['2200']);
    const [itemBefore] = await db.select().from(items).where(eq(items.id, avgItemId));

    const receipt = await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2025-03-09'),
      taxRateId,
      lines: [{ itemId: avgItemId, quantity: 2, rate: 20 }],
    });
    // 40 + 4 tax = 44 into UF; COGS 2 * 6 = 12.
    expect(receipt.total).toBe('44.00');

    const voided = await voidSalesReceipt(ctx, receipt.id);
    expect(voided.status).toBe('void');

    // All balances restored.
    expect(await balanceOf(acct['1050'])).toBe(ufBefore);
    expect(await balanceOf(acct['5000'])).toBe(cogsBefore);
    expect(await balanceOf(acct['1300'])).toBe(invBefore);
    expect(await balanceOf(acct['2200'])).toBe(taxBefore);

    // Stock restored.
    const [itemAfter] = await db.select().from(items).where(eq(items.id, avgItemId));
    expect(itemAfter.quantityOnHand).toBe(itemBefore.quantityOnHand);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 11: void restores FIFO stock value
  // -------------------------------------------------------------------------
  it('voiding a FIFO receipt restores quantity and inventory value', async () => {
    const invBefore = await balanceOf(acct['1300']);
    const [itemBefore] = await db.select().from(items).where(eq(items.id, fifoItemId));

    // 3 remaining @ $5; sell 2 → COGS $10.
    const receipt = await createSalesReceipt(ctx, {
      date: new Date('2025-03-10'),
      lines: [{ itemId: fifoItemId, quantity: 2, rate: 15 }],
    });

    await voidSalesReceipt(ctx, receipt.id);

    expect(await balanceOf(acct['1300'])).toBe(invBefore);
    const [itemAfter] = await db.select().from(items).where(eq(items.id, fifoItemId));
    expect(itemAfter.quantityOnHand).toBe(itemBefore.quantityOnHand);

    // The restored stock can be sold again (layers were re-created).
    const resale = await createSalesReceipt(ctx, {
      date: new Date('2025-03-11'),
      lines: [{ itemId: fifoItemId, quantity: 3, rate: 15 }],
    });
    expect(resale.total).toBe('45.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12: double-void is a CONFLICT
  // -------------------------------------------------------------------------
  it('voiding an already-voided receipt throws CONFLICT', async () => {
    const receipt = await createSalesReceipt(ctx, {
      date: new Date('2025-03-12'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: 25 }],
    });
    await voidSalesReceipt(ctx, receipt.id);
    await expect(voidSalesReceipt(ctx, receipt.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // -------------------------------------------------------------------------
  // Test 13: validation guards
  // -------------------------------------------------------------------------
  it('rejects empty lines, bad quantities, unknown customers and bad methods', async () => {
    await expect(
      createSalesReceipt(ctx, { date: new Date('2025-03-13'), lines: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      createSalesReceipt(ctx, {
        date: new Date('2025-03-13'),
        lines: [{ accountId: acct['4000'], quantity: 0, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      createSalesReceipt(ctx, {
        customerId: '00000000-0000-0000-0000-000000000099',
        date: new Date('2025-03-13'),
        lines: [{ accountId: acct['4000'], quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      createSalesReceipt(ctx, {
        date: new Date('2025-03-13'),
        method: 'bitcoin' as never,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // Test 13b: the receipt's class must belong to this company (create and update)
  // -------------------------------------------------------------------------
  it('rejects a class from another company on create and update, accepts its own', async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'other@salesreceipts.test', name: 'Other', passwordHash: 'x' })
      .returning();
    const [otherCo] = await db.insert(companies).values({ name: 'Other Co', ownerId: otherUser.id }).returning();
    const [foreignClass] = await db.insert(classes).values({ companyId: otherCo.id, name: 'Foreign' }).returning();
    const [ownClass] = await db.insert(classes).values({ companyId: ctx.companyId, name: 'Retail' }).returning();
    const base = { date: new Date('2025-03-14'), lines: [{ accountId: acct['4000'], quantity: 1, rate: 10 }] };

    await expect(createSalesReceipt(ctx, { ...base, classId: foreignClass.id })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Class does not exist in this company.',
    });
    await expect(
      createSalesReceipt(ctx, { ...base, classId: '00000000-0000-0000-0000-000000000077' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const ok = await createSalesReceipt(ctx, { ...base, classId: ownClass.id });
    expect(ok.classId).toBe(ownClass.id);

    await expect(updateSalesReceipt(ctx, ok.id, { ...base, classId: foreignClass.id })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Class does not exist in this company.',
    });
    const [still] = await db.select().from(salesReceipts).where(eq(salesReceipts.id, ok.id));
    expect(still.classId).toBe(ownClass.id);
    const cleared = await updateSalesReceipt(ctx, ok.id, { ...base, classId: null });
    expect(cleared.classId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 14: receipt numbers are sequential per company
  // -------------------------------------------------------------------------
  it('receipt numbers are sequential', async () => {
    const all = await listSalesReceipts(ctx);
    const nums = all.map((r) => r.receiptNumber).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
  });

  // -------------------------------------------------------------------------
  // Test 15: trial balance still balanced after everything
  // -------------------------------------------------------------------------
  it('trial balance is balanced after all sales receipt operations', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
