/**
 * Integration tests for payment corrections + refunds:
 *   - voidPayment / unapplyFromInvoice / applyPayment / refundPayment   (payments.ts)
 *   - voidBillPayment                                                   (billPayments.ts)
 *   - refundCreditMemo                                                  (creditMemos.ts)
 *   - refundVendorCredit                                                (vendorCredits.ts)
 *
 * Every mutation is checked against the two accounting identities:
 *   1. debits == credits (trial balance stays balanced)
 *   2. control account == subledger:
 *        A/R balance == Σ open-invoice balanceDue − Σ payment unapplied − Σ memo unapplied
 *        A/P balance == Σ open-bill balanceDue − Σ vendor-credit unapplied
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  vendors,
  invoices,
  bills,
  billLines,
  paymentsReceived,
  paymentApplications,
  billPaymentApplications,
  creditMemos,
  vendorCredits,
  journalEntries,
  deposits,
  depositLines,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  receivePayment,
  voidPayment,
  unapplyFromInvoice,
  applyPayment,
  refundPayment,
  getPayment,
} from './payments';
import { payBills, voidBillPayment, getBillPayment } from './billPayments';
import { createCreditMemo, refundCreditMemo, applyToInvoice, voidCreditMemo } from './creditMemos';
import { createVendorCredit, refundVendorCredit, voidVendorCredit } from './vendorCredits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payment-void-refunds');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let invoiceCounter = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createOpenInvoice(
  amount: string,
  opts?: { currency?: string; exchangeRate?: string },
): Promise<string> {
  invoiceCounter += 1;
  const rate = opts?.exchangeRate ?? '1.000000';
  const [inv] = await db
    .insert(invoices)
    .values({
      companyId: ctx.companyId,
      customerId,
      invoiceNumber: invoiceCounter,
      date: new Date('2026-01-05'),
      status: 'open',
      subtotal: amount,
      total: amount,
      amountPaid: '0.00',
      balanceDue: amount,
      currency: opts?.currency ?? null,
      exchangeRate: rate,
    })
    .returning();

  // Post the invoice GL impact at the BOOKED rate: Dr A/R / Cr Sales.
  const base = Money.round2(Money.mul(amount, rate)).toFixed(2);
  await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date: new Date('2026-01-05'),
    description: `Invoice #${invoiceCounter}`,
    sourceRef: `invoice:${inv.id}`,
    lines: [
      { accountId: acct['1200'], debit: base, memo: 'Invoice A/R' },
      { accountId: acct['4000'], credit: base, memo: 'Invoice revenue' },
    ],
  });
  return inv.id;
}

async function createOpenBill(amount: string): Promise<string> {
  const entry = await postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date: new Date('2026-01-05'),
    description: 'Bill — supplies',
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
      billNumber: `B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      date: new Date('2026-01-05'),
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

async function accountBalance(code: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, acct[code]));
  return row.balance;
}

/** A/R control == open-invoice subledger − unapplied payments − unapplied credit memos. */
async function assertArIdentity() {
  const invRows = await db
    .select({ balanceDue: invoices.balanceDue, currency: invoices.currency })
    .from(invoices)
    .where(eq(invoices.companyId, ctx.companyId));
  const payRows = await db
    .select({ unapplied: paymentsReceived.unapplied })
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, ctx.companyId), isNull(paymentsReceived.voidedAt)));
  const memoRows = await db
    .select({ unapplied: creditMemos.unapplied, status: creditMemos.status })
    .from(creditMemos)
    .where(eq(creditMemos.companyId, ctx.companyId));

  let expected = Money.zero();
  for (const r of invRows) expected = expected.plus(Money.of(r.balanceDue));
  for (const r of payRows) expected = expected.minus(Money.of(r.unapplied));
  for (const r of memoRows) {
    if (r.status !== 'void') expected = expected.minus(Money.of(r.unapplied));
  }

  const ar = await accountBalance('1200');
  expect(Money.round2(ar).toFixed(2)).toBe(Money.round2(expected).toFixed(2));
}

