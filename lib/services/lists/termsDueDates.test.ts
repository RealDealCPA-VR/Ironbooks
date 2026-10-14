/**
 * B5 / C3: the Terms list (Standard and Date-Driven, including user-created entries) drives the
 * due date of invoices and bills saved without one, and the early-payment discount suggested in
 * Receive Payments / Pay Bills. Explicit due dates are kept. Hermetic PGlite company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createInvoice, getInvoice, updateInvoice } from '../invoices';
import { createBill, getBill, listBillsToPay } from '../bills';
import { suggestEarlyPaymentDiscounts } from '../payments';
import { createStatementCharge } from '../batchInvoicing';
import { createEntry } from './simpleLists';
import { dueDateFromTermsList } from './terms';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-terms-due-dates-b5');
let db: DB;
let ctx: ServiceContext;
let incomeId: string;
let expenseId: string;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date | string | null | undefined) => (x ? new Date(x).toISOString().slice(0, 10) : null);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'terms-b5@test.local', name: 'Terms', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Terms B5 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const [inc] = await db.select().from(accounts).where(and(eq(accounts.companyId, company.id), eq(accounts.type, 'revenue')));
  const [exp] = await db.select().from(accounts).where(and(eq(accounts.companyId, company.id), eq(accounts.type, 'expense')));
  incomeId = inc.id;
  expenseId = exp.id;
  await createEntry(ctx, 'terms', { name: 'Net 45', kind: 'standard', netDays: 45 });
  await createEntry(ctx, 'terms', { name: '15th of month', kind: 'date_driven', dueDayOfMonth: 15, dueNextMonthWithinDays: 5 });
  await createEntry(ctx, 'terms', { name: '3% 20 Net 60', kind: 'standard', netDays: 60, discountPercent: '3', discountDays: 20 });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const invoiceLines = () => [{ accountId: incomeId, description: 'Work', quantity: 1, rate: 1000, taxable: false }];
const billLines = () => [{ accountId: expenseId, amount: '500.00' }];

describe('B5: Terms list drives due dates', () => {
  it('resolves custom, date-driven and legacy free-text terms', async () => {
    expect(iso(await dueDateFromTermsList(ctx, 'Net 45', d('2026-03-10')))).toBe('2026-04-24');
    expect(iso(await dueDateFromTermsList(ctx, 'net 45', d('2026-03-10')))).toBe('2026-04-24'); // case-insensitive name
    // Date-driven: due the 15th; issued within 5 days of it (or after) → next month's 15th.
    expect(iso(await dueDateFromTermsList(ctx, '15th of month', d('2026-03-02')))).toBe('2026-03-15');
    expect(iso(await dueDateFromTermsList(ctx, '15th of month', d('2026-03-12')))).toBe('2026-04-15');
    expect(iso(await dueDateFromTermsList(ctx, '15th of month', d('2026-12-20')))).toBe('2027-01-15');
    // Not on the list: the legacy parser still understands it; nonsense → null.
    expect(iso(await dueDateFromTermsList(ctx, '2/10 n/90', d('2026-03-10')))).toBe('2026-06-08');
    expect(await dueDateFromTermsList(ctx, 'whenever', d('2026-03-10'))).toBeNull();
    expect(await dueDateFromTermsList(ctx, null, d('2026-03-10'))).toBeNull();
  });

  it('invoice with a custom Net 45 term and no due date → date + 45; terms stored', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Net45 Customer' });
    const inv = await createInvoice(ctx, { customerId: cust.id, date: d('2026-03-10'), terms: 'Net 45', lines: invoiceLines() });
    expect(iso(inv.dueDate)).toBe('2026-04-24');
    expect(inv.terms).toBe('Net 45');
    const got = await getInvoice(ctx, inv.id);
    expect(iso(got.dueDate)).toBe('2026-04-24');
  });

  it('invoice with a date-driven term computes the due date', async () => {
    const cust = await createCustomer(ctx, { displayName: 'DateDriven Customer' });
    const early = await createInvoice(ctx, { customerId: cust.id, date: d('2026-05-03'), terms: '15th of month', lines: invoiceLines() });
    expect(iso(early.dueDate)).toBe('2026-05-15');
    const late = await createInvoice(ctx, { customerId: cust.id, date: d('2026-05-11'), terms: '15th of month', lines: invoiceLines() });
    expect(iso(late.dueDate)).toBe('2026-06-15');
  });

  it('invoice: an explicit due date is respected; editing with terms only recomputes', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Explicit Customer' });
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-10'),
      dueDate: d('2026-03-20'),
      terms: 'Net 45',
      lines: invoiceLines(),
    });
    expect(iso(inv.dueDate)).toBe('2026-03-20');
    const upd = await updateInvoice(ctx, inv.id, { customerId: cust.id, date: d('2026-03-10'), terms: '15th of month', lines: invoiceLines() });
    expect(iso(upd.dueDate)).toBe('2026-03-15'); // exactly 5 days before the 15th: still this month
    expect(upd.terms).toBe('15th of month');
  });

  it('bill: vendor terms "Net 45" (custom list entry) → date + 45 with no due date given', async () => {
    const vendor = await createVendor(ctx, { displayName: 'Net45 Vendor', terms: 'Net 45' });
    const bill = await createBill(ctx, { vendorId: vendor.id, date: d('2026-03-10'), lines: billLines() });
    expect(iso(bill.dueDate)).toBe('2026-04-24');
    expect((await getBill(ctx, bill.id)).terms).toBe('Net 45');
  });

  it('bill: explicit date-driven terms compute; explicit due date wins', async () => {
    const vendor = await createVendor(ctx, { displayName: 'Plain Vendor' });
    const dd = await createBill(ctx, { vendorId: vendor.id, date: d('2026-03-12'), terms: '15th of month', lines: billLines() });
    expect(iso(dd.dueDate)).toBe('2026-04-15');
    const explicit = await createBill(ctx, {
      vendorId: vendor.id,
      date: d('2026-03-12'),
      dueDate: d('2026-03-31'),
      terms: 'Net 45',
      lines: billLines(),
    });
    expect(iso(explicit.dueDate)).toBe('2026-03-31');
  });

  it('statement charge with customer on a custom term gets its due date from the list', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Charge Customer', terms: 'Net 45' });
    const charge = await createStatementCharge(ctx, { customerId: cust.id, date: d('2026-03-10'), accountId: incomeId, rate: '25' });
    expect(iso(charge.dueDate)).toBe('2026-04-24');
  });
});

describe('C3: early-payment discount uses the Terms list first', () => {
  it('Receive Payments: a custom "3% 20 Net 60" term suggests 3% within 20 days', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Discount Customer' });
    const inv = await createInvoice(ctx, { customerId: cust.id, date: d('2026-03-01'), terms: '3% 20 Net 60', lines: invoiceLines() });
    expect(iso(inv.dueDate)).toBe('2026-04-30');
    const onTime = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust.id, paymentDate: d('2026-03-21'), invoiceIds: [inv.id] });
    expect(onTime[0]).toMatchObject({ eligible: true, suggested: '30.00', discountDate: '2026-03-21' });
    const late = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust.id, paymentDate: d('2026-03-22'), invoiceIds: [inv.id] });
    expect(late[0]).toMatchObject({ eligible: false, suggested: '0.00' });
  });

  it('Receive Payments: free-text terms not on the list still use the parser', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Legacy Discount Customer' });
    const inv = await createInvoice(ctx, { customerId: cust.id, date: d('2026-03-01'), terms: '1% 15 net 45', lines: invoiceLines() });
    const s = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust.id, paymentDate: d('2026-03-10'), invoiceIds: [inv.id] });
    expect(s[0]).toMatchObject({ eligible: true, suggested: '10.00', discountDate: '2026-03-16' });
  });

  it('Pay Bills: discount and due date from a custom list term', async () => {
    const vendor = await createVendor(ctx, { displayName: 'Discount Vendor', terms: '3% 20 Net 60' });
    const bill = await createBill(ctx, { vendorId: vendor.id, date: d('2026-03-01'), lines: billLines() });
    expect(iso(bill.dueDate)).toBe('2026-04-30');
    const rows = await listBillsToPay(ctx, { vendorId: vendor.id, asOf: d('2026-03-15') });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ discountPercent: 3, suggestedDiscount: '15.00', discountAvailable: true });
    expect(iso(rows[0].discountDate)).toBe('2026-03-21');
  });
});
