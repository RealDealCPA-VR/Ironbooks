/**
 * Review round 4: double-submit races (two identical requests in flight at once) in services
 * not covered by round 3 — reads / "already done" checks now run inside the transaction.
 * Each test asserts the correct outcome and failed before its fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  invoices,
  items,
  accounts,
  journalEntries,
  journalEntryLines,
  reconciliationItems,
  paymentChecks,
  bankTransactions,
  paychecks,
  reconciliations,
  estimates,
  accountantCopies,
  bankAccounts as bankAccountsTable,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import { createInvoice } from './invoices';
import { assessFinanceCharges } from './financeCharges';
import { yearEndClose } from './fiscalClose';
import { physicalCount, adjustInventoryValue } from './inventoryOps';
import { adjustInventory } from './inventory';
import { createItem } from './items';
import { setBom, buildAssembly, unbuildAssembly, createPendingBuild, finalizePendingBuild } from './assemblies';
import { createVendorCredit, voidVendorCredit } from './vendorCredits';
import { createExpense, voidExpense } from './expenses';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { condensePeriod } from './condense';
import { closePeriod } from './fiscalPeriods';
import { createEmployee, createPayRun } from './payroll';
import { createTimeEntry } from './timeTracking';
import { createBankAccount } from './bankAccounts';
import { startReconciliation, toggleCleared, getProgress, completeReconciliation, cancelReconciliation } from './reconcile';
import { createLoan, setUpLoanPayment } from './loans';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { queueCustomerRefundCheck } from './liabilityPayments';
import { matchTransaction } from './bankCategorize';
import { markPrinted } from './printQueue';
import { createCustomer } from './customers';
import { createEstimate, updateEstimateStatus, convertToInvoice as convertEstimate } from './estimates';
import { MONTH_END_STEP_KEYS, updateMonthEndStep, closeMonth } from './monthEndClose';
import { getClosingDateSettings } from './company';
import { createAccountantCopy } from './accountantCopy/client';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-races');
const TEST_DIR = path.join(TEST_ROOT, 'data');
const D = (s: string) => new Date(s + 'T12:00:00Z');
let db: DB;
let prevDataDir: string | undefined;

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1010', 'Recon Bank A', 'asset', 'checking'],
  ['1020', 'Recon Bank B', 'asset', 'checking'],
  ['1030', 'Feed Bank', 'asset', 'checking'],
  ['1040', 'Recon Bank C', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['1300', 'Inventory Asset', 'asset', 'inventory'],
  ['1301', 'Inv Count', 'asset', 'inventory'],
  ['1302', 'Inv Value', 'asset', 'inventory'],
  ['1303', 'Inv Comp', 'asset', 'inventory'],
  ['1304', 'Inv Assy', 'asset', 'inventory'],
  ['1305', 'Inv Comp2', 'asset', 'inventory'],
  ['1306', 'Inv Assy2', 'asset', 'inventory'],
  ['1307', 'Inv VC', 'asset', 'inventory'],
  ['1308', 'Inv Exp', 'asset', 'inventory'],
  ['1309', 'Inv IR', 'asset', 'inventory'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
  ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
  ['2600', 'Note Payable', 'liability', 'long_term_liability'],
  ['3000', 'Equity', 'equity', 'owners_equity'],
  ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
  ['4000', 'Sales', 'revenue', 'sales'],
  ['4400', 'Finance Charge Income', 'revenue', 'other_income'],
  ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
  ['5950', 'Inventory Adjustments', 'expense', 'cost_of_goods_sold'],
  ['6000', 'Supplies', 'expense', 'operating_expenses'],
  ['6500', 'Payroll Expense', 'expense', 'payroll'],
  ['6510', 'Payroll Tax Expense', 'expense', 'payroll'],
  ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
];

async function newCompany(tag: string) {
  const [user] = await db.insert(users).values({ email: `${tag}@r4races.local`, name: tag, passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: `R4 ${tag}`, ownerId: user.id }).returning();
  const c: ServiceContext = { db, companyId: company.id, userId: user.id };
  const a: Record<string, string> = {};
  for (const [code, name, type, subtype] of DEFS) {
    a[code] = (await createAccount(c, { code, name, type: type as never, subtype })).id;
  }
  return { ctx: c, acct: a };
}

let ctx: ServiceContext;
let acct: Record<string, string>;
let customerId: string;
let vendorId: string;

/** Ledger balance (posted debits - credits) of an account. */
async function gl(c: ServiceContext, accountId: string): Promise<number> {
  const rows = await db
    .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, c.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.debit ?? 0) * 100) - Math.round(Number(r.credit ?? 0) * 100), 0);
  return cents / 100;
}

