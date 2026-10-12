/**
 * Team ledger fix (P0, I11): named A/R and A/P journal-entry lines are open items that can be paid
 * and applied, exactly like QuickBooks' "General Journal" rows in Receive Payments / Pay Bills.
 *
 * Original bug: payments.ts / billPayments.ts never referenced journal open items, so a JE debit to
 * A/R for a customer could not be paid, a JE credit to A/R could not be applied to an invoice, and
 * the A/P equivalents could not be paid / applied — the aging listed them (and the invoice they
 * offset) as open forever.
 *
 * After every step: A/R control == A/R aging == sum of customer balances == integrity check, and
 * A/P control == A/P aging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, invoices, journalEntryLines, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging, arAgingDetail } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createManualEntry, journalOpenItems, updateEntry, voidEntry } from './journal';
import { voidJournalEntry } from './posting';
import {
  listAvailableCredits,
  receivePayment,
  recordBouncedCheck,
  updatePayment,
  voidPayment,
} from './payments';
import { payBills, updateBillPayment, voidBillPayment } from './billPayments';
import {
  applyJournalCredit,
  applyPaymentToJournalCharges,
  listJournalApplications,
  listJournalOpenItems,
  unapplyJournalApplication,
} from './journalApplications';
import { verifyIntegrity } from './integrity';
import { createDeposit } from './deposits';
import { clientDataReview } from './accountant/clientDataReview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-journal-applications');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
let customerId: string;
let vendorId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');

async function controlOf(subtype: 'accounts_receivable' | 'accounts_payable', asOf: Date = AS_OF): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round((subtype === 'accounts_receivable' ? total : -total) * 100) / 100;
}

/** A/R control == aging == customer balances == integrity; returns the A/R total. */
async function expectArTied(expected?: number): Promise<number> {
  const control = await controlOf('accounts_receivable');
  const aging = Number((await arAging(ctx, AS_OF)).totals.total);
  const customersTotal = (await customerBalanceSummary(ctx)).reduce((s, r) => s + Number(r.totalBalanceDue), 0);
  expect(aging).toBeCloseTo(control, 2);
  expect(customersTotal).toBeCloseTo(control, 2);
  const integrity = await verifyIntegrity(ctx);
  const arCheck = integrity.checks.find((c) => c.name.startsWith('A/R control'));
  expect(arCheck?.ok, arCheck?.detail).toBe(true);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
  return control;
}

/** A/P control == A/P aging; returns the A/P total. */
async function expectApTied(expected?: number): Promise<number> {
  const control = await controlOf('accounts_payable');
  const aging = Number((await apAging(ctx, AS_OF)).totals.total);
  expect(aging).toBeCloseTo(control, 2);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
  return control;
}

async function customerBalance(id: string): Promise<number> {
  const row = (await customerBalanceSummary(ctx)).find((r) => r.customerId === id);
  return Number(row?.totalBalanceDue ?? 0);
}

