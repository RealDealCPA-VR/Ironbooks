/**
 * Review loop 4 fixes (payroll, sales tax, inventory):
 *  - a pay run refuses an hourly employee with no hours (instead of a $0 check);
 *  - year-to-date wages for a check count only what was paid before it;
 *  - editing a paycheck keeps the bank account it was paid from;
 *  - an edit keeps the tax rate an invoice / sales receipt was charged at;
 *  - the Sales Tax Codes list needs the sales-tax-codes right to change;
 *  - editing a posted invoice / sales receipt re-posts kept lines at the cost they were sold at;
 *  - a FIFO return of a sold-out item restocks at what the units last cost;
 *  - the valuation at a past date counts the units on hand at that date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, customers, items, journalEntries, journalEntryLines, paychecks, taxRates, users, vendors } from '@/lib/db/schema';
import { unionRoles, type PermissionGrant, type RoleDefinition } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createBill } from './bills';
import { createInvoice, updateInvoice } from './invoices';
import { createSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createCreditMemo } from './creditMemos';
import { receiveStock } from './fifo';
import { inventoryValuationAsOf } from './inventory';
import { createEntry } from './lists/simpleLists';
import { createEmployee, createPayRun, editPaycheck, runPaycheck, ytdWagesPaid } from './payroll';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-fixes');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
let vendorId: string;
let seq = 0;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function inventoryItem(name: string): Promise<string> {
  seq++;
  const [row] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, sku: `R4-${seq}`, type: 'inventory', purchaseCost: '1.00' })
    .returning();
  return row.id;
}

/** Total COGS debits posted for a document (posted entries with this sourceRef). */
async function cogsFor(sourceRef: string, excludeEntryId?: string | null): Promise<string> {
  const rows = await db
    .select({ debit: journalEntryLines.debit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, sourceRef),
        eq(journalEntries.status, 'posted'),
        excludeEntryId ? ne(journalEntries.id, excludeEntryId) : undefined,
      ),
    );
  return rows.reduce((s, r) => s + Number(r.debit ?? 0), 0).toFixed(2);
}

const role = (permissions: PermissionGrant): RoleDefinition => ({
  key: 'custom',
  name: 'custom',
  description: '',
  builtin: false,
  permissions,
  flags: {},
});

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'review4@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review Four Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Buyer', taxable: true }).returning())[0].id;
  vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning())[0].id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('editing a posted sale keeps what the units were sold at', { timeout: 120_000 }, () => {
  it('invoice: a memo-only edit after a costlier purchase keeps the original COGS', async () => {
    const itemId = await inventoryItem('Widget');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}a`, date: d('2026-02-01'), lines: [{ itemId, quantity: 10, unitCost: 8 }] });
    const inv = await createInvoice(ctx, { customerId, date: d('2026-02-10'), lines: [{ itemId, quantity: 4, rate: 20 }] });
    expect(await cogsFor(`invoice-cogs:${inv.id}`)).toBe('32.00');
    // Stock bought since at a much higher cost: today's average is (6×8 + 10×20) / 16 = 15.50.
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}b`, date: d('2026-03-01'), lines: [{ itemId, quantity: 10, unitCost: 20 }] });

    await updateInvoice(ctx, inv.id, { customerId, date: d('2026-02-10'), memo: 'typo fixed', lines: [{ itemId, quantity: 4, rate: 20 }] });
    expect(await cogsFor(`invoice-cogs:${inv.id}`)).toBe('32.00');
    const [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect(it.quantityOnHand).toBe('16.0000');

    // A changed quantity is a new sale of those units: costed at today's average.
    await updateInvoice(ctx, inv.id, { customerId, date: d('2026-02-10'), lines: [{ itemId, quantity: 2, rate: 20 }] });
    expect(Number(await cogsFor(`invoice-cogs:${inv.id}`))).toBeGreaterThan(16);
  });

  it('sales receipt: a memo-only edit keeps the original COGS', async () => {
    const itemId = await inventoryItem('Gadget');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}a`, date: d('2026-02-01'), lines: [{ itemId, quantity: 10, unitCost: 5 }] });
    const rc = await createSalesReceipt(ctx, { date: d('2026-02-10'), lines: [{ itemId, quantity: 3, rate: 12 }] });
    expect(await cogsFor(`salesreceipt:${rc.id}`, rc.postedEntryId)).toBe('15.00');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}b`, date: d('2026-03-01'), lines: [{ itemId, quantity: 10, unitCost: 30 }] });

    const edited = await updateSalesReceipt(ctx, rc.id, { date: d('2026-02-10'), memo: 'note', lines: [{ itemId, quantity: 3, rate: 12 }] });
    expect(await cogsFor(`salesreceipt:${rc.id}`, edited.postedEntryId)).toBe('15.00');
  });
});