/** A/P control == open-bill subledger − unapplied vendor credits. */
async function assertApIdentity() {
  const billRows = await db
    .select({ balanceDue: bills.balanceDue })
    .from(bills)
    .where(eq(bills.companyId, ctx.companyId));
  const creditRows = await db
    .select({ unapplied: vendorCredits.unapplied, status: vendorCredits.status })
    .from(vendorCredits)
    .where(eq(vendorCredits.companyId, ctx.companyId));

  let expected = Money.zero();
  for (const r of billRows) expected = expected.plus(Money.of(r.balanceDue));
  for (const r of creditRows) {
    if (r.status !== 'void') expected = expected.minus(Money.of(r.unapplied));
  }

  const ap = await accountBalance('2000');
  expect(Money.round2(ap).toFixed(2)).toBe(Money.round2(expected).toFixed(2));
}

async function assertBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('payment-void-refunds: corrections + refunds', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'void-refunds@test.local', name: 'Void Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Void/Refund Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Office Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Refund Customer' })
      .returning();
    customerId = cust.id;

    const [vend] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Refund Vendor' })
      .returning();
    vendorId = vend.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── voidPayment ────────────────────────────────────────────────────────────

  it('voidPayment reverses GL, rolls back invoice, deletes applications', async () => {
    const invoiceId = await createOpenInvoice('1000.00');
    const { payment, entry } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-01'),
      method: 'check',
      amount: '1000.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId, amountApplied: '1000.00' }],
    });

    const checkingBefore = await accountBalance('1000');

    const voided = await voidPayment(ctx, payment.id);
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.unapplied).toBe('0.00');

    // Invoice rolled back to fully open.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.amountPaid).toBe('0.00');
    expect(inv.balanceDue).toBe('1000.00');
    expect(inv.status).toBe('open');

    // Application rows deleted.
    const apps = await db
      .select()
      .from(paymentApplications)
      .where(eq(paymentApplications.paymentId, payment.id));
    expect(apps).toHaveLength(0);

    // GL entry voided, balances reversed.
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry!.id));
    expect(je.status).toBe('void');
    const checkingAfter = await accountBalance('1000');
    expect(Money.sub(checkingBefore, checkingAfter).toFixed(2)).toBe('1000.00');

    await assertBalanced();
    await assertArIdentity();
  });

  it('voidPayment is idempotent', async () => {
    const invoiceId = await createOpenInvoice('50.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-01'),
      method: 'cash',
      amount: '50.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId, amountApplied: '50.00' }],
    });
    await voidPayment(ctx, payment.id);
    const again = await voidPayment(ctx, payment.id);
    expect(again.voidedAt).not.toBeNull();
    await assertBalanced();
    await assertArIdentity();
  });

  it('voidPayment is blocked when the payment is included in a deposit', async () => {
    const invoiceId = await createOpenInvoice('200.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-02'),
      method: 'check',
      amount: '200.00',
      // defaults to Undeposited Funds
      applications: [{ invoiceId, amountApplied: '200.00' }],
    });

    // Sweep into a deposit (mirrors what the deposits service does).
    const depEntry = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2026-02-03'),
      description: 'Deposit',
      lines: [
        { accountId: acct['1000'], debit: '200.00' },
        { accountId: acct['1050'], credit: '200.00' },
      ],
    });
    const [dep] = await db
      .insert(deposits)
      .values({
        companyId: ctx.companyId,
        depositAccountId: acct['1000'],
        date: new Date('2026-02-03'),
        total: '200.00',
        postedEntryId: depEntry.id,
      })
      .returning();
    await db.insert(depositLines).values({ depositId: dep.id, paymentId: payment.id, amount: '200.00' });

    await expect(voidPayment(ctx, payment.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await assertBalanced();
    await assertArIdentity();
  });

  // ── unapplyFromInvoice ─────────────────────────────────────────────────────

  it('unapplyFromInvoice partially frees an application back to unapplied', async () => {
    const invoiceId = await createOpenInvoice('500.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-05'),
      method: 'check',
      amount: '500.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId, amountApplied: '500.00' }],
    });

    const updated = await unapplyFromInvoice(ctx, {
      paymentId: payment.id,
      invoiceId,
      amount: '200.00',
    });
    expect(updated.unapplied).toBe('200.00');

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.amountPaid).toBe('300.00');
    expect(inv.balanceDue).toBe('200.00');
    expect(inv.status).toBe('partial');

    const full = await getPayment(ctx, payment.id);
    expect(full.applications).toHaveLength(1);
    expect(full.applications[0].amountApplied).toBe('300.00');

    await assertBalanced();
    await assertArIdentity();

    // Unapply the remainder (amount omitted → full applied amount).
    const updated2 = await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId });
    expect(updated2.unapplied).toBe('500.00');

    const [inv2] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv2.amountPaid).toBe('0.00');
    expect(inv2.balanceDue).toBe('500.00');
    expect(inv2.status).toBe('open');

    const full2 = await getPayment(ctx, payment.id);
    expect(full2.applications).toHaveLength(0);

    await assertBalanced();
    await assertArIdentity();
  });

  it('unapplyFromInvoice rejects amounts above the applied amount', async () => {
    const invoiceId = await createOpenInvoice('100.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-05'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId, amountApplied: '100.00' }],
    });
    await expect(
      unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId, amount: '150.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ── applyPayment (apply-later) ─────────────────────────────────────────────

  it('applyPayment consumes an overpayment against later invoices', async () => {
    const invA = await createOpenInvoice('300.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-10'),
      method: 'ach',
      amount: '500.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: invA, amountApplied: '300.00' }],
    });
    expect(payment.unapplied).toBe('200.00');
    await assertArIdentity();

    const invB = await createOpenInvoice('150.00');
    const updated = await applyPayment(ctx, {
      paymentId: payment.id,
      applications: [{ invoiceId: invB, amountApplied: '150.00' }],
    });
    expect(updated.unapplied).toBe('50.00');

    const [b] = await db.select().from(invoices).where(eq(invoices.id, invB));
    expect(b.status).toBe('paid');
    expect(b.balanceDue).toBe('0.00');

    await assertBalanced();
    await assertArIdentity();

    // Over-application of the remaining unapplied is rejected.
    const invC = await createOpenInvoice('80.00');
    await expect(
      applyPayment(ctx, {
        paymentId: payment.id,
        applications: [{ invoiceId: invC, amountApplied: '80.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Duplicate invoice ids are rejected.
    await expect(
      applyPayment(ctx, {
        paymentId: payment.id,
        applications: [
          { invoiceId: invC, amountApplied: '25.00' },
          { invoiceId: invC, amountApplied: '25.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('applyPayment merges into an existing application row', async () => {
    const inv = await createOpenInvoice('400.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-12'),
      method: 'check',
      amount: '400.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv, amountApplied: '400.00' }],
    });

    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv, amount: '100.00' });
    await applyPayment(ctx, {
      paymentId: payment.id,
      applications: [{ invoiceId: inv, amountApplied: '100.00' }],
    });

    const full = await getPayment(ctx, payment.id);
    expect(full.applications).toHaveLength(1);
    expect(full.applications[0].amountApplied).toBe('400.00');
    expect(full.unapplied).toBe('0.00');

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv));
    expect(row.status).toBe('paid');

    await assertBalanced();
    await assertArIdentity();
  });

  it('applyPayment rejects invoices of a different customer and voided payments', async () => {
    const [otherCust] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Other Cust' })
      .returning();
    const { payment } = await receivePayment(ctx, {
      customerId: otherCust.id,
      date: new Date('2026-02-12'),
      method: 'cash',
      amount: '60.00',
      depositAccountId: acct['1000'],
      applications: [],
    });

    const inv = await createOpenInvoice('60.00'); // belongs to the main customer
    await expect(
      applyPayment(ctx, {
        paymentId: payment.id,
        applications: [{ invoiceId: inv, amountApplied: '60.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await voidPayment(ctx, payment.id);
    await expect(
      applyPayment(ctx, {
        paymentId: payment.id,
        applications: [{ invoiceId: inv, amountApplied: '60.00' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await assertBalanced();
    await assertArIdentity();
  });

  // ── refundPayment ──────────────────────────────────────────────────────────

  it('refundPayment returns an overpayment: Dr A/R, Cr bank, unapplied reduced', async () => {
    const inv = await createOpenInvoice('100.00');
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-15'),
      method: 'check',
      amount: '250.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv, amountApplied: '100.00' }],
    });
    expect(payment.unapplied).toBe('150.00');

    const checkingBefore = await accountBalance('1000');
    const { payment: updated, entry } = await refundPayment(ctx, {
      paymentId: payment.id,
      bankAccountId: acct['1000'],
      amount: '150.00',
      date: new Date('2026-02-16'),
    });
    expect(updated.unapplied).toBe('0.00');
    expect(entry.sourceRef).toBe(`refund:${payment.id}`);

    const checkingAfter = await accountBalance('1000');
    expect(Money.sub(checkingBefore, checkingAfter).toFixed(2)).toBe('150.00');

    await assertBalanced();
    await assertArIdentity();

    // Further refunds exceed the (now zero) unapplied balance.
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '0.01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refundPayment rejects non-bank accounts', async () => {
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-02-15'),
      method: 'check',
      amount: '40.00',
      depositAccountId: acct['1000'],
      applications: [],
    });
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1200'], amount: '40.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Clean up the open credit so later identity checks stay simple.
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '40.00' });
    await assertArIdentity();
  });

  // ── FX: apply-later on a foreign-currency payment ──────────────────────────

  it('applyPayment posts an FX plug when invoice and payment rates differ', async () => {
    // EUR invoice booked at 1.10; EUR overpayment settled at 1.20.
    const inv = await createOpenInvoice('200.00', { currency: 'EUR', exchangeRate: '1.100000' });
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-03-01'),
      method: 'bank_transfer',
      amount: '200.00',
      depositAccountId: acct['1000'],
      applications: [],
      currency: 'EUR',
      exchangeRate: '1.200000',
    });
    expect(payment.unapplied).toBe('200.00');

    const arBefore = await accountBalance('1200');
    await applyPayment(ctx, {
      paymentId: payment.id,
      applications: [{ invoiceId: inv, amountApplied: '200.00' }],
    });

    // The invoice debited A/R 220.00 (200×1.10); the payment credited A/R 240.00
    // (200×1.20) for the unapplied remainder. The plug debits A/R 20.00 so the
    // pair nets to zero in base currency.
    const arAfter = await accountBalance('1200');
    expect(Money.sub(arAfter, arBefore).toFixed(2)).toBe('20.00');

    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv));
    expect(row.status).toBe('paid');
    expect(row.balanceDue).toBe('0.00');

    await assertBalanced();
  });

  it('voiding a foreign-currency overpayment refund restores exactly the refunded amount (no cent drift)', async () => {
    // 10.05 EUR at 0.30 posts 3.02 base; 3.02 / 0.30 would give back 10.07.
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-03-02'),
      method: 'bank_transfer',
      amount: '50.00',
      depositAccountId: acct['1000'],
      applications: [],
      currency: 'EUR',
      exchangeRate: '0.300000',
    });
    const { entry } = await refundPayment(ctx, {
      paymentId: payment.id,
      bankAccountId: acct['1000'],
      amount: '10.05',
      date: new Date('2026-03-03'),
    });
    const [refunded] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(refunded.unapplied).toBe('39.95');
    await voidJournalEntry(ctx, entry.id);
    const [restored] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(restored.unapplied).toBe('50.00');
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '50.00' });
    await assertBalanced();
  });

  // ── voidBillPayment ────────────────────────────────────────────────────────

  it('voidBillPayment reverses GL and rolls back the bill', async () => {
    const billId = await createOpenBill('500.00');
    const payment = await payBills(ctx, {
      vendorId,
      date: new Date('2026-03-05'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [{ billId, amountApplied: '500.00' }],
    });

    const [paid] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(paid.status).toBe('paid');

    const checkingBefore = await accountBalance('1000');
    const voided = await voidBillPayment(ctx, payment.id);
    expect(voided.voidedAt).not.toBeNull();

    const [rolled] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(rolled.amountPaid).toBe('0.00');
    expect(rolled.balanceDue).toBe('500.00');
    expect(rolled.status).toBe('open');

    const apps = await db
      .select()
      .from(billPaymentApplications)
      .where(eq(billPaymentApplications.billPaymentId, payment.id));
    expect(apps).toHaveLength(0);

    // Cash restored.
    const checkingAfter = await accountBalance('1000');
    expect(Money.sub(checkingAfter, checkingBefore).toFixed(2)).toBe('500.00');

    // GL entry voided.
    const [je] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, payment.postedEntryId!));
    expect(je.status).toBe('void');

    await assertBalanced();
    await assertApIdentity();

    // Idempotent.
    const again = await voidBillPayment(ctx, payment.id);
    expect(again.voidedAt).not.toBeNull();
    await assertApIdentity();
  });

  it('voidBillPayment rolls a partially paid bill back to open', async () => {
    const billId = await createOpenBill('400.00');
    const payment = await payBills(ctx, {
      vendorId,
      date: new Date('2026-03-06'),
      method: 'ach',
      paymentAccountId: acct['1000'],
      applications: [{ billId, amountApplied: '150.00' }],
    });

    const [partial] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(partial.status).toBe('partial');
    expect(partial.balanceDue).toBe('250.00');

    await voidBillPayment(ctx, payment.id);
    const [rolled] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(rolled.status).toBe('open');
    expect(rolled.balanceDue).toBe('400.00');
    expect(rolled.amountPaid).toBe('0.00');

    const full = await getBillPayment(ctx, payment.id);
    expect(full.voidedAt).not.toBeNull();
    expect(full.applications).toHaveLength(0);

    await assertBalanced();
    await assertApIdentity();
  });

  // ── refundCreditMemo ───────────────────────────────────────────────────────

  it('refundCreditMemo issues a refund check and consumes the credit', async () => {
    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-03-10'),
      lines: [{ quantity: '1', rate: '120.00', description: 'Returned goods' }],
    });
    expect(memo.unapplied).toBe('120.00');
    await assertArIdentity();

    const checkingBefore = await accountBalance('1000');
    const { creditMemo: updated, entry } = await refundCreditMemo(ctx, {
      creditMemoId: memo.id,
      bankAccountId: acct['1000'],
      amount: '120.00',
      date: new Date('2026-03-11'),
    });

    expect(updated.unapplied).toBe('0.00');
    expect(updated.refundedAmount).toBe('120.00');
    expect(updated.status).toBe('paid');
    expect(entry.sourceRef).toBe(`refund:${memo.id}`);

    const checkingAfter = await accountBalance('1000');
    expect(Money.sub(checkingBefore, checkingAfter).toFixed(2)).toBe('120.00');

    await assertBalanced();
    await assertArIdentity();

    // A refunded memo cannot be voided (its credit was consumed).
    await expect(voidCreditMemo(ctx, memo.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refundCreditMemo supports partial refunds; remainder is still applicable', async () => {
    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-03-12'),
      lines: [{ quantity: '1', rate: '200.00' }],
    });

    const { creditMemo: updated } = await refundCreditMemo(ctx, {
      creditMemoId: memo.id,
      bankAccountId: acct['1000'],
      amount: '80.00',
    });
    expect(updated.unapplied).toBe('120.00');
    expect(updated.refundedAmount).toBe('80.00');
    expect(updated.status).toBe('open');

    await assertBalanced();
    await assertArIdentity();

    // Remainder still applies to an invoice.
    const inv = await createOpenInvoice('120.00');
    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv, amount: '120.00' });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv));
    expect(row.status).toBe('paid');

    await assertBalanced();
    await assertArIdentity();

    // Over-refund of the now-zero balance is rejected.
    await expect(
      refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '1.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ── refundVendorCredit ─────────────────────────────────────────────────────

  it('refundVendorCredit records cash back: Dr bank, Cr A/P', async () => {
    const credit = await createVendorCredit(ctx, {
      vendorId,
      date: new Date('2026-03-15'),
      lines: [{ accountId: acct['5000'], amount: '90.00', description: 'Overcharge refund' }],
    });
    expect(credit.unapplied).toBe('90.00');
    await assertApIdentity();

    const checkingBefore = await accountBalance('1000');
    const { credit: updated, entry } = await refundVendorCredit(ctx, {
      vendorCreditId: credit.id,
      bankAccountId: acct['1000'],
      amount: '90.00',
      date: new Date('2026-03-16'),
    });

    expect(updated.unapplied).toBe('0.00');
    expect(updated.refundedAmount).toBe('90.00');
    expect(updated.status).toBe('closed');
    expect(entry.sourceRef).toBe(`refund:${credit.id}`);

    const checkingAfter = await accountBalance('1000');
    expect(Money.sub(checkingAfter, checkingBefore).toFixed(2)).toBe('90.00');

    await assertBalanced();
    await assertApIdentity();

    // A refunded credit cannot be voided.
    await expect(voidVendorCredit(ctx, credit.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refundVendorCredit validates amount and account', async () => {
    const credit = await createVendorCredit(ctx, {
      vendorId,
      date: new Date('2026-03-17'),
      lines: [{ accountId: acct['5000'], amount: '30.00' }],
    });

    await expect(
      refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['1000'], amount: '31.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['2000'], amount: '10.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['1000'], amount: '0' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Partial refund leaves the credit partial.
    const { credit: updated } = await refundVendorCredit(ctx, {
      vendorCreditId: credit.id,
      bankAccountId: acct['1000'],
      amount: '10.00',
    });
    expect(updated.status).toBe('partial');
    expect(updated.unapplied).toBe('20.00');

    await assertBalanced();
    await assertApIdentity();
  });
});