async function lineOf(entryId: string, accountCode: string) {
  const [l] = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, code[accountCode])));
  return l;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'ledger-ja@test.local', name: 'Ledger', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Journal Items Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  for (const a of all) code[a.code] = a.id;
  customerId = (await createCustomer(ctx, { displayName: 'Journal Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Journal Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('A/R: General Journal charges and credits in Receive Payments', () => {
  let chargeEntryId: string;
  let chargeLineId: string;
  let firstPaymentId: string;
  let secondPaymentId: string;

  it('a JE A/R debit for a customer is an open, payable General Journal charge', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-02-01'),
      description: 'Rebill freight',
      lines: [
        { accountId: code['1200'], debit: '100.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '100.00' },
      ],
    });
    chargeEntryId = je.id;
    chargeLineId = (await lineOf(je.id, '1200')).id;
    const open = await listJournalOpenItems(ctx, 'ar', customerId);
    expect(open.charges).toHaveLength(1);
    expect(open.charges[0]).toMatchObject({ journalLineId: chargeLineId, open: '100.00', ref: expect.stringMatching(/General Journal #/) });
    expect(open.credits).toHaveLength(0);
    expect(await customerBalance(customerId)).toBe(100);
    await expectArTied(100);
  });

  it('can be partially paid in Receive Payments, then paid off', async () => {
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: D('2026-02-10'),
      method: 'check',
      amount: '60.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLineId, amount: '60.00' }],
    });
    firstPaymentId = payment.id;
    expect(payment.unapplied).toBe('0.00');
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges[0].open).toBe('40.00');
    expect(await customerBalance(customerId)).toBe(40);
    await expectArTied(40);

    // Overpaying the charge is refused with a plain message.
    await expect(
      receivePayment(ctx, {
        customerId,
        date: D('2026-02-11'),
        method: 'check',
        amount: '50.00',
        applications: [],
        journalItems: [{ journalLineId: chargeLineId, amount: '50.00' }],
      }),
    ).rejects.toThrow(/only has 40.00 left open/);

    const second = await receivePayment(ctx, {
      customerId,
      date: D('2026-02-12'),
      method: 'check',
      amount: '40.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLineId, amount: '40.00' }],
    });
    secondPaymentId = second.payment.id;
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges).toHaveLength(0);
    // The aging detail no longer lists the closed General Journal line.
    const detail = await arAgingDetail(ctx, AS_OF);
    expect(detail.rows.some((r) => r.docId === chargeEntryId)).toBe(false);
    expect(await customerBalance(customerId)).toBe(0);
    await expectArTied(0);
    // Statements still see the full charge (activity), offset by the two payments.
    expect((await journalOpenItems(ctx, 'ar', { entityId: customerId, gross: true }))[0].amount).toBe('100.00');
  });

  it('refuses to void or edit the journal entry while payments are applied to it', async () => {
    await expect(voidEntry(ctx, chargeEntryId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      updateEntry(ctx, chargeEntryId, {
        date: D('2026-02-01'),
        description: 'Rebill freight (edited)',
        lines: [
          { accountId: code['1200'], debit: '90.00', entityType: 'customer', entityId: customerId },
          { accountId: code['4000'], credit: '90.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The database refuses it too, whatever the path.
    await expect(voidJournalEntry(ctx, chargeEntryId)).rejects.toThrow(/applied/);
    await expectArTied(0);
  });

  it('voiding a payment reopens the charge; editing a payment re-applies it', async () => {
    await voidPayment(ctx, secondPaymentId);
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges[0].open).toBe('40.00');
    await expectArTied(40);

    // Edit the first payment: 60 → 100, paying the whole charge.
    await updatePayment(ctx, firstPaymentId, {
      customerId,
      date: D('2026-02-10'),
      method: 'check',
      amount: '100.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLineId, amount: '100.00' }],
    });
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges).toHaveLength(0);
    await expectArTied(0);

    // Unapply 30 from the charge: it becomes unapplied credit on the payment (still tied).
    const [app] = await listJournalApplications(ctx, { paymentId: firstPaymentId });
    expect(app.kind).toBe('payment');
    await unapplyJournalApplication(ctx, app.id);
    const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, firstPaymentId));
    expect(p.unapplied).toBe('100.00');
    expect(await customerBalance(customerId)).toBe(0); // +100 charge, −100 unapplied credit
    await expectArTied(0);

    // Apply the unapplied credit back to the charge later ("apply later").
    await applyPaymentToJournalCharges(ctx, {
      paymentId: firstPaymentId,
      items: [{ journalLineId: chargeLineId, amount: '100.00' }],
    });
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges).toHaveLength(0);
    await expectArTied(0);
  });

  it('a JE A/R credit is an available credit that can be applied to an invoice', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-01'),
      lines: [{ description: 'Consulting', quantity: 1, rate: '300.00' }],
    });
    // Usual write-off pattern: Dr bad debt / Cr A/R for the customer.
    const credit = await createManualEntry(ctx, {
      date: D('2026-03-05'),
      description: 'Courtesy credit',
      lines: [
        { accountId: code['6000'], debit: '100.00' },
        { accountId: code['1200'], credit: '100.00', entityType: 'customer', entityId: customerId },
      ],
    });
    const creditLineId = (await lineOf(credit.id, '1200')).id;
    expect(await customerBalance(customerId)).toBe(200);
    await expectArTied(200);

    const available = await listAvailableCredits(ctx, customerId);
    expect(available).toContainEqual(
      expect.objectContaining({ kind: 'journal_entry', id: creditLineId, available: '100.00' }),
    );
    // Client Data Review > Fix unapplied customer credits sees it too.
    const review = await clientDataReview(ctx);
    const task = review.tasks.find((t) => t.key === 'unapplied_customer_credits')!;
    expect(task.issues.some((i) => i.id === `journal_line:${creditLineId}`)).toBe(true);

    // Receive 200 and use the 100 General Journal credit on the same invoice.
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: D('2026-03-10'),
      method: 'check',
      amount: '200.00',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
      journalCredits: [{ journalLineId: creditLineId, invoiceId: inv.id, amount: '100.00' }],
    });
    const [i1] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(i1.status).toBe('paid');
    expect(i1.balanceDue).toBe('0.00');
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).credits).toHaveLength(0);
    expect(await customerBalance(customerId)).toBe(0);
    await expectArTied(0);

    // Voiding the credit's journal entry is refused while it is applied.
    await expect(voidEntry(ctx, credit.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // Voiding the payment takes the credit back off the invoice too.
    await voidPayment(ctx, payment.id);
    const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(i2.balanceDue).toBe('300.00');
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).credits[0].open).toBe('100.00');
    await expectArTied(200);

    // Standalone "apply credit" (no payment), then unapply it.
    const app = await applyJournalCredit(ctx, { journalLineId: creditLineId, invoiceId: inv.id, amount: '40.00' });
    const [i3] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(i3.balanceDue).toBe('260.00');
    expect((await listJournalOpenItems(ctx, 'ar', customerId)).credits[0].open).toBe('60.00');
    await expectArTied(200);
    await unapplyJournalApplication(ctx, app.id);
    const [i4] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(i4.balanceDue).toBe('300.00');
    await expectArTied(200);

    // With nothing applied any more, the credit entry can be voided.
    await voidEntry(ctx, credit.id);
    await expectArTied(300);
  });

  it('refuses the wrong direction, another customer, and over-application', async () => {
    const other = (await createCustomer(ctx, { displayName: 'Other Customer' })).id;
    await expect(
      receivePayment(ctx, {
        customerId: other,
        date: D('2026-03-20'),
        method: 'check',
        amount: '10.00',
        applications: [],
        journalItems: [{ journalLineId: chargeLineId, amount: '10.00' }],
      }),
    ).rejects.toThrow(/different customer/);
    const credit = await createManualEntry(ctx, {
      date: D('2026-03-21'),
      description: 'Another credit',
      lines: [
        { accountId: code['6000'], debit: '25.00' },
        { accountId: code['1200'], credit: '25.00', entityType: 'customer', entityId: customerId },
      ],
    });
    const creditLineId = (await lineOf(credit.id, '1200')).id;
    // A credit can't be "paid".
    await expect(
      receivePayment(ctx, {
        customerId,
        date: D('2026-03-22'),
        method: 'check',
        amount: '25.00',
        applications: [],
        journalItems: [{ journalLineId: creditLineId, amount: '25.00' }],
      }),
    ).rejects.toThrow(/is a credit to the customer/);
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-22'),
      lines: [{ description: 'Small job', quantity: 1, rate: '10.00' }],
    });
    await expect(
      applyJournalCredit(ctx, { journalLineId: creditLineId, invoiceId: inv.id, amount: '20.00' }),
    ).rejects.toThrow(/more than its balance due/);
    await expectArTied();
  });

  it('respects the closing date', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-04-01'),
      description: 'April charge',
      lines: [
        { accountId: code['1200'], debit: '70.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '70.00' },
      ],
    });
    const lineId = (await lineOf(je.id, '1200')).id;
    await setClosingDate(ctx, { closingDate: '2026-04-30', password: 'pw' });
    try {
      await expect(
        receivePayment(ctx, {
          customerId,
          date: D('2026-04-15'),
          method: 'check',
          amount: '70.00',
          applications: [],
          journalItems: [{ journalLineId: lineId, amount: '70.00' }],
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const inv = await createInvoice(ctx, {
        customerId,
        date: D('2026-05-02'),
        lines: [{ description: 'May', quantity: 1, rate: '50.00' }],
      });
      const credit = await createManualEntry(ctx, {
        date: D('2026-05-03'),
        description: 'May credit',
        lines: [
          { accountId: code['6000'], debit: '5.00' },
          { accountId: code['1200'], credit: '5.00', entityType: 'customer', entityId: customerId },
        ],
      });
      const creditLineId = (await lineOf(credit.id, '1200')).id;
      await expect(
        applyJournalCredit(ctx, { journalLineId: creditLineId, invoiceId: inv.id, amount: '5.00', date: D('2026-04-20') }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      // A payment dated after the closing date is fine.
      await receivePayment(ctx, {
        customerId,
        date: D('2026-05-05'),
        method: 'check',
        amount: '70.00',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '70.00' }],
      });
      await expectArTied();
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null });
    }
  });

  it('a bounced payment re-opens the General Journal charge it paid', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-06-01'),
      description: 'June charge',
      lines: [
        { accountId: code['1200'], debit: '45.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '45.00' },
      ],
    });
    const lineId = (await lineOf(je.id, '1200')).id;
    const { payment } = await receivePayment(ctx, {
      customerId,
      date: D('2026-06-02'),
      method: 'check',
      amount: '45.00',
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '45.00' }],
    });
    await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-06-03'), paymentIds: [payment.id] });
    const before = await expectArTied();
    await recordBouncedCheck(ctx, { paymentId: payment.id, date: D('2026-06-10') });
    const open = (await listJournalOpenItems(ctx, 'ar', customerId)).charges.find((c) => c.journalLineId === lineId);
    expect(open?.open).toBe('45.00');
    await expectArTied(before + 45);
  });
});