/** The item's book value (qty × average + the remainder it carries) vs. the GL valuation. */
async function tiesOut(itemId: string): Promise<{ book: string; gl: string }> {
  const [it] = await db.select().from(items).where(eq(items.id, itemId));
  const avg = it.averageCost ?? '0';
  const carried = it.valueRemainderAvg != null && Number(it.valueRemainderAvg) === Number(avg) ? Number(it.valueRemainder ?? 0) : 0;
  const book = (Math.round(Number(it.quantityOnHand ?? 0) * Number(avg) * 100) / 100 + carried).toFixed(2);
  const val = await inventoryValuationAsOf(ctx, d('2027-12-31'));
  return { book, gl: val.items.find((r) => r.id === itemId)?.valueAsOf ?? '0.00' };
}

describe('kept-cost edits keep inventory tied to the ledger', { timeout: 120_000 }, () => {
  it('editing the sale that sold an item out (a cent remainder) neither throws nor leaves value behind', async () => {
    const itemId = await inventoryItem('Bulk');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}a`, date: d('2026-04-01'), lines: [{ itemId, quantity: 3000, unitCost: '0.333333' }] });
    const inv = await createInvoice(ctx, { customerId, date: d('2026-04-05'), lines: [{ itemId, quantity: 3000, rate: 1 }] });
    const sold = await cogsFor(`invoice-cogs:${inv.id}`);
    await updateInvoice(ctx, inv.id, { customerId, date: d('2026-04-05'), memo: 'edit', lines: [{ itemId, quantity: 3000, rate: 1 }] });
    expect(await cogsFor(`invoice-cogs:${inv.id}`)).toBe(sold);
    const t = await tiesOut(itemId);
    expect(t.gl).toBe('0.00');
    expect(t.book).toBe(t.gl);
  });

  it('a memo edit after the average moved keeps GL == valuation', async () => {
    const itemId = await inventoryItem('Moved');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}a`, date: d('2026-04-01'), lines: [{ itemId, quantity: 1000, unitCost: 1 }] });
    const inv = await createInvoice(ctx, { customerId, date: d('2026-04-05'), lines: [{ itemId, quantity: 10, rate: 3 }] });
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}b`, date: d('2026-04-10'), lines: [{ itemId, quantity: 100, unitCost: '1.37' }] });
    const before = await tiesOut(itemId);
    expect(before.book).toBe(before.gl);
    await updateInvoice(ctx, inv.id, { customerId, date: d('2026-04-05'), memo: 'edit', lines: [{ itemId, quantity: 10, rate: 3 }] });
    expect(await cogsFor(`invoice-cogs:${inv.id}`)).toBe('10.00');
    const after = await tiesOut(itemId);
    expect(after).toEqual(before);
  });
});

describe('a line with its own tax item keeps its rate on an edit', { timeout: 120_000 }, () => {
  it('re-saving keeps the 8% the line was charged after the rate went to 9%', async () => {
    const [rate] = await db.insert(taxRates).values({ companyId: ctx.companyId, name: 'Line 8%', rate: '0.080000' }).returning();
    const lines = [{ description: 'Taxed line', quantity: 1, rate: 100, taxable: true, taxRateId: rate.id }];
    const inv = await createInvoice(ctx, { customerId, date: d('2026-01-20'), lines });
    expect(inv.taxAmount).toBe('8.00');
    await db.update(taxRates).set({ rate: '0.090000' }).where(eq(taxRates.id, rate.id));
    const edited = await updateInvoice(ctx, inv.id, { customerId, date: d('2026-01-20'), memo: 'edit', lines });
    expect(edited.taxAmount).toBe('8.00');
  });
});

describe('a sales document keeps the tax rate it was charged at', { timeout: 120_000 }, () => {
  it('invoice and sales receipt edits keep 5% after the rate went to 10%', async () => {
    const [rate] = await db.insert(taxRates).values({ companyId: ctx.companyId, name: 'City 5%', rate: '0.050000' }).returning();
    const inv = await createInvoice(ctx, { customerId, date: d('2026-01-15'), taxRateId: rate.id, lines: [{ description: 'Goods', quantity: 1, rate: 100, taxable: true }] });
    const rc = await createSalesReceipt(ctx, { customerId, date: d('2026-01-15'), taxRateId: rate.id, lines: [{ description: 'Goods', quantity: 1, rate: 100, taxable: true }] });
    expect(inv.taxAmount).toBe('5.00');
    expect(rc.taxAmount).toBe('5.00');

    await db.update(taxRates).set({ rate: '0.100000' }).where(eq(taxRates.id, rate.id));

    const inv2 = await updateInvoice(ctx, inv.id, { customerId, date: d('2026-01-15'), taxRateId: rate.id, memo: 'edit', lines: [{ description: 'Goods', quantity: 1, rate: 100, taxable: true }] });
    expect(inv2.taxAmount).toBe('5.00');
    const rc2 = await updateSalesReceipt(ctx, rc.id, { customerId, date: d('2026-01-15'), taxRateId: rate.id, memo: 'edit', lines: [{ description: 'Goods', quantity: 1, rate: 100, taxable: true }] });
    expect(rc2.taxAmount).toBe('5.00');

    // A new document takes today's rate.
    const fresh = await createInvoice(ctx, { customerId, date: d('2026-06-15'), taxRateId: rate.id, lines: [{ description: 'Goods', quantity: 1, rate: 100, taxable: true }] });
    expect(fresh.taxAmount).toBe('10.00');
  });
});

describe('Sales Tax Codes list', () => {
  it('needs the sales-tax-codes right to add a code', async () => {
    const limited: ServiceContext = { ...ctx, access: unionRoles([role({ 'lists.other_lists': ['view', 'create', 'modify'] } as PermissionGrant)]) };
    await expect(createEntry(limited, 'sales-tax-codes', { code: 'ZRO', description: 'Zero rated', taxable: false })).rejects.toThrow();
  });
});

describe('inventory', { timeout: 120_000 }, () => {
  it('a FIFO return of a sold-out item restocks at the latest layer cost, not the stale purchase cost', async () => {
    const itemId = await inventoryItem('Fifo Part');
    await receiveStock(ctx, { itemId, quantity: 5, unitCost: 7, date: d('2026-02-01') });
    await createInvoice(ctx, { customerId, date: d('2026-02-05'), lines: [{ itemId, quantity: 5, rate: 15 }] });
    const memo = await createCreditMemo(ctx, { customerId, date: d('2026-02-08'), lines: [{ itemId, quantity: 1, rate: 15 }] });
    expect(await cogsFor(`creditmemo-cogs:${memo.id}`)).toBe('7.00'); // was the $1.00 purchase cost
    const [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect(it.quantityOnHand).toBe('1.0000');
    const val = await inventoryValuationAsOf(ctx, d('2026-12-31'));
    expect(val.items.find((r) => r.id === itemId)?.valueAsOf).toBe('7.00');
  });

  it('the valuation at a past date counts the units on hand then', async () => {
    const itemId = await inventoryItem('Dated');
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}a`, date: d('2026-01-10'), lines: [{ itemId, quantity: 10, unitCost: 8 }] });
    await createBill(ctx, { vendorId, billNumber: `R4-B${seq}b`, date: d('2026-02-10'), lines: [{ itemId, quantity: 10, unitCost: 20 }] });
    const jan = await inventoryValuationAsOf(ctx, d('2026-01-31'));
    const row = jan.items.find((r) => r.id === itemId)!;
    expect(row.valueAsOf).toBe('80.00');
    expect(row.quantityAsOf).toBe('10.0000'); // not $80 / today's $14 average
  });
});

