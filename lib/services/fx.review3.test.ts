/**
 * Review round 3 — multi-currency aggregates that summed foreign document amounts as home currency.
 *
 *  - 1099 report / worksheet: foreign bill payments (cash share x payment rate) and foreign checks
 *    are reported in home currency (a vendor was dropped under the $600 threshold).
 *  - Dashboard: overdue-invoice, A/P-due-soon and bills-due-this-week totals are home currency.
 *  - Income Tracker: the Paid bar counts foreign payments at home value; a fully open foreign
 *    invoice booked below rate 1 is 'open', not 'partial'.
 *  - Open Invoices report: the grand total is home currency.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createExpense } from './expenses';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { vendor1099Report, vendor1099Worksheet } from './statements';
import { getDashboardInsights } from './dashboard';
import { incomeTracker } from './incomeTracker';
import { openInvoices } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-fx');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

describe('review3 fx aggregates', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review3-fx@test.local', name: 'R3 FX', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R3 FX Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  async function eurVendor(name: string, is1099 = false) {
    const v = await createVendor(ctx, { displayName: `${name} ${seq}`, is1099, taxId: is1099 ? '12-3456789' : undefined } as never);
    await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, v.id));
    return v;
  }
  const eurBill = (vendorId: string, amount: string, date: string, dueDate?: string) =>
    createBill(ctx, { vendorId, date: d(date), ...(dueDate ? { dueDate: d(dueDate) } : {}), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6000'], amount }] } as never);
  const eurInvoice = (customerId: string, amount: string, date: string, rate = '1.20', dueDate?: string) =>
    createInvoice(ctx, { customerId, date: d(date), ...(dueDate ? { dueDate: d(dueDate) } : {}), currency: 'EUR', exchangeRate: rate, lines: [{ accountId: acct['4000'], quantity: 1, rate: amount }] } as never);

  it('1099 report / worksheet report foreign bill payments and checks in home currency', async () => {
    const v = await eurVendor('EUR contractor', true);
    // EUR 300 bill paid at 1.20 = USD 360 cash; EUR 250 check at 1.20 = USD 300. Total USD 660 (>= 600; 2025, before the $2,000 threshold of 2026).
    const bill = await eurBill(v.id, '300.00', '2025-02-01');
    await payBills(ctx, { vendorId: v.id, date: d('2025-02-10'), method: 'ach', paymentAccountId: acct['1020'], exchangeRate: '1.20', applications: [{ billId: bill.id, amountApplied: '300.00' }] });
    await createExpense(ctx, { vendorId: v.id, date: d('2025-03-01'), method: 'check', paymentAccountId: acct['1020'], currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6000'], amount: '250.00' }] });

    const row = (await vendor1099Report(ctx, { year: 2025 })).find((r) => r.vendorId === v.id);
    expect.soft(row?.total ?? 'omitted').toBe('660.00');
    const wr = (await vendor1099Worksheet(ctx, { year: 2025 })).rows.find((r) => r.vendorId === v.id);
    expect.soft(wr?.nec1 ?? 'omitted').toBe('660.00');
    expect.soft(wr?.necEligible).toBe(true);
  });

  it('1099s: a foreign payment with an early-payment discount reports cash share x payment rate', async () => {
    const v = await eurVendor('EUR discount contractor', true);
    const bill = await eurBill(v.id, '1000.00', '2025-02-01');
    // EUR 980 cash + EUR 20 discount at 1.20: USD 1,176 left the bank.
    await payBills(ctx, { vendorId: v.id, date: d('2025-02-10'), method: 'ach', paymentAccountId: acct['1020'], exchangeRate: '1.20', discountAccountId: acct['6000'], applications: [{ billId: bill.id, amountApplied: '980.00', discountTaken: '20.00' }] });
    const row = (await vendor1099Report(ctx, { year: 2025 })).find((r) => r.vendorId === v.id);
    expect.soft(row?.total ?? 'omitted').toBe('1176.00');
    const wr = (await vendor1099Worksheet(ctx, { year: 2025 })).rows.find((r) => r.vendorId === v.id);
    expect.soft(wr?.nec1 ?? 'omitted').toBe('1176.00');
  });

  it('dashboard overdue / due-soon / due-this-week totals are in home currency (tie to the A/R aging)', async () => {
    const c = await createCustomer(ctx, { displayName: `EUR customer ${seq}` } as never);
    await eurInvoice(c.id, '1000.00', '2026-01-01', '1.20', '2026-01-31');
    const v = await eurVendor('EUR supplier');
    await eurBill(v.id, '500.00', '2026-01-01', '2026-01-31');
    await eurBill(v.id, '100.00', '2026-02-20', '2026-03-03');

    const ins = await getDashboardInsights(ctx, d('2026-03-01'));
    expect.soft(ins.arAging.total).toBe('1200.00');
    expect.soft(ins.overdueInvoiceTotal).toBe('1200.00');
    expect.soft(ins.apDueSoon.total).toBe('720.00');
    expect.soft(ins.billsDueThisWeekTotal).toBe('120.00');
  });

  it('income tracker Paid bar counts a foreign payment at its home value', async () => {
    const c = await createCustomer(ctx, { displayName: `EUR payer ${seq}` } as never);
    const inv = await eurInvoice(c.id, '1000.00', '2026-03-01');
    await receivePayment(ctx, { customerId: c.id, date: d('2026-03-05'), amount: '1000.00', method: 'ach', depositAccountId: acct['1020'], currency: 'EUR', exchangeRate: '1.20', applications: [{ invoiceId: inv.id, amountApplied: '1000.00' }] } as never);
    const t = await incomeTracker(ctx, { asOf: d('2026-03-10') });
    expect.soft(t.totals.paid.amount).toBe('1200.00');
  });

  it('income tracker: an untouched foreign invoice booked below rate 1 is open, not partial', async () => {
    const c = await createCustomer(ctx, { displayName: `EUR open ${seq}` } as never);
    const inv = await eurInvoice(c.id, '1000.00', '2026-03-01', '0.80', '2026-04-30');
    const t = await incomeTracker(ctx, { asOf: d('2026-03-10') });
    const row = t.rows.find((r) => r.id === inv.id);
    expect.soft(row?.status).toBe('open');
    expect.soft(row?.openBalance).toBe('800.00');
  });

  it('open invoices report: grand total in home currency', async () => {
    const c = await createCustomer(ctx, { displayName: `EUR open inv ${seq}` } as never);
    const h = await createCustomer(ctx, { displayName: `Home open inv ${seq}` } as never);
    await eurInvoice(c.id, '1000.00', '2026-03-01');
    await createInvoice(ctx, { customerId: h.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00' }] } as never);
    const rep = await openInvoices(ctx);
    expect.soft(rep.totalOpen).toBe('1250.00');
  });
});
