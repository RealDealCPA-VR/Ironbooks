/**
 * Review round 5 — check reports (reportsExtra.ts): paychecks are checks.
 *
 * Print Checks numbers a paycheck in the bank account's check sequence (checkNumbers.ts counts
 * paychecks when it picks the next number), but Missing Checks and Check Detail read only Write
 * Checks, bill payments by check and sales tax / liability checks. So check 1002 printed for a
 * paycheck between checks 1001 and 1003 was reported as MISSING, and the paycheck never appeared
 * on Check Detail (QuickBooks lists Paycheck rows on both).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createExpense } from './expenses';
import { createEmployee, runPaycheck, voidPaycheck } from './payroll';
import { markPaycheckPrinted, queuePaychecks } from './printQueue';
import { checkDetail, missingChecks } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-reports-extra');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
let paycheckId = '';
let voidedPaycheckId = '';

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-extra@test.local', name: 'R5 Extra', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Checks Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;

  const check = (num: string, date: string, amount: string) =>
    createExpense(ctx, { payeeName: `Payee ${num}`, date: d(date), method: 'check', reference: num, paymentAccountId: A['1000'], lines: [{ accountId: A['6000'], amount }] } as never);
  const emp = await createEmployee(ctx, { firstName: 'Ann', lastName: 'Able', payType: 'salary', payRate: 52000 } as never);
  const paycheck = async (date: string, num: string) => {
    const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d(date), grossPay: '1000.00', taxes: [], employerTaxes: [] } as never);
    await queuePaychecks(ctx, [pc.id]);
    await markPaycheckPrinted(ctx, { paycheckId: pc.id, checkNumber: num });
    return pc.id;
  };

  await check('1001', '2026-07-01', '12.00');
  paycheckId = await paycheck('2026-07-02', '1002');
  await check('1003', '2026-07-03', '30.00');
  voidedPaycheckId = await paycheck('2026-07-04', '1004');
  await voidPaycheck(ctx, voidedPaycheckId);
  await check('1006', '2026-07-06', '8.00');
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('paychecks are checks on the check reports', () => {
  it('Missing Checks: a printed paycheck uses its number (a voided one too); only 1005 is missing', async () => {
    const r = await missingChecks(ctx);
    expect(r.accounts).toHaveLength(1);
    const row = r.accounts[0];
    expect(row.accountId).toBe(A['1000']);
    expect(row.firstNumber).toBe(1001);
    expect(row.lastNumber).toBe(1006);
    expect(row.missing).toEqual([{ from: 1005, to: 1005, count: 1 }]);
    expect(row.checkCount).toBe(5);
    // Filtered to the account the paychecks were drawn on.
    const one = await missingChecks(ctx, A['1000']);
    expect(one.accounts[0].missing).toEqual([{ from: 1005, to: 1005, count: 1 }]);
  });

  it('Check Detail lists the paychecks (net pay; the voided one marked void and left out of the total)', async () => {
    const r = await checkDetail(ctx, { from: d('2026-07-01'), to: d('2026-07-31') });
    const pcs = r.rows.filter((x) => x.source === 'paycheck');
    expect(pcs.map((x) => [x.checkNumber, x.amount, x.voided, x.payee])).toEqual([
      ['1002', '1000.00', false, 'Ann Able'],
      ['1004', '1000.00', true, 'Ann Able'],
    ]);
    expect(pcs[0].id).toBe(paycheckId);
    expect(pcs[0].bankAccountId).toBe(A['1000']);
    // The split lines add up to the check.
    const lineSum = pcs[0].lines.reduce((s, l) => s + Number(l.amount), 0);
    expect(lineSum.toFixed(2)).toBe('1000.00');
    // Total = the non-void checks: 12 + 1000 + 30 + 8.
    expect(r.total).toBe('1050.00');
  });

  it('Check Detail honours the date range for paychecks', async () => {
    const r = await checkDetail(ctx, { from: d('2026-07-03'), to: d('2026-07-31') });
    expect(r.rows.filter((x) => x.source === 'paycheck').map((x) => x.checkNumber)).toEqual(['1004']);
  });
});

/**
 * Check Detail and Deposit Detail totals are in home currency. A check or deposit on a foreign
 * bank account keeps its own currency on its row, but the TOTAL added those amounts to the
 * dollar ones as if they were dollars (EUR 100 + USD 50 = "150.00").
 */
