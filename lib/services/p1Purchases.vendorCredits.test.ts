/**
 * P1 purchases — vendor credits (Items tab returns, Ref. No., Class, Customer:Job, PDF, refund
 * void) and inventory adjustments (Adjustment Account, Class, Customer:Job on both costing paths).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items, journalEntries, journalEntryLines, users, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createItem } from './items';
import { createClass } from './dimensions';
import { createJob } from './jobs';
import { trialBalance } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { adjustInventory } from './inventory';
import { receiveStock, consumeStock } from './fifo';
import { adjustQuantityAtSite } from './inventorySiteOps';
import {
  createVendorCredit,
  getVendorCredit,
  refundVendorCredit,
  updateVendorCredit,
  voidVendorCredit,
} from './vendorCredits';
import { buildVendorCreditPdf } from '@/lib/pdf/vendorCredit';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-purchases-vc');
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newCompany(name: string) {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

async function balanceOf(ctx: ServiceContext, accountId: string): Promise<number> {
  const rows = await db
    .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  return Math.round(rows.reduce((s, r) => s + Number(r.debit ?? 0) - Number(r.credit ?? 0), 0) * 100) / 100;
}

async function item(ctx: ServiceContext, id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row;
}

async function expectBalanced(ctx: ServiceContext) {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}

/** Inventory asset GL balance equals the stock subledger (qty x avg cost / FIFO layers). */
async function expectInventoryTies(ctx: ServiceContext, acct: Record<string, string>, itemId: string, expectedValue: number) {
  expect(await balanceOf(ctx, acct['1300'])).toBeCloseTo(expectedValue, 2);
  const it = await item(ctx, itemId);
  expect(it).toBeTruthy();
}

