/**
 * Integration tests for the pay-bills-deposits package:
 *
 *  A. payBills — early-payment discounts taken
 *     - GL: Dr A/P (cash + discount), Cr bank (cash), Cr discount account
 *     - bill fully settled by cash + discount
 *     - validation: missing discount account, over-application, negative discount
 *     - voidBillPayment reverses the full settlement (cash + discount)
 *
 *  B. Deposits — sales receipts in UF, cash back, extra lines, void
 *     - listUndepositedPayments returns payments AND sales receipts
 *     - createDeposit mixes payments + receipts + extra line + cash back
 *     - line invariant: sum(deposit_lines.amount) === deposits.total (net)
 *     - voidDeposit reverses GL and returns items to the undeposited list
 *
 * Boot pattern mirrors deposits.test.ts / billPayments.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  vendors,
  bills,
  billLines,
  billPaymentApplications,
  paymentsReceived,
  salesReceipts,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { payBills, voidBillPayment } from './billPayments';
import {
  createDeposit,
  getDeposit,
  listUndepositedPayments,
  voidDeposit,
  RECEIPT_LINE_PREFIX,
  CASHBACK_LINE_PREFIX,
} from './deposits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-pay-bills-deposits');

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let vendorId: string;
let customerId: string;

async function balance(code: string): Promise<number> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Number(row.balance);
}

/** Seed an open bill: Dr expense / Cr A/P + bills row. Returns billId. */
async function seedBill(amount: string, billNumber: string): Promise<string> {
  const entry = await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date: new Date('2025-05-01'),
    description: `Bill ${billNumber}`,
    lines: [
      { accountId: acct['5000'], debit: amount },
      { accountId: acct['2000'], credit: amount },
    ],
  });
  const [bill] = await db
    .insert(bills)
    .values({
      companyId: ctx.companyId,
      vendorId,
      billNumber,
      date: new Date('2025-05-01'),
      dueDate: new Date('2025-05-31'),
      status: 'open',
      total: amount,
      amountPaid: '0.00',
      balanceDue: amount,
      postedEntryId: entry.id,
    })
    .returning();
  await db.insert(billLines).values({
    billId: bill.id,
    accountId: acct['5000'],
    description: 'Supplies',
    quantity: '1',
    amount,
  });
  return bill.id;
}

/** Seed a customer payment into Undeposited Funds (mirrors receivePayment). */
async function seedUFPayment(amount: string, ref: string): Promise<string> {
  await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date: new Date('2025-06-01'),
    description: `Payment ${ref}`,
    lines: [
      { accountId: acct['1050'], debit: amount },
      { accountId: acct['1200'], credit: amount },
    ],
  });
  const [pmt] = await db
    .insert(paymentsReceived)
    .values({
      companyId: ctx.companyId,
      customerId,
      date: new Date('2025-06-01'),
      method: 'check',
      reference: ref,
      amount,
      unapplied: '0',
      depositAccountId: acct['1050'],
    })
    .returning();
  return pmt.id;
}

/** Seed a sales receipt received into Undeposited Funds (mirrors createSalesReceipt). */
async function seedUFSalesReceipt(amount: string, receiptNumber: number): Promise<string> {
  await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date: new Date('2025-06-02'),
    description: `Sales Receipt #${receiptNumber}`,
    lines: [
      { accountId: acct['1050'], debit: amount },
      { accountId: acct['4000'], credit: amount },
    ],
  });
  const [sr] = await db
    .insert(salesReceipts)
    .values({
      companyId: ctx.companyId,
      customerId,
      receiptNumber,
      date: new Date('2025-06-02'),
      method: 'cash',
      status: 'paid',
      subtotal: amount,
      total: amount,
      depositAccountId: acct['1050'],
    })
    .returning();
  return sr.id;
}

