import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, journalEntryLines, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { adjustInventory, inventoryValuation } from './inventory';
import { createSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { createCreditMemo, voidCreditMemo } from './creditMemos';
import { updateItem } from './items';
import { adjustQuantityAtSite } from './inventorySiteOps';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-review2');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
const acct: Record<string, string> = {};

async function seedItem(name: string, vals: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({
      companyId: ctx.companyId,
      name,
      type: 'inventory',
      quantityOnHand: '0',
      averageCost: '0',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'],
      ...vals,
    } as never)
    .returning();
  return row.id;
}

/** GL inventory value carried by entries tagged with this item's postings (all posted lines on 1300). */
async function glInventory(): Promise<number> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, acct['1300'])));
  return Math.round(rows.reduce((s, r) => s + Number(r.d ?? 0) - Number(r.c ?? 0), 0) * 100) / 100;
}

async function valuationTotal(): Promise<number> {
  return Number((await inventoryValuation(ctx)).grandTotal);
}

describe('review2: inventory', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rev2@inv.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Rev2 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Cust', taxable: false }).returning();
    customerId = cust.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A: voiding a sales receipt after the average cost changed keeps valuation = GL', async () => {
    const id = await seedItem('SRWidget');
    await adjustInventory(ctx, { itemId: id, quantityChange: 10, unitCost: 10, date: new Date('2026-01-01') });
    const sr = await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2026-01-02'),
      lines: [{ itemId: id, quantity: 10, rate: 30 }],
    });
    // Restock at a higher cost: average moves 10 -> 20.
    await adjustInventory(ctx, { itemId: id, quantityChange: 10, unitCost: 20, date: new Date('2026-01-03') });
    expect(await valuationTotal()).toBe(await glInventory()); // 200 = 200
    await voidSalesReceipt(ctx, sr.id);
    // GL got the original $100 COGS back -> 300; the item must be valued at 300 too.
    expect(await glInventory()).toBe(300);
    expect(await valuationTotal()).toBe(300);
  });

  it('B: voiding a restocking credit memo after the average cost changed keeps valuation = GL', async () => {
    const before = await glInventory();
    const valBefore = await valuationTotal();
    const id = await seedItem('CMWidget', { averageCost: '10' }); // sold out earlier at $10
    const cm = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-02-01'),
      lines: [{ itemId: id, quantity: 5, rate: 30, restock: true }],
    });
    // Restock: 5 @ $10 = $50 into GL and valuation.
    expect(await glInventory()).toBe(before + 50);
    expect(await valuationTotal()).toBe(valBefore + 50);
    await adjustInventory(ctx, { itemId: id, quantityChange: 5, unitCost: 20, date: new Date('2026-02-02') });
    // GL +150, avg = 15
    await voidCreditMemo(ctx, cm.id);
    // GL drops by the $50 restock; remaining 5 units carry $100.
    expect(await glInventory()).toBe(before + 100);
    expect(await valuationTotal()).toBe(valBefore + 100);
  });

  it('C: credit-memo restock valued at purchaseCost (no average yet) must also set the item value', async () => {
    const before = await glInventory();
    const valBefore = await valuationTotal();
    const id = await seedItem('NewReturnWidget', { averageCost: '0', purchaseCost: '8' });
    await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-03-01'),
      lines: [{ itemId: id, quantity: 3, rate: 30, restock: true }],
    });
    expect(await glInventory()).toBe(before + 24);
    expect(await valuationTotal()).toBe(valBefore + 24);
  });

  it('D: the inventory asset account cannot change while the item holds stock', async () => {
    const other = (await createAccount(ctx, { code: '1310', name: 'Inventory - Other', type: 'asset' as never, subtype: 'inventory' })).id;
    const id = await seedItem('AcctWidget');
    await adjustInventory(ctx, { itemId: id, quantityChange: 2, unitCost: 5, date: new Date('2026-04-01') });
    await expect(updateItem(ctx, id, { assetAccountId: other })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Once the stock is gone, the account may change.
    await adjustInventory(ctx, { itemId: id, quantityChange: -2, date: new Date('2026-04-02') });
    const updated = await updateItem(ctx, id, { assetAccountId: other });
    expect(updated.assetAccountId).toBe(other);
  });

  it('E: a FIFO-costed removal on an average-cost item draws on its existing stock', async () => {
    const id = await seedItem('SeedWidget');
    await adjustInventory(ctx, { itemId: id, quantityChange: 10, unitCost: 5, date: new Date('2026-05-01') });
    const gl = await glInventory();
    const val = await valuationTotal();
    expect(val).toBe(gl);
    const res = await adjustQuantityAtSite(ctx, { itemId: id, quantityChange: -4, date: new Date('2026-05-02'), costing: 'fifo' });
    expect(res.quantityOnHand).toBe('6.0000');
    expect(res.glAmount).toBe('20.00');
    expect(await glInventory()).toBe(gl - 20);
    const row = (await inventoryValuation(ctx)).items.find((r) => r.id === id)!;
    expect(row.costingMethod).toBe('fifo');
    expect(row.totalValue).toBe('30.00');
    expect(await valuationTotal()).toBe(val - 20);
  });
});
