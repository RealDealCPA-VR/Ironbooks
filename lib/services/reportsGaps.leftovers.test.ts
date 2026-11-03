/**
 * Report gaps round — review-round-5 leftovers owned by the reports area (failing tests first).
 *
 *  1. Cash-basis Profit & Loss by Job keeps a paid, job-costed bill line in its Customer:Job
 *     column (the synthetic cash-basis lines had lost the job: "No customer:job").
 *  2. Check Detail / Deposit Detail list bank-feed (imported statement) transactions, which every
 *     GL report already shows as Checks and Deposits.
 *  3. Expenses by Vendor Summary groups by payee exactly like the Detail (employees, other names
 *     and free-text payees were all lumped into "(no vendor)").
 *  4. Statement of Cash Flows: the Inventory and Net cash lines QuickZoom to exactly the accounts
 *     they add up (inventory accounts; bank + Undeposited Funds).
 *  5. Transaction types: reconciliation service charges / interest are Check / Deposit, assembly
 *     builds are Build Assembly, opening quantities Inventory Adjust, Home Currency Adjustments
 *     and sales tax adjustments General Journal (they all showed "Other").
 *  6. Home-currency customer statement after a bounced check that had taken an early-payment
 *     discount: the payment / discount split is kept (the full amount showed as payment).
 *  7. Purchases by Item / Vendor are in home currency (verify).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, users } from '@/lib/db/schema';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createExpense, updateExpense, voidExpense } from './expenses';
import { postJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';
import { splitByShares } from './reportEngine';
import { Money } from '@/lib/money';
import { checkDetail, depositDetail } from './reportsExtra';
import { categorize } from './bankCategorize';
import { createEmployee } from './payroll';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-leftovers');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const row = (r: StdReport, pred: (x: StdReport['rows'][number]) => boolean) => r.rows.find(pred);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'gaps-left@test.local', name: 'Gaps', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Gaps Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  S.vendor = (await createVendor(ctx, { displayName: 'Paper Supply' } as never)).id;
  S.job = (await createCustomer(ctx, { displayName: 'Kitchen Job' } as never)).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('1. cash-basis Profit & Loss by Job keeps the Customer:Job of a paid bill line', () => {
  it('a job-costed bill paid in full shows under its job on both bases (and QuickZooms to it)', async () => {
    const bill = await createBill(ctx, {
      vendorId: S.vendor,
      billNumber: 'B-1',
      date: d('2026-04-01'),
      lines: [{ accountId: A['6300'], amount: '70.00', customerId: S.job }],
    } as never);
    await payBills(ctx, {
      vendorId: S.vendor,
      date: d('2026-04-10'),
      method: 'check',
      paymentAccountId: A['1000'],
      applications: [{ billId: bill.id, amountApplied: '70.00' }],
    } as never);
    for (const basis of ['accrual', 'cash'] as const) {
      const r = await runStandardReport(ctx, 'profit-loss-by-job', { from: '2026-04-01', to: '2026-04-30', basis });
      const job = r.columns.find((c) => c.header === 'Kitchen Job');
      expect(job, `${basis}: ${JSON.stringify(r.columns.map((c) => c.header))}`).toBeTruthy();
      expect(r.columns.some((c) => c.header === 'No customer:job'), basis).toBe(false);
      const supplies = row(r, (x) => x.id.endsWith(`:a:${A['6300']}`))!;
      expect(supplies.cells[job!.key], basis).toBe('70.00');
      // The job cell's QuickZoom (Transaction Detail by Account with customerJobId) lists the line.
      const href = supplies.hrefs?.[job!.key];
      expect(href, basis).toBeTruthy();
      const q = Object.fromEntries(new URL(`http://x${href}`).searchParams);
      const detail = await runStandardReport(ctx, 'transaction-detail-by-account', q);
      const total = detail.rows.filter((x) => x.kind === 'data').reduce((s, x) => s + Number(x.cells.amount ?? 0), 0);
      expect(total.toFixed(2), basis).toBe('70.00');
    }
  });
});

describe('2. Check Detail / Deposit Detail include bank-feed transactions', () => {
  it('categorized feed lines are listed as checks and deposits, with their payee and split', async () => {
    const [ba] = await db
      .insert(bankAccounts)
      .values({ companyId: ctx.companyId, accountId: A['1000'], bankName: 'Feed Bank', accountNumber: '000123456789' })
      .returning();
    const line = async (amount: string, payee: string, date: string) =>
      (await db.insert(bankTransactions).values({ companyId: ctx.companyId, bankAccountId: ba.id, date: d(date), description: payee.toUpperCase(), payee, amount }).returning())[0];
    const out = await line('-30.00', 'Shell', '2026-07-05');
    const inn = await line('50.00', 'Refund Co', '2026-07-06');
    await categorize(ctx, { bankTransactionId: out.id, accountId: A['6000'] });
    await categorize(ctx, { bankTransactionId: inn.id, accountId: A['4000'] });

    const checks = await checkDetail(ctx, { from: d('2026-07-01'), to: d('2026-07-31') });
    expect(checks.rows.map((r) => [r.source, r.payee, r.amount, r.bankAccountId])).toEqual([['bank_transaction', 'Shell', '30.00', A['1000']]]);
    expect(checks.rows[0].lines).toEqual([{ description: null, detail: 'Advertising & Marketing', amount: '30.00' }]);
    expect(checks.total).toBe('30.00');

    const deps = await depositDetail(ctx, { from: d('2026-07-01'), to: d('2026-07-31') });
    expect(deps.rows.map((r) => [r.accountId, r.total])).toEqual([[A['1000'], '50.00']]);
    expect(deps.rows[0].lines).toEqual([{ description: null, customerName: 'Refund Co', amount: '50.00', accountName: 'Sales Income' }]);
    expect(deps.total).toBe('50.00');
  });
});

describe('3. Expenses by Vendor Summary groups by payee like the Detail', () => {
  it('employees, other names and free-text payees get their own rows; rows tie to the Detail groups', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Ann', lastName: 'Able', payType: 'hourly', payRate: 20 } as never);
    await createExpense(ctx, { payeeName: 'Corner Cafe', date: d('2026-08-03'), method: 'check', reference: '901', paymentAccountId: A['1000'], lines: [{ accountId: A['6000'], amount: '12.00' }] } as never);
    await createExpense(ctx, { vendorId: S.vendor, date: d('2026-08-04'), method: 'check', reference: '902', paymentAccountId: A['1000'], lines: [{ accountId: A['6300'], amount: '40.00' }] } as never);
    await postJournalEntry(ctx, {
      date: d('2026-08-05'),
      description: 'Mileage reimbursement',
      lines: [
        { accountId: A['6000'], debit: '9.00', entityType: 'employee', entityId: emp.id },
        { accountId: A['1000'], credit: '9.00' },
      ],
    });
    const params = { from: '2026-08-01', to: '2026-08-31' };
    const sum = await runStandardReport(ctx, 'expenses-by-vendor-summary', params);
    const amounts = Object.fromEntries(sum.rows.filter((x) => x.kind === 'data').map((x) => [x.cells.label, x.cells.amount]));
    expect(amounts).toEqual({ 'Paper Supply': '40.00', 'Corner Cafe': '12.00', 'Ann Able': '9.00' });
    const detail = await runStandardReport(ctx, 'expenses-by-vendor-detail', params);
    const subtotals = Object.fromEntries(
      detail.rows.filter((x) => x.kind === 'subtotal').map((x) => [String(x.cells.label).replace(/^Total /, ''), x.cells.amount]),
    );
    expect(subtotals).toEqual(amounts);
    // Each summary amount explains to exactly its own transactions.
    const { drilldownCell } = await import('./reportDrilldown');
    for (const r of sum.rows.filter((x) => x.kind === 'data')) {
      const x = await drilldownCell(ctx, 'expenses-by-vendor-summary', params, r.id, 'amount');
      expect(x.total, String(r.cells.label)).toBe(r.cells.amount);
      expect(x.ties).toBe(true);
    }
  });
});

describe('4. Statement of Cash Flows QuickZoom covers exactly the line', () => {
  it('Inventory zooms to the inventory accounts and Net cash to bank + Undeposited Funds', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-09-02'),
      description: 'stock bought',
      lines: [
        { accountId: A['1300'], debit: '100.00' },
        { accountId: A['1000'], credit: '100.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: d('2026-09-03'),
      description: 'deposit received',
      lines: [
        { accountId: A['1050'], debit: '25.00' },
        { accountId: A['1250'], credit: '25.00' },
      ],
    });
    const params = { from: '2026-09-01', to: '2026-09-30' };
    const r = await runStandardReport(ctx, 'statement-of-cash-flows', params);
    const run = async (id: string) => {
      const href = row(r, (x) => x.id === id)!.href!;
      const q = Object.fromEntries(new URL(`http://x${href}`).searchParams);
      const detail = await runStandardReport(ctx, 'transaction-detail-by-account', q);
      const accts = new Set(detail.rows.filter((x) => x.kind === 'data' && x.entryId).map((x) => String(x.cells.account ?? '')));
      const net = detail.rows.filter((x) => x.kind === 'data' && x.entryId).reduce((s, x) => s + Number(x.cells.amount ?? 0), 0);
      return { accts, net: net.toFixed(2) };
    };
    const inv = await run('scf:inv');
    expect([...inv.accts]).toEqual(['Inventory Asset']);
    expect(inv.net).toBe('100.00');
    expect(row(r, (x) => x.id === 'scf:inv')!.cells.total).toBe('-100.00');
    const cash = await run('scf:net');
    expect([...cash.accts].sort()).toEqual(['Checking', 'Undeposited Funds']);
    expect(cash.net).toBe(row(r, (x) => x.id === 'scf:net')!.cells.total);
  });
});

describe('5. transaction types of posting sources that showed "Other"', () => {
  it('reconciliation charges / interest, builds, opening stock, HCA and sales tax adjustments', async () => {
    const { startReconciliation, addStatementAdjustments } = await import('./reconcile');
    const [ba] = await db
      .insert(bankAccounts)
      .values({ companyId: ctx.companyId, accountId: A['1010'], bankName: 'Savings Bank', accountNumber: '000999888777' })
      .returning();
    const rec = await startReconciliation(ctx, { bankAccountId: ba.id, statementDate: '2026-10-31', statementBalance: '0' } as never);
    await addStatementAdjustments(ctx, rec.id, {
      serviceCharge: { amount: '4.00', accountId: A['6100'] },
      interestEarned: { amount: '1.50', accountId: A['4900'] },
    } as never);
    const je = (sourceRef: string, debit: string, credit: string, amount: string) =>
      postJournalEntry(ctx, { date: d('2026-10-15'), description: sourceRef, sourceRef, lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }] });
    await je('assembly_build:11111111-1111-4111-8111-111111111111:a:b', A['1300'], A['5000'], '7.00');
    await je('item_opening:22222222-2222-4222-8222-222222222222', A['1300'], A['3000'], '8.00');
    await postJournalEntry(ctx, {
      date: d('2026-10-15'),
      description: 'hca:revalue',
      sourceRef: 'hca:33333333-3333-4333-8333-333333333333',
      lines: [
        { accountId: A['1200'], debit: '3.00', entityType: 'customer', entityId: S.job },
        { accountId: A['4900'], credit: '3.00' },
      ],
    });
    await je('sales_tax_adj:44444444-4444-4444-8444-444444444444', A['2200'], A['4900'], '2.00');
    const detail = await runStandardReport(ctx, 'transaction-list-by-date', { from: '2026-10-01', to: '2026-10-31' });
    const byMemo = (needle: string) => detail.rows.find((x) => String(x.cells.memo ?? '').includes(needle))?.cells.type;
    expect(byMemo('Bank service charge')).toBe('Check');
    expect(byMemo('Interest earned')).toBe('Deposit');
    expect(byMemo('assembly_build')).toBe('Build Assembly');
    expect(byMemo('item_opening')).toBe('Inventory Adjust');
    expect(byMemo('hca:')).toBe('General Journal');
    expect(byMemo('sales_tax_adj')).toBe('General Journal');
    // The Check / Deposit type filters find the reconciliation charge and interest.
    const chk = await runStandardReport(ctx, 'transaction-list-by-date', { from: '2026-10-01', to: '2026-10-31', txnType: 'check' });
    expect(chk.rows.some((x) => String(x.cells.memo ?? '').includes('Bank service charge'))).toBe(true);
    const dep = await runStandardReport(ctx, 'transaction-list-by-date', { from: '2026-10-01', to: '2026-10-31', txnType: 'deposit' });
    expect(dep.rows.some((x) => String(x.cells.memo ?? '').includes('Interest earned'))).toBe(true);
    const other = await runStandardReport(ctx, 'transaction-list-by-date', { from: '2026-10-01', to: '2026-10-31', txnType: 'other' });
    expect(other.rows.filter((x) => x.kind === 'data' && x.entryId)).toEqual([]);
  });
});

describe('6. home-currency statement after a bounced check that took a discount', () => {
  it('keeps the payment and the discount apart (in home currency) and still ties to A/R', async () => {
    const { setBaseCurrency, upsertCurrency } = await import('./currencies');
    const { createInvoice } = await import('./invoices');
    const { receivePayment, recordBouncedCheck } = await import('./payments');
    const { customerStatement, customerArLedgerBalance } = await import('./statements');
    const [user] = await db.insert(users).values({ email: 'gaps-fx@test.local', name: 'FX', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Gaps FX Co', ownerId: user.id });
    const fctx: ServiceContext = { db, companyId: company.id, userId: user.id };
    const F: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) F[a.code] = a.id;
    await setBaseCurrency(fctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(fctx, { code: 'EUR', name: 'Euro', rateToBase: '1.25' });
    const cust = (await createCustomer(fctx, { displayName: 'Euro GmbH' } as never)).id;
    // One EUR invoice makes this a foreign-currency customer (statement in home currency).
    await createInvoice(fctx, {
      customerId: cust,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.25',
      taxRateId: null,
      lines: [{ description: 'EUR work', quantity: 1, rate: 100, accountId: F['4000'] }],
    } as never);
    // A dollar invoice paid early with a 2.00 discount, by a check that then bounced (bounced
    // checks are recorded for home-currency payments only).
    const inv = await createInvoice(fctx, {
      customerId: cust,
      date: d('2026-03-02'),
      taxRateId: null,
      lines: [{ description: 'USD work', quantity: 1, rate: 100, accountId: F['4000'] }],
    } as never);
    const { payment } = await receivePayment(fctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      reference: '77',
      amount: '98.00',
      depositAccountId: F['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '98.00', discountAmount: '2.00' }],
    } as never);
    await recordBouncedCheck(fctx, { paymentId: payment.id, date: d('2026-03-12') });
    const st = await customerStatement(fctx, cust, {});
    expect(st.homeCurrency).toBe(true);
    const of = (t: string) => st.lines.filter((l) => l.type === t).map((l) => l.amount);
    expect(of('invoice')).toEqual(['125.00', '100.00']);
    expect(of('payment')).toEqual(['98.00']);
    expect(of('discount')).toEqual(['2.00']);
    expect(of('bounced_check')).toEqual(['100.00']);
    const gl = await customerArLedgerBalance(fctx, cust);
    expect(gl).toBe('225.00');
    expect(st.closingBalance).toBe(gl);
  });
});

describe('7. Purchases by Item / Vendor in home currency', () => {
  it('a EUR bill line counts at its home value', async () => {
    const { setBaseCurrency, upsertCurrency } = await import('./currencies');
    const { createItem } = await import('./items');
    const { vendors } = await import('@/lib/db/schema');
    const [user] = await db.insert(users).values({ email: 'gaps-pfx@test.local', name: 'PFX', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Gaps Purchases FX', ownerId: user.id });
    const pctx: ServiceContext = { db, companyId: company.id, userId: user.id };
    const P: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) P[a.code] = a.id;
    await setBaseCurrency(pctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(pctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const v = (await createVendor(pctx, { displayName: 'Paris Parts' } as never)).id;
    await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, v));
    const part = (await createItem(pctx, { name: 'Gear', type: 'non_inventory', purchaseCost: 10, expenseAccountId: P['6300'] } as never)).id;
    await createBill(pctx, { vendorId: v, billNumber: 'P-1', date: d('2026-02-02'), currency: 'EUR', exchangeRate: '1.20', lines: [{ itemId: part, quantity: 1, unitCost: 100 }] } as never);
    const params = { from: '2026-02-01', to: '2026-02-28' };
    const byItem = await runStandardReport(pctx, 'purchases-by-item-summary', params);
    expect(byItem.rows.find((x) => x.cells.label === 'Gear')?.cells.amount).toBe('120.00');
    const byVendor = await runStandardReport(pctx, 'purchases-by-vendor-summary', params);
    expect(byVendor.rows.find((x) => x.cells.label === 'Paris Parts')?.cells.amount).toBe('120.00');
    const detail = await runStandardReport(pctx, 'purchases-by-item-detail', params);
    expect(detail.rows.find((x) => x.kind === 'data' && x.cells.num === 'P-1')?.cells.amount).toBe('120.00');
  });
});

describe('cash-basis job split: the largest share takes the rounding cents (post-merge review)', () => {
  it('splits by share, the pieces add up exactly, and only the largest share absorbs the remainder', () => {
    const parts = (amount: string, shares: string[]) => splitByShares(Money.of(amount), shares.map((x) => Money.of(x))).map((d) => d.toFixed(2));
    // 0.05 by 40 / 30 / 30: 0.02 + 0.015→0.02 + 0.015→0.02 = 0.06; the largest share gives the cent back.
    expect(parts('0.05', ['40', '30', '30'])).toEqual(['0.01', '0.02', '0.02']);
    expect(parts('10.00', ['1', '1', '1'])).toEqual(['3.34', '3.33', '3.33']);
    expect(parts('-10.00', ['2', '1'])).toEqual(['-6.67', '-3.33']);
    for (const [a, sh] of [['99.99', ['7', '3', '1']], ['0.01', ['5', '5']], ['1234.57', ['13', '29', '58']]] as const) {
      const p = splitByShares(Money.of(a), sh.map((x) => Money.of(x)));
      expect(p.reduce((s2, x) => s2.plus(x), Money.zero()).toFixed(2)).toBe(Money.of(a).toFixed(2));
    }
  });
});

describe('Balance Sheet: the Retained Earnings account row QuickZooms to what it adds up (post-merge review)', () => {
  it('with earlier years folded in, the row opens the prior years’ Profit & Loss, which ties', async () => {
    await postJournalEntry(ctx, {
      date: d('2025-05-15'),
      description: 'Prior-year sale',
      lines: [
        { accountId: A['1000'], debit: '300.00' },
        { accountId: A['4000'], credit: '300.00' },
      ],
    });
    const bs = await runStandardReport(ctx, 'balance-sheet', { asOf: '2026-12-31' });
    const re = row(bs, (x) => x.id.endsWith(`:a:${A['3900']}`) || x.id.endsWith(A['3900']))!;
    expect(re, JSON.stringify(bs.rows.map((x) => [x.id, x.cells.label]))).toBeTruthy();
    const amountKey = bs.columns.find((c) => c.type === 'money')!.key;
    expect(re.cells[amountKey]).toBe('300.00');
    expect(re.href).toBeTruthy();
    const url = new URL(`http://x${re.href}`);
    expect(url.pathname.endsWith('/profit-loss')).toBe(true);
    const q = Object.fromEntries(url.searchParams);
    expect(q.to).toBe('2025-12-31');
    const pl = await runStandardReport(ctx, 'profit-loss', q);
    const net = pl.rows.find((x) => x.kind === 'grand')!;
    expect(net.cells[pl.columns.find((c) => c.type === 'money')!.key]).toBe('300.00');
  });
});

describe('Closing Date Exception Report on the standard viewer (post-merge review: grouped layout)', () => {
  it('one heading per changed transaction, its Latest values, then each Prior version; a void has no Latest', async () => {
    const over = { ...ctx, closingDateOverride: true };
    const check = { vendorId: S.vendor, date: d('2026-01-10'), method: 'check', reference: '501', paymentAccountId: A['1000'] };
    const edited = await createExpense(ctx, { ...check, lines: [{ accountId: A['6000'], amount: '100.00', description: 'Paper' }] } as never);
    const voided = await createExpense(ctx, { ...check, date: d('2026-01-20'), reference: '502', lines: [{ accountId: A['6000'], amount: '33.00', description: 'Toner' }] } as never);
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    try {
      await updateExpense(over, edited.id, { ...check, lines: [{ accountId: A['6000'], amount: '125.00', description: 'Paper' }] } as never);
      await voidExpense(over, voided.id);
      const r = await runStandardReport(ctx, 'closing-date-exceptions', {});
      expect(r.subtitle).toBe('Closing date 01/31/2026');
      expect(new Set(r.rows.map((x) => x.id)).size).toBe(r.rows.length);
      const headings = r.rows.filter((x) => x.kind === 'section');
      const editedHead = headings.find((h) => String(h.cells.state).includes('dated 01/10/2026'))!;
      expect(String(editedHead.cells.state)).toMatch(/^Check.*dated 01\/10\/2026: .*with password.* \(closed through 01\/31\/2026\)$/);
      const editedRows = r.rows.filter((x) => x.parentId === editedHead.id);
      const debitOf = (state: string) => editedRows.filter((x) => x.cells.state === state).map((x) => x.cells.debit).filter(Boolean);
      expect(debitOf('Latest')).toEqual(['125.00']);
      expect(debitOf('Prior')).toEqual(['100.00']);
      // The Latest rows come before the Prior ones, and the first line of a version says who and when.
      const states = editedRows.map((x) => x.cells.state);
      expect(states.indexOf('Prior')).toBeGreaterThan(states.lastIndexOf('Latest'));
      expect(editedRows.find((x) => x.cells.state === 'Latest')!.cells.changed).not.toBe('');

      const voidHead = headings.find((h) => String(h.cells.state).includes('dated 01/20/2026'))!;
      const voidRows = r.rows.filter((x) => x.parentId === voidHead.id);
      expect(voidRows[0].id).toBe(`${voidHead.id}:void-now`);
      expect(voidRows[0].cells.memo).toMatch(/Void now/);
      expect(voidRows.filter((x) => x.cells.state === 'Prior').map((x) => x.cells.debit).filter(Boolean)).toEqual(['33.00']);
      expect(voidRows.some((x) => x.cells.state === 'Latest' && x.cells.debit)).toBe(false);
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
  });
});