describe('P1 purchases — vendor credits and inventory adjustments', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'p1-vc@test.local', name: 'P1 VC', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('vendor credit Items tab, Ref. No., Class and Customer:Job', () => {
    let ctx: ServiceContext;
    let acct: Record<string, string>;
    let vendorId: string;
    let widget: string;
    let classId: string;
    let customerId: string;
    let jobId: string;

    beforeAll(async () => {
      ({ ctx, acct } = await newCompany('VC Items Co'));
      vendorId = (await createVendor(ctx, { displayName: 'Parts Supplier' })).id;
      widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'], purchaseCost: '10' })).id;
      // 10 widgets on hand at $10 average.
      await adjustInventory(ctx, { itemId: widget, quantityChange: '10', unitCost: '10', date: d('2026-01-05') });
      classId = (await createClass(ctx, { name: 'East' })).id;
      customerId = (await createCustomer(ctx, { displayName: 'Job Owner' })).id;
      jobId = (await createJob(ctx, { customerId, name: 'Kitchen remodel' })).id;
    });

    it('returning inventory relieves stock at cost; the price difference goes to COGS', async () => {
      const credit = await createVendorCredit(ctx, {
        vendorId,
        date: d('2026-02-01'),
        refNumber: 'CM-778',
        memo: 'Returned damaged widgets',
        lines: [
          { itemId: widget, quantity: '3', unitCost: '11', classId, customerId, jobId },
          { accountId: acct['6300'], amount: '5.00', description: 'Restocking fee waived', classId },
        ],
      });
      expect(credit.total).toBe('38.00');
      expect(credit.refNumber).toBe('CM-778');

      // Stock: 7 left, average cost unchanged; inventory GL = 70.
      const it = await item(ctx, widget);
      expect(Number(it.quantityOnHand)).toBe(7);
      expect(Number(it.averageCost)).toBe(10);
      await expectInventoryTies(ctx, acct, widget, 70);
      // COGS gets the $3 difference (vendor credited $33 for $30 of stock).
      expect(await balanceOf(ctx, acct['5000'])).toBe(-3);
      expect(await balanceOf(ctx, acct['2000'])).toBe(38);

      const full = await getVendorCredit(ctx, credit.id);
      expect(full.lines[0]).toMatchObject({ itemId: widget, classId, customerId, jobId, costAmount: '30.00', amount: '33.00' });
      expect(full.lines[1]).toMatchObject({ accountId: acct['6300'], classId });

      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, credit.postedEntryId!));
      expect(je.reference).toBe('CM-778');
      const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, je.id));
      expect(lines.find((l) => l.accountId === acct['1300'])?.classId).toBe(classId);
      await expectBalanced(ctx);

      const pdf = await buildVendorCreditPdf(ctx, credit.id);
      expect(pdf.number).toBe('CM-778');
      expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('returning more than is on hand is refused', async () => {
      await expect(
        createVendorCredit(ctx, { vendorId, date: d('2026-02-02'), lines: [{ itemId: widget, quantity: '50', amount: '500' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expectBalanced(ctx);
    });

    it('editing the quantity re-posts and re-relieves stock; voiding puts the stock back', async () => {
      const credit = await createVendorCredit(ctx, {
        vendorId,
        date: d('2026-02-03'),
        lines: [{ itemId: widget, quantity: '2', unitCost: '10' }],
      });
      expect(Number((await item(ctx, widget)).quantityOnHand)).toBe(5);
      await updateVendorCredit(ctx, credit.id, {
        vendorId,
        date: d('2026-02-03'),
        refNumber: 'NEW-REF',
        lines: [{ itemId: widget, quantity: '1', unitCost: '10' }],
      });
      expect(Number((await item(ctx, widget)).quantityOnHand)).toBe(6);
      await expectInventoryTies(ctx, acct, widget, 60);
      // A memo / Ref-only edit keeps the entry.
      const before = (await getVendorCredit(ctx, credit.id)).postedEntryId;
      await updateVendorCredit(ctx, credit.id, {
        vendorId,
        date: d('2026-02-03'),
        refNumber: 'NEWER-REF',
        memo: 'just a note',
        lines: [{ itemId: widget, quantity: '1', unitCost: '10', description: 'Widget (1)' }],
      });
      const after = await getVendorCredit(ctx, credit.id);
      expect(after.postedEntryId).toBe(before);
      expect(after.refNumber).toBe('NEWER-REF');
      expect(Number((await item(ctx, widget)).quantityOnHand)).toBe(6);

      await voidVendorCredit(ctx, credit.id);
      expect(Number((await item(ctx, widget)).quantityOnHand)).toBe(7);
      await expectInventoryTies(ctx, acct, widget, 70);
      await expectBalanced(ctx);
    });

    it('a non-inventory item line credits the item expense account', async () => {
      const svc = (await createItem(ctx, { name: 'Freight', type: 'non_inventory', expenseAccountId: acct['6600'], incomeAccountId: acct['4000'] })).id;
      const before = await balanceOf(ctx, acct['6600']);
      await createVendorCredit(ctx, { vendorId, date: d('2026-02-04'), lines: [{ itemId: svc, quantity: '1', amount: '12.50' }] });
      expect(await balanceOf(ctx, acct['6600'])).toBe(before - 12.5);
      await expectBalanced(ctx);
    });

    it('FIFO item returns take the oldest layers', async () => {
      const fifoItem = (await createItem(ctx, { name: 'Lot item', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
      await receiveStock(ctx, { itemId: fifoItem, quantity: '5', unitCost: '4', date: d('2026-01-01') });
      await receiveStock(ctx, { itemId: fifoItem, quantity: '5', unitCost: '6', date: d('2026-01-02') });
      const inv0 = await balanceOf(ctx, acct['1300']);
      const credit = await createVendorCredit(ctx, { vendorId, date: d('2026-02-05'), lines: [{ itemId: fifoItem, quantity: '6', amount: '30.00' }] });
      // 5 x 4 + 1 x 6 = 26 relieved; 4 to COGS.
      expect(await balanceOf(ctx, acct['1300'])).toBe(inv0 - 26);
      const full = await getVendorCredit(ctx, credit.id);
      expect(full.lines[0].costAmount).toBe('26.00');
      await voidVendorCredit(ctx, credit.id);
      expect(await balanceOf(ctx, acct['1300'])).toBe(inv0);
      expect(Number((await item(ctx, fifoItem)).quantityOnHand)).toBe(10);
      await expectBalanced(ctx);
    });
  });

  describe('voiding a vendor-credit refund gives the vendor credit back', () => {
    it('unapplied and refunded amounts are restored', async () => {
      const { ctx, acct } = await newCompany('VC Refund Void Co');
      const vendorId = (await createVendor(ctx, { displayName: 'Refunding Vendor' })).id;
      const credit = await createVendorCredit(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
      const { entry } = await refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['1000'], amount: '60.00', date: d('2026-03-05') });
      let [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, credit.id));
      expect(row).toMatchObject({ unapplied: '40.00', refundedAmount: '60.00', status: 'partial' });

      await voidJournalEntry(ctx, entry.id);
      [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, credit.id));
      expect(row).toMatchObject({ unapplied: '100.00', refundedAmount: '0.00', status: 'open' });
      // A/P: the credit (Dr 100) stands again in full.
      expect(await balanceOf(ctx, acct['2000'])).toBe(100);
      await expectBalanced(ctx);
    });
  });

  describe('inventory adjustments use the Adjustment Account, Class and Customer:Job', () => {
    it('average-cost: default Inventory Adjustments account (created), never equity', async () => {
      const { ctx, acct } = await newCompany('Adj Avg Co');
      const it = (await createItem(ctx, { name: 'Bolt', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
      const cls = (await createClass(ctx, { name: 'Warehouse' })).id;
      const cust = (await createCustomer(ctx, { displayName: 'Adj Customer' })).id;
      const job = (await createJob(ctx, { customerId: cust, name: 'Site A' })).id;
      const res = await adjustInventory(ctx, { itemId: it, quantityChange: '4', unitCost: '2.50', date: d('2026-04-01'), classId: cls, jobId: job, memo: 'Found in back room' });
      const adj = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).find((a) => a.name === 'Inventory Adjustments');
      expect(adj?.type).toBe('expense');
      expect(await balanceOf(ctx, acct['3000'])).toBe(0);
      expect(await balanceOf(ctx, adj!.id)).toBe(-10);
      const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, res.entry!.id));
      const adjLine = lines.find((l) => l.accountId === adj!.id)!;
      expect(adjLine).toMatchObject({ classId: cls, entityType: 'customer', entityId: cust, memo: 'Found in back room' });

      // Removal to a user-chosen account (Office Supplies) instead of COGS.
      await adjustInventory(ctx, { itemId: it, quantityChange: '-1', date: d('2026-04-02'), adjustmentAccountId: acct['6300'] });
      expect(await balanceOf(ctx, acct['6300'])).toBe(2.5);
      expect(await balanceOf(ctx, acct['5000'])).toBe(0);
      // A/R, A/P or the inventory asset itself cannot be the adjustment account.
      for (const code of ['1200', '2000', '1300']) {
        await expect(adjustInventory(ctx, { itemId: it, quantityChange: '1', unitCost: '1', date: d('2026-04-03'), adjustmentAccountId: acct[code] })).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expectBalanced(ctx);
    });

    it('FIFO path and the site adjustment honour the same fields; sales COGS relief still hits COGS', async () => {
      const { ctx, acct } = await newCompany('Adj FIFO Co');
      const it = (await createItem(ctx, { name: 'Cable', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
      const cls = (await createClass(ctx, { name: 'West' })).id;
      await receiveStock(ctx, { itemId: it, quantity: '10', unitCost: '3', date: d('2026-05-01'), adjustmentAccountId: acct['6300'], classId: cls });
      expect(await balanceOf(ctx, acct['6300'])).toBe(-30);
      expect(await balanceOf(ctx, acct['3000'])).toBe(0);

      const site = await adjustQuantityAtSite(ctx, { itemId: it, quantityChange: '-2', date: d('2026-05-02'), classId: cls, memo: 'Damaged' });
      const adj = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).find((a) => a.name === 'Inventory Adjustments')!;
      expect(await balanceOf(ctx, adj.id)).toBe(6);
      const siteLines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, site.entryId!));
      expect(siteLines.find((l) => l.accountId === adj.id)?.classId).toBe(cls);

      await consumeStock(ctx, { itemId: it, quantity: '1', date: d('2026-05-03') });
      expect(await balanceOf(ctx, acct['5000'])).toBe(3);

      await expectBalanced(ctx);
    });
  });
});
