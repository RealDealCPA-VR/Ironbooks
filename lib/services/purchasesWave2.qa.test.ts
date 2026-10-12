/**
 * wave2 purchases — independent QA (tester). Adversarial tests for the A/P + banking gaps:
 * D1 edit-after-save (rollback, closing date, reconciled-line guard, subledgers),
 * D2 Items tab on checks (QOH / average cost / inventory asset == subledger, FX cost),
 * D3 print queue (idempotency, duplicate numbers on print, voided checks),
 * D4 check printer setup (malformed offsets / styles),
 * D5 terms (parsing edge cases, discount window boundaries, filters),
 * D6 vendor purchase fields,
 * F1 Loan Manager (schedule math, payoff, escrow, rollback, liability == loan balance),
 * A3/A4 duplicate numbers (scope: account / vendor, void frees, case/whitespace),
 * J10 multi-currency (penny allocation, A/P control == home subledger, discounts + FX,
 *     vendor credits, A/P aging in home currency),
 * plus permission-map and zod-schema checks.
 * Every scenario re-checks: trial balance + balance sheet balanced, A/P control == subledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, ne } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  vendors,
  items,
  customers,
  paymentsReceived,
  bills,
  billPaymentApplications,
  billPayments,
  vendorCredits,
  journalEntries,
  purchaseOrderLines,
  loanPayments,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { apAging } from './reportsExtra';
import { postJournalEntry } from './posting';
import { createExpense, updateExpense, voidExpense, getExpense } from './expenses';
import { createBill, updateBill, voidBill, getBill, listBillsToPay } from './bills';
import { payBills, updateBillPayment, voidBillPayment, getBillPayment } from './billPayments';
import { createVendorCredit, updateVendorCredit, applyToBill, voidVendorCredit } from './vendorCredits';
import { createTransfer, updateTransfer } from './transfers';
import { createPurchaseOrder, updatePurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { createItemReceipt, updateItemReceipt, convertToBill } from './itemReceipts';
import { createDeposit, updateDeposit, listUndepositedPayments } from './deposits';
import { createBankAccount } from './bankAccounts';
import { startReconciliation, listClearable, toggleCleared, completeReconciliation } from './reconcile';
import { setClosingDate } from './company';
import { upsertCurrency, setBaseCurrency, setAccountCurrency, homeAmounts } from './currencies';
import { parseTerms, dueDateFromTerms, discountFor } from './billTerms';
import { listPrintQueue, markPrinted, saveCheckPrintSettings, getCheckPrintSettings } from './printQueue';
import { nextCheckNumber, findDuplicateCheckNumbers } from './checkNumbers';
import { createVendor, updateVendor } from './vendors';
import { adjustInventory } from './inventory';
import {
  createLoan,
  getLoan,
  setUpLoanPayment,
  amortizationSchedule,
  periodicPayment,
  numberOfPayments,
} from './loans';
import { numberToWords, offsetToPoints } from '@/lib/pdf/check';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import { loanPaymentSchema, markPrintedSchema, checkPrintSettingsSchema, loanSchema } from '@/lib/validation/purchases';
import { expenseLineSchema } from '@/lib/validation/expenses';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchases-wave2-qa');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext; // a second company (cross-tenant checks)
const acct: Record<string, string> = {};
let foreignAcct2: string;

const d = (s: string) => new Date(`${s}T12:00:00Z`);
let vendorSeq = 0;

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}

async function mkVendor(extra: Record<string, unknown> = {}) {
  vendorSeq += 1;
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName: `QA Vendor ${vendorSeq}`, ...extra } as never)
    .returning();
  return v;
}

async function mkInventoryItem(name: string) {
  const [it] = await db
    .insert(items)
    .values({
      companyId: ctx.companyId,
      name,
      type: 'inventory',
      assetAccountId: acct['1300'],
      quantityOnHand: '0',
      averageCost: '0',
    } as never)
    .returning();
  return it;
}

async function itemRow(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row;
}

/**
 * Home-currency A/P subledger: open bills (home balanceDue; foreign = booked home anchor minus
 * home A/P already relieved) minus unapplied vendor credits.
 */
async function apSubledgerHome(): Promise<string> {
  const rows = await db
    .select()
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), ne(bills.status, 'void')));
  let sum = Money.zero();
  for (const b of rows) {
    if (!b.currency) {
      sum = sum.plus(Money.of(b.balanceDue));
      continue;
    }
    const anchor = Money.round2(Money.of(b.total).times(Money.of(b.exchangeRate ?? 1)));
    const apps = await db
      .select({ home: billPaymentApplications.amountHome, applied: billPaymentApplications.amountApplied })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(and(eq(billPaymentApplications.billId, b.id), isNull(billPayments.voidedAt)));
    const relieved = apps.reduce((s, a) => s.plus(Money.of(a.home ?? a.applied)), Money.zero());
    sum = sum.plus(anchor.minus(relieved));
  }
  const vcs = await db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, ctx.companyId), ne(vendorCredits.status, 'void')));
  for (const vc of vcs) sum = sum.minus(Money.of(vc.unapplied));
  return sum.toFixed(2);
}

/** TB balanced, BS balanced, A/P control == subledger, inventory asset == stock subledger. */
async function invariants() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(
    Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2),
  );
  expect(await apSubledgerHome()).toBe(await bal('2000'));
  // Average-cost stock subledger vs the inventory asset account (items here use clean costs).
  const inv = await db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));
  const value = inv.reduce(
    (s, i) => s.plus(Money.of(i.quantityOnHand ?? 0).times(Money.of(i.averageCost ?? 0))),
    Money.zero(),
  );
  expect(Money.of(value).minus(Money.of(await bal('1300'))).abs().lessThanOrEqualTo('0.05')).toBe(true);
}

async function reconcileAll(accountCode: string, statementDate: Date) {
  const bank = await createBankAccount(ctx, {
    accountId: acct[accountCode],
    bankName: `Bank ${accountCode}`,
    accountNumber: `99887766${accountCode}`,
  });
  const recon = await startReconciliation(ctx, {
    bankAccountId: bank.id,
    statementDate,
    statementBalance: await bal(accountCode),
  } as never);
  const lines = await listClearable(ctx, bank.id, statementDate, recon.id);
  for (const l of lines) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
  await completeReconciliation(ctx, recon.id);
}

async function withClosingDate<T>(date: string, fn: () => Promise<T>): Promise<T> {
  await setClosingDate(ctx, { closingDate: date } as never);
  try {
    return await fn();
  } finally {
    await setClosingDate(ctx, { closingDate: null } as never);
  }
}

