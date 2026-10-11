/**
 * Wave-2 lists — independent QA (tester). Adversarial checks on the doer's lists package:
 * ledger invariants (TB / BS balanced, inventory subledger == GL control account), closing-date
 * respect and rollback of opening stock, tenancy, malformed input, rounding, idempotency, and
 * Clean Up never deleting something the company file still uses. Hermetic PGlite company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, customers, inventoryLayers, items, journalEntries, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { adjustInventory, inventoryValuation } from '../inventory';
import { createClass } from '../dimensions';
import { balanceSheet, trialBalance } from '../reports';
import { createTaxRate, updateTaxRate } from '../salesTax';
import { logMiles } from '../mileage';
import { computeDiscount, computeDueDate } from './termsMath';
import { customerTerms, resolveTermsRef } from './terms';
import { createEntry, listEntries, removeEntry, updateEntry } from './simpleLists';
import { addNote } from './notes';
import { createUomSet, convertToBase } from './uom';
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

  it('zero-value opening stock posts nothing but still opens a layer; invariants hold', async () => {
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
    expect(after).toBe(before); // 400.00 of stock must still be worth 400.00 (300 x 1.3333 = 399.99)
    await assertInvariants(c);
  });

  it('merging two FIFO items moves layers; valuation and GL unchanged', async () => {
    const x = await createItemWithOpeningStock(ctx, { name: 'Fifo X', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '4', openingValue: '10.00', openingAsOf: d('2026-01-05') });
    const y = await createItemWithOpeningStock(ctx, { name: 'Fifo Y', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '6', openingValue: '30.00', openingAsOf: d('2026-01-05') });
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
    const fifo = await createItemWithOpeningStock(ctx, { name: 'Mix fifo', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '1', openingValue: '1.00', openingAsOf: d('2026-01-05') });
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
