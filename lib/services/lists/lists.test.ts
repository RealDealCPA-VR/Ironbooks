/**
 * Wave-2 lists: Terms math + list, simple lists, sales tax codes on customers/items, notes,
 * to-dos, billing rate levels, U/M sets, opening stock (G1), merges (B16), Clean Up (J1),
 * Add/Edit Multiple (B15), Change Item Prices (G4), POs from the reorder list (G3), Inventory
 * Center (G5), tax rate edit (B18), mileage vehicles (B14). Hermetic PGlite company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  classes,
  customers,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  purchaseOrders,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer, updateCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem, updateItem } from '../items';
import { adjustInventory, setReorderPoint } from '../inventory';
import { createClass } from '../dimensions';
import { createEmployee } from '../payroll';
import { postJournalEntry } from '../posting';
import { trialBalance } from '../reports';
import { createTaxRate, updateTaxRate } from '../salesTax';
import { logMiles } from '../mileage';
import { mergeCustomers, mergeVendors } from '../merge';
import { computeDiscount, computeDueDate, describeTerms } from './termsMath';
import { dueDateFor, resolveTermsRef } from './terms';
import { createEntry, listEntries, removeEntry, updateEntry } from './simpleLists';
import { addNote, listNotes } from './notes';
import { createTodo, listTodos, updateTodo } from './todos';
import { assignBillingRateLevel, createBillingRateLevel, resolveBillingRate } from './billingRates';
import { convertToBase, createUomSet, toBaseQuantity, updateUomSet } from './uom';
import { createItemWithOpeningStock } from './openingStock';
import { mergeClasses, mergeEmployees, mergeItems, mergeOtherNames } from './mergeLists';
import { previewCleanup, runCleanup } from './cleanup';
import { bulkSave } from './bulk';
import { changeItemPrices, createPurchaseOrdersFromReorder, stockStatusByVendor } from './itemTools';
import { inventoryCenterList, inventoryItemDetail } from './inventoryCenter';
import { findReferences } from './references';
import { resolvePaymentMethod } from './paymentMethods';
import { assignJobType } from './jobTypes';
import { jobs as jobsTable } from '@/lib/db/schema';
import { setComponents } from '../combinedTax';
import { parseTsv, pastedRowsToRecords, parseAmount } from '@/lib/lists/bulk';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-lists-q7m2');
let db: DB;
let ctx: ServiceContext;
let acct: Record<string, string>;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

async function assertBooksBalance() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'lists@wave2.local', name: 'Lister', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Lists Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('terms math (pure)', () => {
  it('standard terms: net days and early-payment discount', () => {
    const t = { kind: 'standard', netDays: 30, discountPercent: '2', discountDays: 10 };
    expect(iso(computeDueDate(t, d('2026-01-15')))).toBe('2026-02-14');
    expect(computeDiscount(t, d('2026-01-15'), d('2026-01-25'), '1000.00')).toMatchObject({ eligible: true, amount: '20.00' });
    expect(computeDiscount(t, d('2026-01-15'), d('2026-01-26'), '1000.00')).toMatchObject({ eligible: false, amount: '0.00' });
    expect(describeTerms(t)).toBe('2% 10, Net 30');
    expect(iso(computeDueDate({ kind: 'standard', netDays: 0 }, d('2026-03-31')))).toBe('2026-03-31');
  });

  it('date-driven terms: fixed day, next month when issued too close, clamps short months', () => {
    const t = { kind: 'date_driven', dueDayOfMonth: 15, dueNextMonthWithinDays: 5 };
    expect(iso(computeDueDate(t, d('2026-01-05')))).toBe('2026-01-15'); // 10 days ahead
    expect(iso(computeDueDate(t, d('2026-01-12')))).toBe('2026-02-15'); // within 5 days
    expect(iso(computeDueDate(t, d('2026-01-20')))).toBe('2026-02-15'); // already past
    expect(iso(computeDueDate(t, d('2026-12-20')))).toBe('2027-01-15'); // year rollover
    const eom = { kind: 'date_driven', dueDayOfMonth: 31, dueNextMonthWithinDays: 0 };
    expect(iso(computeDueDate(eom, d('2026-02-10')))).toBe('2026-02-28');
    const disc = { kind: 'date_driven', dueDayOfMonth: 25, dueNextMonthWithinDays: 0, discountPercent: '1', discountDayOfMonth: 10 };
    expect(computeDiscount(disc, d('2026-04-02'), d('2026-04-10')).eligible).toBe(true);
    expect(computeDiscount(disc, d('2026-04-02'), d('2026-04-11')).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('simple lists + Terms list', () => {
  it('seeds QB defaults once and resolves legacy terms codes', async () => {
    const terms = await listEntries(ctx, 'terms');
    expect(terms.map((t) => t.name)).toContain('Net 30');
    const again = await listEntries(ctx, 'terms');
    expect(again.length).toBe(terms.length);
    const net30 = await resolveTermsRef(ctx, 'net_30');
    expect(net30?.name).toBe('Net 30');
    expect((await resolveTermsRef(ctx, 'NET 30'))?.id).toBe(net30?.id);
    expect(iso(await dueDateFor(ctx, 'net_30', d('2026-05-01')))).toBe('2026-05-31');
    const codes = await listEntries(ctx, 'sales-tax-codes');
    expect(codes.map((c) => c.code).sort()).toEqual(['Non', 'Tax']);
  });

  it('validates terms rules and keeps names unique (case-insensitive)', async () => {
    await expect(createEntry(ctx, 'terms', { name: 'Bad', kind: 'standard', netDays: 10, discountPercent: '2', discountDays: 20 })).rejects.toThrow(/discount period/);
    await expect(createEntry(ctx, 'terms', { name: 'Net 30', kind: 'standard', netDays: 30 })).rejects.toThrow(/already/);
    await expect(createEntry(ctx, 'terms', { name: 'EOM', kind: 'date_driven' })).rejects.toThrow(/day of the month/);
    const eom = await createEntry(ctx, 'terms', { name: '15th', kind: 'date_driven', dueDayOfMonth: 15, dueNextMonthWithinDays: 3, netDays: 99 });
    expect(eom.netDays).toBeNull(); // irrelevant standard fields are cleared
    const upd = await updateEntry(ctx, 'terms', eom.id, { dueDayOfMonth: 20 });
    expect(upd.dueDayOfMonth).toBe(20);
    expect(upd.dueNextMonthWithinDays).toBe(3);
  });

  it('deletes an unused entry but only deactivates one that is in use', async () => {
    const t = await createEntry(ctx, 'terms', { name: 'Net 7', kind: 'standard', netDays: 7 });
    const c = await createCustomer(ctx, { displayName: 'Terms User', termsId: t.id });
    expect(c.termsId).toBe(t.id);
    expect(c.terms).toBe('Net 7');
    const r = await removeEntry(ctx, 'terms', t.id);
    expect(r).toEqual({ deleted: false, deactivated: true });
    const ship = await createEntry(ctx, 'ship-via', { name: 'Courier X' });
    expect(await removeEntry(ctx, 'ship-via', ship.id)).toEqual({ deleted: true, deactivated: false });
    const pm = await createEntry(ctx, 'payment-methods', { name: 'Zelle', type: 'bank_transfer' });
    expect(pm.type).toBe('bank_transfer');
    await expect(createEntry(ctx, 'sales-tax-codes', { code: 'TOOLONG', taxable: false })).rejects.toThrow();
    // audit trail written
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityId, ship.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(['create', 'delete']);
  });

  it('assigns a job type to a job', async () => {
    const jt = await createEntry(ctx, 'job-types', { name: 'Remodel' });
    const cust = await createCustomer(ctx, { displayName: 'Job Owner' });
    const [job] = await db.insert(jobsTable).values({ companyId: ctx.companyId, customerId: cust.id, name: 'Kitchen' }).returning();
    expect((await assignJobType(ctx, job.id, jt.id)).jobTypeId).toBe(jt.id);
    expect(await removeEntry(ctx, 'job-types', jt.id)).toEqual({ deleted: false, deactivated: true });
    expect((await assignJobType(ctx, job.id, null)).jobTypeId).toBeNull();
  });

  it('maps payment method list entries to the payment enum', async () => {
    expect(await resolvePaymentMethod(ctx, 'Visa')).toMatchObject({ type: 'credit_card' });
    const custom = await createEntry(ctx, 'payment-methods', { name: 'Venmo', type: 'other' });
    expect(await resolvePaymentMethod(ctx, custom.id)).toMatchObject({ id: custom.id, type: 'other' });
    expect(await resolvePaymentMethod(ctx, 'check')).toMatchObject({ type: 'check' });
    await expect(resolvePaymentMethod(ctx, 'Bitcoin')).rejects.toThrow(/not found/i);
  });

  it('customers and items follow their sales tax code; resale number is kept', async () => {
    const codes = await listEntries(ctx, 'sales-tax-codes');
    const non = codes.find((c) => c.code === 'Non')!;
    const tax = codes.find((c) => c.code === 'Tax')!;
    const c = await createCustomer(ctx, { displayName: 'Reseller Inc', salesTaxCodeId: non.id, resaleNumber: 'R-123', taxExemptionReason: 'Resale' });
    expect(c.taxable).toBe(false);
    expect(c.resaleNumber).toBe('R-123');
    const c2 = await updateCustomer(ctx, c.id, { salesTaxCodeId: tax.id });
    expect(c2.taxable).toBe(true);
    const it1 = await createItem(ctx, { name: 'Taxless Service', salesTaxCodeId: non.id });
    expect(it1.taxable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('notes, to-dos, billing rates, U/M, tax rate edit, vehicles', () => {
  it('keeps dated notes and to-dos linked to a record', async () => {
    const c = await createCustomer(ctx, { displayName: 'Noted Customer' });
    await addNote(ctx, { entityType: 'customer', entityId: c.id, body: 'First call', noteDate: '2026-01-01T00:00:00.000Z' });
    await addNote(ctx, { entityType: 'customer', entityId: c.id, body: 'Second call', noteDate: '2026-02-01T00:00:00.000Z' });
    const notes = await listNotes(ctx, 'customer', c.id);
    expect(notes.map((n) => n.body)).toEqual(['Second call', 'First call']);
    await expect(addNote(ctx, { entityType: 'vendor', entityId: c.id, body: 'x' })).rejects.toThrow(/not found/i);
    const todo = await createTodo(ctx, { title: 'Call back', entityType: 'customer', entityId: c.id, dueDate: '2026-03-01T00:00:00.000Z', priority: 'high' });
    expect((await listTodos(ctx, { entityType: 'customer', entityId: c.id }))[0].entityName).toBe('Noted Customer');
    const done = await updateTodo(ctx, todo.id, { status: 'done' });
    expect(done.completedAt).not.toBeNull();
    await expect(createTodo(ctx, { title: 'Half link', entityType: 'customer' })).rejects.toThrow(/both/);
  });

  it('resolves billing rates by level, falling back to the item price', async () => {
    const svc = await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '100' });
    const svc2 = await createItem(ctx, { name: 'Design', type: 'service', salesPrice: '80' });
    const emp = await createEmployee(ctx, { firstName: 'Ada', lastName: 'Lovelace', payType: 'hourly', payRate: '50' });
    expect((await resolveBillingRate(ctx, { employeeId: emp.id }, svc.id)).rate).toBe('100.0000');
    const custom = await createBillingRateLevel(ctx, { name: 'Senior', type: 'custom', items: [{ itemId: svc.id, rate: '150' }] });
    await assignBillingRateLevel(ctx, { employeeId: emp.id }, custom.id);
    expect(await resolveBillingRate(ctx, { employeeId: emp.id }, svc.id)).toMatchObject({ rate: '150.0000', source: 'billing_rate_level' });
    expect(await resolveBillingRate(ctx, { employeeId: emp.id }, svc2.id)).toMatchObject({ rate: '80.0000', source: 'item_price' });
    const fixed = await createBillingRateLevel(ctx, { name: 'Flat 60', type: 'fixed_rate', fixedRate: '60' });
    await assignBillingRateLevel(ctx, { employeeId: emp.id }, fixed.id);
    expect((await resolveBillingRate(ctx, { employeeId: emp.id }, svc2.id)).rate).toBe('60.0000');
    await expect(createBillingRateLevel(ctx, { name: 'No rate', type: 'fixed_rate' })).rejects.toThrow(/hourly rate/);
  });

  it('converts unit-of-measure quantities to the base unit and protects used sets', async () => {
    const set = await createUomSet(ctx, {
      name: 'Count by case',
      baseUnitName: 'Each',
      baseUnitAbbrev: 'ea',
      units: [{ name: 'Case', abbrev: 'cs', factor: '12' }, { name: 'Half case', abbrev: 'hc', factor: '6' }],
      defaultPurchaseUnit: 'Case',
    });
    expect(convertToBase(set, 3, 'cs')).toBe('36.0000');
    expect(convertToBase(set, 5, 'Each')).toBe('5.0000');
    expect(() => convertToBase(set, 1, 'pallet')).toThrow(/not a unit/);
    const it = await createItem(ctx, { name: 'Widget UOM', type: 'inventory', uomSetId: set.id });
    expect(await toBaseQuantity(ctx, it.id, 2, 'Half case')).toBe('12.0000');
    await expect(
      updateUomSet(ctx, set.id, { name: 'Count by case', baseUnitName: 'Piece', baseUnitAbbrev: 'pc', units: [{ name: 'Case', abbrev: 'cs', factor: '12' }] }),
    ).rejects.toThrow(/base unit/);
    await expect(
      updateUomSet(ctx, set.id, { name: 'Count by case', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [{ name: 'Case', abbrev: 'cs', factor: '24' }] }),
    ).rejects.toThrow(/conversion/);
    await expect(createUomSet(ctx, { name: 'Bad', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [{ name: 'Zero', abbrev: 'z', factor: '0' }] })).rejects.toThrow(/greater than zero/);
  });

  it('edits a sales tax rate (B18)', async () => {
    const rate = await createTaxRate(ctx, { name: 'City', rate: '0.05' });
    const upd = await updateTaxRate(ctx, rate.id, { rate: '0.0625', name: 'City tax' });
    expect(upd.rate).toBe('0.062500');
    expect(upd.name).toBe('City tax');
    await expect(updateTaxRate(ctx, rate.id, { rate: '2' })).rejects.toThrow(/between 0 and 1/);
    const combined = await createTaxRate(ctx, { name: 'Combined', rate: '0' });
    await setComponents(ctx, combined.id, [{ name: 'State', rate: '0.05' }, { name: 'County', rate: '0.01' }]);
    await expect(updateTaxRate(ctx, combined.id, { rate: '0.07' })).rejects.toThrow(/components/);
    expect((await updateTaxRate(ctx, combined.id, { name: 'Combined 6%', isActive: true })).rate).toBe('0.060000');
  });

  it('logs mileage against a vehicle and checks odometer readings', async () => {
    const v = await createEntry(ctx, 'vehicles', { name: 'Van 1' });
    const log = await logMiles(ctx, { date: d('2026-01-03'), miles: 42, vehicleId: v.id, odometerStart: 1000, odometerEnd: 1042 });
    expect(log.vehicleName).toBe('Van 1');
    await expect(logMiles(ctx, { date: d('2026-01-03'), miles: 10, vehicleId: v.id, odometerStart: 1000, odometerEnd: 1042 })).rejects.toThrow(/odometer/);
  });
});

// ---------------------------------------------------------------------------
describe('opening quantity on hand (G1)', () => {
  it('posts Inventory vs Opening Balance Equity, opens a FIFO layer (openingCosting fifo), and keeps the books balanced', async () => {
    const { item, opening } = await createItemWithOpeningStock(ctx, {
      name: 'Opening Widget',
      type: 'inventory',
      assetAccountId: acct['1300'],
      openingQuantity: '10',
      openingValue: '125.50',
      openingAsOf: d('2026-01-01'),
      openingCosting: 'fifo',
    });
    expect(opening?.costing).toBe('fifo');
    expect(item.quantityOnHand).toBe('10.0000');
    expect(opening?.value).toBe('125.50');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, opening!.entryId!));
    const obe = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Opening Balance Equity')));
    expect(lines.find((l) => l.accountId === acct['1300'])?.debit).toBe('125.50');
    expect(lines.find((l) => l.accountId === obe[0].id)?.credit).toBe('125.50');
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, item.id));
    expect(layers).toHaveLength(1);
    expect(layers[0].unitCost).toBe('12.5500');
    await assertBooksBalance();
  });

  it('defaults to average cost: no FIFO layer, the value rides on averageCost', async () => {
    const { item, opening } = await createItemWithOpeningStock(ctx, {
      name: 'Opening Average Widget',
      type: 'inventory',
      assetAccountId: acct['1300'],
      openingQuantity: '10',
      openingValue: '125.50',
      openingAsOf: d('2026-01-01'),
    });
    expect(opening?.costing).toBe('average');
    expect(opening?.layerId).toBeNull();
    expect(item.averageCost).toBe('12.5500');
    expect(await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, item.id))).toHaveLength(0);
    await assertBooksBalance();
  });

  it('refuses values that cannot be split into an exact unit cost, and non-inventory items', async () => {
    await expect(
      createItemWithOpeningStock(ctx, { name: 'Odd', type: 'inventory', openingQuantity: '300', openingValue: '1000', openingAsOf: d('2026-01-01') }),
    ).rejects.toThrow(/exact unit cost/);
    expect(await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Odd')))).toHaveLength(0);
    await expect(
      createItemWithOpeningStock(ctx, { name: 'Svc open', type: 'service', openingQuantity: '1', openingValue: '1' }),
    ).rejects.toThrow(/inventory items/);
    const { opening } = await createItemWithOpeningStock(ctx, { name: 'By unit cost', type: 'inventory', openingQuantity: '3', openingUnitCost: '1.3333', openingAsOf: d('2026-01-01') });
    expect(opening?.value).toBe('4.00');
    await assertBooksBalance();
  });
});

// ---------------------------------------------------------------------------
describe('merge items, classes, employees, other names (B16)', () => {
  it('merges two average-cost inventory items: quantities add, cost is value-weighted', async () => {
    const a = await createItem(ctx, { name: 'Bolt A', type: 'inventory' });
    const b = await createItem(ctx, { name: 'Bolt B', type: 'inventory' });
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 10, unitCost: 2, date: d('2026-01-02') });
    await adjustInventory(ctx, { itemId: b.id, quantityChange: 30, unitCost: 4, date: d('2026-01-02') });
    await setReorderPoint(ctx, a.id, 5);
    const r = await mergeItems(ctx, { fromId: a.id, toId: b.id });
    expect(r.deactivatedId).toBe(a.id);
    const [to] = await db.select().from(items).where(eq(items.id, b.id));
    const [from] = await db.select().from(items).where(eq(items.id, a.id));
    expect(to.quantityOnHand).toBe('40.0000');
    expect(to.averageCost).toBe('3.5000');
    expect(from.isActive).toBe(false);
    expect(from.quantityOnHand).toBe('0.0000');
    await assertBooksBalance();
  });

  it('refuses mismatched item types and self merges', async () => {
    const s = await createItem(ctx, { name: 'Svc M', type: 'service' });
    const i = await createItem(ctx, { name: 'Inv M', type: 'inventory' });
    await expect(mergeItems(ctx, { fromId: s.id, toId: i.id })).rejects.toThrow(/same type/);
    await expect(mergeItems(ctx, { fromId: s.id, toId: s.id })).rejects.toThrow(/itself/);
  });

  it('merges classes, moving posted line tags without changing balances', async () => {
    const c1 = await createClass(ctx, { name: 'East' });
    const c2 = await createClass(ctx, { name: 'West' });
    const entry = await postJournalEntry(ctx, {
      date: d('2026-01-05'),
      description: 'Class tagged',
      lines: [
        { accountId: acct['6000'], debit: '50.00', classId: c1.id },
        { accountId: acct['1000'], credit: '50.00', classId: c1.id },
      ],
    });
    const before = await trialBalance(ctx);
    await mergeClasses(ctx, { fromId: c1.id, toId: c2.id });
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entry.id));
    expect(lines.every((l) => l.classId === c2.id)).toBe(true);
    const after = await trialBalance(ctx);
    expect(after.totalDebit).toBe(before.totalDebit);
    const [gone] = await db.select().from(classes).where(eq(classes.id, c1.id));
    expect(gone.isActive).toBe(false);
  });

  it('merges employees without paychecks and other names (moving notes)', async () => {
    const e1 = await createEmployee(ctx, { firstName: 'Bob', lastName: 'One', payType: 'hourly', payRate: '20' });
    const e2 = await createEmployee(ctx, { firstName: 'Bob', lastName: 'Uno', payType: 'hourly', payRate: '20' });
    await addNote(ctx, { entityType: 'employee', entityId: e1.id, body: 'dup' });
    const r = await mergeEmployees(ctx, { fromId: e1.id, toId: e2.id });
    expect(r.reassigned.notes).toBe(1);
    expect(await listNotes(ctx, 'employee', e2.id)).toHaveLength(1);
    const o1 = await createEntry(ctx, 'other-names', { name: 'Owner Draw' });
    const o2 = await createEntry(ctx, 'other-names', { name: 'Owner' });
    await mergeOtherNames(ctx, { fromId: o1.id, toId: o2.id });
    expect((await listEntries(ctx, 'other-names')).map((o) => o.name)).toEqual(['Owner']);
  });

  it('customer/vendor merge sweeps every remaining reference (preferred vendor, notes)', async () => {
    const v1 = await createVendor(ctx, { displayName: 'Supply One' });
    const v2 = await createVendor(ctx, { displayName: 'Supply Two' });
    const it = await createItem(ctx, { name: 'Pref Item', type: 'inventory', preferredVendorId: v1.id });
    await addNote(ctx, { entityType: 'vendor', entityId: v1.id, body: 'old vendor note' });
    await mergeVendors(ctx, { fromId: v1.id, toId: v2.id });
    const [after] = await db.select().from(items).where(eq(items.id, it.id));
    expect(after.preferredVendorId).toBe(v2.id);
    expect(await listNotes(ctx, 'vendor', v2.id)).toHaveLength(1);
    const parent = await createCustomer(ctx, { displayName: 'Parent Co' });
    const child = await createCustomer(ctx, { displayName: 'Child Co', parentId: parent.id });
    await mergeCustomers(ctx, { fromId: parent.id, toId: child.id });
    const [c] = await db.select().from(customers).where(eq(customers.id, child.id));
    expect(c.parentId).toBeNull(); // never its own parent
  });
});

// ---------------------------------------------------------------------------
describe('Clean Up Company Data (J1)', () => {
  it('removes only inactive entries that nothing references', async () => {
    const unused = await createVendor(ctx, { displayName: 'Unused Old Vendor' });
    const used = await createVendor(ctx, { displayName: 'Used Old Vendor' });
    await createItem(ctx, { name: 'Uses vendor', preferredVendorId: used.id });
    const active = await createVendor(ctx, { displayName: 'Active Vendor' });
    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, unused.id));
    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, used.id));
    const preview = await previewCleanup(ctx, ['vendors']);
    const names = preview.lists[0].entries.map((e) => e.name);
    expect(names).toContain('Unused Old Vendor');
    expect(names).not.toContain('Used Old Vendor');
    expect(names).not.toContain('Active Vendor');
    const res = await runCleanup(ctx, { lists: ['vendors'], ids: [unused.id, used.id, active.id] });
    expect(res.removed.map((r) => r.id)).toEqual([unused.id]);
    expect(await db.select().from(vendors).where(eq(vendors.id, unused.id))).toHaveLength(0);
    expect(await db.select().from(vendors).where(eq(vendors.id, used.id))).toHaveLength(1);
  });

  it('finds references through source links and JSON documents too', async () => {
    const it = await createItem(ctx, { name: 'Ref probe', type: 'inventory' });
    await adjustInventory(ctx, { itemId: it.id, quantityChange: 1, unitCost: 1, date: d('2026-01-02') });
    await adjustInventory(ctx, { itemId: it.id, quantityChange: -1, date: d('2026-01-03') });
    const hits = await findReferences(ctx, 'items', [it.id]);
    expect(hits.get(it.id)!.some((h) => h.column === 'source_ref')).toBe(true);
    await updateItem(ctx, it.id, { isActive: false });
    const preview = await previewCleanup(ctx, ['items']);
    expect(preview.lists[0].entries.map((e) => e.id)).not.toContain(it.id);
  });
});

// ---------------------------------------------------------------------------
describe('Add/Edit Multiple (B15)', () => {
  it('parses pasted Excel text with quotes, tabs and a header row', () => {
    const rows = parseTsv('Customer name\tEmail\tCredit limit\r\n"Acme, ""The"" Co"\tacme@x.com\t$1,200.50\nBeta\t\t\n\n');
    expect(rows).toEqual([['Customer name', 'Email', 'Credit limit'], ['Acme, "The" Co', 'acme@x.com', '$1,200.50'], ['Beta', '', '']]);
    const { records, usedHeader } = pastedRowsToRecords('customers', rows);
    expect(usedHeader).toBe(true);
    expect(records[0]).toMatchObject({ displayName: 'Acme, "The" Co', email: 'acme@x.com', creditLimit: '$1,200.50' });
    expect(parseAmount('(12.00)')).toBe('-12.00');
    expect(parseAmount('abc')).toBeNull();
  });

  it('reports every bad row and saves nothing until all rows are valid', async () => {
    const bad = await bulkSave(ctx, 'customers', [
      { displayName: 'Bulk One', email: 'one@x.com', terms: 'Net 30' },
      { displayName: '', email: 'x' },
      { displayName: 'Bulk Three', creditLimit: 'lots' },
      { displayName: 'bulk one' },
    ]);
    expect(bad.saved).toBe(false);
    expect(bad.errors.map((e) => e.row).sort()).toEqual([1, 2, 3]);
    expect(await db.select().from(customers).where(eq(customers.displayName, 'Bulk One'))).toHaveLength(0);
    const dry = await bulkSave(ctx, 'customers', [{ displayName: 'Bulk One', terms: 'Net 30' }], { dryRun: true });
    expect(dry).toMatchObject({ saved: false, dryRun: true, created: 1, errors: [] });
    expect(await db.select().from(customers).where(eq(customers.displayName, 'Bulk One'))).toHaveLength(0);
    const ok = await bulkSave(ctx, 'customers', [
      { displayName: 'Bulk One', terms: 'Net 30', creditLimit: '$1,000' },
      { displayName: 'Bulk Two', salesTaxCode: 'Non' },
    ]);
    expect(ok).toMatchObject({ saved: true, created: 2 });
    const [one] = await db.select().from(customers).where(eq(customers.displayName, 'Bulk One'));
    expect(one.creditLimit).toBe('1000.00');
    expect(one.termsId).not.toBeNull();
    const edit = await bulkSave(ctx, 'customers', [{ id: one.id, displayName: 'Bulk One Renamed', phone: '555' }]);
    expect(edit).toMatchObject({ saved: true, updated: 1 });
  });

  it('adds items with accounts by number and a preferred vendor by name', async () => {
    await createVendor(ctx, { displayName: 'Bulk Supplier' });
    const r = await bulkSave(ctx, 'items', [
      { name: 'Bulk Gadget', type: 'inventory', salesPrice: '9.99', purchaseCost: '4', assetAccount: '1300', incomeAccount: '4000', expenseAccount: '5000', preferredVendor: 'Bulk Supplier', reorderPoint: '5' },
      { name: 'Bulk Bad', type: 'spaceship' },
    ]);
    expect(r.errors).toEqual([expect.objectContaining({ row: 1, field: 'type' })]);
    const r2 = await bulkSave(ctx, 'items', [
      { name: 'Bulk Gadget', type: 'inventory', salesPrice: '9.99', purchaseCost: '4', assetAccount: '1300', incomeAccount: 'Sales Income', expenseAccount: '5000', preferredVendor: 'Bulk Supplier', reorderPoint: '5' },
    ]);
    expect(r2.saved).toBe(true);
    const [g] = await db.select().from(items).where(eq(items.name, 'Bulk Gadget'));
    expect(g.incomeAccountId).toBe(acct['4000']);
    expect(g.reorderPoint).toBe('5.0000');
  });
});

// ---------------------------------------------------------------------------
describe('item tools (G3, G4, G5)', () => {
  it('changes prices by percent with rounding; a preview changes nothing', async () => {
    const a = await createItem(ctx, { name: 'Price A', type: 'non_inventory', salesPrice: '10.00', purchaseCost: '6' });
    const b = await createItem(ctx, { name: 'Price B', type: 'non_inventory', salesPrice: '19.99' });
    const prev = await changeItemPrices(ctx, { itemIds: [a.id, b.id], adjustBy: 'percent', value: '10', rounding: 'cent', dryRun: true });
    expect(prev.changes.find((c) => c.id === b.id)?.newPrice).toBe('21.99');
    expect((await db.select().from(items).where(eq(items.id, a.id)))[0].salesPrice).toBe('10.00');
    const res = await changeItemPrices(ctx, { itemIds: [a.id], basis: 'cost', adjustBy: 'percent', value: '50', rounding: 'up_99' });
    expect(res.changed).toBe(1);
    expect((await db.select().from(items).where(eq(items.id, a.id)))[0].salesPrice).toBe('9.99');
    await expect(changeItemPrices(ctx, { itemIds: [a.id], adjustBy: 'percent', value: '-100' })).rejects.toThrow(/100%/);
  });

  it('creates one PO per preferred vendor from the reorder list', async () => {
    const v1 = await createVendor(ctx, { displayName: 'Reorder Vendor 1' });
    const v2 = await createVendor(ctx, { displayName: 'Reorder Vendor 2' });
    const i1 = await createItem(ctx, { name: 'Low 1', type: 'inventory', purchaseCost: '2', preferredVendorId: v1.id });
    const i2 = await createItem(ctx, { name: 'Low 2', type: 'inventory', purchaseCost: '3', preferredVendorId: v1.id });
    const i3 = await createItem(ctx, { name: 'Low 3', type: 'inventory', purchaseCost: '4', preferredVendorId: v2.id });
    const i4 = await createItem(ctx, { name: 'Low no vendor', type: 'inventory' });
    for (const i of [i1, i2, i3, i4]) await setReorderPoint(ctx, i.id, 5);
    const ids = [i1.id, i2.id, i3.id, i4.id];
    const dry = await createPurchaseOrdersFromReorder(ctx, { itemIds: ids, dryRun: true });
    expect(dry.purchaseOrders).toHaveLength(2);
    expect(dry.withoutVendor.map((w) => w.name)).toEqual(['Low no vendor']);
    const before = (await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, ctx.companyId))).length;
    const res = await createPurchaseOrdersFromReorder(ctx, { itemIds: ids, quantities: { [i1.id]: '7' } });
    expect(res.purchaseOrders).toHaveLength(2);
    expect((await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, ctx.companyId))).length).toBe(before + 2);
    const v1po = res.purchaseOrders.find((p) => p.vendorId === v1.id)!;
    expect(v1po.lines.find((l) => l.itemId === i1.id)?.quantity).toBe('7.0000');
    const byVendor = await stockStatusByVendor(ctx);
    expect(byVendor.groups.find((g) => g.vendorId === v2.id)?.rows.map((r) => r.name)).toContain('Low 3');
    expect(byVendor.groups[byVendor.groups.length - 1].vendorId).toBeNull();
  });

  it('Inventory Center lists stock and an item\'s transactions', async () => {
    const list = await inventoryCenterList(ctx);
    const w = list.find((r) => r.name === 'Opening Widget')!;
    expect(w.quantityOnHand).toBe('10.0000');
    expect(w.value).toBe('125.50');
    expect(w.costing).toBe('fifo');
    const detail = await inventoryItemDetail(ctx, w.id);
    expect(detail.transactions.some((t) => t.type === 'Inventory Adjustment')).toBe(true);
    const je = await db.select().from(journalEntries).where(eq(journalEntries.sourceRef, `item:${w.id}`));
    expect(je).toHaveLength(1);
    await assertBooksBalance();
  });
});