describe('wave2 purchases — QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'w2p-qa@test.local', name: 'QA', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Purchases QA Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1011', 'Recon Bank A', 'asset', 'checking'],
      ['1012', 'Recon Bank B', 'asset', 'checking'],
      ['1020', 'Euro Bank', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['1400', 'Escrow Deposits', 'asset', 'savings'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2100', 'Visa', 'liability', 'credit_card'],
      ['2600', 'Truck Loan', 'liability', 'long_term_liability'],
      ['2610', 'Short Loan', 'liability', 'long_term_liability'],
      ['2620', 'Escrow Loan', 'liability', 'long_term_liability'],
      ['2630', 'Euro Lender Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['4950', 'Discounts Taken', 'revenue', 'other_income'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6100', 'Bank Fees', 'expense', 'operating_expenses'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
      ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype } as never)).id;
    }
    foreignAcct2 = (await createAccount(ctx2, { code: '6300', name: 'Other co supplies', type: 'expense' as never, subtype: 'operating_expenses' } as never)).id;

    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '50000.00' },
        { accountId: acct['1011'], debit: '5000.00' },
        { accountId: acct['1012'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '60000.00' },
      ],
    });

    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' } as never);
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.0712' } as never);
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes the dir first. */
    }
  });

  // ======================================================================== D1 rollback
  describe('D1 edit-after-save: atomicity, closing date, reconciliation', () => {
    it('bill payment edit into a closed period rolls back completely (bill, payment, entry)', async () => {
      const v = await mkVendor();
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '300.00' }] });
      const pay = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-04-11'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill.id, amountApplied: '100.00' }],
      });
      const bankBefore = await bal('1000');
      await withClosingDate('2026-01-31', async () => {
        await expect(
          updateBillPayment(ctx, pay.id, {
            vendorId: v.id,
            date: d('2026-01-20'),
            method: 'check',
            paymentAccountId: acct['1000'],
            applications: [{ billId: bill.id, amountApplied: '250.00' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      });
      const b = await getBill(ctx, bill.id);
      expect(b.balanceDue).toBe('200.00');
      expect(b.status).toBe('partial');
      const p = await getBillPayment(ctx, pay.id);
      expect(p.amount).toBe('100.00');
      expect(p.postedEntryId).toBe(pay.postedEntryId);
      expect(p.applications).toHaveLength(1);
      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, pay.postedEntryId!));
      expect(je.status).toBe('posted');
      expect(await bal('1000')).toBe(bankBefore);
      await invariants();
    });

    it('bill payment edit cannot over-apply a bill, move vendors, or pay another vendor’s bill', async () => {
      const v = await mkVendor();
      const v2 = await mkVendor();
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '300.00' }] });
      const other = await createBill(ctx, { vendorId: v2.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
      const pay = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-04-11'),
        method: 'ach',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill.id, amountApplied: '100.00' }],
      });
      const base = { vendorId: v.id, date: d('2026-04-11'), method: 'ach' as const, paymentAccountId: acct['1000'] };
      // exactly the full bill is fine (old application is rolled back first) ...
      await updateBillPayment(ctx, pay.id, { ...base, applications: [{ billId: bill.id, amountApplied: '300.00' }] });
      expect((await getBill(ctx, bill.id)).status).toBe('paid');
      // ... one cent more is not, and nothing changes.
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, applications: [{ billId: bill.id, amountApplied: '300.01' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect((await getBill(ctx, bill.id)).balanceDue).toBe('0.00');
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, vendorId: v2.id, applications: [{ billId: other.id, amountApplied: '10.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, applications: [{ billId: other.id, amountApplied: '10.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect((await getBill(ctx, other.id)).balanceDue).toBe('50.00');
      expect((await getBillPayment(ctx, pay.id)).amount).toBe('300.00');
      // Voided payments cannot be edited.
      await voidBillPayment(ctx, pay.id);
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, applications: [{ billId: bill.id, amountApplied: '10.00' }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await getBill(ctx, bill.id)).balanceDue).toBe('300.00');
      await invariants();
    });

    it('check edit that would un-receive consumed stock is refused and rolls back (QOH, GL)', async () => {
      const it1 = await mkInventoryItem('QA Consumed Widget');
      const exp = await createExpense(ctx, {
        payeeName: 'Parts Store',
        date: d('2026-03-01'),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ itemId: it1.id, quantity: '10', unitCost: '4.00' }],
      });
      await adjustInventory(ctx, { itemId: it1.id, quantityChange: '-8', date: d('2026-03-02'), memo: 'used' });
      const invBefore = await bal('1300');
      const bankBefore = await bal('1000');
      await expect(
        updateExpense(ctx, exp.id, {
          payeeName: 'Parts Store',
          date: d('2026-03-01'),
          method: 'check',
          reference: exp.reference,
          paymentAccountId: acct['1000'],
          lines: [{ itemId: it1.id, quantity: '5', unitCost: '4.00' }],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(Money.of((await itemRow(it1.id)).quantityOnHand).toFixed(2)).toBe('2.00');
      expect(await bal('1300')).toBe(invBefore);
      expect(await bal('1000')).toBe(bankBefore);
      const got = await getExpense(ctx, exp.id);
      expect(got.postedEntryId).toBe(exp.postedEntryId);
      expect(got.total).toBe('40.00');
      await invariants();
    });

    it('memo-only edit of a check dated in a closed period does not touch the ledger', async () => {
      const exp = await createExpense(ctx, {
        payeeName: 'Old Payee',
        date: d('2026-01-10'),
        method: 'cash',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '12.00' }],
      });
      await withClosingDate('2026-01-31', async () => {
        // Amount change of a closed-period check is refused ...
        await expect(
          updateExpense(ctx, exp.id, {
            payeeName: 'Old Payee',
            date: d('2026-01-10'),
            method: 'cash',
            paymentAccountId: acct['1000'],
            lines: [{ accountId: acct['6300'], amount: '13.00' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        // ... and moving it OUT of the closed period is refused too (old date closed).
        await expect(
          updateExpense(ctx, exp.id, {
            payeeName: 'Old Payee',
            date: d('2026-02-10'),
            method: 'cash',
            paymentAccountId: acct['1000'],
            lines: [{ accountId: acct['6300'], amount: '12.00' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      });
      expect((await getExpense(ctx, exp.id)).total).toBe('12.00');
      await invariants();
    });

    it('reconciled bill payment: number change OK, amount change blocked with a plain message', async () => {
      const v = await mkVendor();
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ accountId: acct['6400'], amount: '400.00' }] });
      const pay = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-02-05'),
        method: 'check',
        reference: '3001',
        paymentAccountId: acct['1011'],
        applications: [{ billId: bill.id, amountApplied: '400.00' }],
      });
      await reconcileAll('1011', d('2026-02-28'));
      const base = { vendorId: v.id, date: d('2026-02-05'), method: 'check' as const, paymentAccountId: acct['1011'] };
      const renum = await updateBillPayment(ctx, pay.id, { ...base, reference: '3002', applications: [{ billId: bill.id, amountApplied: '400.00' }] });
      expect(renum.reference).toBe('3002');
      expect(renum.postedEntryId).toBe(pay.postedEntryId);
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, reference: '3002', applications: [{ billId: bill.id, amountApplied: '300.00' }] }),
      ).rejects.toThrow(/reconciliation/);
      // Changing the date of a cleared check is blocked too.
      await expect(
        updateBillPayment(ctx, pay.id, { ...base, date: d('2026-02-06'), reference: '3002', applications: [{ billId: bill.id, amountApplied: '400.00' }] }),
      ).rejects.toThrow(/reconciliation/);
      expect((await getBill(ctx, bill.id)).status).toBe('paid');
      await invariants();
    });

    it('reconciled transfer: memo OK, amount / account blocked; from == to refused', async () => {
      const t = await createTransfer(ctx, { date: d('2026-02-03'), fromAccountId: acct['1012'], toAccountId: acct['1000'], amount: '250.00' });
      await reconcileAll('1012', d('2026-02-28'));
      const ok = await updateTransfer(ctx, t.id, { date: d('2026-02-03'), fromAccountId: acct['1012'], toAccountId: acct['1000'], amount: '250.00', memo: 'to ops' });
      expect(ok.memo).toBe('to ops');
      expect(ok.postedEntryId).toBe(t.postedEntryId);
      await expect(
        updateTransfer(ctx, t.id, { date: d('2026-02-03'), fromAccountId: acct['1012'], toAccountId: acct['1000'], amount: '260.00' }),
      ).rejects.toThrow(/reconciliation/);
      await expect(
        updateTransfer(ctx, t.id, { date: d('2026-02-03'), fromAccountId: acct['1012'], toAccountId: acct['1011'], amount: '250.00' }),
      ).rejects.toThrow(/reconciliation/);
      const t2 = await createTransfer(ctx, { date: d('2026-03-03'), fromAccountId: acct['1000'], toAccountId: acct['1011'], amount: '5.00' });
      await expect(
        updateTransfer(ctx, t2.id, { date: d('2026-03-03'), fromAccountId: acct['1000'], toAccountId: acct['1000'], amount: '5.00' }),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        updateTransfer(ctx, t2.id, { date: d('2026-03-03'), fromAccountId: acct['1000'], toAccountId: acct['1011'], amount: '0' }),
      ).rejects.toBeInstanceOf(ServiceError);
      await invariants();
    });

    it('deposit edit: removed payment returns to Undeposited Funds (UF account == undeposited list)', async () => {
      const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'QA Customer' }).returning();
      const seed = async (amount: string, ref: string) => {
        await postJournalEntry(ctx, {
          date: d('2026-03-10'),
          description: `Payment ${ref}`,
          // Mimic receivePayment's posting: a customer payment carries its own (marked) A/R line
          // (wave2 foundation: unnamed A/R lines are only allowed as a document's control line).
          sourceRef: `customer:${cust.id}`,
          lines: [
            { accountId: acct['1050'], debit: amount },
            { accountId: acct['1200'], credit: amount, controlLine: true },
          ],
        });
        const [p] = await db
          .insert(paymentsReceived)
          .values({ companyId: ctx.companyId, customerId: cust.id, date: d('2026-03-10'), method: 'check', reference: ref, amount, unapplied: amount, depositAccountId: acct['1050'] } as never)
          .returning();
        return p.id;
      };
      const p1 = await seed('500.00', 'QA-1');
      const p2 = await seed('250.00', 'QA-2');
      const ufSubledger = async () =>
        (await listUndepositedPayments(ctx)).reduce((s, r) => s.plus(Money.of(r.amount)), Money.zero()).toFixed(2);

      const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-11'), paymentIds: [p1, p2] });
      expect(await bal('1050')).toBe(await ufSubledger());
      const dep2 = await updateDeposit(ctx, dep.id, { depositAccountId: acct['1000'], date: d('2026-03-11'), paymentIds: [p1] });
      expect(dep2.total).toBe('500.00');
      expect((await listUndepositedPayments(ctx)).map((r) => r.id)).toContain(p2);
      expect(await bal('1050')).toBe('250.00');
      expect(await bal('1050')).toBe(await ufSubledger());
      // p1 is still in the first deposit: it cannot be deposited twice.
      await expect(
        createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-12'), paymentIds: [p1] }),
      ).rejects.toBeInstanceOf(ServiceError);
      // Deposit with no lines at all is refused on edit.
      await expect(
        updateDeposit(ctx, dep.id, { depositAccountId: acct['1000'], date: d('2026-03-11'), paymentIds: [] }),
      ).rejects.toBeInstanceOf(ServiceError);
      // Depositing into Undeposited Funds itself is refused on edit.
      await expect(
        updateDeposit(ctx, dep.id, { depositAccountId: acct['1050'], date: d('2026-03-11'), paymentIds: [p1] }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect(await bal('1050')).toBe(await ufSubledger());
      await invariants();
    });

    it('vendor credit edit: applied credit cannot change amount; memo edit keeps the entry; cross-company account refused', async () => {
      const v = await mkVendor();
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
      const vc = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-05-02'), lines: [{ accountId: acct['6300'], amount: '40.00' }] });
      await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00' });
      await expect(
        updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-05-02'), lines: [{ accountId: acct['6300'], amount: '45.00' }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const memo = await updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-05-02'), memo: 'returned toner', lines: [{ accountId: acct['6300'], amount: '40.00' }] });
      expect(memo.memo).toBe('returned toner');
      expect(memo.postedEntryId).toBe(vc.postedEntryId);
      expect(memo.unapplied).toBe('25.00');

      const vc2 = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-05-03'), lines: [{ accountId: acct['6300'], amount: '10.00' }] });
      await expect(
        updateVendorCredit(ctx, vc2.id, { vendorId: v.id, date: d('2026-05-03'), lines: [{ accountId: foreignAcct2, amount: '10.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        updateVendorCredit(ctx, vc2.id, { vendorId: v.id, date: d('2026-05-03'), lines: [{ accountId: acct['6300'], amount: '-10.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      await invariants();
    });

    it('item receipt edit re-claims PO quantities; an over-receipt edit rolls back; billed receipts are locked', async () => {
      const v = await mkVendor();
      const gadget = await mkInventoryItem('QA Gadget');
      const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ itemId: gadget.id, quantity: '10', rate: '2' }] } as never);
      const ir = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-05-02'), purchaseOrderId: po.id, lines: [{ itemId: gadget.id, quantity: '4', unitCost: '2' }] });
      await updateItemReceipt(ctx, ir.id, { vendorId: v.id, date: d('2026-05-02'), purchaseOrderId: po.id, lines: [{ itemId: gadget.id, quantity: '6', unitCost: '2' }] });
      const poLine = async () => (await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id)))[0];
      expect(Money.of((await poLine()).quantityBilled).toFixed(0)).toBe('6');
      expect(Money.of((await itemRow(gadget.id)).quantityOnHand).toFixed(0)).toBe('6');

      await expect(
        updateItemReceipt(ctx, ir.id, { vendorId: v.id, date: d('2026-05-02'), purchaseOrderId: po.id, lines: [{ itemId: gadget.id, quantity: '11', unitCost: '2' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect(Money.of((await poLine()).quantityBilled).toFixed(0)).toBe('6');
      expect(Money.of((await itemRow(gadget.id)).quantityOnHand).toFixed(0)).toBe('6');

      // PO edit: received line cannot be removed or reduced below the received quantity.
      const full = await getPurchaseOrder(ctx, po.id);
      await expect(
        updatePurchaseOrder(ctx, po.id, { vendorId: v.id, date: d('2026-05-01'), lines: [{ accountId: acct['6300'], quantity: '1', rate: '1' }] } as never),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        updatePurchaseOrder(ctx, po.id, { vendorId: v.id, date: d('2026-05-01'), lines: [{ id: full.lines[0].id, itemId: gadget.id, quantity: '5', rate: '2' }] } as never),
      ).rejects.toBeInstanceOf(ServiceError);
      await expect(
        updatePurchaseOrder(ctx, po.id, { vendorId: (await mkVendor()).id, date: d('2026-05-01'), lines: [{ id: full.lines[0].id, itemId: gadget.id, quantity: '10', rate: '2' }] } as never),
      ).rejects.toBeInstanceOf(ServiceError);

      await convertToBill(ctx, ir.id);
      await expect(
        updateItemReceipt(ctx, ir.id, { vendorId: v.id, date: d('2026-05-02'), purchaseOrderId: po.id, lines: [{ itemId: gadget.id, quantity: '5', unitCost: '2' }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await invariants();
    });

    it('PO edit refuses accounts / items from another company', async () => {
      const v = await mkVendor();
      const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-05-04'), lines: [{ accountId: acct['6300'], quantity: '1', rate: '5' }] } as never);
      await expect(
        updatePurchaseOrder(ctx, po.id, { vendorId: v.id, date: d('2026-05-04'), lines: [{ accountId: foreignAcct2, quantity: '1', rate: '5' }] } as never),
      ).rejects.toBeInstanceOf(ServiceError);
    });
  });

  // ======================================================================== D2
  describe('D2 Items tab on checks / card charges', () => {
    it('edit re-receives at the new quantity; average cost and asset value stay in step', async () => {
      const w = await mkInventoryItem('QA Avg Widget');
      const exp = await createExpense(ctx, {
        payeeName: 'Supplier',
        date: d('2026-03-05'),
        method: 'credit_card',
        paymentAccountId: acct['2100'],
        lines: [{ itemId: w.id, quantity: '10', unitCost: '4.00' }],
      });
      const v = await mkVendor();
      await createBill(ctx, { vendorId: v.id, date: d('2026-03-06'), lines: [{ itemId: w.id, quantity: '10', unitCost: '6.00' }] });
      expect(Money.of((await itemRow(w.id)).averageCost).toFixed(2)).toBe('5.00');
      await updateExpense(ctx, exp.id, {
        payeeName: 'Supplier',
        date: d('2026-03-05'),
        method: 'credit_card',
        paymentAccountId: acct['2100'],
        lines: [{ itemId: w.id, quantity: '20', unitCost: '4.00' }],
      });
      const row = await itemRow(w.id);
      expect(Money.of(row.quantityOnHand).toFixed(2)).toBe('30.00');
      expect(Money.of(row.quantityOnHand).times(Money.of(row.averageCost)).toFixed(2)).toBe('140.00');
      await invariants();
    });

    it('rejects bad item lines: zero/negative qty, missing cost, unknown or other-company item, refund with items', async () => {
      const w = await mkInventoryItem('QA Reject Widget');
      const base = { payeeName: 'X', date: d('2026-03-07'), method: 'check' as const, paymentAccountId: acct['1000'] };
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: w.id, quantity: '0', unitCost: '1' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: w.id, quantity: '-1', unitCost: '1' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: w.id, quantity: '2' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: w.id, quantity: '2', unitCost: '-3' }] })).rejects.toBeInstanceOf(ServiceError);
      const [otherItem] = await db
        .insert(items)
        .values({ companyId: ctx2.companyId, name: 'Not ours', type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
        .returning();
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: otherItem.id, quantity: '1', unitCost: '1' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(
        createExpense(ctx, { ...base, method: 'credit_card', paymentAccountId: acct['2100'], isRefund: true, lines: [{ itemId: w.id, quantity: '1', unitCost: '1' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      // A non-inventory item with no expense account and no account picked.
      const [svc] = await db
        .insert(items)
        .values({ companyId: ctx.companyId, name: 'QA Service no acct', type: 'service', quantityOnHand: '0', averageCost: '0' } as never)
        .returning();
      await expect(createExpense(ctx, { ...base, lines: [{ itemId: svc.id, quantity: '1', unitCost: '5' }] })).rejects.toBeInstanceOf(ServiceError);
      expect(Money.of((await itemRow(w.id)).quantityOnHand).toFixed(0)).toBe('0');
      await invariants();
    });

    it('a non-inventory item line posts to its expense account and does not touch stock', async () => {
      const [svc] = await db
        .insert(items)
        .values({ companyId: ctx.companyId, name: 'QA Delivery', type: 'service', expenseAccountId: acct['6100'], quantityOnHand: '0', averageCost: '0' } as never)
        .returning();
      const before = await bal('6100');
      await createExpense(ctx, { payeeName: 'Courier', date: d('2026-03-08'), method: 'cash', paymentAccountId: acct['1000'], lines: [{ itemId: svc.id, quantity: '3', unitCost: '2.50' }] });
      expect(Money.of(await bal('6100')).minus(before).toFixed(2)).toBe('7.50');
      expect(Money.of((await itemRow(svc.id)).quantityOnHand).toFixed(0)).toBe('0');
      await invariants();
    });

    it('foreign-currency check with item lines receives stock at the HOME cost', async () => {
      const w = await mkInventoryItem('QA Euro Widget');
      const before = await bal('1300');
      const exp = await createExpense(ctx, {
        payeeName: 'Paris shop',
        date: d('2026-03-09'),
        method: 'check',
        paymentAccountId: acct['1020'],
        lines: [{ itemId: w.id, quantity: '3', unitCost: '3.33' }],
      });
      expect(exp.currency).toBe('EUR');
      // 9.99 EUR x 1.0712 = 10.7013 -> 10.70 home
      expect(Money.of(await bal('1300')).minus(before).toFixed(2)).toBe('10.70');
      const row = await itemRow(w.id);
      expect(Money.of(row.quantityOnHand).times(Money.of(row.averageCost)).toFixed(2)).toBe('10.70');
      await voidExpense(ctx, exp.id);
      expect(await bal('1300')).toBe(before);
      expect(Money.of((await itemRow(w.id)).quantityOnHand).toFixed(0)).toBe('0');
      await invariants();
    });
  });

  // ======================================================================== D3 / D4
  describe('D3 print queue / D4 printer setup', () => {
    it('printing is not idempotent-unsafe: second print, voided check and duplicate number are refused', async () => {
      const exp = await createExpense(ctx, {
        payeeName: 'Queue Payee',
        date: d('2026-04-01'),
        method: 'check',
        paymentAccountId: acct['1000'],
        toPrint: true,
        lines: [{ accountId: acct['6300'], amount: '20.00' }],
      });
      expect(exp.reference).toBeNull();
      expect((await listPrintQueue(ctx)).some((q) => q.id === exp.id)).toBe(true);
      const used = await createExpense(ctx, {
        payeeName: 'Numbered',
        date: d('2026-04-01'),
        method: 'check',
        reference: '7400',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
      });
      await expect(markPrinted(ctx, { source: 'expense', id: exp.id, checkNumber: '7400' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await getExpense(ctx, exp.id)).toPrint).toBe(true);
      // auto-number = next in sequence for the account
      const next = await nextCheckNumber(ctx, acct['1000']);
      const printed = (await markPrinted(ctx, { source: 'expense', id: exp.id })) as { reference: string };
      expect(printed.reference).toBe(next);
      await expect(markPrinted(ctx, { source: 'expense', id: exp.id, checkNumber: '9999' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await getExpense(ctx, exp.id)).reference).toBe(next);

      const exp2 = await createExpense(ctx, {
        payeeName: 'Void me',
        date: d('2026-04-02'),
        method: 'check',
        paymentAccountId: acct['1000'],
        toPrint: true,
        lines: [{ accountId: acct['6300'], amount: '3.00' }],
      });
      await voidExpense(ctx, exp2.id);
      expect((await listPrintQueue(ctx)).some((q) => q.id === exp2.id)).toBe(false);
      await expect(markPrinted(ctx, { source: 'expense', id: exp2.id })).rejects.toBeInstanceOf(ServiceError);
      await expect(markPrinted(ctx, { source: 'bogus' as never, id: exp2.id })).rejects.toBeInstanceOf(ServiceError);
      await expect(markPrinted(ctx, { source: 'bill_payment', id: used.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await invariants();
    });

    it('bill-payment check: queue filter by account, other company cannot print it, voided payment leaves the queue', async () => {
      const v = await mkVendor({ printOnCheckAs: 'Printed Name LLC', accountNumber: 'A-77' });
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-03'), lines: [{ accountId: acct['6300'], amount: '60.00' }] });
      const pay = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-04-04'),
        method: 'check',
        reference: '555',
        paymentAccountId: acct['1011'],
        toPrint: true,
        applications: [{ billId: bill.id, amountApplied: '60.00' }],
      });
      expect(pay.reference).toBeNull();
      const q = await listPrintQueue(ctx, { paymentAccountId: acct['1011'] });
      const item = q.find((x) => x.id === pay.id)!;
      expect(item.payee).toBe('Printed Name LLC');
      expect(item.memo).toBe('Acct # A-77');
      expect((await listPrintQueue(ctx, { paymentAccountId: acct['1012'] })).some((x) => x.id === pay.id)).toBe(false);
      await expect(markPrinted(ctx2, { source: 'bill_payment', id: pay.id, checkNumber: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await voidBillPayment(ctx, pay.id);
      expect((await listPrintQueue(ctx)).some((x) => x.id === pay.id)).toBe(false);
      await invariants();
    });

    it('printer setup rejects malformed values and keeps the last good settings', async () => {
      const good = await saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '-1', offsetY: '1' });
      expect(good).toEqual({ style: 'standard', offsetX: '-1.00', offsetY: '1.00' });
      await expect(saveCheckPrintSettings(ctx, { style: 'fancy', offsetX: '0', offsetY: '0' })).rejects.toBeInstanceOf(ServiceError);
      await expect(saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: '1.001', offsetY: '0' })).rejects.toBeInstanceOf(ServiceError);
      await expect(saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: 'NaN', offsetY: '0' })).rejects.toBeInstanceOf(ServiceError);
      await expect(saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: 'Infinity', offsetY: '0' })).rejects.toBeInstanceOf(ServiceError);
      expect(await getCheckPrintSettings(ctx)).toEqual(good);
      // Settings are per company.
      expect((await getCheckPrintSettings(ctx2)).style).toBe('voucher');
      expect(offsetToPoints('5')).toBe(72);
      expect(offsetToPoints('garbage')).toBe(0);
      expect(numberToWords('1000000.01')).toBe('One Million and 01/100');
      expect(numberToWords('4.35')).toBe('Four and 35/100');
    });
  });

  // ======================================================================== D5
  describe('D5 terms', () => {
    it('parses edge cases and computes due dates across month ends / leap years', () => {
      expect(parseTerms('1.5% 10 Net 30')).toEqual({ netDays: 30, discountPercent: 1.5, discountDays: 10 });
      expect(parseTerms('NET 60')).toEqual({ netDays: 60, discountPercent: 0, discountDays: 0 });
      expect(parseTerms('Due on Receipt')).toEqual({ netDays: 0, discountPercent: 0, discountDays: 0 });
      expect(parseTerms('whenever')).toBeNull();
      expect(parseTerms('   ')).toBeNull();
      expect(parseTerms(null)).toBeNull();
      expect(dueDateFromTerms(d('2028-02-15'), 'net_15')!.toISOString().slice(0, 10)).toBe('2028-03-01');
      expect(dueDateFromTerms(d('2026-12-20'), 'net_30')!.toISOString().slice(0, 10)).toBe('2027-01-19');
      expect(dueDateFromTerms(d('2026-12-20'), 'mystery')).toBeNull();
    });

    it('discount window is inclusive of the last day and suggestion uses the open balance', () => {
      const bill = { date: d('2026-04-01'), terms: '2_10_net_30', balanceDue: '333.33', total: '1000.00' };
      expect(discountFor(bill, d('2026-04-11')).available).toBe(true);
      expect(discountFor(bill, d('2026-04-11')).suggestedDiscount).toBe('6.67');
      expect(discountFor(bill, d('2026-04-12')).available).toBe(false);
      expect(discountFor(bill, d('2026-04-12')).suggestedDiscount).toBe('0.00');
      expect(discountFor({ ...bill, terms: 'net_30' }, d('2026-04-02')).suggestedDiscount).toBe('0.00');
    });

    it('explicit due date wins over terms; unknown terms leave no due date; filters keep undated bills', async () => {
      const v = await mkVendor({ terms: 'net_30' });
      const explicit = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), dueDate: d('2026-06-05'), lines: [{ accountId: acct['6300'], amount: '1.00' }] });
      expect(explicit.dueDate!.toISOString().slice(0, 10)).toBe('2026-06-05');
      const v2 = await mkVendor({ terms: null });
      const undated = await createBill(ctx, { vendorId: v2.id, date: d('2026-06-01'), lines: [{ accountId: acct['6300'], amount: '1.00' }] });
      expect(undated.dueDate).toBeNull();
      expect((await listBillsToPay(ctx, { vendorId: v2.id, dueOnOrBefore: d('2026-01-01') })).map((b) => b.id)).toContain(undated.id);
      const overridden = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), terms: '2_10_net_30', lines: [{ accountId: acct['6300'], amount: '1.00' }] });
      expect(overridden.dueDate!.toISOString().slice(0, 10)).toBe('2026-07-01');
      await invariants();
    });
  });

  // ======================================================================== A3 / A4
  describe('A3/A4 duplicate numbers', () => {
    it('check numbers are scoped to the bank account, trimmed, freed by void, and shared with bill payments', async () => {
      const mk = (ref: string, accountCode = '1000', check = true) =>
        createExpense(ctx, {
          payeeName: 'Dup',
          date: d('2026-04-05'),
          method: 'check',
          reference: ref,
          paymentAccountId: acct[accountCode],
          lines: [{ accountId: acct['6300'], amount: '1.00' }],
          checkDuplicateNumber: check,
        });
      const first = await mk('8100');
      await expect(mk(' 8100 ')).rejects.toMatchObject({ code: 'CONFLICT', details: { duplicateNumber: true } });
      await mk('8100', '1011'); // other account: fine
      await voidExpense(ctx, first.id);
      await mk('8100'); // voided check's number is free again

      const v = await mkVendor();
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-05'), lines: [{ accountId: acct['6300'], amount: '5.00' }] });
      await expect(
        payBills(ctx, {
          vendorId: v.id,
          date: d('2026-04-06'),
          method: 'check',
          reference: '8100',
          paymentAccountId: acct['1000'],
          checkDuplicateNumber: true,
          applications: [{ billId: bill.id, amountApplied: '5.00' }],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Nothing was posted by the refused payment.
      expect((await getBill(ctx, bill.id)).balanceDue).toBe('5.00');
      const bp = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-04-06'),
        method: 'check',
        reference: '8101',
        paymentAccountId: acct['1000'],
        checkDuplicateNumber: true,
        applications: [{ billId: bill.id, amountApplied: '5.00' }],
      });
      expect((await findDuplicateCheckNumbers(ctx, { paymentAccountId: acct['1000'], number: '8101' })).map((m) => m.id)).toEqual([bp.id]);
      // Editing a check to keep its own number is not a duplicate.
      const own = await mk('8102');
      await updateExpense(ctx, own.id, {
        payeeName: 'Dup',
        date: d('2026-04-05'),
        method: 'check',
        reference: '8102',
        paymentAccountId: acct['1000'],
        memo: 'same number',
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
        checkDuplicateNumber: true,
      });
      await expect(
        updateExpense(ctx, own.id, {
          payeeName: 'Dup',
          date: d('2026-04-05'),
          method: 'check',
          reference: '8101',
          paymentAccountId: acct['1000'],
          lines: [{ accountId: acct['6300'], amount: '1.00' }],
          checkDuplicateNumber: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await invariants();
    });

    it('vendor bill numbers: per vendor, case-insensitive, void frees, self-edit is not a duplicate', async () => {
      const v = await mkVendor();
      const v2 = await mkVendor();
      const mk = (vendorId: string, num: string) =>
        createBill(ctx, { vendorId, billNumber: num, date: d('2026-04-07'), lines: [{ accountId: acct['6300'], amount: '2.00' }], checkDuplicateNumber: true });
      const b1 = await mk(v.id, 'INV-100');
      await expect(mk(v.id, 'inv-100 ')).rejects.toMatchObject({ code: 'CONFLICT' });
      await mk(v2.id, 'INV-100');
      await updateBill(ctx, b1.id, { vendorId: v.id, billNumber: 'INV-100', date: d('2026-04-07'), memo: 'edit', lines: [{ accountId: acct['6300'], amount: '3.00' }], checkDuplicateNumber: true });
      await voidBill(ctx, b1.id);
      await mk(v.id, 'INV-100');
      await invariants();
    });
  });

  // ======================================================================== D6
  describe('D6 vendor purchase fields', () => {
    it('pre-fill accounts: dedupe, other-company accounts refused, clearing works', async () => {
      const v = await createVendor(ctx, { displayName: 'QA Prefill', prefillAccountIds: [acct['6300'], acct['6300'], acct['6400']] });
      expect(v.prefillAccountIds).toEqual([acct['6300'], acct['6400']]);
      await expect(updateVendor(ctx, v.id, { prefillAccountIds: [foreignAcct2] })).rejects.toBeInstanceOf(ServiceError);
      const cleared = await updateVendor(ctx, v.id, { prefillAccountIds: [] });
      expect(cleared.prefillAccountIds).toBeNull();
    });

    it('vendor currency cannot change once the vendor has a vendor credit', async () => {
      const v = await createVendor(ctx, { displayName: 'QA Credit Only' });
      await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-04-08'), lines: [{ accountId: acct['6300'], amount: '9.00' }] });
      await expect(updateVendor(ctx, v.id, { currency: 'EUR' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await invariants();
    });

    it('vendor currency must exist in the currency list', async () => {
      await expect(createVendor(ctx, { displayName: 'QA Yen', currency: 'JPY' })).rejects.toBeInstanceOf(ServiceError);
    });
  });

  // ======================================================================== F1
  describe('F1 Loan Manager', () => {
    it('schedule math: zero rate, weekly frequency and prepayments all end exactly at 0.00', () => {
      for (const [rate, months, ppy] of [
        ['0', 12, 12],
        ['7.25', 36, 52],
        ['18', 60, 26],
        ['3.5', 360, 12],
      ] as const) {
        const n = numberOfPayments(months, ppy);
        const pay = periodicPayment('12345.67', rate, n, ppy);
        const s = amortizationSchedule({ balance: '12345.67', annualRate: rate, paymentsPerYear: ppy, totalPayments: n, nextNumber: 1, firstPaymentDate: d('2026-01-31'), payment: pay });
        expect(s).toHaveLength(n);
        expect(s[s.length - 1].balance).toBe('0.00');
        expect(s.reduce((acc, r) => acc.plus(Money.of(r.principal)), Money.zero()).toFixed(2)).toBe('12345.67');
        for (const r of s) expect(Money.of(r.principal).isNegative()).toBe(false);
      }
      // Monthly from Jan 31 never skips a month.
      const s = amortizationSchedule({ balance: '100', annualRate: '0', paymentsPerYear: 12, totalPayments: 3, nextNumber: 1, firstPaymentDate: d('2026-01-31'), payment: '33.34' });
      expect(s.map((r) => r.date.toISOString().slice(0, 7))).toEqual(['2026-01', '2026-02', '2026-03']);
    });

    it('validates loan setup', async () => {
      const base = {
        name: 'Bad',
        liabilityAccountId: acct['2610'],
        interestAccountId: acct['6800'],
        originalAmount: '1000',
        annualRate: '5',
        termMonths: 12,
        originDate: d('2026-01-01'),
        firstPaymentDate: d('2026-02-01'),
      };
      await expect(createLoan(ctx, { ...base, liabilityAccountId: acct['6300'] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, interestAccountId: acct['2000'] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, annualRate: '101' })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, annualRate: '-1' })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, originalAmount: '0' })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, termMonths: 0 })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, termMonths: 1.5 })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, paymentsPerYear: 7 })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, escrowAmount: '10' })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx, { ...base, liabilityAccountId: foreignAcct2 })).rejects.toBeInstanceOf(ServiceError);
      await expect(createLoan(ctx2, { ...base, liabilityAccountId: acct['2610'] })).rejects.toBeInstanceOf(ServiceError);
    });

    it('pays a short loan off exactly: liability == loan balance after every payment, then no next payment', async () => {
      await postJournalEntry(ctx, {
        date: d('2026-01-02'),
        description: 'Short loan proceeds',
        lines: [
          { accountId: acct['1000'], debit: '1000.00' },
          { accountId: acct['2610'], credit: '1000.00' },
        ],
      });
      const loan = await createLoan(ctx, {
        name: 'Short',
        liabilityAccountId: acct['2610'],
        interestAccountId: acct['6800'],
        paymentAccountId: acct['1000'],
        originalAmount: '1000.00',
        annualRate: '9.99',
        termMonths: 3,
        originDate: d('2026-01-02'),
        firstPaymentDate: d('2026-02-02'),
      });
      for (let k = 0; k < 3; k++) {
        await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
        const l = await getLoan(ctx, loan.id);
        expect(l.balance).toBe(await bal('2610'));
      }
      const done = await getLoan(ctx, loan.id);
      expect(done.balance).toBe('0.00');
      expect(done.next).toBeNull();
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '0.01' })).rejects.toBeInstanceOf(ServiceError);
      expect(await bal('2610')).toBe('0.00');
      await invariants();
    });

    it('escrow split, prepayment and bad overrides; a failing payment leaves no loan payment row', async () => {
      await postJournalEntry(ctx, {
        date: d('2026-01-03'),
        description: 'Escrow loan proceeds',
        lines: [
          { accountId: acct['1000'], debit: '6000.00' },
          { accountId: acct['2620'], credit: '6000.00' },
        ],
      });
      const loan = await createLoan(ctx, {
        name: 'Mortgage-ish',
        liabilityAccountId: acct['2620'],
        interestAccountId: acct['6800'],
        escrowAccountId: acct['1400'],
        paymentAccountId: acct['1000'],
        originalAmount: '6000.00',
        annualRate: '6',
        termMonths: 12,
        originDate: d('2026-01-03'),
        firstPaymentDate: d('2026-02-03'),
        escrowAmount: '50.00',
      });
      const escrowBefore = await bal('1400');
      const bankBefore = await bal('1000');
      const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
      expect(lp.escrow).toBe('50.00');
      expect(lp.total).toBe(Money.of(lp.principal).plus(lp.interest).plus('50').toFixed(2));
      expect(Money.of(await bal('1400')).minus(escrowBefore).toFixed(2)).toBe('50.00');
      expect(Money.of(bankBefore).minus(await bal('1000')).toFixed(2)).toBe(lp.total);

      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '-1' })).rejects.toBeInstanceOf(ServiceError);
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '999999' })).rejects.toBeInstanceOf(ServiceError);
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '0', interest: '0', escrow: '0' })).rejects.toBeInstanceOf(ServiceError);
      // No lender => cannot be a bill; refused without leaving a payment row.
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'bill' })).rejects.toBeInstanceOf(ServiceError);
      // Duplicate check number on a loan payment is refused inside the transaction.
      await createExpense(ctx, { payeeName: 'Z', date: d('2026-02-01'), method: 'check', reference: '6601', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '1.00' }] });
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', reference: '6601' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const rows = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id));
      expect(rows).toHaveLength(1);

      // Extra principal: the schedule shortens and still ends at zero.
      await setUpLoanPayment(ctx, loan.id, { kind: 'check', principal: '3000.00' });
      const after = await getLoan(ctx, loan.id);
      expect(after.balance).toBe(await bal('2620'));
      expect(after.schedule[after.schedule.length - 1].balance).toBe('0.00');
      expect(after.schedule.length).toBeLessThan(10);
      await invariants();
    });

    it('a Loan Manager bill cannot be edited out of step with the loan (liability == loan balance)', async () => {
      await postJournalEntry(ctx, {
        date: d('2026-01-04'),
        description: 'Truck loan proceeds',
        lines: [
          { accountId: acct['1000'], debit: '20000.00' },
          { accountId: acct['2600'], credit: '20000.00' },
        ],
      });
      const lender = await mkVendor();
      const loan = await createLoan(ctx, {
        name: 'Truck QA',
        lenderVendorId: lender.id,
        liabilityAccountId: acct['2600'],
        interestAccountId: acct['6800'],
        paymentAccountId: acct['1000'],
        originalAmount: '20000',
        annualRate: '6',
        termMonths: 36,
        originDate: d('2026-01-04'),
        firstPaymentDate: d('2026-02-04'),
      });
      const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'bill' });
      const bill = await getBill(ctx, lp.billId!);
      // Move the whole payment to principal by editing the bill.
      const edit = updateBill(ctx, bill.id, {
        vendorId: lender.id,
        billNumber: bill.billNumber,
        date: bill.date,
        lines: [{ accountId: acct['2600'], amount: bill.total }],
      });
      await edit.catch(() => undefined);
      const l = await getLoan(ctx, loan.id);
      expect(l.balance).toBe(await bal('2600'));
      await expect(edit).rejects.toMatchObject({ code: 'CONFLICT' });
      await invariants();
    });

    it('a foreign-currency lender: loan payment keeps loan balance == liability (or is refused atomically)', async () => {
      await postJournalEntry(ctx, {
        date: d('2026-01-05'),
        description: 'Euro lender proceeds',
        lines: [
          { accountId: acct['1000'], debit: '500.00' },
          { accountId: acct['2630'], credit: '500.00' },
        ],
      });
      const lender = await mkVendor({ currency: 'EUR' });
      const loan = await createLoan(ctx, {
        name: 'Euro QA',
        lenderVendorId: lender.id,
        liabilityAccountId: acct['2630'],
        interestAccountId: acct['6800'],
        paymentAccountId: acct['1000'],
        originalAmount: '500',
        annualRate: '4',
        termMonths: 6,
        originDate: d('2026-01-05'),
        firstPaymentDate: d('2026-02-05'),
      });
      // Either refused (and then nothing at all was written) or posted so that the loan
      // balance still equals the liability account (principal posted in the loan's currency).
      let refused = false;
      try {
        await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceError);
        refused = true;
      }
      if (refused) {
        expect(await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id))).toHaveLength(0);
        expect(await bal('2630')).toBe('500.00');
      }
      expect((await getLoan(ctx, loan.id)).balance).toBe(await bal('2630'));
      await invariants();
    });
  });

  // ======================================================================== J10
  describe('J10 multi-currency purchases', () => {
    it('penny allocation: awkward rate, many lines, three partial payments clear A/P to the cent', async () => {
      const v = await mkVendor({ currency: 'EUR' });
      const apBefore = await bal('2000');
      const bill = await createBill(ctx, {
        vendorId: v.id,
        date: d('2026-06-01'),
        lines: [
          { accountId: acct['6300'], amount: '33.33' },
          { accountId: acct['6300'], amount: '33.33' },
          { accountId: acct['6400'], amount: '33.34' },
        ],
      });
      expect(Money.of(await bal('2000')).minus(apBefore).toFixed(2)).toBe('107.12');
      await invariants();
      for (const amt of ['33.33', '33.33', '33.34']) {
        await payBills(ctx, {
          vendorId: v.id,
          date: d('2026-06-10'),
          method: 'ach',
          paymentAccountId: acct['1000'],
          applications: [{ billId: bill.id, amountApplied: amt }],
        });
        await invariants();
      }
      expect((await getBill(ctx, bill.id)).status).toBe('paid');
      expect(await bal('2000')).toBe(apBefore);
      const h = homeAmounts(['0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '0.01'], '1.0712');
      expect(h.total.toFixed(2)).toBe('0.07');
      expect(h.lines.reduce((s, x) => s.plus(x), Money.zero()).toFixed(2)).toBe('0.07');
    });

    it('foreign bill paid early with a discount at a different rate: A/P fully relieved, FX plug balances', async () => {
      const v = await mkVendor({ currency: 'EUR', terms: '2_10_net_30' });
      const apBefore = await bal('2000');
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6300'], amount: '1000.00' }] });
      const bankBefore = await bal('1000');
      await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-06-05'),
        method: 'check',
        reference: '9500',
        paymentAccountId: acct['1000'],
        discountAccountId: acct['4950'],
        exchangeRate: '1.05',
        applications: [{ billId: bill.id, amountApplied: '980.00', discountTaken: '20.00' }],
      });
      expect(await bal('2000')).toBe(apBefore);
      expect(Money.of(bankBefore).minus(await bal('1000')).toFixed(2)).toBe('1029.00');
      await invariants();
    });

    it('editing / voiding a foreign bill payment keeps A/P home control == subledger', async () => {
      const v = await mkVendor({ currency: 'EUR' });
      const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-02'), lines: [{ accountId: acct['6300'], amount: '77.77' }] });
      const pay = await payBills(ctx, { vendorId: v.id, date: d('2026-06-03'), method: 'ach', paymentAccountId: acct['1000'], exchangeRate: '1.2', applications: [{ billId: bill.id, amountApplied: '77.77' }] });
      await invariants();
      await updateBillPayment(ctx, pay.id, { vendorId: v.id, date: d('2026-06-03'), method: 'ach', paymentAccountId: acct['1000'], exchangeRate: '0.9', applications: [{ billId: bill.id, amountApplied: '20.00' }] });
      await invariants();
      await voidBillPayment(ctx, pay.id);
      expect((await getBill(ctx, bill.id)).balanceDue).toBe('77.77');
      await invariants();
    });

    it('rejects mismatched currencies and bad exchange rates', async () => {
      const eur = await mkVendor({ currency: 'EUR' });
      const home = await mkVendor();
      await expect(createBill(ctx, { vendorId: eur.id, date: d('2026-06-04'), exchangeRate: '0', lines: [{ accountId: acct['6300'], amount: '1.00' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createBill(ctx, { vendorId: eur.id, date: d('2026-06-04'), exchangeRate: '-1.1', lines: [{ accountId: acct['6300'], amount: '1.00' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createBill(ctx, { vendorId: home.id, date: d('2026-06-04'), currency: 'EUR', lines: [{ accountId: acct['6300'], amount: '1.00' }] })).rejects.toBeInstanceOf(ServiceError);
      await expect(createBill(ctx, { vendorId: home.id, date: d('2026-06-04'), currency: 'GBP', lines: [{ accountId: acct['6300'], amount: '1.00' }] })).rejects.toBeInstanceOf(ServiceError);
      // Bills in two currencies on one payment.
      const hb = await createBill(ctx, { vendorId: home.id, date: d('2026-06-04'), lines: [{ accountId: acct['6300'], amount: '1.00' }] });
      await expect(
        payBills(ctx, { vendorId: home.id, date: d('2026-06-05'), method: 'ach', paymentAccountId: acct['1020'], applications: [{ billId: hb.id, amountApplied: '1.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      // A EUR account cannot get a home-currency card charge / a USD currency override.
      await expect(
        createExpense(ctx, { payeeName: 'X', date: d('2026-06-05'), method: 'check', currency: 'USD', paymentAccountId: acct['1020'], lines: [{ accountId: acct['6300'], amount: '1.00' }] }),
      ).rejects.toBeInstanceOf(ServiceError);
      // Bank account currency is locked once it has transactions.
      await expect(setAccountCurrency(ctx, acct['1000'], 'EUR')).rejects.toBeInstanceOf(ServiceError);
      await invariants();
    });

    it('a vendor credit for a foreign-currency vendor posts A/P in HOME currency', async () => {
      const v = await mkVendor({ currency: 'EUR' });
      const apBefore = await bal('2000');
      let createdId: string | null = null;
      try {
        createdId = (await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-06-06'), lines: [{ accountId: acct['6300'], amount: '100.00' }] })).id;
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceError); // refusing foreign vendor credits is acceptable
      }
      let apDrop: string | null = null;
      if (createdId) {
        apDrop = Money.of(apBefore).minus(await bal('2000')).toFixed(2);
        // Keep the shared books clean for later tests regardless of the outcome.
        await voidVendorCredit(ctx, createdId);
      }
      await invariants();
      // 100 EUR x 1.0712 = 107.12 home must come off A/P, not 100.00.
      if (apDrop !== null) expect(apDrop).toBe('107.12');
    });

    it('A/P aging reports foreign bills in home currency, so its total ties to the A/P account', async () => {
      const v = await mkVendor({ currency: 'EUR' });
      await createBill(ctx, { vendorId: v.id, date: d('2026-06-07'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
      const aging = await apAging(ctx, d('2026-12-31'));
      const row = aging.rows.find((r) => r.id === v.id)!;
      expect(row.total).toBe('107.12');
      expect(Money.of(aging.totals.total).toFixed(2)).toBe(await bal('2000'));
    });
  });

  // ======================================================================== permissions / schemas
  describe('permission map and request schemas', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    it('maps every new purchases route with a non-view action for mutations', () => {
      const cases: Array<[string, string, string]> = [
        ['/api/loans', 'GET', 'banking'],
        ['/api/loans', 'POST', 'banking'],
        [`/api/loans/${uuid}`, 'PATCH', 'banking'],
        [`/api/loans/${uuid}`, 'DELETE', 'banking'],
        [`/api/loans/${uuid}/payments`, 'POST', 'banking'],
        ['/api/print-queue', 'POST', 'banking'],
        ['/api/print-queue/paychecks', 'POST', 'payroll'],
        ['/api/checks/settings', 'PUT', 'banking'],
        [`/api/expenses/${uuid}`, 'PATCH', 'banking'],
        [`/api/deposits/${uuid}`, 'PATCH', 'banking'],
        [`/api/bill-payments/${uuid}`, 'PATCH', 'vendors'],
        [`/api/vendor-credits/${uuid}`, 'PATCH', 'vendors'],
        [`/api/purchase-orders/${uuid}`, 'PATCH', 'vendors'],
        [`/api/item-receipts/${uuid}`, 'PATCH', 'inventory'],
        [`/api/transfers/${uuid}`, 'PATCH', 'accounting'],
        ['/api/bills/to-pay', 'GET', 'vendors'],
        ['/api/check-numbers/duplicate', 'GET', 'banking'],
      ];
      for (const [p, m, area] of cases) {
        const rule = apiRuleFor(p, m);
        expect(rule, `${m} ${p}`).not.toBeNull();
        expect(typeof rule === 'object' && rule ? rule.area : rule, `${m} ${p}`).toBe(area);
        if (m !== 'GET') expect((rule as { action: string }).action, `${m} ${p}`).not.toBe('view');
      }
      expect(pageAreasFor('/loans')).toContain('banking');
    });

    it('schemas reject malformed input', () => {
      expect(markPrintedSchema.safeParse({ source: 'invoice', id: uuid }).success).toBe(false);
      expect(markPrintedSchema.safeParse({ source: 'expense', id: 'not-a-uuid' }).success).toBe(false);
      expect(checkPrintSettingsSchema.safeParse({ style: 'voucher', offsetX: '1e3', offsetY: '0' }).success).toBe(false);
      expect(loanPaymentSchema.safeParse({ kind: 'cash' }).success).toBe(false);
      expect(loanPaymentSchema.safeParse({ kind: 'check', principal: '1.234' }).success).toBe(false);
      expect(loanSchema.safeParse({ name: 'x', liabilityAccountId: uuid, interestAccountId: uuid, originalAmount: '10', annualRate: '5', termMonths: 0, originDate: '2026-01-01', firstPaymentDate: '2026-02-01' }).success).toBe(false);
      expect(expenseLineSchema.safeParse({ description: 'nothing' }).success).toBe(false);
      expect(expenseLineSchema.safeParse({ accountId: uuid }).success).toBe(false);
      expect(expenseLineSchema.safeParse({ itemId: uuid, quantity: '2', unitCost: '1.5' }).success).toBe(true);
    });
  });
});