describe('pay-bills-deposits package', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'pbd-test@bookkeeper.local', name: 'PBD Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'PBD Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Petty Cash', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3100', 'Owner Contribution', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4900', 'Discounts Taken', 'revenue', 'other_income'],
      ['5000', 'Office Supplies Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [v] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Acme Supply' })
      .returning();
    vendorId = v.id;

    const [c] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Beta Customer' })
      .returning();
    customerId = c.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A. payBills — early-payment discounts
  // ──────────────────────────────────────────────────────────────────────────

  describe('payBills with discountTaken', () => {
    let billId: string;

    it('rejects a discount without a discountAccountId', async () => {
      billId = await seedBill('500.00', 'BILL-D1');
      await expect(
        payBills(ctx, {
          vendorId,
          date: new Date('2025-05-10'),
          method: 'check',
          paymentAccountId: acct['1000'],
          applications: [{ billId, amountApplied: '490.00', discountTaken: '10.00' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects cash + discount exceeding the balance due', async () => {
      await expect(
        payBills(ctx, {
          vendorId,
          date: new Date('2025-05-10'),
          method: 'check',
          paymentAccountId: acct['1000'],
          discountAccountId: acct['4900'],
          applications: [{ billId, amountApplied: '495.00', discountTaken: '10.00' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects a negative discount', async () => {
      await expect(
        payBills(ctx, {
          vendorId,
          date: new Date('2025-05-10'),
          method: 'check',
          paymentAccountId: acct['1000'],
          discountAccountId: acct['4900'],
          applications: [{ billId, amountApplied: '490.00', discountTaken: '-10.00' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('settles the bill with cash 490 + discount 10 and posts the 3-line GL split', async () => {
      const chkBefore = await balance('1000');
      const apBefore = await balance('2000');
      const discBefore = await balance('4900');

      const payment = await payBills(ctx, {
        vendorId,
        date: new Date('2025-05-10'),
        method: 'check',
        reference: 'CHK-9001',
        paymentAccountId: acct['1000'],
        discountAccountId: acct['4900'],
        applications: [{ billId, amountApplied: '490.00', discountTaken: '10.00' }],
      });

      // Payment header carries CASH only.
      expect(payment.amount).toBe('490.00');

      // Bill is fully settled.
      const [bill] = await db.select().from(bills).where(eq(bills.id, billId));
      expect(bill.status).toBe('paid');
      expect(Number(bill.balanceDue)).toBeCloseTo(0, 2);
      expect(Number(bill.amountPaid)).toBeCloseTo(500, 2);

      // Application row stores the full settlement (cash + discount).
      const apps = await db
        .select()
        .from(billPaymentApplications)
        .where(eq(billPaymentApplications.billPaymentId, payment.id));
      expect(apps).toHaveLength(1);
      expect(apps[0].amountApplied).toBe('500.00');

      // GL: bank -490, A/P -500 (liability relieved), discount income +10.
      expect((await balance('1000')) - chkBefore).toBeCloseTo(-490, 2);
      expect((await balance('2000')) - apBefore).toBeCloseTo(-500, 2);
      expect((await balance('4900')) - discBefore).toBeCloseTo(10, 2);

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('voidBillPayment reverses cash AND discount, reopening the bill', async () => {
      const billId2 = await seedBill('200.00', 'BILL-D2');
      const chkBefore = await balance('1000');
      const apBefore = await balance('2000');
      const discBefore = await balance('4900');

      const payment = await payBills(ctx, {
        vendorId,
        date: new Date('2025-05-12'),
        method: 'check',
        paymentAccountId: acct['1000'],
        discountAccountId: acct['4900'],
        applications: [{ billId: billId2, amountApplied: '196.00', discountTaken: '4.00' }],
      });

      const voided = await voidBillPayment(ctx, payment.id);
      expect(voided.voidedAt).toBeTruthy();

      const [bill] = await db.select().from(bills).where(eq(bills.id, billId2));
      expect(bill.status).toBe('open');
      expect(Number(bill.balanceDue)).toBeCloseTo(200, 2);
      expect(Number(bill.amountPaid)).toBeCloseTo(0, 2);

      // All balances back where they started.
      expect(await balance('1000')).toBeCloseTo(chkBefore, 2);
      expect(await balance('2000')).toBeCloseTo(apBefore, 2);
      expect(await balance('4900')).toBeCloseTo(discBefore, 2);

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('still supports plain no-discount payments', async () => {
      const billId3 = await seedBill('100.00', 'BILL-D3');
      const payment = await payBills(ctx, {
        vendorId,
        date: new Date('2025-05-15'),
        method: 'ach',
        paymentAccountId: acct['1000'],
        applications: [{ billId: billId3, amountApplied: '100.00' }],
      });
      expect(payment.amount).toBe('100.00');
      const [bill] = await db.select().from(bills).where(eq(bills.id, billId3));
      expect(bill.status).toBe('paid');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B. Deposits — sales receipts, cash back, extra lines, void
  // ──────────────────────────────────────────────────────────────────────────

  describe('Make Deposits completion', () => {
    let pmtId: string;
    let srId: string;
    let depositId: string;

    it('listUndepositedPayments includes sales receipts sitting in UF', async () => {
      pmtId = await seedUFPayment('300.00', 'CHK-100');
      srId = await seedUFSalesReceipt('150.00', 1);

      const items = await listUndepositedPayments(ctx);
      expect(items).toHaveLength(2);

      const pmt = items.find((i) => i.id === pmtId);
      const sr = items.find((i) => i.id === srId);
      expect(pmt?.kind).toBe('payment');
      expect(sr?.kind).toBe('sales_receipt');
      expect(sr?.amount).toBe('150.00');
      expect(sr?.customerName).toBe('Beta Customer');
    });

    it('createDeposit handles payment + receipt + extra line + cash back', async () => {
      const chkBefore = await balance('1000');
      const ufBefore = await balance('1050');
      const pettyBefore = await balance('1010');
      const equityBefore = await balance('3100');

      const deposit = await createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: new Date('2025-06-05'),
        paymentIds: [pmtId],
        salesReceiptIds: [srId],
        extraLines: [
          { accountId: acct['3100'], amount: '50.00', description: 'Owner contribution' },
        ],
        cashBack: { accountId: acct['1010'], amount: '20.00', memo: 'Petty cash top-up' },
        memo: 'Full-feature deposit',
      });
      depositId = deposit.id;

      // Net to bank: 300 + 150 + 50 - 20 = 480.
      expect(deposit.total).toBe('480.00');
      expect((await balance('1000')) - chkBefore).toBeCloseTo(480, 2);
      expect((await balance('1050')) - ufBefore).toBeCloseTo(-450, 2);
      expect((await balance('1010')) - pettyBefore).toBeCloseTo(20, 2);
      expect((await balance('3100')) - equityBefore).toBeCloseTo(50, 2);

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('deposit lines: receipt + cash-back encodings, and sum(lines) === total', async () => {
      const dep = await getDeposit(ctx, depositId);
      expect(dep.lines).toHaveLength(4);

      const pmtLine = dep.lines.find((l) => l.paymentId === pmtId);
      expect(pmtLine?.amount).toBe('300.00');

      const srLine = dep.lines.find((l) =>
        (l.description ?? '').startsWith(RECEIPT_LINE_PREFIX),
      );
      expect(srLine?.description).toBe(`${RECEIPT_LINE_PREFIX}${srId}`);
      expect(srLine?.amount).toBe('150.00');

      const cbLine = dep.lines.find((l) =>
        (l.description ?? '').startsWith(CASHBACK_LINE_PREFIX),
      );
      expect(cbLine?.amount).toBe('-20.00');

      const sum = dep.lines.reduce((s, l) => s + Number(l.amount), 0);
      expect(sum).toBeCloseTo(Number(dep.total), 2);
    });

    it('deposited items disappear from the undeposited list', async () => {
      const items = await listUndepositedPayments(ctx);
      expect(items.map((i) => i.id)).not.toContain(pmtId);
      expect(items.map((i) => i.id)).not.toContain(srId);
    });

    it('re-depositing a deposited sales receipt throws CONFLICT', async () => {
      await expect(
        createDeposit(ctx, {
          depositAccountId: acct['1000'],
          date: new Date('2025-06-06'),
          salesReceiptIds: [srId],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects cash back that swallows the whole deposit', async () => {
      const freshPmt = await seedUFPayment('40.00', 'CHK-101');
      await expect(
        createDeposit(ctx, {
          depositAccountId: acct['1000'],
          date: new Date('2025-06-06'),
          paymentIds: [freshPmt],
          cashBack: { accountId: acct['1010'], amount: '40.00' },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('supports an extra-lines-only deposit (owner contribution)', async () => {
      const chkBefore = await balance('1000');
      const deposit = await createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: new Date('2025-06-07'),
        extraLines: [{ accountId: acct['3100'], amount: '75.00', description: 'Capital' }],
      });
      expect(deposit.total).toBe('75.00');
      expect((await balance('1000')) - chkBefore).toBeCloseTo(75, 2);
    });

    it('voidDeposit reverses GL and returns items to the undeposited list', async () => {
      const chkBefore = await balance('1000');
      const ufBefore = await balance('1050');
      const pettyBefore = await balance('1010');

      const voided = await voidDeposit(ctx, depositId);
      expect(voided.voidedAt).toBeTruthy();

      // GL reversed: bank -480, UF +450, petty cash -20.
      expect((await balance('1000')) - chkBefore).toBeCloseTo(-480, 2);
      expect((await balance('1050')) - ufBefore).toBeCloseTo(450, 2);
      expect((await balance('1010')) - pettyBefore).toBeCloseTo(-20, 2);

      // Payment + receipt are undeposited again.
      const items = await listUndepositedPayments(ctx);
      expect(items.map((i) => i.id)).toContain(pmtId);
      expect(items.map((i) => i.id)).toContain(srId);

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('voidDeposit is idempotent', async () => {
      const again = await voidDeposit(ctx, depositId);
      expect(again.voidedAt).toBeTruthy();
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('the voided items can be re-deposited', async () => {
      const deposit = await createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: new Date('2025-06-10'),
        paymentIds: [pmtId],
        salesReceiptIds: [srId],
      });
      expect(deposit.total).toBe('450.00');
      const items = await listUndepositedPayments(ctx);
      expect(items.map((i) => i.id)).not.toContain(pmtId);
      expect(items.map((i) => i.id)).not.toContain(srId);
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });
  });
});
