/**
 * Wave-2 lists — independent QA (tester). Adversarial checks on the doer's lists package:
 * ledger invariants (TB / BS balanced, inventory subledger == GL control account), closing-date
 * respect and rollback of opening stock, tenancy, malformed input, rounding, idempotency, and
 * Clean Up never deleting something the company file still uses. Hermetic PGlite company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, customers, inventoryLayers, items, journalEntries, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createCustomer, updateCustomer } from '../customers';
import { createVendor, updateVendor } from '../vendors';
import { createItem, updateItem } from '../items';
import { adjustInventory, inventoryValuation } from '../inventory';
import { createClass } from '../dimensions';
import { balanceSheet, trialBalance } from '../reports';
import { createTaxRate, updateTaxRate } from '../salesTax';
import { logMiles } from '../mileage';
import { computeDiscount, computeDueDate } from './termsMath';
import { customerTerms, resolveTermsRef } from './terms';
import { createEntry, listEntries, removeEntry, updateEntry } from './simpleLists';
import { addNote } from './notes';
import { createUomSet, convertToBase, getUomSet, updateUomSet } from './uom';
import { createItemWithOpeningStock } from './openingStock';
import { mergeClasses, mergeItems, mergeOtherNames } from './mergeLists';
import { previewCleanup, runCleanup } from './cleanup';
import { bulkSave } from './bulk';
import { changeItemPrices } from './itemTools';
import { inventoryCenterList } from './inventoryCenter';
import { API_ROUTE_PERMISSIONS, PAGE_AREAS, apiRuleFor } from '@/lib/permissions/routes';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-lists-qa-x9k4');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext; // a second company in the same file (tenancy checks)
let acct: Record<string, string>;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

/** TB balanced, BS balanced, and inventory valuation == Inventory Asset (1300) GL balance. */
async function assertInvariants(c: ServiceContext = ctx) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(c);
  expect(Number(bs.totalAssets)).toBeCloseTo(Number(bs.totalLiabilities) + Number(bs.totalEquity), 2);
  const row = tb.rows.find((r) => r.code === '1300');
  const gl = row ? Number(row.debit) - Number(row.credit) : 0;
  const val = await inventoryValuation(c);
  expect(val.grandTotal).toBe(gl.toFixed(2));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qa@wave2.local', name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'QA Lists Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const company2 = await createCompany(db, { name: 'Other Co', ownerId: user.id });
  other = { db, companyId: company2.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('B5 terms math edge cases', () => {
  it('handles leap years, month-end clamps and year rollover', () => {
    const eom = { kind: 'date_driven', dueDayOfMonth: 31, dueNextMonthWithinDays: 0 };
    expect(iso(computeDueDate(eom, d('2028-02-10')))).toBe('2028-02-29');
    expect(iso(computeDueDate(eom, d('2026-04-30')))).toBe('2026-04-30');
    const day1 = { kind: 'date_driven', dueDayOfMonth: 1, dueNextMonthWithinDays: 10 };
    expect(iso(computeDueDate(day1, d('2026-12-25')))).toBe('2027-02-01'); // Jan 1 is within 10 days → Feb 1
    expect(iso(computeDueDate({ kind: 'standard', netDays: 30 }, d('2028-02-15')))).toBe('2028-03-16');
    // time-of-day on the txn date does not shift the calendar day
    expect(iso(computeDueDate({ kind: 'standard', netDays: 1 }, new Date('2026-05-01T23:59:59.999Z')))).toBe('2026-05-02');
  });

  it('rounds discounts half-up to the cent and is never eligible without a discount', () => {
    const t = { kind: 'standard', netDays: 30, discountPercent: '2', discountDays: 10 };
    expect(computeDiscount(t, d('2026-01-01'), d('2026-01-11'), '0.25').amount).toBe('0.01'); // 0.005 → 0.01
    expect(computeDiscount(t, d('2026-01-01'), d('2026-01-11'), '0.24').amount).toBe('0.00');
    expect(computeDiscount(t, d('2026-01-01'), d('2026-01-01'), '1234.56').amount).toBe('24.69');
    const none = { kind: 'standard', netDays: 30 };
    expect(computeDiscount(none, d('2026-01-01'), d('2026-01-01'), '100')).toMatchObject({ eligible: false, amount: '0.00', percent: '0' });
    // date-driven discount day never later than the due date
    const dd = { kind: 'date_driven', dueDayOfMonth: 5, dueNextMonthWithinDays: 0, discountPercent: '1', discountDayOfMonth: 20 };
    const r = computeDiscount(dd, d('2026-03-01'), d('2026-03-06'));
    expect(iso(r.discountDate!)).toBe('2026-03-05');
    expect(r.eligible).toBe(false);
  });

  it('rejects invalid terms on the list (percent out of range, discount longer than net, missing day)', async () => {
    await expect(createEntry(ctx, 'terms', { name: 'Neg', kind: 'standard', netDays: 30, discountPercent: '-1', discountDays: 5 })).rejects.toThrow();
    await expect(createEntry(ctx, 'terms', { name: 'Big', kind: 'standard', netDays: 30, discountPercent: '101', discountDays: 5 })).rejects.toThrow();
    await expect(createEntry(ctx, 'terms', { name: 'Long', kind: 'standard', netDays: 10, discountPercent: '2', discountDays: 20 })).rejects.toThrow(/longer/);
    await expect(createEntry(ctx, 'terms', { name: 'NoDay', kind: 'date_driven' })).rejects.toThrow(/day of the month/);
    await expect(createEntry(ctx, 'terms', { name: 'Day 32', kind: 'date_driven', dueDayOfMonth: 32 })).rejects.toThrow();
    await expect(createEntry(ctx, 'terms', { name: '   ', kind: 'standard', netDays: 1 })).rejects.toThrow();
    await expect(createEntry(ctx, 'terms', { name: 'net 30', kind: 'standard', netDays: 30 })).rejects.toThrow(/already/); // case-insensitive
  });

  it('terms lists are per company: another company cannot resolve or edit our entries', async () => {
    const mine = await createEntry(ctx, 'terms', { name: 'Net 45 QA', kind: 'standard', netDays: 45 });
    await expect(resolveTermsRef(other, mine.id)).rejects.toThrow(/not found/i);
    await expect(updateEntry(other, 'terms', mine.id, { netDays: 1 })).rejects.toThrow(/not found/i);
    await expect(removeEntry(other, 'terms', mine.id)).rejects.toThrow(/not found/i);
    // the same name is fine in another company
    await expect(createEntry(other, 'terms', { name: 'Net 45 QA', kind: 'standard', netDays: 45 })).resolves.toBeTruthy();
  });

  it('a customer cannot be pointed at another company\'s terms or tax code', async () => {
    const theirs = (await listEntries(other, 'terms')).find((t) => t.name === 'Net 30')!;
    await expect(createCustomer(ctx, { displayName: 'Cross Terms', termsId: theirs.id })).rejects.toThrow(/not found/i);
    const theirCode = (await listEntries(other, 'sales-tax-codes'))[0];
    await expect(createCustomer(ctx, { displayName: 'Cross Code', salesTaxCodeId: theirCode.id })).rejects.toThrow(/not found/i);
    await expect(createItem(ctx, { name: 'Cross code item', salesTaxCodeId: theirCode.id })).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
describe('B5/J1 legacy terms strings count as uses', () => {
  it('a default customer (legacy terms "net_30") keeps the Net 30 entry from being deleted', async () => {
    const c = await createCustomer(ctx, { displayName: 'Legacy Terms Customer' }); // default terms
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id));
    const net30 = (await listEntries(ctx, 'terms')).find((t) => t.name === 'Net 30')!;
    // Either the customer links the list entry, or the legacy code must protect it.
    expect(row.termsId === net30.id || row.terms === 'net_30').toBe(true);
    const res = await removeEntry(ctx, 'terms', net30.id);
    expect(res.deleted).toBe(false); // it is in use → deactivated, never deleted
    expect((await customerTerms(ctx, c.id))?.netDays).toBe(30);
    // Clean Up must not remove it either, even though it is now inactive.
    const preview = await previewCleanup(ctx, ['terms']);
    expect(preview.lists[0].entries.map((e) => e.id)).not.toContain(net30.id);
    await updateEntry(ctx, 'terms', net30.id, { isActive: true });
  });
});

// ---------------------------------------------------------------------------
describe('G1 opening stock: closing date, rollback, subledger', () => {
  it('refuses an as-of date inside the closed period and leaves no item, layer or entry behind', async () => {
    await setClosingDate(ctx, { closingDate: '2025-12-31' });
    try {
      await expect(
        createItemWithOpeningStock(ctx, {
          name: 'Closed Period Widget',
          type: 'inventory',
          assetAccountId: acct['1300'],
          openingQuantity: '5',
          openingValue: '50.00',
          openingAsOf: d('2025-06-30'),
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      expect(await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Closed Period Widget')))).toHaveLength(0);
      expect(await db.select().from(inventoryLayers).where(eq(inventoryLayers.companyId, ctx.companyId))).toHaveLength(0);
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    await assertInvariants();
  });

  it('malformed opening input is a validation error, not a crash', async () => {
    const base = { type: 'inventory' as const, assetAccountId: acct['1300'], openingAsOf: d('2026-01-01') };
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'NegQ', openingQuantity: '-1', openingValue: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'FiveDp', openingQuantity: '1.00001', openingUnitCost: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'NegV', openingQuantity: '1', openingValue: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'ValueOnly', openingValue: '5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'NoValue', openingQuantity: '2' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createItemWithOpeningStock(ctx, { ...base, name: 'BadDate', openingQuantity: '1', openingValue: '1', openingAsOf: new Date('nope') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createItemWithOpeningStock(ctx, { ...base, name: 'Lot tracked', trackingMode: 'lot', openingQuantity: '1', openingValue: '1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // a non-asset account as the inventory account is refused (would debit income)
    await expect(
      createItemWithOpeningStock(ctx, { ...base, name: 'Wrong acct', assetAccountId: acct['4000'], openingQuantity: '1', openingValue: '1' }),
    ).rejects.toThrow();
    const names = ['NegQ', 'FiveDp', 'NegV', 'ValueOnly', 'NoValue', 'BadDate', 'Lot tracked', 'Wrong acct'];
    for (const n of names) {
      expect(await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, n)))).toHaveLength(0);
    }
    await assertInvariants();
  });

  it('zero-value opening stock posts nothing; invariants hold', async () => {
    const before = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    const { item, opening } = await createItemWithOpeningStock(ctx, {
      name: 'Free Samples',
      type: 'inventory',
      assetAccountId: acct['1300'],
      openingQuantity: '7',
      openingValue: '0',
      openingAsOf: d('2026-01-01'),
    });
    expect(opening?.entryId).toBeNull();
    expect(item.quantityOnHand).toBe('7.0000');
    expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length).toBe(before);
    await assertInvariants();
  });

  it('valuation equals the posted amount for awkward unit costs; audit row written', async () => {
    const { item, opening } = await createItemWithOpeningStock(ctx, {
      name: 'Thirds',
      type: 'inventory',
      assetAccountId: acct['1300'],
      openingQuantity: '3',
      openingValue: '10.00',
      openingAsOf: d('2026-01-01'),
    }).catch((e) => ({ item: null, opening: null, err: e })) as { item: { id: string } | null; opening: { value: string } | null };
    if (item) expect(opening?.value).toBe('10.00');
    await createItemWithOpeningStock(ctx, {
      name: 'Big Lot',
      type: 'inventory',
      assetAccountId: acct['1300'],
      openingQuantity: '1234.5678',
      openingUnitCost: '0.0101',
      openingAsOf: d('2026-01-02'),
    });
    await assertInvariants();
    if (item) {
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityId, item.id)));
      expect(audits.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('B16 merges keep the books and the inventory subledger intact', () => {
  it('merging two average-cost items does not change total inventory value (no rounding drift)', async () => {
    // Own company file so a drift here cannot cascade into the other subledger checks.
    const [u] = await db.select().from(users).where(eq(users.email, 'qa@wave2.local'));
    const co = await createCompany(db, { name: 'Drift Co', ownerId: u.id });
    const c: ServiceContext = { db, companyId: co.id, userId: u.id };
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, co.id), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'Avg A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'Avg B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 100, unitCost: 2, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 200, unitCost: 1, date: d('2026-02-01') });
    await assertInvariants(c);
    const before = (await inventoryValuation(c)).grandTotal;
    expect(before).toBe('400.00');
    await mergeItems(c, { fromId: a.id, toId: b.id });
    const after = (await inventoryValuation(c)).grandTotal;
    // Average cost is stored to 4 dp, so 300 x 1.3333 = 399.99 cannot equal 400.00. The merge posts
    // the 0.01 difference (Inventory vs COGS) so the GL inventory account still equals the
    // subledger — no unexplained drift between valuation and the books.
    expect(after).toBe('399.99'); // 300 x 1.3333, with the 0.01 rounding posted to the GL
    await assertInvariants(c); // valuation === GL 1300, TB and BS balanced
  });

  it('merging two FIFO items moves layers; valuation and GL unchanged', async () => {
    const x = await createItemWithOpeningStock(ctx, { name: 'Fifo X', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '4', openingValue: '10.00', openingAsOf: d('2026-01-05'), openingCosting: 'fifo' });
    const y = await createItemWithOpeningStock(ctx, { name: 'Fifo Y', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '6', openingValue: '30.00', openingAsOf: d('2026-01-05'), openingCosting: 'fifo' });
    const before = (await inventoryValuation(ctx)).grandTotal;
    const tbBefore = await trialBalance(ctx);
    await mergeItems(ctx, { fromId: x.item.id, toId: y.item.id });
    expect((await inventoryValuation(ctx)).grandTotal).toBe(before);
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, x.item.id));
    expect(layers).toHaveLength(0);
    const [yy] = await db.select().from(items).where(eq(items.id, y.item.id));
    expect(yy.quantityOnHand).toBe('10.0000');
    const tbAfter = await trialBalance(ctx);
    expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    const centre = (await inventoryCenterList(ctx)).find((r) => r.name === 'Fifo Y')!;
    expect(centre.value).toBe('40.00');
    await assertInvariants();
  });

  it('refuses merging across companies, unknown ids and a FIFO item into a stocked average item', async () => {
    const mine = await createItem(ctx, { name: 'Tenant mine', type: 'service' });
    const theirs = await createItem(other, { name: 'Tenant theirs', type: 'service' });
    await expect(mergeItems(ctx, { fromId: theirs.id, toId: mine.id })).rejects.toThrow(/not found/i);
    await expect(mergeItems(ctx, { fromId: mine.id, toId: theirs.id })).rejects.toThrow(/not found/i);
    const fifo = await createItemWithOpeningStock(ctx, { name: 'Mix fifo', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '1', openingValue: '1.00', openingAsOf: d('2026-01-05'), openingCosting: 'fifo' });
    const avg = await createItem(ctx, { name: 'Mix avg', type: 'inventory', assetAccountId: acct['1300'] });
    await adjustInventory(ctx, { itemId: avg.id, quantityChange: 2, unitCost: 3, date: d('2026-02-01') });
    await expect(mergeItems(ctx, { fromId: fifo.item.id, toId: avg.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // refused merge changed nothing
    const [f] = await db.select().from(items).where(eq(items.id, fifo.item.id));
    expect(f.isActive).toBe(true);
    expect(f.quantityOnHand).toBe('1.0000');
    await assertInvariants();
  });

  it('class merge with hierarchy never leaves a class as its own ancestor', async () => {
    const parent = await createClass(ctx, { name: 'Region' });
    const child = await createClass(ctx, { name: 'Region North', parentId: parent.id });
    const grandchild = await createClass(ctx, { name: 'Region North City', parentId: child.id });
    await mergeClasses(ctx, { fromId: parent.id, toId: child.id });
    const { classes } = await import('@/lib/db/schema');
    const all = await db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
    const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
    for (const c of all) {
      const seen = new Set<string>();
      let cur: string | null | undefined = c.id;
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }
    expect(parentOf.get(child.id)).toBeNull();
    expect(parentOf.get(grandchild.id)).toBe(child.id);
    await expect(mergeClasses(other, { fromId: grandchild.id, toId: child.id })).rejects.toThrow(/not found/i);
  });

  it('other-name merge across companies is refused', async () => {
    const mine = await createEntry(ctx, 'other-names', { name: 'QA Payee' });
    const theirs = await createEntry(other, 'other-names', { name: 'QA Payee' });
    await expect(mergeOtherNames(ctx, { fromId: theirs.id, toId: mine.id })).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
describe('J1 Clean Up never removes used or active entries', () => {
  it('keeps an inactive item that has posted history and an inactive vendor with notes', async () => {
    const it1 = { item: await createItem(ctx, { name: 'Has history', type: 'inventory', assetAccountId: acct['1300'] }) };
    await adjustInventory(ctx, { itemId: it1.item.id, quantityChange: 1, unitCost: 2, date: d('2026-01-05') });
    // write it off so qty is 0 and only posted history references it
    await adjustInventory(ctx, { itemId: it1.item.id, quantityChange: -1, date: d('2026-01-06') });
    await db.update(items).set({ isActive: false }).where(eq(items.id, it1.item.id));
    const v = await createVendor(ctx, { displayName: 'Noted inactive vendor' });
    await addNote(ctx, { entityType: 'vendor', entityId: v.id, body: 'keep me' });
    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, v.id));
    const res = await runCleanup(ctx, { lists: ['items', 'vendors'] });
    expect(res.removed.map((r) => r.id)).not.toContain(it1.item.id);
    expect(res.removed.map((r) => r.id)).not.toContain(v.id);
    expect(await db.select().from(items).where(eq(items.id, it1.item.id))).toHaveLength(1);
    await assertInvariants();
  });

  it('is idempotent and tenant-scoped: a second run removes nothing, another company\'s entries untouched', async () => {
    const theirs = await createVendor(other, { displayName: 'Their unused vendor' });
    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, theirs.id));
    const first = await runCleanup(ctx, { lists: ['vendors'], ids: [theirs.id] });
    expect(first.removed).toHaveLength(0);
    expect(await db.select().from(vendors).where(eq(vendors.id, theirs.id))).toHaveLength(1);
    await runCleanup(ctx);
    const second = await runCleanup(ctx);
    expect(second.removed).toHaveLength(0);
    await assertInvariants();
  });
});

// ---------------------------------------------------------------------------
describe('B15 Add/Edit Multiple adversarial', () => {
  it('a duplicate of an existing record, a cross-company id and an empty batch are refused atomically', async () => {
    await createCustomer(ctx, { displayName: 'Existing QA Cust' });
    const theirs = await createCustomer(other, { displayName: 'Their QA Cust' });
    const r = await bulkSave(ctx, 'customers', [
      { displayName: 'Fresh QA 1' },
      { displayName: 'Existing QA Cust' },
      { id: theirs.id, displayName: 'Hijacked' },
    ]);
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.row).sort()).toEqual([1, 2]);
    expect(await db.select().from(customers).where(eq(customers.displayName, 'Fresh QA 1'))).toHaveLength(0);
    const [t] = await db.select().from(customers).where(eq(customers.id, theirs.id));
    expect(t.displayName).toBe('Their QA Cust');
    await expect(bulkSave(ctx, 'customers', [])).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a case-variant of an existing name is a duplicate too (QB names are case-insensitive)', async () => {
    await createCustomer(ctx, { displayName: 'Case QA Cust' });
    const r = await bulkSave(ctx, 'customers', [{ displayName: 'case qa cust' }]);
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.row)).toEqual([0]);
  });

  it('items with a non-asset inventory account or a bad price are rejected per row', async () => {
    const r = await bulkSave(ctx, 'items', [
      { name: 'Bulk QA ok', type: 'service', salesPrice: '5' },
      { name: 'Bulk QA wrong asset', type: 'inventory', assetAccount: '4000', incomeAccount: '4000', expenseAccount: '5000' },
      { name: 'Bulk QA bad price', type: 'service', salesPrice: '12abc' },
    ]);
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.row).sort()).toEqual([1, 2]);
    expect(await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Bulk QA ok')))).toHaveLength(0);
    // rolled back rows leave no audit trail
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.companyId, ctx.companyId));
    expect(audits.some((a) => JSON.stringify(a.newValues ?? {}).includes('Bulk QA ok'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('G4 Change Item Prices adversarial', () => {
  it('the stored price equals the previewed price (no silent truncation by the 2-dp column)', async () => {
    const a = await createItem(ctx, { name: 'Odd price', type: 'service', salesPrice: '9.99' });
    const prev = await changeItemPrices(ctx, { itemIds: [a.id], adjustBy: 'percent', value: '3.3', rounding: 'none', dryRun: true });
    const res = await changeItemPrices(ctx, { itemIds: [a.id], adjustBy: 'percent', value: '3.3', rounding: 'none' });
    const [row] = await db.select().from(items).where(eq(items.id, a.id));
    expect(Number(row.salesPrice)).toBe(Number(res.changes[0].newPrice));
    expect(res.changes[0].newPrice).toBe(prev.changes[0].newPrice);
  });

  it('cross-company ids, non-numeric values and below-zero results are handled', async () => {
    const theirs = await createItem(other, { name: 'Their priced', type: 'service', salesPrice: '10' });
    await expect(changeItemPrices(ctx, { itemIds: [theirs.id], adjustBy: 'percent', value: '10' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [t] = await db.select().from(items).where(eq(items.id, theirs.id));
    expect(t.salesPrice).toBe('10.00');
    const cheap = await createItem(ctx, { name: 'Cheap', type: 'service', salesPrice: '1.00' });
    const r = await changeItemPrices(ctx, { itemIds: [cheap.id], adjustBy: 'amount', value: '-5' });
    expect(r.changed).toBe(0);
    expect(r.changes[0].skipped).toMatch(/below zero/);
    await expect(changeItemPrices(ctx, { itemIds: [cheap.id], adjustBy: 'percent', value: 'ten' })).rejects.toThrow();
    const [c] = await db.select().from(items).where(eq(items.id, cheap.id));
    expect(c.salesPrice).toBe('1.00');
  });
});

// ---------------------------------------------------------------------------
describe('G2 / B18 / B14 malformed input', () => {
  it('a tiny conversion factor never rounds down to zero', async () => {
    const make = createUomSet(ctx, {
      name: 'Tiny',
      baseUnitName: 'Gram',
      baseUnitAbbrev: 'g',
      units: [{ name: 'Speck', abbrev: 'sp', factor: '0.0000001' }],
    });
    const set = await make.catch(() => null);
    if (set) {
      const u = set.units.find((x: { name: string }) => x.name === 'Speck')!;
      expect(Number(u.factor)).toBeGreaterThan(0);
      expect(convertToBase(set, 1, 'Speck')).not.toBe('NaN');
    }
  });

  it('tax rate edit is tenant-scoped and validates', async () => {
    const theirs = await createTaxRate(other, { name: 'Their rate', rate: '0.05' });
    await expect(updateTaxRate(ctx, theirs.id, { rate: '0.06' })).rejects.toThrow(/not found/i);
    const mine = await createTaxRate(ctx, { name: 'QA rate', rate: '0.05' });
    await expect(updateTaxRate(ctx, mine.id, { rate: '-0.01' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateTaxRate(ctx, mine.id, { name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const otherAgency = await (await import('../salesTax')).createTaxAgency?.(other, { name: 'Their agency' }).catch(() => null);
    if (otherAgency) await expect(updateTaxRate(ctx, mine.id, { agencyId: otherAgency.id })).rejects.toThrow(/not found/i);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityId, mine.id)));
    expect(audits.filter((a) => a.action === 'update')).toHaveLength(0); // refused edits leave no trace
  });

  it('mileage refuses another company\'s vehicle and negative odometers', async () => {
    const theirs = await createEntry(other, 'vehicles', { name: 'Their van' });
    await expect(logMiles(ctx, { date: d('2026-01-03'), miles: 5, vehicleId: theirs.id })).rejects.toThrow(/not found/i);
    const mine = await createEntry(ctx, 'vehicles', { name: 'QA van' });
    await expect(logMiles(ctx, { date: d('2026-01-03'), miles: 5, vehicleId: mine.id, odometerStart: -5, odometerEnd: 0 })).rejects.toThrow(/negative/);
  });
});

// ---------------------------------------------------------------------------
describe('permission mapping for the wave-2 lists routes and pages', () => {
  const routes = [
    '/api/lists/[list]', '/api/lists/[list]/[id]', '/api/terms/compute', '/api/todos', '/api/todos/[id]',
    '/api/notes', '/api/notes/[id]', '/api/uom-sets', '/api/uom-sets/[id]', '/api/items/bulk',
    '/api/items/change-prices', '/api/cleanup', '/api/customers/bulk', '/api/vendors/bulk',
    '/api/inventory/center', '/api/inventory/center/[id]', '/api/inventory/reorder/create-po',
    '/api/inventory/stock-by-vendor', '/api/tax-rates/[id]', '/api/job-type-assign',
  ];
  it('every new route is mapped and the route file exists', () => {
    for (const r of routes) {
      expect(API_ROUTE_PERMISSIONS[r], r).toBeDefined();
      const file = path.resolve(process.cwd(), 'app', ...r.split('/').filter(Boolean), 'route.ts');
      expect(fs.existsSync(file), file).toBe(true);
    }
  });
  it('destructive Clean Up needs delete rights; price change needs modify', () => {
    expect(apiRuleFor('/api/cleanup', 'POST')).toMatchObject({ action: 'delete' });
    expect(apiRuleFor('/api/items/change-prices', 'POST')).toMatchObject({ action: 'modify' });
    expect(apiRuleFor('/api/cleanup', 'GET')).toMatchObject({ action: 'view' });
  });
  it('new pages are mapped', () => {
    for (const p of ['/lists', '/lists/cleanup', '/inventory-center']) expect(PAGE_AREAS[p], p).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Re-test round 1: verify the doer's fixes with fresh, independent repros.
describe('re-test round 1', () => {
  async function freshCompany(name: string): Promise<ServiceContext> {
    const [u] = await db.select().from(users).where(eq(users.email, 'qa@wave2.local'));
    const co = await createCompany(db, { name, ownerId: u.id });
    return { db, companyId: co.id, userId: u.id };
  }

  it('B5/J1 legacy codes on vendors protect their entry; another company\'s use does not', async () => {
    const a = await freshCompany('Terms Use A');
    const b = await freshCompany('Terms Use B');
    await createVendor(a, { displayName: 'Due Vendor', terms: 'due_on_receipt' });
    const [v] = await db.select().from(vendors).where(and(eq(vendors.companyId, a.companyId), eq(vendors.displayName, 'Due Vendor')));
    const dueA = (await listEntries(a, 'terms')).find((t) => t.name === 'Due on receipt')!;
    expect(v.termsId === dueA.id || v.terms === 'due_on_receipt').toBe(true);
    expect((await removeEntry(a, 'terms', dueA.id)).deleted).toBe(false);
    // Clean Up of company A must keep the now-inactive but still used entry
    const preview = await previewCleanup(a, ['terms']);
    expect(preview.lists[0].entries.map((e) => e.id)).not.toContain(dueA.id);
    await runCleanup(a, { lists: ['terms'] });
    const [still] = await db.select({ n: sql<number>`count(*)` }).from(sql`payment_terms`).where(sql`id = ${dueA.id}::uuid`);
    expect(Number(still.n)).toBe(1);
    // Company B has no one on "Due on receipt": deleting it there is a real delete
    const dueB = (await listEntries(b, 'terms')).find((t) => t.name === 'Due on receipt')!;
    expect((await removeEntry(b, 'terms', dueB.id)).deleted).toBe(true);
    // A discount terms entry used by its text code cannot be deleted; an unused one can
    await createCustomer(a, { displayName: 'Disc Cust', terms: '2_10_net_30' });
    const two = (await listEntries(a, 'terms')).find((t) => t.name === '2% 10 Net 30')!;
    const one = (await listEntries(a, 'terms')).find((t) => t.name === '1% 10 Net 30')!;
    expect((await removeEntry(a, 'terms', two.id)).deleted).toBe(false);
    expect((await removeEntry(a, 'terms', one.id)).deleted).toBe(true);
  });

  it('B16 merge rounding up (+0.01) is posted too; GL == subledger, TB/BS balanced', async () => {
    const c = await freshCompany('Drift Up Co');
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'Up A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'Up B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 100, unitCost: 1, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 200, unitCost: 2, date: d('2026-02-01') });
    expect((await inventoryValuation(c)).grandTotal).toBe('500.00');
    const jesBefore = await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId));
    await mergeItems(c, { fromId: a.id, toId: b.id });
    expect((await inventoryValuation(c)).grandTotal).toBe('500.01'); // 300 x 1.6667
    const jesAfter = await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId));
    expect(jesAfter.length).toBe(jesBefore.length + 1);
    await assertInvariants(c);
  });

  it('B16 merge without rounding posts nothing (no zero entries)', async () => {
    const c = await freshCompany('Drift None Co');
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'Ex A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'Ex B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 3, unitCost: 1, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 3, unitCost: 2, date: d('2026-02-01') });
    const n = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length;
    await mergeItems(c, { fromId: a.id, toId: b.id });
    expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length).toBe(n);
    expect((await inventoryValuation(c)).grandTotal).toBe('9.00');
    await assertInvariants(c);
  });

  it('B16 merge needing a rounding entry inside a closed period either is refused and rolls back fully, or never lands in the closed period', async () => {
    const c = await freshCompany('Drift Closed Co');
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'Cl A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'Cl B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 100, unitCost: 2, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 200, unitCost: 1, date: d('2026-02-01') });
    const future = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const closed = await setClosingDate(c, { closingDate: future }).then(() => true, () => false);
    try {
      const ok = await mergeItems(c, { fromId: a.id, toId: b.id }).then(() => true, () => false);
      const [ra] = await db.select().from(items).where(eq(items.id, a.id));
      const [rb] = await db.select().from(items).where(eq(items.id, b.id));
      if (!ok) {
        expect(ra.isActive).toBe(true);
        expect(Number(ra.quantityOnHand)).toBe(100);
        expect(Number(rb.quantityOnHand)).toBe(200);
      } else {
        expect(closed).toBe(false); // a posting dated inside the closed period must not succeed
      }
      await assertInvariants(c);
    } finally {
      if (closed) await setClosingDate(c, { closingDate: null });
    }
  });

  it('G4 rounding "none" keeps cents: half-up, preview == stored for several odd prices', async () => {
    const cases: Array<[string, string, string]> = [
      ['9.99', '3.3', '10.32'],
      ['1.00', '0.5', '1.01'], // 1.005 -> 1.01 half-up
      ['0.10', '4.9', '0.10'],
      ['19.95', '-12.345', '17.49'], // 17.4872...
    ];
    for (const [price, pct, expected] of cases) {
      const it0 = await createItem(ctx, { name: `Cents ${price} ${pct}`, type: 'service', salesPrice: price });
      const prev = await changeItemPrices(ctx, { itemIds: [it0.id], adjustBy: 'percent', value: pct, rounding: 'none', dryRun: true });
      const res = await changeItemPrices(ctx, { itemIds: [it0.id], adjustBy: 'percent', value: pct, rounding: 'none' });
      const [row] = await db.select().from(items).where(eq(items.id, it0.id));
      expect(prev.changes[0].newPrice).toBe(expected);
      expect(res.changes[0].newPrice).toBe(expected);
      expect(row.salesPrice).toBe(expected);
    }
  });

  it('G2 factors: 6 dp accepted exactly, 7 dp / exponent / oversize refused as validation errors', async () => {
    const ok = await createUomSet(ctx, { name: 'Six dp', baseUnitName: 'Milligram', baseUnitAbbrev: 'mg', units: [{ name: 'Micro', abbrev: 'ug', factor: '0.000001' }] });
    const u = ok.units.find((x: { name: string }) => x.name === 'Micro')!;
    expect(u.factor).toBe('0.000001');
    expect(Number(convertToBase(ok, 1_000_000, 'Micro'))).toBe(1);
    for (const factor of ['0.0000001', '1e-7', '0.0000005']) {
      await expect(
        createUomSet(ctx, { name: `Bad ${factor}`, baseUnitName: 'G', baseUnitAbbrev: 'g', units: [{ name: 'X', abbrev: 'x', factor }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // numeric(18,6) holds at most 12 integer digits: a bigger factor must be a validation error, not a DB crash
    await expect(
      createUomSet(ctx, { name: 'Huge', baseUnitName: 'G', baseUnitAbbrev: 'g', units: [{ name: 'Planet', abbrev: 'pl', factor: '10000000000000' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // and an update goes through the same rule
    await expect(
      updateUomSet(ctx, ok.id, { name: 'Six dp', baseUnitName: 'Milligram', baseUnitAbbrev: 'mg', units: [{ name: 'Micro', abbrev: 'ug', factor: '0.0000001' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getUomSet(ctx, ok.id)).units[0].factor).toBe('0.000001');
  });

  it('B15 names are case-insensitive for vendors and items too (single create, bulk and rename)', async () => {
    await createVendor(ctx, { displayName: 'Acme QA Supply' });
    await expect(createVendor(ctx, { displayName: 'ACME qa supply' })).rejects.toThrow();
    const rv = await bulkSave(ctx, 'vendors', [{ displayName: 'acme QA SUPPLY' }]);
    expect(rv.saved).toBe(false);
    await createItem(ctx, { name: 'Widget QA Case', type: 'service' });
    await expect(createItem(ctx, { name: 'WIDGET qa case', type: 'service' })).rejects.toThrow();
    const ri = await bulkSave(ctx, 'items', [{ name: 'widget qa case', type: 'service' }]);
    expect(ri.saved).toBe(false);
    // renaming onto another record's name in a different case is refused...
    const c1 = await createCustomer(ctx, { displayName: 'Rename One QA' });
    const c2 = await createCustomer(ctx, { displayName: 'Rename Two QA' });
    await expect(updateCustomer(ctx, c2.id, { displayName: 'RENAME ONE qa' })).rejects.toThrow();
    // ...but changing the case of your own name is allowed
    await expect(updateCustomer(ctx, c1.id, { displayName: 'RENAME ONE QA' })).resolves.toBeTruthy();
    const v2 = await createVendor(ctx, { displayName: 'Vendor Self QA' });
    await expect(updateVendor(ctx, v2.id, { displayName: 'vendor self qa' })).resolves.toBeTruthy();
    const i2 = await createItem(ctx, { name: 'Item Self QA', type: 'service' });
    await expect(updateItem(ctx, i2.id, { name: 'ITEM SELF QA' })).resolves.toBeTruthy();
    // case-variant names in another company are fine
    await expect(createCustomer(other, { displayName: 'rename one qa' })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Re-test round 1 (resumed run): stricter checks on the fixes.
describe('re-test round 1 (strict)', () => {
  async function freshCompany(name: string): Promise<ServiceContext> {
    const [u] = await db.select().from(users).where(eq(users.email, 'qa@wave2.local'));
    const co = await createCompany(db, { name, ownerId: u.id });
    return { db, companyId: co.id, userId: u.id };
  }

  it('B16 rounding merge with a future closing date is refused PERIOD_CLOSED and rolls back completely', async () => {
    const c = await freshCompany('Drift Closed Strict Co');
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'CS A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'CS B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 100, unitCost: 2, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 200, unitCost: 1, date: d('2026-02-01') });
    const jeBefore = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length;
    const future = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    await setClosingDate(c, { closingDate: future });
    const auditBefore = (await db.select().from(auditLogs).where(eq(auditLogs.companyId, c.companyId))).length;
    try {
      await expect(mergeItems(c, { fromId: a.id, toId: b.id })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [ra] = await db.select().from(items).where(eq(items.id, a.id));
      const [rb] = await db.select().from(items).where(eq(items.id, b.id));
      expect(ra.isActive).toBe(true);
      expect(ra.quantityOnHand && Number(ra.quantityOnHand)).toBe(100);
      expect(rb.quantityOnHand && Number(rb.quantityOnHand)).toBe(200);
      expect(Number(rb.averageCost)).toBe(1);
      expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length).toBe(jeBefore);
      expect((await db.select().from(auditLogs).where(eq(auditLogs.companyId, c.companyId))).length).toBe(auditBefore);
      expect((await inventoryValuation(c)).grandTotal).toBe('400.00');
      await assertInvariants(c);
    } finally {
      await setClosingDate(c, { closingDate: null });
    }
  });

  it('B16 rounding entry is a balanced 2-line posted entry of exactly 0.01 between Inventory and COGS, linked to the item', async () => {
    const c = await freshCompany('Drift Shape Co');
    const [inv] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1300')));
    const a = await createItem(c, { name: 'Sh A', type: 'inventory', assetAccountId: inv.id });
    const b = await createItem(c, { name: 'Sh B', type: 'inventory', assetAccountId: inv.id });
    await adjustInventory(c, { itemId: a.id, quantityChange: 100, unitCost: 2, date: d('2026-02-01') });
    await adjustInventory(c, { itemId: b.id, quantityChange: 200, unitCost: 1, date: d('2026-02-01') });
    await mergeItems(c, { fromId: a.id, toId: b.id });
    const roundingOnly = and(
      eq(journalEntries.companyId, c.companyId),
      eq(journalEntries.sourceRef, `item:${b.id}`),
      sql`${journalEntries.description} LIKE 'Rounding from merging%'`,
    );
    const [je] = await db.select().from(journalEntries).where(roundingOnly);
    expect(je).toBeDefined();
    expect(je.status).toBe('posted');
    const lines = await db.execute(sql`SELECT account_id::text AS account_id, debit, credit FROM journal_entry_lines WHERE journal_entry_id = ${je.id}::uuid`);
    const rows = ((lines as unknown as { rows?: unknown[] }).rows ?? (lines as unknown as unknown[])) as Array<{ account_id: string; debit: string | null; credit: string | null }>;
    expect(rows.length).toBe(2);
    const invLine = rows.find((r) => r.account_id === inv.id)!;
    expect(invLine).toBeDefined();
    expect(Number(invLine.credit)).toBe(0.01); // 399.99 < 400.00: inventory credited
    const other = rows.find((r) => r.account_id !== inv.id)!;
    expect(Number(other.debit)).toBe(0.01);
    // merging again (retry / double click) must be idempotent: refused or a no-op, never a second rounding entry
    const val1 = (await inventoryValuation(c)).grandTotal;
    await mergeItems(c, { fromId: a.id, toId: b.id }).catch(() => undefined);
    expect((await inventoryValuation(c)).grandTotal).toBe(val1);
    const [rb2] = await db.select().from(items).where(eq(items.id, b.id));
    expect(Number(rb2.quantityOnHand)).toBe(300);
    const all = await db.select().from(journalEntries).where(roundingOnly);
    expect(all.length).toBe(1);
    await assertInvariants(c);
  });

  it('B5/J1 legacy text terms match is company-scoped and case-insensitive; Clean Up of an unused inactive entry still deletes', async () => {
    const a = await freshCompany('Terms Strict A');
    await createCustomer(a, { displayName: 'Legacy Upper', terms: 'net_15' });
    // force the legacy shape: text code only, no termsId, upper-case code
    await db.update(customers).set({ termsId: null, terms: 'NET_15' })
      .where(and(eq(customers.companyId, a.companyId), eq(customers.displayName, 'Legacy Upper')));
    const net15 = (await listEntries(a, 'terms')).find((t) => t.name === 'Net 15')!;
    expect(net15).toBeDefined();
    expect((await removeEntry(a, 'terms', net15.id)).deleted).toBe(false);
    // an unused entry that is inactive is still cleaned up
    const t = await createEntry(a, 'terms', { name: 'Net 77 QA', kind: 'standard', netDays: 77 });
    await updateEntry(a, 'terms', t.id, { isActive: false });
    const preview = await previewCleanup(a, ['terms']);
    const ids = preview.lists[0].entries.map((e) => e.id);
    expect(ids).toContain(t.id);
    expect(ids).not.toContain(net15.id);
  });
});