describe('Check / Deposit Detail totals with a foreign-currency bank account', () => {
  let fctx: ServiceContext;
  const F: Record<string, string> = {};
  beforeAll(async () => {
    const { setBaseCurrency, upsertCurrency, setAccountCurrency } = await import('./currencies');
    const { createAccount } = await import('./accounts');
    const [user] = await db.insert(users).values({ email: 'r5-extra-fx@test.local', name: 'R5 FX', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'FX Checks Co', ownerId: user.id });
    fctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) F[a.code] = a.id;
    await setBaseCurrency(fctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(fctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    F.eur = (await createAccount(fctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(fctx, F.eur, 'EUR');
    await createExpense(fctx, { payeeName: 'Paris Supplier', date: d('2026-08-01'), method: 'check', reference: '501', paymentAccountId: F.eur, currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: F['6000'], amount: '100.00' }] } as never);
    await createExpense(fctx, { payeeName: 'Local Supplier', date: d('2026-08-02'), method: 'check', reference: '1001', paymentAccountId: F['1000'], lines: [{ accountId: F['6000'], amount: '50.00' }] } as never);
    const { createDeposit } = await import('./deposits');
    await createDeposit(fctx, { depositAccountId: F.eur, date: d('2026-08-03'), exchangeRate: '1.20', extraLines: [{ accountId: F['3000'], amount: '100.00' }] });
    await createDeposit(fctx, { depositAccountId: F['1000'], date: d('2026-08-04'), extraLines: [{ accountId: F['3000'], amount: '50.00' }] });
  });

  it('Check Detail: EUR 100 at 1.20 + USD 50 = 170.00', async () => {
    const r = await checkDetail(fctx, { from: d('2026-08-01'), to: d('2026-08-31') });
    expect(r.rows.map((x) => x.amount).sort()).toEqual(['100.00', '50.00']);
    expect(r.total).toBe('170.00');
  });

  it('Deposit Detail: EUR 100 at 1.20 + USD 50 = 170.00', async () => {
    const { depositDetail } = await import('./reportsExtra');
    const r = await depositDetail(fctx, { from: d('2026-08-01'), to: d('2026-08-31') });
    expect(r.rows.map((x) => x.total).sort()).toEqual(['100.00', '50.00']);
    expect(r.total).toBe('170.00');
  });
});

/**
 * GET /api/reports/collections (collectionsReport) added a foreign invoice's balance to the dollar
 * ones in the customer and grand totals (the Open Invoices API already converts its total).
 */
describe('legacy collections API: totals in home currency', () => {
  it('EUR 100 at 1.20 overdue + USD 50 overdue = 170.00', async () => {
    const { setBaseCurrency, upsertCurrency } = await import('./currencies');
    const { createCustomer } = await import('./customers');
    const { createInvoice } = await import('./invoices');
    const { collectionsReport } = await import('./reportsExtra');
    const [user] = await db.insert(users).values({ email: 'r5-coll-fx@test.local', name: 'R5 Coll', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'FX Collections Co', ownerId: user.id });
    const cctx: ServiceContext = { db, companyId: company.id, userId: user.id };
    const C: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) C[a.code] = a.id;
    await setBaseCurrency(cctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(cctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const eur = await createCustomer(cctx, { displayName: 'Paris Client' } as never);
    const usd = await createCustomer(cctx, { displayName: 'Local Client' } as never);
    await createInvoice(cctx, { customerId: eur.id, date: d('2026-01-01'), dueDate: d('2026-01-31'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: C['4000'], quantity: 1, rate: '100.00' }] } as never);
    await createInvoice(cctx, { customerId: usd.id, date: d('2026-01-01'), dueDate: d('2026-01-31'), lines: [{ accountId: C['4000'], quantity: 1, rate: '50.00' }] } as never);
    const r = await collectionsReport(cctx, d('2026-08-31'));
    expect(r.customers.find((c) => c.customerId === eur.id)?.totalDue).toBe('120.00');
    expect(r.totalDue).toBe('170.00');
  });
});
