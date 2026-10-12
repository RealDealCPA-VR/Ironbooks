/**
 * wave2 purchases — end-to-end tests for the A/P + banking parity gaps:
 *  D1 edit-after-save (checks, bill payments, vendor credits, deposits, transfers, POs, item
 *     receipts) incl. the reconciled-line guard and closing-date respect,
 *  D2 Items tab on checks (inventory receipt + reversal),
 *  D3 unified print queue (check + bill payment + paycheck) with numbering on print,
 *  D4 check styles / alignment settings + PDF render,
 *  D5 terms -> due date + discount suggestions + Pay Bills filters,
 *  D6 vendor pre-fill accounts / print-on-check name / account number on memo,
 *  F1 Loan Manager (schedule + set up payment as check and bill),
 *  A3/A4 duplicate check / bill numbers with override,
 *  J10 foreign-currency bills / checks / bill payments (home TB balanced, A/P clears, FX gain).
 * Every scenario ends with the trial balance balanced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  vendors,
  items,
  employees,
  paychecks,
  journalEntryLines,
  journalEntries,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import { createExpense, updateExpense, voidExpense, getExpense } from './expenses';
import { createBill, listBillsToPay, getBill } from './bills';
import { payBills, updateBillPayment, getBillPayment } from './billPayments';
import { createVendorCredit, updateVendorCredit, voidVendorCredit } from './vendorCredits';
import { createTransfer, updateTransfer, voidTransfer } from './transfers';
import { createPurchaseOrder, updatePurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { createDeposit, updateDeposit } from './deposits';
import { createBankAccount } from './bankAccounts';
import { startReconciliation, listClearable, toggleCleared, completeReconciliation } from './reconcile';
import { setClosingDate } from './company';
import { upsertCurrency, setBaseCurrency, setAccountCurrency, homeAmounts } from './currencies';
import { parseTerms, dueDateFromTerms, discountFor } from './billTerms';
import {
  listPrintQueue,
  markPrinted,
  queuePaychecks,
  checkPrintData,
  saveCheckPrintSettings,
  getCheckPrintSettings,
} from './printQueue';
import { createVendor, updateVendor } from './vendors';
import { vendorPrefillAccounts } from './vendorPurchaseFields';
import {
  createLoan,
  getLoan,
  setUpLoanPayment,
  amortizationSchedule,
  periodicPayment,
} from './loans';
import { renderCheckPdf } from '@/lib/pdf/check';
import { apAging } from './reportsExtra';
import { refundVendorCredit } from './vendorCredits';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchases-wave2');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;

const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
async function tbOk() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

describe('wave2 purchases', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'w2p@test.local', name: 'W2P', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Purchases Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1020', 'Euro Bank', 'asset', 'checking'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2100', 'Visa', 'liability', 'credit_card'],
      ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
      ['2600', 'Truck Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4900', 'Other Income', 'revenue', 'other_income'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6100', 'Bank Fees', 'expense', 'operating_expenses'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
      ['6500', 'Payroll Expense', 'expense', 'payroll'],
      ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
      ['4950', 'Discounts Taken', 'revenue', 'other_income'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Office Depot' }).returning())[0].id;
    // Fund checking: owner puts in 10,000.
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may still hold a file handle; the next run wipes the dir first. */
    }
  });

  // ---------------------------------------------------------------- D1 checks
  it('D1: edits a saved check (amount repost, memo-only keeps the entry)', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-02-01'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '100.00' }],
    });
    expect(await bal('6300')).toBe('100.00');
    const firstEntry = exp.postedEntryId;

    const memoOnly = await updateExpense(ctx, exp.id, {
      vendorId,
      date: d('2026-02-01'),
      method: 'check',
      reference: exp.reference,
      paymentAccountId: acct['1000'],
      memo: 'fixed memo',
      lines: [{ accountId: acct['6300'], amount: '100.00', description: 'paper' }],
    });
    expect(memoOnly.postedEntryId).toBe(firstEntry);
    expect(memoOnly.memo).toBe('fixed memo');

    const changed = await updateExpense(ctx, exp.id, {
      vendorId,
      date: d('2026-02-02'),
      method: 'check',
      reference: exp.reference,
      paymentAccountId: acct['1000'],
      lines: [
        { accountId: acct['6300'], amount: '60.00' },
        { accountId: acct['6400'], amount: '90.00' },
      ],
    });
    expect(changed.postedEntryId).not.toBe(firstEntry);
    expect(changed.total).toBe('150.00');
    expect(await bal('6300')).toBe('60.00');
    expect(await bal('6400')).toBe('90.00');
    expect(await bal('1000')).toBe('9850.00');
    const [old] = await db.select().from(journalEntries).where(eq(journalEntries.id, firstEntry!));
    expect(old.status).toBe('void');
    await voidExpense(ctx, exp.id);
    expect(await bal('1000')).toBe('10000.00');
    await tbOk();
  });

  it('D1: a reconciled check allows memo edits but blocks amount edits with a plain message', async () => {
    const exp = await createExpense(ctx, {
      payeeName: 'Landlord',
      date: d('2026-02-10'),
      method: 'check',
      reference: '5001',
      paymentAccountId: acct['1010'],
      lines: [{ accountId: acct['6400'], amount: '500.00' }],
    });
    await postJournalEntry(ctx, {
      date: d('2026-02-01'),
      description: 'fund savings',
      lines: [
        { accountId: acct['1010'], debit: '2000.00' },
        { accountId: acct['3000'], credit: '2000.00' },
      ],
    });
    const bank = await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'Sav Bank', accountNumber: '123456789' });
    const recon = await startReconciliation(ctx, { bankAccountId: bank.id, statementDate: d('2026-02-28'), statementBalance: '1500.00' });
    const lines = await listClearable(ctx, bank.id, d('2026-02-28'), recon.id);
    for (const l of lines) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    await completeReconciliation(ctx, recon.id);

    const base = {
      payeeName: 'Landlord',
      date: d('2026-02-10'),
      method: 'check' as const,
      reference: '5001',
      paymentAccountId: acct['1010'],
    };
    const ok = await updateExpense(ctx, exp.id, { ...base, memo: 'Feb rent', lines: [{ accountId: acct['6400'], amount: '500.00' }] });
    expect(ok.memo).toBe('Feb rent');
    await expect(
      updateExpense(ctx, exp.id, { ...base, lines: [{ accountId: acct['6400'], amount: '550.00' }] }),
    ).rejects.toThrow(/completed bank reconciliation/);
    await tbOk();
  });

  it('D1: respects the closing date', async () => {
    const exp = await createExpense(ctx, {
      payeeName: 'Old',
      date: d('2026-01-05'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '10.00' }],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31' } as never);
    await expect(
      updateExpense(ctx, exp.id, {
        payeeName: 'Old',
        date: d('2026-03-05'),
        method: 'cash',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '12.00' }],
      }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await setClosingDate(ctx, { closingDate: null } as never);
    await tbOk();
  });

  // ---------------------------------------------------------------- D2 items tab
  it('D2: item lines on a check receive inventory; void pulls it back out', async () => {
    const [widget] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-03-01'),
      method: 'credit_card',
      paymentAccountId: acct['2100'],
      lines: [
        { itemId: widget.id, quantity: '10', unitCost: '4.25' },
        { accountId: acct['6300'], amount: '5.00' },
      ],
    });
    expect(exp.total).toBe('47.50');
    const [w1] = await db.select().from(items).where(eq(items.id, widget.id));
    expect(Money.of(w1.quantityOnHand).toFixed(2)).toBe('10.00');
    expect(Money.of(w1.averageCost).toFixed(2)).toBe('4.25');
    expect(await bal('1300')).toBe('42.50');
    const got = await getExpense(ctx, exp.id);
    expect(got.lines[0].itemId).toBe(widget.id);

    await voidExpense(ctx, exp.id);
    const [w2] = await db.select().from(items).where(eq(items.id, widget.id));
    expect(Money.of(w2.quantityOnHand).toFixed(2)).toBe('0.00');
    expect(await bal('1300')).toBe('0.00');
    await tbOk();
  });

  // ---------------------------------------------------------------- A3 / A4
  it('A3: duplicate check numbers are refused unless overridden', async () => {
    const mk = (check: boolean) =>
      createExpense(ctx, {
        payeeName: 'X',
        date: d('2026-03-02'),
        method: 'check',
        reference: '7777',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
        checkDuplicateNumber: check,
      });
    await mk(true);
    await expect(mk(true)).rejects.toMatchObject({ code: 'CONFLICT', details: { duplicateNumber: true } });
    const dup = await mk(false); // user confirmed
    expect(dup.reference).toBe('7777');
  });

  it('A4: duplicate vendor bill numbers are refused unless overridden', async () => {
    const mk = (check: boolean) =>
      createBill(ctx, {
        vendorId,
        billNumber: 'INV-9',
        date: d('2026-03-03'),
        lines: [{ accountId: acct['6300'], amount: '2.00' }],
        checkDuplicateNumber: check,
      });
    await mk(true);
    await expect(mk(true)).rejects.toMatchObject({ code: 'CONFLICT' });
    await mk(false);
  });

  // ---------------------------------------------------------------- D5 terms
  it('D5: terms parse, due dates and discount suggestions', async () => {
    expect(parseTerms('2_10_net_30')).toEqual({ netDays: 30, discountPercent: 2, discountDays: 10 });
    expect(parseTerms('2/10 n/30')).toEqual({ netDays: 30, discountPercent: 2, discountDays: 10 });
    expect(parseTerms('due_on_receipt')!.netDays).toBe(0);
    expect(dueDateFromTerms(d('2026-01-31'), 'net_15')!.toISOString().slice(0, 10)).toBe('2026-02-15');
    const disc = discountFor({ date: d('2026-04-01'), terms: '2_10_net_30', balanceDue: '1000.00', total: '1000.00' }, d('2026-04-05'));
    expect(disc.available).toBe(true);
    expect(disc.suggestedDiscount).toBe('20.00');

    const v2 = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Termsy', terms: '2_10_net_30' }).returning())[0];
    const bill = await createBill(ctx, { vendorId: v2.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '1000.00' }] });
    expect(bill.dueDate!.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(bill.terms).toBe('2_10_net_30');

    const withDisc = await listBillsToPay(ctx, { vendorId: v2.id, discountAvailableOnly: true, asOf: d('2026-04-05') });
    expect(withDisc).toHaveLength(1);
    expect(withDisc[0].suggestedDiscount).toBe('20.00');
    expect(await listBillsToPay(ctx, { vendorId: v2.id, discountAvailableOnly: true, asOf: d('2026-04-20') })).toHaveLength(0);
    expect(await listBillsToPay(ctx, { vendorId: v2.id, dueOnOrBefore: d('2026-04-30') })).toHaveLength(0);
    expect(await listBillsToPay(ctx, { vendorId: v2.id, dueOnOrBefore: d('2026-05-01') })).toHaveLength(1);

    // Pay with the discount: A/P cleared fully, bank pays 980.
    const before = await bal('1000');
    await payBills(ctx, {
      vendorId: v2.id,
      date: d('2026-04-05'),
      method: 'check',
      paymentAccountId: acct['1000'],
      discountAccountId: acct['4950'],
      applications: [{ billId: bill.id, amountApplied: '980.00', discountTaken: '20.00' }],
    });
    expect(Money.of(before).minus(await bal('1000')).toFixed(2)).toBe('980.00');
    expect((await getBill(ctx, bill.id)).status).toBe('paid');
    await tbOk();
  });

  // ---------------------------------------------------------------- D1 + D3 bill payments
  it('D1/D3: bill payment to print, edit amount, print with a number', async () => {
    const bill = await createBill(ctx, { vendorId, date: d('2026-04-10'), lines: [{ accountId: acct['6300'], amount: '300.00' }] });
    const pay = await payBills(ctx, {
      vendorId,
      date: d('2026-04-11'),
      method: 'check',
      paymentAccountId: acct['1000'],
      toPrint: true,
      applications: [{ billId: bill.id, amountApplied: '100.00' }],
    });
    expect(pay.toPrint).toBe(true);
    expect(pay.reference).toBeNull();

    const edited = await updateBillPayment(ctx, pay.id, {
      vendorId,
      date: d('2026-04-11'),
      method: 'check',
      paymentAccountId: acct['1000'],
      toPrint: true,
      applications: [{ billId: bill.id, amountApplied: '250.00' }],
    });
    expect(edited.amount).toBe('250.00');
    const b = await getBill(ctx, bill.id);
    expect(b.balanceDue).toBe('50.00');
    expect(b.status).toBe('partial');

    const queue = await listPrintQueue(ctx);
    const item = queue.find((q) => q.id === pay.id)!;
    expect(item.source).toBe('bill_payment');
    expect(item.amount).toBe('250.00');
    const printed = (await markPrinted(ctx, { source: 'bill_payment', id: pay.id, checkNumber: '8801' })) as { reference: string; toPrint: boolean };
    expect(printed.reference).toBe('8801');
    expect(printed.toPrint).toBe(false);
    expect((await listPrintQueue(ctx)).find((q) => q.id === pay.id)).toBeUndefined();
    const got = await getBillPayment(ctx, pay.id);
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, got.postedEntryId!));
    expect(je.reference).toBe('8801');
    await tbOk();
  });

  it('D3: paychecks join the print queue and get numbered', async () => {
    const [emp] = await db.insert(employees).values({ companyId: ctx.companyId, firstName: 'Ann', lastName: 'Lee' }).returning();
    const entry = await postJournalEntry(ctx, {
      date: d('2026-04-15'),
      description: 'Paycheck',
      lines: [
        { accountId: acct['6500'], debit: '1000.00' },
        { accountId: acct['2300'], credit: '200.00' },
        { accountId: acct['1000'], credit: '800.00' },
      ],
    });
    const [pc] = await db
      .insert(paychecks)
      .values({ companyId: ctx.companyId, employeeId: emp.id, payDate: d('2026-04-15'), grossPay: '1000.00', totalTaxes: '200.00', netPay: '800.00', postedEntryId: entry.id })
      .returning();
    await queuePaychecks(ctx, [pc.id]);
    const q = await listPrintQueue(ctx, { paymentAccountId: acct['1000'] });
    expect(q.find((i) => i.id === pc.id)?.payee).toBe('Ann Lee');
    const data = await checkPrintData(ctx, 'paycheck', pc.id);
    expect(data.amount).toBe('800.00');
    await markPrinted(ctx, { source: 'paycheck', id: pc.id, checkNumber: '9100' });
    const [after] = await db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(after.checkNumber).toBe('9100');
    expect(after.toPrint).toBe(false);
    // The paycheck number now counts for duplicate detection on Checking.
    await expect(
      createExpense(ctx, {
        payeeName: 'Y',
        date: d('2026-04-16'),
        method: 'check',
        reference: '9100',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
        checkDuplicateNumber: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // ---------------------------------------------------------------- D4 / D6
  it('D4/D6: check settings, styles, print-on-check name and account number memo', async () => {
    expect((await getCheckPrintSettings(ctx)).style).toBe('voucher');
    const s = await saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: '0.125', offsetY: '-0.25' });
    expect(s).toEqual({ style: 'wallet', offsetX: '0.13', offsetY: '-0.25' });
    await expect(saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: '2', offsetY: '0' })).rejects.toThrow(/at most/);

    const v = await createVendor(ctx, {
      displayName: 'Acme Short',
      printOnCheckAs: 'Acme Corporation of America',
      accountNumber: 'CUST-42',
      prefillAccountIds: [acct['6300'], acct['6400']],
    });
    expect(await vendorPrefillAccounts(ctx, v.id)).toEqual([acct['6300'], acct['6400']]);
    await expect(
      updateVendor(ctx, v.id, { prefillAccountIds: [acct['6300'], acct['6400'], acct['6100'], acct['6800']] }),
    ).rejects.toThrow(/at most 3/);
    const exp = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-04-20'),
      method: 'check',
      paymentAccountId: acct['1000'],
      toPrint: true,
      lines: [{ accountId: acct['6300'], amount: '12.34' }],
    });
    const data = await checkPrintData(ctx, 'expense', exp.id);
    expect(data.payee).toBe('Acme Corporation of America');
    expect(data.memo).toBe('Acct # CUST-42');

    for (const style of ['voucher', 'standard', 'wallet'] as const) {
      const bytes = await renderCheckPdf({
        company: { name: 'Purchases Co' },
        payee: data.payee,
        amountNumeric: data.amount,
        date: data.date,
        memo: data.memo,
        voucher: data.voucher,
        style,
        offset: { x: '0.1', y: '-0.1' },
      });
      expect(bytes.length).toBeGreaterThan(500);
    }
  });

  // ---------------------------------------------------------------- D1 others
  it('D1: vendor credits, transfers, deposits, POs and item receipts can be edited', async () => {
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-05-01'), lines: [{ accountId: acct['6300'], amount: '40.00' }] });
    const vc2 = await updateVendorCredit(ctx, vc.id, { vendorId, date: d('2026-05-01'), lines: [{ accountId: acct['6400'], amount: '45.00' }] });
    expect(vc2.total).toBe('45.00');
    expect(vc2.unapplied).toBe('45.00');

    const t = await createTransfer(ctx, { date: d('2026-05-02'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '100.00' });
    const t2 = await updateTransfer(ctx, t.id, { date: d('2026-05-02'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '125.00', memo: 'move' });
    expect(t2.amount).toBe('125.00');
    const t3 = await updateTransfer(ctx, t.id, { date: d('2026-05-02'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '125.00', memo: 'renamed' });
    expect(t3.postedEntryId).toBe(t2.postedEntryId);
    await voidTransfer(ctx, t.id);

    const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-05-03'), extraLines: [{ accountId: acct['3000'], amount: '50.00' }] });
    const dep2 = await updateDeposit(ctx, dep.id, { depositAccountId: acct['1000'], date: d('2026-05-03'), extraLines: [{ accountId: acct['3000'], amount: '75.00' }] });
    expect(dep2.total).toBe('75.00');

    const po = await createPurchaseOrder(ctx, { vendorId, date: d('2026-05-04'), lines: [{ accountId: acct['6300'], quantity: '2', rate: '10' }] });
    const full = await getPurchaseOrder(ctx, po.id);
    const po2 = await updatePurchaseOrder(ctx, po.id, {
      vendorId,
      date: d('2026-05-04'),
      memo: 'more',
      lines: [
        { id: full.lines[0].id, accountId: acct['6300'], quantity: '3', rate: '10' },
        { accountId: acct['6400'], quantity: '1', rate: '5' },
      ],
    });
    expect(po2.total).toBe('35.00');
    expect(po2.lines).toHaveLength(2);

    const [gizmo] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Gizmo', type: 'inventory', assetAccountId: acct['1300'], quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const ir = await createItemReceipt(ctx, { vendorId, date: d('2026-05-05'), lines: [{ itemId: gizmo.id, quantity: '4', unitCost: '3' }] });
    const ir2 = await updateItemReceipt(ctx, ir.id, { vendorId, date: d('2026-05-05'), lines: [{ itemId: gizmo.id, quantity: '6', unitCost: '3' }] });
    expect(ir2.id).toBe(ir.id);
    expect(ir2.total).toBe('18.00');
    const [g] = await db.select().from(items).where(eq(items.id, gizmo.id));
    expect(Money.of(g.quantityOnHand).toFixed(0)).toBe('6');
    await tbOk();
  });

  // ---------------------------------------------------------------- F1 loans
  it('F1: Loan Manager schedule and set up payment (check + bill)', async () => {
    const pay = periodicPayment('20000', '6', 36, 12);
    expect(pay.toFixed(2)).toBe('608.44');
    const sched = amortizationSchedule({
      balance: '20000', annualRate: '6', paymentsPerYear: 12, totalPayments: 36, nextNumber: 1,
      firstPaymentDate: d('2026-02-01'), payment: pay,
    });
    expect(sched).toHaveLength(36);
    const principalSum = sched.reduce((s, r) => s.plus(Money.of(r.principal)), Money.zero());
    expect(principalSum.toFixed(2)).toBe('20000.00');
    expect(sched[35].balance).toBe('0.00');
    expect(sched[0].interest).toBe('100.00');

    // Loan proceeds (recorded the usual way).
    await postJournalEntry(ctx, {
      date: d('2026-01-15'),
      description: 'Truck loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '20000.00' },
        { accountId: acct['2600'], credit: '20000.00' },
      ],
    });
    const lender = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Truck Bank' }).returning())[0];
    const loan = await createLoan(ctx, {
      name: 'Truck',
      lenderVendorId: lender.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1000'],
      originalAmount: '20000',
      annualRate: '6',
      termMonths: 36,
      originDate: d('2026-01-15'),
      firstPaymentDate: d('2026-02-15'),
    });
    const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
    expect(lp.principal).toBe('508.44');
    expect(lp.interest).toBe('100.00');
    expect(await bal('2600')).toBe('19491.56');
    expect(await bal('6800')).toBe('100.00');

    const lp2 = await setUpLoanPayment(ctx, loan.id, { kind: 'bill' });
    expect(lp2.paymentNumber).toBe(2);
    expect(lp2.billId).toBeTruthy();
    const after = await getLoan(ctx, loan.id);
    expect(after.paymentsMade).toBe(2);
    expect(after.next!.number).toBe(3);
    // Voiding the check puts payment 1's principal back.
    await voidExpense(ctx, lp.expenseId!);
    expect((await getLoan(ctx, loan.id)).balance).toBe(Money.of('20000').minus(lp2.principal).toFixed(2));
    await tbOk();
  });

  // ---------------------------------------------------------------- J10 FX
  it('J10: foreign-currency bill + payment post in home currency and clear A/P', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');

    const h = homeAmounts(['33.33', '33.33', '33.34'], '1.0712');
    expect(h.lines.reduce((s, v) => s.plus(v), Money.zero()).toFixed(2)).toBe(h.total.toFixed(2));

    const eurVendor = await createVendor(ctx, { displayName: 'Paris Supplies', currency: 'EUR' });
    const apBefore = await bal('2000');
    const bill = await createBill(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-06-01'),
      lines: [
        { accountId: acct['6300'], amount: '33.33' },
        { accountId: acct['6400'], amount: '66.67' },
      ],
    });
    expect(bill.currency).toBe('EUR');
    expect(Money.of(bill.exchangeRate!).toFixed(2)).toBe('1.10');
    expect(Money.of(await bal('2000')).minus(apBefore).toFixed(2)).toBe('110.00');

    // A home-currency vendor cannot get a EUR check.
    await expect(
      createExpense(ctx, {
        vendorId,
        date: d('2026-06-01'),
        method: 'check',
        paymentAccountId: acct['1020'],
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
      }),
    ).rejects.toThrow(/EUR/);

    // Pay from the home bank at 1.05: A/P relieved 110.00, bank 105.00, FX gain 5.00.
    const bankBefore = await bal('1000');
    const pay = await payBills(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-06-20'),
      method: 'check',
      reference: '9901',
      paymentAccountId: acct['1000'],
      exchangeRate: '1.05',
      applications: [{ billId: bill.id, amountApplied: '100.00' }],
    });
    expect(pay.currency).toBe('EUR');
    expect(Money.of(bankBefore).minus(await bal('1000')).toFixed(2)).toBe('105.00');
    expect(await bal('2000')).toBe(apBefore);
    const fxLines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, pay.postedEntryId!));
    expect(fxLines.find((l) => l.memo === 'Realized exchange gain')?.credit).toBe('5.00');
    expect((await getBill(ctx, bill.id)).status).toBe('paid');

    // EUR check from the EUR bank account converts at the list rate.
    const chk = await createExpense(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-06-21'),
      method: 'check',
      paymentAccountId: acct['1020'],
      lines: [{ accountId: acct['6300'], amount: '10.01' }],
    });
    expect(chk.currency).toBe('EUR');
    expect(await bal('1020')).toBe('-11.01');
    await tbOk();
  });
  it('J10: home-currency-only documents refuse foreign accounts/vendors; A/P aging ties in home currency', async () => {
    // (Runs after the J10 test above: EUR is set up and 1020 is a EUR bank account.)
    const eurVendor = await createVendor(ctx, { displayName: 'Lyon Parts', currency: 'EUR' });
    const before = { ap: await bal('2000'), eur: await bal('1020'), chk: await bal('1000') };

    // p1 fx: a EUR vendor's credit is a EUR credit (home A/P at the list rate); a home credit still
    // can't be refunded into a EUR bank.
    const eurVc = await createVendorCredit(ctx, { vendorId: eurVendor.id, date: d('2026-06-22'), lines: [{ accountId: acct['6300'], amount: '5.00' }] });
    expect(eurVc.currency).toBe('EUR');
    await voidVendorCredit(ctx, eurVc.id);
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-06-22'), lines: [{ accountId: acct['6300'], amount: '5.00' }] });
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '5.00', date: d('2026-06-22') }),
    ).rejects.toThrow(/EUR/);

    // p1 fx: a home deposit can't put cash back into the EUR bank, and a transfer between
    // currencies needs the amount that arrived (nothing posted).
    await expect(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: d('2026-06-22'),
        extraLines: [{ accountId: acct['4900'], amount: '10.00' }],
        cashBack: { accountId: acct['1020'], amount: '1.00' },
      }),
    ).rejects.toThrow(/EUR/);
    await expect(
      createTransfer(ctx, { fromAccountId: acct['1000'], toAccountId: acct['1020'], amount: '10.00', date: d('2026-06-22') }),
    ).rejects.toThrow(/EUR/);

    // Loan Manager: a EUR lender is refused atomically.
    const loan = await createLoan(ctx, {
      name: 'Euro note',
      lenderVendorId: eurVendor.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1000'],
      originalAmount: '1000',
      annualRate: '5',
      termMonths: 12,
      originDate: d('2026-06-01'),
      firstPaymentDate: d('2026-07-01'),
    });
    await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check' })).rejects.toThrow(/home currency/);
    expect((await getLoan(ctx, loan.id)).paymentsMade).toBe(0);

    expect(await bal('1020')).toBe(before.eur);
    expect(await bal('1000')).toBe(before.chk);
    expect(Money.of(before.ap).minus(await bal('2000')).toFixed(2)).toBe('5.00'); // only the home credit

    // A/P aging: a foreign bill, part paid at a different rate, is aged at its home open balance.
    const bill = await createBill(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-06-23'),
      exchangeRate: '1.0712',
      lines: [{ accountId: acct['6300'], amount: '100.00' }],
    } as never);
    await payBills(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-06-24'),
      method: 'check',
      reference: '9950',
      paymentAccountId: acct['1000'],
      exchangeRate: '1.20',
      applications: [{ billId: bill.id, amountApplied: '33.33' }],
    });
    const aging = await apAging(ctx, d('2026-12-31'));
    const row = aging.rows.find((r) => r.id === eurVendor.id)!;
    expect(row.total).toBe('71.42'); // 107.12 - round2(33.33 x 1.0712)=35.70
    expect(Money.of(aging.totals.total).toFixed(2)).toBe(await bal('2000'));
    await tbOk();
  });
});
