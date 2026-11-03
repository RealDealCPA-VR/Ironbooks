/**
 * Feature round (accountant) — I13 Client Data Review: a real Clear Up Undeposited Funds
 * matcher (with its fix), 1099 account mapping, unapplied bill payments / checks to A/P, employee
 * defaults and closing date tasks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, journalEntryLines } from '@/lib/db/schema';
import { setClosingDate } from '../company';
import { createCustomer } from '../customers';
import { createVendor, updateVendor } from '../vendors';
import { createInvoice } from '../invoices';
import { receivePayment } from '../payments';
import { createDeposit, getDeposit, listUndepositedPayments } from '../deposits';
import { createExpense } from '../expenses';
import { createEmployee } from '../payroll';
import { set1099Mapping } from '../statements';
import { trialBalance } from '../reports';
import { clientDataReview, takeReviewSnapshot } from './clientDataReview';
import { clearUpUndepositedFunds } from './clientDataReviewTasks';
import { makeTestCompany, type TestCompany } from '../testkit.prefs';

let t: TestCompany;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const task = async (key: string) => (await clientDataReview(t.ctx, { undepositedOlderThanDays: 3650 })).tasks.find((x) => x.key === key)!;

describe('I13 Client Data Review tasks', () => {
  let customerId: string;
  beforeAll(async () => {
    t = await makeTestCompany('i13cdr');
    customerId = (await createCustomer(t.ctx, { displayName: 'Corner Cafe' })).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('Clear Up Undeposited Funds: finds a payment whose money a deposit recorded straight to income, and fixes it', async () => {
    const inv = await createInvoice(t.ctx, { customerId, date: d('2026-03-01'), lines: [{ description: 'Catering', quantity: 1, rate: '250.00' }] });
    const pay = await receivePayment(t.ctx, { customerId, date: d('2026-03-02'), method: 'check', amount: '250.00', applications: [{ invoiceId: inv.id, amountApplied: '250.00' }] });
    // The bookkeeper deposited the check by typing it straight to Sales: income counted twice.
    const dep = await createDeposit(t.ctx, {
      depositAccountId: t.acct['1000'],
      date: d('2026-03-04'),
      extraLines: [{ accountId: t.acct['4000'], amount: '250.00', description: 'Corner Cafe check' }],
    });
    const uf = await task('undeposited_funds');
    const issue = uf.issues.find((i) => i.fix?.kind === 'clear_undeposited');
    expect(issue).toBeDefined();
    expect(issue!.amount).toBe('250.00');
    const fix = issue!.fix as { kind: 'clear_undeposited'; depositId: string; lineId: string; items: Array<{ kind: 'payment'; id: string }> };
    expect(fix.depositId).toBe(dep.id);
    expect(fix.items).toEqual([{ kind: 'payment', id: pay.payment.id }]);

    const income = async () => (await t.db.select().from(accounts).where(eq(accounts.id, t.acct['4000'])))[0].balance;
    expect(await income()).toBe('500.00');
    await clearUpUndepositedFunds(t.ctx, fix);
    expect(await income()).toBe('250.00');
    expect((await listUndepositedPayments(t.ctx)).some((p) => p.id === pay.payment.id)).toBe(false);
    const after = await getDeposit(t.ctx, dep.id);
    expect(after.total).toBe('250.00');
    expect(after.lines.some((l) => l.paymentId === pay.payment.id)).toBe(true);
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
    expect((await task('undeposited_funds')).issues.some((i) => i.fix?.kind === 'clear_undeposited')).toBe(false);
  });

  it('matches a day of payments deposited as one direct line', async () => {
    const a = await createInvoice(t.ctx, { customerId, date: d('2026-04-01'), lines: [{ description: 'A', quantity: 1, rate: '100.00' }] });
    const b = await createInvoice(t.ctx, { customerId, date: d('2026-04-01'), lines: [{ description: 'B', quantity: 1, rate: '50.00' }] });
    await receivePayment(t.ctx, { customerId, date: d('2026-04-05'), method: 'cash', amount: '100.00', applications: [{ invoiceId: a.id, amountApplied: '100.00' }] });
    await receivePayment(t.ctx, { customerId, date: d('2026-04-05'), method: 'cash', amount: '50.00', applications: [{ invoiceId: b.id, amountApplied: '50.00' }] });
    await createDeposit(t.ctx, { depositAccountId: t.acct['1000'], date: d('2026-04-06'), extraLines: [{ accountId: t.acct['4000'], amount: '150.00' }] });
    const issue = (await task('undeposited_funds')).issues.find((i) => i.fix?.kind === 'clear_undeposited');
    expect(issue).toBeDefined();
    expect((issue!.fix as { items: unknown[] }).items).toHaveLength(2);
    // A wrong total is refused.
    const fix = issue!.fix as { depositId: string; lineId: string; items: Array<{ kind: 'payment'; id: string }> };
    await expect(clearUpUndepositedFunds(t.ctx, { ...fix, items: fix.items.slice(0, 1) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await clearUpUndepositedFunds(t.ctx, fix);
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('Clear up keeps the Received From name on the deposit\'s other lines (review P1)', async () => {
    const owner = (await createCustomer(t.ctx, { displayName: 'Owner Person' })).id;
    const inv = await createInvoice(t.ctx, { customerId, date: d('2026-06-01'), lines: [{ description: 'Lunch', quantity: 1, rate: '275.00' }] });
    await receivePayment(t.ctx, { customerId, date: d('2026-06-02'), method: 'check', amount: '275.00', applications: [{ invoiceId: inv.id, amountApplied: '275.00' }] });
    const dep = await createDeposit(t.ctx, {
      depositAccountId: t.acct['1000'],
      date: d('2026-06-03'),
      extraLines: [
        { accountId: t.acct['4000'], amount: '275.00', description: 'Corner Cafe check' },
        { accountId: t.acct['3000'], amount: '100.00', description: 'Owner money', entityType: 'customer', entityId: owner },
      ],
    });
    const issue = (await task('undeposited_funds')).issues.find((i) => i.fix?.kind === 'clear_undeposited' && (i.fix as { depositId: string }).depositId === dep.id);
    expect(issue).toBeDefined();
    await clearUpUndepositedFunds(t.ctx, issue!.fix as never);
    const after = await getDeposit(t.ctx, dep.id);
    const kept = after.lines.find((l) => l.description === 'Owner money');
    expect(kept).toMatchObject({ entityType: 'customer', entityId: owner });
    // The journal line keeps its Name too.
    const jl = await t.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, after.postedEntryId!));
    expect(jl.some((l) => l.memo === 'Owner money' && l.entityType === 'customer' && l.entityId === owner)).toBe(true);
  });

  it('a line received from another customer is not offered as the duplicate of a payment (review P2)', async () => {
    const other = (await createCustomer(t.ctx, { displayName: 'Walk-up Buyer' })).id;
    const inv = await createInvoice(t.ctx, { customerId, date: d('2026-07-01'), lines: [{ description: 'Box', quantity: 1, rate: '61.00' }] });
    await receivePayment(t.ctx, { customerId, date: d('2026-07-02'), method: 'cash', amount: '61.00', applications: [{ invoiceId: inv.id, amountApplied: '61.00' }] });
    const dep = await createDeposit(t.ctx, {
      depositAccountId: t.acct['1000'],
      date: d('2026-07-03'),
      extraLines: [{ accountId: t.acct['4000'], amount: '61.00', description: 'Cash sale', entityType: 'customer', entityId: other }],
    });
    const issues = (await task('undeposited_funds')).issues;
    expect(issues.some((i) => i.fix?.kind === 'clear_undeposited' && (i.fix as { depositId: string }).depositId === dep.id)).toBe(false);
  });

  it('1099: vendors without a tax ID, no mapping, then accounts not mapped to a box', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Jo Contractor', is1099: true } as never);
    await createExpense(t.ctx, { vendorId: v.id, date: d('2026-05-01'), method: 'check', paymentAccountId: t.acct['1000'], lines: [{ accountId: t.acct['6600'], amount: '800.00' }] });
    let issues = (await task('vendor_1099')).issues;
    expect(issues.some((i) => i.id === `1099_taxid:${v.id}`)).toBe(true);
    expect(issues.some((i) => i.id === '1099_mapping:none')).toBe(true);
    await updateVendor(t.ctx, v.id, { taxId: '12-3456789' } as never);
    await set1099Mapping(t.ctx, { boxes: [{ box: 'nec_1', accountIds: [t.acct['6400']] }] });
    issues = (await task('vendor_1099')).issues;
    expect(issues.some((i) => i.id.startsWith('1099_taxid:'))).toBe(false);
    const unmapped = issues.find((i) => i.id === `1099_unmapped:${t.acct['6600']}`);
    expect(unmapped?.amount).toBe('800.00');
  });

  it('unapplied bill payments: a check written to Accounts Payable is its own task', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Paper Supply' });
    await createExpense(t.ctx, { vendorId: v.id, date: d('2026-05-02'), method: 'check', paymentAccountId: t.acct['1000'], lines: [{ accountId: t.acct['2000'], amount: '75.00' }] });
    const paymentsTask = await task('unapplied_bill_payments');
    expect(paymentsTask.issues.some((i) => /Paper Supply: check of 2026-05-02 paid 75.00/.test(i.title))).toBe(true);
    const creditsTask = await task('unapplied_vendor_credits');
    expect(creditsTask.issues.some((i) => /Paper Supply/.test(i.title))).toBe(false);
  });

  it('employee defaults: what payroll and W-2s still need', async () => {
    const e = await createEmployee(t.ctx, { firstName: 'Sam', lastName: 'Ng', payType: 'hourly', payRate: '0' } as never);
    const issue = (await task('employee_defaults')).issues.find((i) => i.id === `employee:${e.id}`);
    expect(issue?.title).toMatch(/pay rate/);
    expect(issue?.title).toMatch(/Social Security number/);
    expect(issue?.title).toMatch(/address/);
  });

  it('payroll and vendor tasks are empty for a member without Payroll / Vendors view (review P2)', async () => {
    const accountingOnly = { ...t.ctx, access: { permissions: { accounting: ['view'] } } } as never;
    const tasks = (await clientDataReview(accountingOnly, { undepositedOlderThanDays: 3650 })).tasks;
    for (const key of ['employee_defaults', 'payroll_liabilities', 'vendor_1099', 'unapplied_bill_payments']) {
      expect(tasks.find((x) => x.key === key)!.issues).toEqual([]);
    }
    // The owner still sees them.
    expect((await task('employee_defaults')).issues.length).toBeGreaterThan(0);
  });

  it('closing date: none set, behind the reviewed period, no password', async () => {
    let issues = (await task('closing_date')).issues;
    expect(issues.some((i) => i.id === 'closing:none')).toBe(true);
    await takeReviewSnapshot(t.ctx, { asOf: '2026-03-31' });
    await setClosingDate(t.ctx, { closingDate: '2026-02-28' });
    issues = (await task('closing_date')).issues;
    const behind = issues.find((i) => i.id === 'closing:behind');
    expect(behind?.fix).toEqual({ kind: 'set_closing_date', suggested: '2026-03-31' });
    expect(issues.some((i) => i.id === 'closing:no_password')).toBe(true);
    await setClosingDate(t.ctx, { closingDate: '2026-03-31', password: 'pw' });
    issues = (await task('closing_date')).issues;
    expect(issues.filter((i) => i.id.startsWith('closing:') && i.id !== 'closing:exceptions')).toHaveLength(0);
  });
});