describe('payroll', { timeout: 300_000 }, () => {
  it('a pay run refuses an hourly employee with no hours', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Hour', lastName: 'Less', payType: 'hourly', payRate: '20' });
    const run = await createPayRun(ctx, {
      payDate: d('2026-03-06'),
      periodStart: d('2026-03-01'),
      periodEnd: d('2026-03-07'),
      employees: [{ employeeId: emp.id }],
    }).catch((e: Error) => ({ results: [{ ok: false, error: e.message }] }));
    expect(run.results[0].ok).toBe(false);
    expect((run.results[0] as { error?: string }).error).toMatch(/hours worked/);
  });

  it("year-to-date wages for a check leave out the checks paid after it", async () => {
    const emp = await createEmployee(ctx, { firstName: 'Ytd', lastName: 'Order', payType: 'salary', payRate: '60000' });
    const march = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-03-31'), grossPay: '5000.00', periodsPerYear: 12 });
    await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-04-30'), grossPay: '5000.00', periodsPerYear: 12 });
    const ytd = await ytdWagesPaid(ctx, emp.id, d('2026-03-31'), march.id);
    expect(ytd.gross).toBe('0.00');
    const may = await ytdWagesPaid(ctx, emp.id, d('2026-05-31'));
    expect(may.gross).toBe('10000.00');
  });

  it('editing a paycheck keeps the bank account it was paid from', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Bank', lastName: 'Kept', payType: 'salary', payRate: '48000' });
    const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-05-15'), grossPay: '2000.00', periodsPerYear: 24 });
    const [row] = await db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    const all = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, row.postedEntryId!));
    const bankLine = lines.find((l) => Number(l.credit ?? 0) > 0 && all.find((a) => a.id === l.accountId)?.type === 'asset')!;
    // The paycheck bank preference changes AFTER the check was paid from Checking.
    const savings = all.find((a) => a.code === '1010')!;
    expect(savings.id).not.toBe(bankLine.accountId);
    await updateCompany(ctx, { settings: { defaultPaycheckAccountId: savings.id } });

    await editPaycheck(ctx, pc.id, { payDate: d('2026-05-15'), grossPay: '2100.00' });
    const [after] = await db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    const newLines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, after.postedEntryId!));
    // Still paid from the account the check was drawn on, not the new default.
    expect(newLines.some((l) => l.accountId === bankLine.accountId && Number(l.credit ?? 0) > 0)).toBe(true);
    expect(newLines.some((l) => l.accountId === savings.id)).toBe(false);
    await updateCompany(ctx, { settings: { defaultPaycheckAccountId: null } });
  });
});