describe('A/P: General Journal amounts owed and vendor credits in Pay Bills', () => {
  let payableEntryId: string;
  let payableLineId: string;
  let vendorCreditLineId: string;
  let billId: string;
  let firstPaymentId: string;
  let secondPaymentId: string;

  it('a JE A/P credit for a vendor can be paid (partially) in Pay Bills', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-02-01'),
      description: 'Accrued repairs',
      lines: [
        { accountId: code['6000'], debit: '500.00' },
        { accountId: code['2000'], credit: '500.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    payableEntryId = je.id;
    payableLineId = (await lineOf(je.id, '2000')).id;
    const open = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(open.charges).toHaveLength(1);
    expect(open.charges[0].open).toBe('500.00');
    await expectApTied(500);

    const payment = await payBills(ctx, {
      vendorId,
      date: D('2026-02-15'),
      method: 'check',
      reference: '1001',
      paymentAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: payableLineId, amount: '200.00' }],
    });
    firstPaymentId = payment.id;
    expect(payment.amount).toBe('200.00');
    expect((await listJournalOpenItems(ctx, 'ap', vendorId)).charges[0].open).toBe('300.00');
    await expectApTied(300);
  });

  it('a JE A/P debit is a vendor credit applied to a bill; bills, JE amounts and credits settle together', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-03-01'),
      billNumber: 'B-77',
      lines: [{ accountId: code['6000'], amount: '400.00' }],
    });
    billId = bill.id;
    const credit = await createManualEntry(ctx, {
      date: D('2026-03-02'),
      description: 'Vendor rebate',
      lines: [
        { accountId: code['2000'], debit: '150.00', entityType: 'vendor', entityId: vendorId },
        { accountId: code['6000'], credit: '150.00' },
      ],
    });
    vendorCreditLineId = (await lineOf(credit.id, '2000')).id;
    const open = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(open.credits).toHaveLength(1);
    expect(open.credits[0].open).toBe('150.00');
    await expectApTied(550);

    const payment = await payBills(ctx, {
      vendorId,
      date: D('2026-03-10'),
      method: 'check',
      reference: '1002',
      paymentAccountId: code['1000'],
      applications: [{ billId, amountApplied: '250.00' }],
      journalItems: [{ journalLineId: payableLineId, amount: '300.00' }],
      journalCredits: [{ journalLineId: vendorCreditLineId, billId, amount: '150.00' }],
    });
    secondPaymentId = payment.id;
    expect(payment.amount).toBe('550.00');
    const [b] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(b.status).toBe('paid');
    expect(b.amountCredited).toBe('150.00');
    const after = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(after.charges).toHaveLength(0);
    expect(after.credits).toHaveLength(0);
    await expectApTied(0);
  });

  it('voiding the journal entry is refused while paid; voiding / editing the bill payment reopens everything', async () => {
    await expect(voidEntry(ctx, payableEntryId)).rejects.toMatchObject({ code: 'CONFLICT' });

    await voidBillPayment(ctx, secondPaymentId);
    const [b] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(b.balanceDue).toBe('400.00');
    expect(b.amountCredited).toBe('0.00');
    const open = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(open.charges[0].open).toBe('300.00');
    expect(open.credits[0].open).toBe('150.00');
    await expectApTied(550);

    // Edit the first bill payment to pay the whole 500 instead of 200.
    await updateBillPayment(ctx, firstPaymentId, {
      vendorId,
      date: D('2026-02-15'),
      method: 'check',
      reference: '1001',
      paymentAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: payableLineId, amount: '500.00' }],
    });
    expect((await listJournalOpenItems(ctx, 'ap', vendorId)).charges).toHaveLength(0);
    await expectApTied(250);

    // Standalone credit to the bill, then unapply it.
    const app = await applyJournalCredit(ctx, { journalLineId: vendorCreditLineId, billId, amount: '150.00' });
    const [b2] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(b2.balanceDue).toBe('250.00');
    expect(b2.status).toBe('partial');
    await expectApTied(250);
    await unapplyJournalApplication(ctx, app.id);
    const [b3] = await db.select().from(bills).where(eq(bills.id, billId));
    expect(b3.balanceDue).toBe('400.00');
    expect(b3.status).toBe('open');
    await expectApTied(250);

    // A bill payment's cash on a journal item is changed by editing the payment, not "unapply".
    const [bp] = await listJournalApplications(ctx, { billPaymentId: firstPaymentId });
    await expect(unapplyJournalApplication(ctx, bp.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses paying a vendor credit, another vendor, and over-payment', async () => {
    const other = (await createVendor(ctx, { displayName: 'Other Vendor' })).id;
    const base = { date: D('2026-04-10'), method: 'check' as const, paymentAccountId: code['1000'], applications: [] };
    await expect(
      payBills(ctx, { ...base, vendorId, journalItems: [{ journalLineId: vendorCreditLineId, amount: '10.00' }] }),
    ).rejects.toThrow(/is a credit from the vendor/);
    await expect(
      payBills(ctx, { ...base, vendorId: other, journalItems: [{ journalLineId: payableLineId, amount: '10.00' }] }),
    ).rejects.toThrow(/different vendor/);
    await expect(
      payBills(ctx, { ...base, vendorId, journalItems: [{ journalLineId: payableLineId, amount: '10.00' }] }),
    ).rejects.toThrow(/only has 0.00 left open/);
    await expectApTied(250);
  });

  it('respects the closing date', async () => {
    const je = await createManualEntry(ctx, {
      date: D('2026-05-01'),
      description: 'May accrual',
      lines: [
        { accountId: code['6000'], debit: '80.00' },
        { accountId: code['2000'], credit: '80.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const lineId = (await lineOf(je.id, '2000')).id;
    await setClosingDate(ctx, { closingDate: '2026-05-31', password: 'pw' });
    try {
      await expect(
        payBills(ctx, {
          vendorId,
          date: D('2026-05-15'),
          method: 'check',
          paymentAccountId: code['1000'],
          applications: [],
          journalItems: [{ journalLineId: lineId, amount: '80.00' }],
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      await expect(
        applyJournalCredit(ctx, { journalLineId: vendorCreditLineId, billId, amount: '10.00', date: D('2026-05-20') }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      await expectApTied(330);
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null });
    }
    await expectArTied();
  });
});

describe('as-of dates: an application moves both sides on the same day', () => {
  const EOD = (d: string) => new Date(`${d}T23:59:59Z`);
  async function arTiedOn(d: string, expected?: number) {
    const control = await controlOf('accounts_receivable', EOD(d));
    const aging = Number((await arAging(ctx, EOD(d))).totals.total);
    const detail = (await arAgingDetail(ctx, EOD(d))).rows.reduce((s, r) => s + Number(r.openBalance), 0);
    expect(aging, `A/R aging on ${d}`).toBeCloseTo(control, 2);
    expect(detail, `A/R aging detail on ${d}`).toBeCloseTo(control, 2);
    if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
  }
  async function apTiedOn(d: string) {
    const control = await controlOf('accounts_payable', EOD(d));
    const aging = Number((await apAging(ctx, EOD(d))).totals.total);
    expect(aging, `A/P aging on ${d}`).toBeCloseTo(control, 2);
  }

  it('a JE credit applied to a LATER invoice: aging between the two dates still shows the credit', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Later Invoice Customer' })).id;
    const je = await createManualEntry(ctx, {
      date: D('2026-08-02'),
      description: 'Goodwill credit',
      lines: [
        { accountId: code['6000'], debit: '40.00' },
        { accountId: code['1200'], credit: '40.00', entityType: 'customer', entityId: cust },
      ],
    });
    const lineId = (await lineOf(je.id, '1200')).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-08-10'),
      lines: [{ description: 'August work', quantity: 1, rate: '150.00' }],
    });
    // Applied "on" Aug 5 — before the invoice existed; it is dated with the invoice instead.
    const app = await applyJournalCredit(ctx, { journalLineId: lineId, invoiceId: inv.id, amount: '40.00', date: D('2026-08-05') });
    expect(app.date.toISOString().slice(0, 10)).toBe('2026-08-10');
    await arTiedOn('2026-08-01');
    await arTiedOn('2026-08-06');
    await arTiedOn('2026-08-11');
    await expectArTied();
  });

  it('a JE vendor credit applied later to an earlier bill: A/P aging ties on every date', async () => {
    const vend = (await createVendor(ctx, { displayName: 'As-Of Bill Vendor' })).id;
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-08-01'), billNumber: 'ASOF-1', lines: [{ accountId: code['6000'], amount: '90.00' }] });
    const je = await createManualEntry(ctx, {
      date: D('2026-08-04'),
      description: 'Vendor rebate',
      lines: [
        { accountId: code['2000'], debit: '30.00', entityType: 'vendor', entityId: vend },
        { accountId: code['6000'], credit: '30.00' },
      ],
    });
    const lineId = (await lineOf(je.id, '2000')).id;
    await applyJournalCredit(ctx, { journalLineId: lineId, billId: bill.id, amount: '30.00', date: D('2026-08-08') });
    for (const d of ['2026-08-02', '2026-08-05', '2026-08-09']) await apTiedOn(d);
    await expectApTied();
  });

  it('a payment dated before the General Journal charge it pays is refused', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Early Payment Customer' })).id;
    const je = await createManualEntry(ctx, {
      date: D('2026-08-20'),
      description: 'Late fee',
      lines: [
        { accountId: code['1200'], debit: '25.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '25.00' },
      ],
    });
    const lineId = (await lineOf(je.id, '1200')).id;
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-08-15'),
        method: 'check',
        amount: '25.00',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '25.00' }],
      }),
    ).rejects.toThrow(/dated 2026-08-20, after this payment/);
    await expectArTied();
  });
});