async function itemState(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  const qty = Number(row.quantityOnHand ?? 0);
  const value = Math.round(qty * Number(row.averageCost ?? 0) * 100) / 100;
  return { qty, value };
}

async function stockedItem(name: string, assetCode: string, qty: string, cost: string) {
  const it = await createItem(ctx, { name, type: 'inventory', assetAccountId: acct[assetCode], incomeAccountId: acct['4000'] });
  if (Number(qty) > 0) {
    await adjustInventory(ctx, { itemId: it.id, quantityChange: qty, unitCost: cost, date: D('2026-02-01') });
  }
  return it.id;
}

const fulfilled = (res: PromiseSettledResult<unknown>[]) => res.filter((r) => r.status === 'fulfilled').length;
const reasons = (res: PromiseSettledResult<unknown>[]) =>
  res.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String((r.reason as Error)?.message ?? r.reason));

describe('review4 races', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    prevDataDir = process.env.BKA_DATA_DIR;
    // yearEndClose writes a pre-op backup of the "active" data dir: keep it inside TEST_ROOT.
    process.env.BKA_DATA_DIR = TEST_DIR;
    db = await getDb(TEST_DIR);
    ({ ctx, acct } = await newCompany('main'));
    const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'C1', taxable: false }).returning();
    customerId = c.id;
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V1' }).returning();
    vendorId = v.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    if (prevDataDir === undefined) delete process.env.BKA_DATA_DIR;
    else process.env.BKA_DATA_DIR = prevDataDir;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('finance charges: two concurrent assessments create only one finance-charge invoice per period', async () => {
    const [fc] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'FC Cust', taxable: false }).returning();
    await createInvoice(ctx, { customerId: fc.id, date: D('2026-01-01'), dueDate: D('2026-01-31'), lines: [{ quantity: 1, rate: '1000.00' }] });
    const args = { asOf: D('2026-06-30'), customerIds: [fc.id] };
    await Promise.allSettled([assessFinanceCharges(ctx, args), assessFinanceCharges(ctx, args)]);
    const rows = await db
      .select({ id: invoices.id, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, fc.id), like(invoices.memo, '%[FC:2026-06]%')));
    expect(rows.filter((r) => r.status !== 'void')).toHaveLength(1);
  });

  it('year-end close: two concurrent closes of the same year post only one closing entry', async () => {
    const { ctx: c, acct: a } = await newCompany('yec');
    await postJournalEntry(c, { date: D('2025-06-01'), description: 'Sale', lines: [{ accountId: a['1000'], debit: '100.00' }, { accountId: a['4000'], credit: '100.00' }] });
    await postJournalEntry(c, { date: D('2025-06-02'), description: 'Supplies', lines: [{ accountId: a['6000'], debit: '40.00' }, { accountId: a['1000'], credit: '40.00' }] });
    await Promise.allSettled([yearEndClose(c, { fiscalYear: 2025 }), yearEndClose(c, { fiscalYear: 2025 })]);
    const closes = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, c.companyId), eq(journalEntries.sourceRef, 'fiscal-close:2025'), eq(journalEntries.status, 'posted')));
    expect(closes).toHaveLength(1);
    expect(await gl(c, a['4000'])).toBe(0); // revenue zeroed once, not driven to +100 (debit)
    expect(await gl(c, a['3900'])).toBe(-60);
  });

  it('physical count: a double-submitted count posts the shrinkage once (GL ties to the item)', async () => {
    const id = await stockedItem('Count Widget', '1301', '10', '5');
    const args = { itemId: id, countedQty: '8', date: D('2026-03-01') };
    await Promise.allSettled([physicalCount(ctx, args), physicalCount(ctx, args)]);
    const s = await itemState(id);
    expect(s.qty).toBe(8);
    expect(await gl(ctx, acct['1301'])).toBe(s.value); // 40
  });

  it('value adjustment: a double-submitted revaluation posts the write-up once (GL ties to the item)', async () => {
    const id = await stockedItem('Value Widget', '1302', '10', '5');
    const args = { itemId: id, newTotalValue: '80', date: D('2026-03-01') };
    await Promise.allSettled([adjustInventoryValue(ctx, args), adjustInventoryValue(ctx, args)]);
    const s = await itemState(id);
    expect(s.value).toBe(80);
    expect(await gl(ctx, acct['1302'])).toBe(80);
  });

  it('assembly build: two concurrent builds cannot both consume the one component on hand', async () => {
    const comp = await stockedItem('Comp One', '1303', '1', '5');
    const assy = await stockedItem('Assy One', '1304', '0', '0');
    await setBom(ctx, assy, [{ componentItemId: comp, quantity: '1' }]);
    const res = await Promise.allSettled([
      buildAssembly(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-02') }),
      buildAssembly(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-02') }),
    ]);
    expect(fulfilled(res), reasons(res).join(' | ')).toBe(1);
    expect(await gl(ctx, acct['1303'])).toBe((await itemState(comp)).value);
    expect(await gl(ctx, acct['1304'])).toBe((await itemState(assy)).value);
  });

  it('pending build: a double-submitted finalize builds the pending build only once', async () => {
    const comp = await stockedItem('Comp Two', '1305', '2', '5');
    const assy = await stockedItem('Assy Two', '1306', '0', '0');
    await setBom(ctx, assy, [{ componentItemId: comp, quantity: '1' }]);
    const pb = await createPendingBuild(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-03') });
    await Promise.allSettled([finalizePendingBuild(ctx, pb.id), finalizePendingBuild(ctx, pb.id)]);
    expect((await itemState(assy)).qty).toBe(1);
    expect((await itemState(comp)).qty).toBe(1);
  });

  it('vendor credit: a double-submitted void restores the returned stock only once', async () => {
    const id = await stockedItem('VC Widget', '1307', '10', '10');
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-03-04'), lines: [{ itemId: id, quantity: '4', amount: '40.00' }] });
    expect((await itemState(id)).qty).toBe(6);
    await Promise.allSettled([voidVendorCredit(ctx, vc.id), voidVendorCredit(ctx, vc.id)]);
    const s = await itemState(id);
    expect(s.qty).toBe(10);
    expect(await gl(ctx, acct['1307'])).toBe(s.value);
  });

  it('check with items: a double-submitted void takes the purchased stock out only once', async () => {
    const id = await stockedItem('Exp Widget', '1308', '10', '10');
    const exp = await createExpense(ctx, {
      payeeName: 'Hardware Store',
      date: D('2026-03-05'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ itemId: id, quantity: '5', unitCost: '10' }],
    });
    expect((await itemState(id)).qty).toBe(15);
    await Promise.allSettled([voidExpense(ctx, exp.id), voidExpense(ctx, exp.id)]);
    const s = await itemState(id);
    expect(s.qty).toBe(10);
    expect(await gl(ctx, acct['1308'])).toBe(s.value);
  });

  it('item receipt: a double-submitted void takes the received stock out only once', async () => {
    const id = await stockedItem('IR Widget', '1309', '10', '10');
    const ir = await createItemReceipt(ctx, { vendorId, date: D('2026-03-06'), lines: [{ itemId: id, quantity: '5', unitCost: '10' }] });
    expect((await itemState(id)).qty).toBe(15);
    await Promise.allSettled([voidItemReceipt(ctx, ir.id), voidItemReceipt(ctx, ir.id)]);
    const s = await itemState(id);
    expect(s.qty).toBe(10);
    expect(await gl(ctx, acct['1309'])).toBe(s.value);
  });

  it('condense: a double-submitted condense does not insert the summary entries twice', async () => {
    const { ctx: c, acct: a } = await newCompany('condense');
    await postJournalEntry(c, { date: D('2023-03-01'), description: 'Old sale', lines: [{ accountId: a['1000'], debit: '100.00' }, { accountId: a['4000'], credit: '100.00' }] });
    await postJournalEntry(c, { date: D('2023-04-01'), description: 'Old supplies', lines: [{ accountId: a['6000'], debit: '30.00' }, { accountId: a['1000'], credit: '30.00' }] });
    await postJournalEntry(c, { date: D('2024-02-01'), description: 'New sale', lines: [{ accountId: a['1000'], debit: '10.00' }, { accountId: a['4000'], credit: '10.00' }] });
    const before = { cash: await gl(c, a['1000']), sales: await gl(c, a['4000']), supplies: await gl(c, a['6000']) };
    await closePeriod(c, { periodStart: new Date('2023-01-01T00:00:00Z'), periodEnd: new Date('2023-12-31T00:00:00Z') });
    const args = { beforeDate: new Date('2024-01-01T00:00:00Z'), dataDir: TEST_DIR };
    await Promise.allSettled([condensePeriod(c, args), condensePeriod(c, args)]);
    const after = { cash: await gl(c, a['1000']), sales: await gl(c, a['4000']), supplies: await gl(c, a['6000']) };
    expect(after).toEqual(before);
  });

  it('pay run: the same time entries pulled into two concurrent pay runs are paid only once', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Hank', lastName: 'Hourly', payType: 'hourly', payRate: '25.00' });
    const te = await createTimeEntry(ctx, { employeeId: emp.id, date: D('2025-01-06'), hours: '8', billable: false });
    const run = () =>
      createPayRun(ctx, {
        payDate: D('2025-01-17'),
        periodStart: D('2025-01-01'),
        periodEnd: D('2025-01-15'),
        employees: [{ employeeId: emp.id, timeEntryIds: [te.id] }],
      });
    const res = await Promise.allSettled([run(), run()]);
    const ok = res.flatMap((r) => (r.status === 'fulfilled' ? r.value.results.filter((x) => x.ok && !x.warning) : []));
    const checks = await db
      .select({ id: paychecks.id })
      .from(paychecks)
      .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.employeeId, emp.id)));
    expect(checks).toHaveLength(1);
    expect(ok).toHaveLength(1);
  });

  it('reconcile: a double-submitted "clear" counts the line once in the cleared balance', async () => {
    const ba = await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'Recon A', accountNumber: '111' });
    const je = await postJournalEntry(ctx, { date: D('2026-05-01'), description: 'Dep', lines: [{ accountId: acct['1010'], debit: '50.00' }, { accountId: acct['3000'], credit: '50.00' }] });
    const [line] = await db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, je.id), eq(journalEntryLines.accountId, acct['1010'])));
    const recon = await startReconciliation(ctx, { bankAccountId: ba.id, statementDate: D('2026-05-31'), statementBalance: '50.00' });
    await Promise.allSettled([toggleCleared(ctx, recon.id, line.id, true), toggleCleared(ctx, recon.id, line.id, true)]);
    const rows = await db.select().from(reconciliationItems).where(eq(reconciliationItems.reconciliationId, recon.id));
    expect((await getProgress(ctx, recon.id)).clearedBalance).toBe('50.00');
    expect(rows).toHaveLength(1);
  });

  it('reconcile: two concurrent starts open only one in-progress reconciliation', async () => {
    const ba = await createBankAccount(ctx, { accountId: acct['1020'], bankName: 'Recon B', accountNumber: '222' });
    const args = { bankAccountId: ba.id, statementDate: D('2026-05-31'), statementBalance: '0.00' };
    const res = await Promise.allSettled([startReconciliation(ctx, args), startReconciliation(ctx, args)]);
    const open = await db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, ba.id), eq(reconciliations.status, 'in_progress')));
    expect(open).toHaveLength(1);
    expect(fulfilled(res)).toBe(1);
  });

  it('loan: a double-submitted final payment cannot pay more principal than is owed', async () => {
    await postJournalEntry(ctx, { date: D('2026-06-01'), description: 'Loan proceeds', lines: [{ accountId: acct['1000'], debit: '100.00' }, { accountId: acct['2600'], credit: '100.00' }] });
    const loan = await createLoan(ctx, {
      name: 'Small note',
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1000'],
      originalAmount: '100',
      annualRate: '6',
      termMonths: 12,
      originDate: D('2026-06-01'),
      firstPaymentDate: D('2026-07-01'),
    });
    const pay = () => setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '100', interest: '0', date: D('2026-07-01') });
    const res = await Promise.allSettled([pay(), pay()]);
    expect(await gl(ctx, acct['2600'])).toBe(0); // not +100 (principal paid twice)
    expect(fulfilled(res)).toBe(1);
  });

  it('accounts: two concurrent creates with the same number make only one account', async () => {
    const args = { code: '6999', name: 'Dup Test', type: 'expense' as never, subtype: 'operating_expenses' };
    const res = await Promise.allSettled([createAccount(ctx, args), createAccount(ctx, args)]);
    const rows = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6999')));
    expect(rows).toHaveLength(1);
    expect(fulfilled(res)).toBe(1);
  });

  it('refund checks: a double-submitted "add refund check" queues only one check', async () => {
    const memo = await createCreditMemo(ctx, { customerId, date: D('2026-07-01'), lines: [{ description: 'x', quantity: 1, rate: '25.00' }] });
    const { entry } = (await refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '25.00', date: D('2026-07-02') })) as { entry: { id: string } };
    const res = await Promise.allSettled([
      queueCustomerRefundCheck(ctx, { entryId: entry.id }),
      queueCustomerRefundCheck(ctx, { entryId: entry.id }),
    ]);
    const rows = await db.select({ id: paymentChecks.id }).from(paymentChecks).where(eq(paymentChecks.postedEntryId, entry.id));
    expect(rows, reasons(res).join(' | ')).toHaveLength(1);
  });

  it('bank feed: two feed lines cannot both be matched to the same register transaction concurrently', async () => {
    const ba = await createBankAccount(ctx, { accountId: acct['1030'], bankName: 'Feed', accountNumber: '333' });
    const je = await postJournalEntry(ctx, { date: D('2026-08-01'), description: 'Deposit', lines: [{ accountId: acct['1030'], debit: '75.00' }, { accountId: acct['3000'], credit: '75.00' }] });
    const [t1] = await db.insert(bankTransactions).values({ companyId: ctx.companyId, bankAccountId: ba.id, date: D('2026-08-01'), amount: '75.00', description: 'DEP' }).returning();
    const [t2] = await db.insert(bankTransactions).values({ companyId: ctx.companyId, bankAccountId: ba.id, date: D('2026-08-01'), amount: '75.00', description: 'DEP' }).returning();
    const res = await Promise.allSettled([matchTransaction(ctx, t1.id, je.id), matchTransaction(ctx, t2.id, je.id)]);
    const matched = await db.select({ id: bankTransactions.id }).from(bankTransactions).where(eq(bankTransactions.matchedEntryId, je.id));
    expect(matched).toHaveLength(1);
    expect(fulfilled(res)).toBe(1);
  });

  it('check numbers: two checks written at once without a number get different numbers', async () => {
    const write = () =>
      createExpense(ctx, { payeeName: 'Payee', date: D('2026-08-05'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '5.00' }] });
    const res = await Promise.allSettled([write(), write()]);
    const refs = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value.reference] : []));
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  it('check numbers: two queued checks printed at once without a number get different numbers', async () => {
    const queue = () =>
      createExpense(ctx, { payeeName: 'Payee', date: D('2026-08-06'), method: 'check', toPrint: true, paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '6.00' }] });
    const a = await queue();
    const b = await queue();
    const res = await Promise.allSettled([
      markPrinted(ctx, { source: 'expense', id: a.id }),
      markPrinted(ctx, { source: 'expense', id: b.id }),
    ]);
    const refs = res.flatMap((r) => (r.status === 'fulfilled' ? [(r.value as { reference: string | null }).reference] : []));
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  it('lists: two concurrent creates of the same customer / item name make only one record', async () => {
    const cr = await Promise.allSettled([createCustomer(ctx, { displayName: 'Twin Co' }), createCustomer(ctx, { displayName: 'Twin Co' })]);
    const ir = await Promise.allSettled([
      createItem(ctx, { name: 'Twin Part', type: 'service', incomeAccountId: acct['4000'] }),
      createItem(ctx, { name: 'Twin Part', type: 'service', incomeAccountId: acct['4000'] }),
    ]);
    const custRows = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Twin Co')));
    const itemRows = await db.select({ id: items.id }).from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Twin Part')));
    expect({ customers: custRows.length, items: itemRows.length }, [...reasons(cr), ...reasons(ir)].join(' | ')).toEqual({ customers: 1, items: 1 });
  });

  it('assembly unbuild: two concurrent unbuilds cannot both take apart the one assembly on hand', async () => {
    const comp = await stockedItem('Comp Three', '1303', '1', '5');
    const assy = await stockedItem('Assy Three', '1304', '0', '0');
    await setBom(ctx, assy, [{ componentItemId: comp, quantity: '1' }]);
    await buildAssembly(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-07') });
    const res = await Promise.allSettled([
      unbuildAssembly(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-08') }),
      unbuildAssembly(ctx, { assemblyItemId: assy, quantity: '1', date: D('2026-03-08') }),
    ]);
    expect(fulfilled(res), reasons(res).join(' | ')).toBe(1);
    expect((await itemState(comp)).qty).toBe(1);
    expect((await itemState(assy)).qty).toBe(0);
  });

  it('estimate: a status change racing the conversion cannot reopen a converted estimate', async () => {
    const est = await createEstimate(ctx, { customerId, date: D('2026-04-01'), lines: [{ description: 'x', quantity: 1, rate: '10.00' }] });
    await updateEstimateStatus(ctx, est.id, 'accepted');
    await Promise.allSettled([convertEstimate(ctx, est.id), updateEstimateStatus(ctx, est.id, 'rejected')]);
    const [row] = await db.select().from(estimates).where(eq(estimates.id, est.id));
    if (row.convertedInvoiceId) expect(row.status).toBe('closed');
  });

  it('reconcile: a cancel racing the completion leaves either a completed session or none, never a half state', async () => {
    const ba = await createBankAccount(ctx, { accountId: acct['1040'], bankName: 'Recon C', accountNumber: '444' });
    const recon = await startReconciliation(ctx, { bankAccountId: ba.id, statementDate: D('2026-05-31'), statementBalance: '0.00' });
    const res = await Promise.allSettled([completeReconciliation(ctx, recon.id), cancelReconciliation(ctx, recon.id)]);
    const [bank] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, ba.id));
    const done = await db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, ba.id), eq(reconciliations.status, 'completed')));
    expect(fulfilled(res), reasons(res).join(' | ')).toBe(1);
    expect(done.length).toBe(bank.lastReconciledDate ? 1 : 0);
  });

  it('month-end close: closing two months at once never moves the closing date backwards', async () => {
    const { ctx: c } = await newCompany('mec');
    for (const periodEnd of ['2026-02-28', '2026-03-31']) {
      for (const stepKey of MONTH_END_STEP_KEYS) {
        await updateMonthEndStep(c, { periodEnd, stepKey, action: 'skip', reason: 'test' });
      }
    }
    await Promise.allSettled([closeMonth(c, { periodEnd: '2026-03-31' }), closeMonth(c, { periodEnd: '2026-02-28' })]);
    expect((await getClosingDateSettings(c)).closingDate).toBe('2026-03-31');
  });

  it("accountant's copy: two concurrent creates leave only one outstanding copy", async () => {
    const { ctx: c } = await newCompany('acopy');
    const res = await Promise.allSettled([
      createAccountantCopy(c, { dividingDate: '2026-06-30', dataDir: TEST_DIR }),
      createAccountantCopy(c, { dividingDate: '2026-06-30', dataDir: TEST_DIR }),
    ]);
    const open = await db
      .select({ id: accountantCopies.id })
      .from(accountantCopies)
      .where(and(eq(accountantCopies.companyId, c.companyId), eq(accountantCopies.status, 'outstanding')));
    expect(open).toHaveLength(1);
    expect(fulfilled(res), reasons(res).join(' | ')).toBe(1);
  });

  it('assembly: a $0 build or unbuild (no ledger entry) still respects a closed period', async () => {
    await closePeriod(ctx, { periodStart: new Date('2024-01-01T00:00:00Z'), periodEnd: new Date('2024-12-31T00:00:00Z') });
    const [comp] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Free Comp', type: 'inventory', assetAccountId: acct['1305'], quantityOnHand: '1.0000', averageCost: '0.0000' })
      .returning();
    const [assy] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Free Assy', type: 'inventory', assetAccountId: acct['1306'], quantityOnHand: '1.0000', averageCost: '0.0000' })
      .returning();
    await setBom(ctx, assy.id, [{ componentItemId: comp.id, quantity: '1' }]);
    await expect(buildAssembly(ctx, { assemblyItemId: assy.id, quantity: '1', date: D('2024-06-01') })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(unbuildAssembly(ctx, { assemblyItemId: assy.id, quantity: '1', date: D('2024-06-01') })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect((await itemState(comp.id)).qty).toBe(1);
    expect((await itemState(assy.id)).qty).toBe(1);
  });

  it('books stay balanced', async () => {
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
