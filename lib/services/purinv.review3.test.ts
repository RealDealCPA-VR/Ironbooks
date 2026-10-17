import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, journalEntryLines, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf, inventoryValuationDetail } from './inventory';
import { createBill } from './bills';
import { createInvoice } from './invoices';
import { setBom, buildAssembly } from './assemblies';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-purinv');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
let vendorId: string;
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

async function glBalance(accountId: string): Promise<number> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  return Math.round(rows.reduce((s, r) => s + Number(r.d ?? 0) - Number(r.c ?? 0), 0) * 100) / 100;
}

describe('review3: purchases & inventory business logic', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rev3@purinv.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Rev3 PurInv Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['1310', 'Finished Goods', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
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
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Vend' }).returning();
    vendorId = v.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('F1: Inventory Valuation as-of / detail include stock bought on a bill and sold on an invoice', async () => {
    const id = await seedItem('BillWidget');
    await createBill(ctx, {
      vendorId,
      date: new Date('2026-01-05'),
      lines: [{ itemId: id, quantity: 10, unitCost: 5 }],
    });
    await createInvoice(ctx, {
      customerId,
      date: new Date('2026-01-10'),
      lines: [{ itemId: id, quantity: 4, rate: 20 }],
    } as never);
    // Current valuation: 6 units @ $5 = $30 (ties to GL).
    const now = (await inventoryValuation(ctx)).items.find((r) => r.id === id)!;
    expect(now.totalValue).toBe('30.00');

    const asOf = await inventoryValuationAsOf(ctx, new Date('2026-12-31'));
    expect(asOf.items.find((r) => r.id === id)?.valueAsOf).toBe('30.00');

    const detail = await inventoryValuationDetail(ctx, { itemId: id });
    expect(detail.items[0].closingValue).toBe('30.00');
  });

  it('F2: building an assembly whose asset account differs from its components keeps the GL per account', async () => {
    const comp = await seedItem('Part', { assetAccountId: acct['1300'] });
    const asm = await seedItem('Kit', { assetAccountId: acct['1310'] });
    await adjustInventory(ctx, { itemId: comp, quantityChange: 10, unitCost: 3, date: new Date('2026-02-01') });
    await setBom(ctx, asm, [{ componentItemId: comp, quantity: 2 }]);
    const fg0 = await glBalance(acct['1310']);
    await buildAssembly(ctx, { assemblyItemId: asm, quantity: 5, date: new Date('2026-02-02') });
    // Assembly now holds 5 @ $6 = $30 in Finished Goods (1310); the GL must show it there.
    const val = (await inventoryValuation(ctx)).items.find((r) => r.id === asm)!;
    expect(val.totalValue).toBe('30.00');
    expect(await glBalance(acct['1310'])).toBe(fg0 + 30);
  });

  it('F3: selling out average-cost stock bought at a non-terminating unit cost leaves no value in the GL', async () => {
    const inv = await seedItem('ThirdsWidget', { assetAccountId: acct['1310'] });
    const before = await glBalance(acct['1310']);
    // 3 units for $10.00 -> $3.3333... each.
    await createBill(ctx, { vendorId, date: new Date('2026-03-01'), lines: [{ itemId: inv, quantity: 3, amount: '10.00' }] });
    for (const d of ['2026-03-02', '2026-03-03', '2026-03-04']) {
      await createInvoice(ctx, { customerId, date: new Date(d), lines: [{ itemId: inv, quantity: 1, rate: 20 }] } as never);
    }
    const [row] = await db.select().from(items).where(eq(items.id, inv));
    expect(Number(row.quantityOnHand)).toBe(0);
    // Nothing on hand -> nothing left in the inventory asset account (QB relieves the last unit at remaining value).
    expect(await glBalance(acct['1310'])).toBe(before);
  });

  it('F1b: as-of today ties to the current valuation per item across bills, invoices, adjustments, restocks, vendor credits, builds and unbuilds', async () => {
    const { createCreditMemo } = await import('./creditMemos');
    const { createVendorCredit } = await import('./vendorCredits');
    const { unbuildAssembly } = await import('./assemblies');
    const a = await seedItem('MixA');
    const b = await seedItem('MixB', { assetAccountId: acct['1310'] });
    const kit = await seedItem('MixKit', { assetAccountId: acct['1310'] });
    // One bill carrying both items (two accounts) at awkward costs.
    await createBill(ctx, {
      vendorId,
      date: new Date('2026-05-01'),
      lines: [
        { itemId: a, quantity: 7, amount: '22.15' },
        { itemId: b, quantity: 3, amount: '10.00' },
        { itemId: a, quantity: 2, unitCost: '4.10' },
      ],
    });
    await adjustInventory(ctx, { itemId: b, quantityChange: 4, unitCost: '2.50', date: new Date('2026-05-02') });
    await createInvoice(ctx, {
      customerId,
      date: new Date('2026-05-03'),
      lines: [
        { itemId: a, quantity: 2, rate: 9 },
        { itemId: b, quantity: 1, rate: 9 },
      ],
    } as never);
    await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-05-04'),
      lines: [{ itemId: a, quantity: 1, rate: 9, restock: true }],
    } as never);
    await createVendorCredit(ctx, { vendorId, date: new Date('2026-05-05'), lines: [{ itemId: b, quantity: 1, unitCost: '3.00' }] });
    await setBom(ctx, kit, [
      { componentItemId: a, quantity: 2 },
      { componentItemId: b, quantity: 1 },
    ]);
    await buildAssembly(ctx, { assemblyItemId: kit, quantity: 2, date: new Date('2026-05-06') });
    await unbuildAssembly(ctx, { assemblyItemId: kit, quantity: 1, date: new Date('2026-05-07') });

    const now = await inventoryValuation(ctx);
    const asOf = await inventoryValuationAsOf(ctx, new Date('2099-01-01'));
    for (const id of [a, b, kit]) {
      const cur = now.items.find((r) => r.id === id)!;
      expect(asOf.items.find((r) => r.id === id)?.valueAsOf, cur.name).toBe(cur.totalValue);
      const detail = await inventoryValuationDetail(ctx, { itemId: id });
      expect(detail.items[0].closingValue, cur.name).toBe(cur.totalValue);
    }
    // Every item is attributed, so the per-item totals add up to the inventory accounts.
    expect(Number(asOf.grandTotal)).toBeCloseTo((await glBalance(acct['1300'])) + (await glBalance(acct['1310'])), 2);
    expect(asOf.grandTotal).toBe(now.grandTotal);
  });

  it('F2b: unbuilding moves the value back to the component account', async () => {
    const { unbuildAssembly } = await import('./assemblies');
    const comp = await seedItem('Part2', { assetAccountId: acct['1300'] });
    const asm = await seedItem('Kit2', { assetAccountId: acct['1310'] });
    await adjustInventory(ctx, { itemId: comp, quantityChange: 4, unitCost: 2.5, date: new Date('2026-06-01') });
    await setBom(ctx, asm, [{ componentItemId: comp, quantity: 2 }]);
    const raw0 = await glBalance(acct['1300']);
    const fg0 = await glBalance(acct['1310']);
    await buildAssembly(ctx, { assemblyItemId: asm, quantity: 2, date: new Date('2026-06-02') });
    expect(await glBalance(acct['1310'])).toBe(fg0 + 10);
    expect(await glBalance(acct['1300'])).toBe(raw0 - 10);
    await unbuildAssembly(ctx, { assemblyItemId: asm, quantity: 2, date: new Date('2026-06-03') });
    expect(await glBalance(acct['1310'])).toBe(fg0);
    expect(await glBalance(acct['1300'])).toBe(raw0);
  });

  it('F3b: physical count to zero and returning the last units on a vendor credit clear the value', async () => {
    const { physicalCount } = await import('./inventoryOps');
    const { createVendorCredit } = await import('./vendorCredits');
    const acctId = (await createAccount(ctx, { code: '1320', name: 'Inv Thirds', type: 'asset' as never, subtype: 'inventory' })).id;
    const x = await seedItem('CountThirds', { assetAccountId: acctId });
    const y = await seedItem('ReturnThirds', { assetAccountId: acctId });
    await createBill(ctx, {
      vendorId,
      date: new Date('2026-07-01'),
      lines: [
        { itemId: x, quantity: 3, amount: '10.00' },
        { itemId: y, quantity: 3, amount: '10.00' },
      ],
    });
    await createInvoice(ctx, { customerId, date: new Date('2026-07-02'), lines: [{ itemId: x, quantity: 1, rate: 9 }] } as never);
    await physicalCount(ctx, { itemId: x, countedQty: 0, date: new Date('2026-07-03') });
    await createInvoice(ctx, { customerId, date: new Date('2026-07-02'), lines: [{ itemId: y, quantity: 1, rate: 9 }] } as never);
    await createVendorCredit(ctx, { vendorId, date: new Date('2026-07-04'), lines: [{ itemId: y, quantity: 2, unitCost: '3.00' }] });
    expect(await glBalance(acctId)).toBe(0);
  });

  it('F3c: FIFO — 3 units for $10.00 consumed one at a time leave $0.00 in the asset account', async () => {
    const { receiveStock, consumeStock } = await import('./fifo');
    const acctId = (await createAccount(ctx, { code: '1330', name: 'Inv FIFO', type: 'asset' as never, subtype: 'inventory' })).id;
    const f = await seedItem('FifoThirds', { assetAccountId: acctId });
    await receiveStock(ctx, { itemId: f, quantity: 3, unitCost: '3.3333333333', date: new Date('2026-08-01') });
    expect(await glBalance(acctId)).toBe(10);
    const costs: string[] = [];
    for (const d of ['2026-08-02', '2026-08-03', '2026-08-04']) {
      costs.push((await consumeStock(ctx, { itemId: f, quantity: 1, date: new Date(d) })).totalCOGS);
    }
    expect(costs).toEqual(['3.33', '3.34', '3.33']);
    expect(await glBalance(acctId)).toBe(0);
  });

  it('AC: builds follow the dividing date like other inventory postings', async () => {
    const { accountantCopies } = await import('@/lib/db/schema');
    const comp = await seedItem('AcPart');
    const asm = await seedItem('AcKit');
    await adjustInventory(ctx, { itemId: comp, quantityChange: 10, unitCost: 1, date: new Date('2026-01-15') });
    await setBom(ctx, asm, [{ componentItemId: comp, quantity: 1 }]);

    // Client file with an outstanding copy (dividing date 2026-03-31).
    const [copy] = await db
      .insert(accountantCopies)
      .values({ companyId: ctx.companyId, side: 'client', status: 'outstanding', dividingDate: '2026-03-31', fileToken: 'tok-client' })
      .returning();
    try {
      // After the dividing date: works as before.
      await buildAssembly(ctx, { assemblyItemId: asm, quantity: 1, date: new Date('2026-04-02') });
      // On/before it: refused exactly like an inventory adjustment dated then.
      await expect(
        adjustInventory(ctx, { itemId: comp, quantityChange: -1, date: new Date('2026-03-01') }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        buildAssembly(ctx, { assemblyItemId: asm, quantity: 1, date: new Date('2026-03-01') }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      await db.delete(accountantCopies).where(eq(accountantCopies.id, copy.id));
    }

    // Accountant's working copy: builds are not carried back by the changes file (the route gate
    // already refuses /api/assemblies), so the service refuses them too instead of losing them.
    const [acc] = await db
      .insert(accountantCopies)
      .values({ companyId: ctx.companyId, side: 'accountant', status: 'open', dividingDate: '2026-12-31', fileToken: 'tok-acc' })
      .returning();
    try {
      const { accountantCopyAllowsApi } = await import('./accountantCopy/routeGate');
      expect(accountantCopyAllowsApi('/api/assemblies/build')).toBe(false);
      await expect(
        buildAssembly(ctx, { assemblyItemId: asm, quantity: 1, date: new Date('2026-05-01') }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const [kit] = await db.select().from(items).where(eq(items.id, asm));
      expect(Number(kit.quantityOnHand)).toBe(1); // nothing half-applied
    } finally {
      await db.delete(accountantCopies).where(eq(accountantCopies.id, acc.id));
    }
  });

  it('F4: a bill converted from a PO takes its due date from the vendor terms, not the PO expected (delivery) date', async () => {
    const { createPurchaseOrder, convertToBill } = await import('./purchaseOrders');
    await db.update(companies).set({ settings: { purchaseOrdersEnabled: true } as never }).where(eq(companies.id, ctx.companyId));
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Net30 Vend', terms: 'net_30' }).returning();
    const exp = await db.insert(items).values({ companyId: ctx.companyId, name: 'Svc', type: 'service', expenseAccountId: acct['5000'] } as never).returning();
    let po;
    try {
      po = await createPurchaseOrder(ctx, {
        vendorId: v.id,
        date: new Date('2026-04-01'),
        expectedDate: new Date('2026-04-05'),
        lines: [{ itemId: exp[0].id, quantity: 1, rate: 100 }],
      });
    } catch (e) {
      throw new Error('PO setup failed: ' + (e as Error).message);
    }
    const bill = await convertToBill(ctx, po.id, { date: new Date('2026-04-10') });
    // Net 30 from the 2026-04-10 bill date.
    expect(bill.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-10');
  });
});
