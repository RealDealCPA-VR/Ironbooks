/**
 * P1 round, team payments — Receive Payments, Pay Bills and the Income Tracker.
 *
 * Covers (PARITY.md section C and the I11 follow-ups):
 *  - the Receive Payments list: newest first, paged with a total, date / customer filters and a
 *    search by reference, check number or amount; only actions the server accepts are offered
 *    (canBounce);
 *  - document numbers (ref numbers) in credit labels and messages instead of internal integers;
 *  - foreign-currency payments: the exchange rate defaults from the currency list, the code is
 *    normalised, and realized exchange gain / loss is posted;
 *  - earlier-payment credits used while EDITING a payment (they used to be dropped silently);
 *  - a General Journal A/R credit applied to a General Journal A/R charge (and the A/P mirror);
 *  - Pay Bills credits and payment saved together, all or nothing;
 *  - the Income Tracker as of a past day.
 *
 * After every money step: the trial balance is balanced and A/R (A/P) control == aging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  bills,
  invoices,
  journalEntryLines,
  journalItemApplications,
  paymentsReceived,
  users,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createCreditMemo } from './creditMemos';
import { createManualEntry, voidEntry } from './journal';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { createDeposit } from './deposits';
import { createVendorCredit } from './vendorCredits';
import { createEstimate, convertToInvoice as convertEstimate } from './estimates';
import { createSalesOrder, convertToInvoice as convertSalesOrder } from './salesOrders';
import { createTimeEntry } from './timeTracking';
import {
  getPayment,
  listAvailableCredits,
  receivePayment,
  recordBouncedCheck,
  searchPayments,
  updatePayment,
  voidPayment,
} from './payments';
import { payBillsWithCredits, voidBillPayment } from './billPayments';
import { applyJournalCredit, listJournalOpenItems, unapplyJournalApplication } from './journalApplications';
import { incomeTracker } from './incomeTracker';
import { autoApplyPayment, cashDue } from '@/lib/paymentApply';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');

async function controlOf(subtype: 'accounts_receivable' | 'accounts_payable'): Promise<number> {
  const tb = await trialBalance(ctx, AS_OF);
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

async function expectBooksTied() {
  const tb = await trialBalance(ctx, AS_OF);
  expect(tb.balanced).toBe(true);
  expect(Number((await arAging(ctx, AS_OF)).totals.total)).toBeCloseTo(await controlOf('accounts_receivable'), 2);
  expect(Number((await apAging(ctx, AS_OF)).totals.total)).toBeCloseTo(await controlOf('accounts_payable'), 2);
}

async function lineOf(entryId: string, accountCode: string) {
  const [l] = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, code[accountCode])));
  return l;
}

async function invoiceFor(customerId: string, amount: string, date: string, extra: Record<string, unknown> = {}) {
  return createInvoice(ctx, {
    customerId,
    date: D(date),
    dueDate: D(date),
    lines: [{ accountId: code['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as Parameters<typeof createInvoice>[1]);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-payments@test.local', name: 'P1', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'P1 Payments Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  for (const a of all) code[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Receive Payments list
// ---------------------------------------------------------------------------

describe('Receive Payments list: newest first, paged, filtered, searchable', () => {
  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    alpha = (await createCustomer(ctx, { displayName: 'Alpha Listing' })).id;
    beta = (await createCustomer(ctx, { displayName: 'Beta Listing' })).id;
    // 7 payments for alpha on different days (inserted out of order), 2 for beta.
    for (const [day, ref, amt] of [
      ['2026-01-05', 'CHK-105', '105.00'],
      ['2026-01-02', 'CHK-102', '102.00'],
      ['2026-01-07', 'CHK-107', '107.00'],
      ['2026-01-01', 'CHK-101', '101.00'],
      ['2026-01-06', 'CHK-106', '106.00'],
      ['2026-01-03', 'CHK-103', '103.00'],
      ['2026-01-04', 'CHK-104', '1,250.00'],
    ] as const) {
      await receivePayment(ctx, {
        customerId: alpha,
        date: D(day),
        method: 'check',
        reference: ref,
        amount: amt.replace(',', ''),
        applications: [],
      });
    }
    await receivePayment(ctx, { customerId: beta, date: D('2026-02-01'), method: 'cash', reference: 'B-1', amount: '10.00', applications: [] });
    await receivePayment(ctx, { customerId: beta, date: D('2026-02-02'), method: 'cash', reference: 'B-2', amount: '20.00', applications: [] });
  });

  it('lists newest first and pages with a total (no silent 100-row cap)', async () => {
    const p1 = await searchPayments(ctx, { customerId: alpha, limit: 3, offset: 0 });
    expect(p1.total).toBe(7);
    expect(p1.payments.map((p) => p.reference)).toEqual(['CHK-107', 'CHK-106', 'CHK-105']);
    const p3 = await searchPayments(ctx, { customerId: alpha, limit: 3, offset: 6 });
    expect(p3.payments.map((p) => p.reference)).toEqual(['CHK-101']);
    expect(p3.payments[0].customerName).toBe('Alpha Listing');
  });

  it('filters by date range (both days inclusive) and customer', async () => {
    const r = await searchPayments(ctx, { customerId: alpha, from: D('2026-01-03'), to: new Date('2026-01-05T00:00:00Z') });
    expect(r.payments.map((p) => p.reference)).toEqual(['CHK-105', 'CHK-104', 'CHK-103']);
    expect(r.total).toBe(3);
    const b = await searchPayments(ctx, { customerId: beta });
    expect(b.payments.map((p) => p.reference)).toEqual(['B-2', 'B-1']);
  });

  it('searches by check number, customer name and amount', async () => {
    expect((await searchPayments(ctx, { search: 'chk-106' })).payments.map((p) => p.reference)).toEqual(['CHK-106']);
    expect((await searchPayments(ctx, { search: '1,250.00' })).payments.map((p) => p.reference)).toEqual(['CHK-104']);
    expect((await searchPayments(ctx, { search: '$102' })).payments.map((p) => p.reference)).toEqual(['CHK-102']);
    expect((await searchPayments(ctx, { search: 'Beta List' })).total).toBe(2);
    // LIKE wildcards in the search text are literal.
    expect((await searchPayments(ctx, { search: '%' })).total).toBe(0);
  });

  it('offers Bounced only for a check that reached the bank (what recordBouncedCheck accepts)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Bounce Flags' })).id;
    const inUf = await receivePayment(ctx, { customerId: cust, date: D('2026-03-01'), method: 'check', amount: '50.00', applications: [] });
    const cash = await receivePayment(ctx, { customerId: cust, date: D('2026-03-02'), method: 'cash', amount: '20.00', depositAccountId: code['1000'], applications: [] });
    const toBank = await receivePayment(ctx, { customerId: cust, date: D('2026-03-03'), method: 'check', amount: '30.00', depositAccountId: code['1000'], applications: [] });
    const flags = async () =>
      new Map((await searchPayments(ctx, { customerId: cust })).payments.map((p) => [p.id, p] as const));
    let f = await flags();
    expect(f.get(inUf.payment.id)!.canBounce).toBe(false); // still in Undeposited Funds
    expect(f.get(cash.payment.id)!.canBounce).toBe(false); // not a check
    expect(f.get(toBank.payment.id)!.canBounce).toBe(true);
    await expect(recordBouncedCheck(ctx, { paymentId: inUf.payment.id, date: D('2026-03-05') })).rejects.toThrow(/not been deposited/);

    await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-03-04'), paymentIds: [inUf.payment.id] });
    f = await flags();
    expect(f.get(inUf.payment.id)!.deposited).toBe(true);
    expect(f.get(inUf.payment.id)!.canBounce).toBe(true);
    await recordBouncedCheck(ctx, { paymentId: inUf.payment.id, date: D('2026-03-06') });
    expect((await flags()).get(inUf.payment.id)!.canBounce).toBe(false);
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Document numbers
// ---------------------------------------------------------------------------

describe('Receive Payments shows document numbers, not internal integers', () => {
  it('credit memo labels and over-application messages use the ref number', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Ref Numbers' })).id;
    const inv = await invoiceFor(cust, '100.00', '2026-04-01', { refNumber: 'JOB-ALPHA' });
    await createCreditMemo(ctx, {
      customerId: cust,
      date: D('2026-04-02'),
      refNumber: 'CM-ZETA',
      lines: [{ accountId: code['4000'], description: 'Credit', quantity: 1, rate: '10.00', taxable: false }],
    } as Parameters<typeof createCreditMemo>[1]);
    const credits = await listAvailableCredits(ctx, cust);
    expect(credits.find((c) => c.kind === 'credit_memo')?.ref).toBe('Credit Memo #CM-ZETA');
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-04-03'),
        method: 'check',
        amount: '150.00',
        applications: [{ invoiceId: inv.id, amountApplied: '120.00' }],
      }),
    ).rejects.toThrow(/invoice #JOB-ALPHA/);
  });
});

// ---------------------------------------------------------------------------
// Foreign currency
// ---------------------------------------------------------------------------

describe('Receive Payments in a foreign currency', () => {
  let cust: string;
  beforeAll(async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.200000' });
    cust = (await createCustomer(ctx, { displayName: 'Euro Customer' })).id;
  });

  it('takes the rate from the currency list and posts the realized exchange gain', async () => {
    const inv = await invoiceFor(cust, '100.00', '2026-05-01', { currency: 'EUR', exchangeRate: '1.10' });
    const fxBefore = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900')));
    const { payment, entry } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-20'),
      method: 'bank_transfer',
      amount: '100.00',
      depositAccountId: code['1000'],
      currency: 'eur', // normalised
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    expect(payment.currency).toBe('EUR');
    expect(Number(payment.exchangeRate)).toBeCloseTo(1.2, 6);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.status).toBe('paid');
    // Bank 120.00 (100 x 1.20), A/R 110.00 (booked at 1.10), gain 10.00.
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entry!.id));
    const fx = (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900'))))[0];
    expect(fx).toBeTruthy();
    expect(fxBefore.length === 0 || fxBefore[0].id === fx.id).toBe(true);
    expect(lines.find((l) => l.accountId === code['1000'])?.debit).toBe('120.00');
    expect(lines.find((l) => l.accountId === code['1200'])?.credit).toBe('110.00');
    expect(lines.find((l) => l.accountId === fx.id)?.credit).toBe('10.00');
    await expectBooksTied();
  });

  it('a typed rate wins; a rate lower than booked posts a loss', async () => {
    const inv = await invoiceFor(cust, '50.00', '2026-05-02', { currency: 'EUR', exchangeRate: '1.10' });
    const { entry } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-21'),
      method: 'bank_transfer',
      amount: '50.00',
      depositAccountId: code['1000'],
      currency: 'EUR',
      exchangeRate: '1.05',
      applications: [{ invoiceId: inv.id, amountApplied: '50.00' }],
    });
    const fx = (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900'))))[0];
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entry!.id));
    expect(lines.find((l) => l.accountId === fx.id)?.debit).toBe('2.50');
    await expectBooksTied();
  });

  it('the home currency code is a home-currency payment; a currency missing from the list needs a rate', async () => {
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-22'),
      method: 'cash',
      amount: '5.00',
      currency: 'USD',
      exchangeRate: '3',
      applications: [],
    });
    expect(payment.currency).toBeNull();
    expect(Number(payment.exchangeRate)).toBe(1);
    await expect(
      receivePayment(ctx, { customerId: cust, date: D('2026-05-22'), method: 'cash', amount: '5.00', currency: 'GBP', applications: [] }),
    ).rejects.toThrow(/GBP is not in your currency list/);
  });

  it('a home-currency payment is refused on a foreign invoice with a plain message', async () => {
    const inv = await invoiceFor(cust, '10.00', '2026-05-03', { currency: 'EUR', exchangeRate: '1.10', refNumber: 'EU-9' });
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-05-23'),
        method: 'cash',
        amount: '10.00',
        applications: [{ invoiceId: inv.id, amountApplied: '10.00' }],
      }),
    ).rejects.toThrow(/Invoice #EU-9 is in EUR/);
    // Received in EUR it is accepted. (Paid off so the open-invoice aging, which lists foreign
    // invoices in their own currency, stays comparable with the home-currency control account.)
    await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-23'),
      method: 'bank_transfer',
      amount: '10.00',
      depositAccountId: code['1000'],
      currency: 'EUR',
      applications: [{ invoiceId: inv.id, amountApplied: '10.00' }],
    });
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Auto-apply with discounts (C3)
// ---------------------------------------------------------------------------

describe('auto-apply respects discounts and credits already entered', () => {
  it('cashDue lowers what cash must cover; the auto-applied payment saves', async () => {
    const docs = [
      { id: 'a', date: '2026-01-01', dueDate: '2026-01-31', balanceDue: '100.00' },
      { id: 'b', date: '2026-02-01', dueDate: '2026-03-01', balanceDue: '50.00' },
    ];
    // Without the fix the whole 100 went on 'a' even though a 2.00 discount was taken.
    const due = cashDue(docs, { a: '2.00', b: '50' });
    expect(due).toEqual([{ ...docs[0], balanceDue: '98.00' }]);
    expect(autoApplyPayment('98.00', due)).toEqual({ a: '98.00' });
    expect(cashDue(docs, { a: 'oops', b: '' })).toEqual(docs);

    const cust = (await createCustomer(ctx, { displayName: 'Discount Auto' })).id;
    const inv = await invoiceFor(cust, '100.00', '2026-06-01');
    const applied = autoApplyPayment('98.00', cashDue([{ id: inv.id, date: '2026-06-01', balanceDue: '100.00' }], { [inv.id]: '2.00' }));
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-06-05'),
      method: 'check',
      amount: '98.00',
      applications: [{ invoiceId: inv.id, amountApplied: applied[inv.id], discountAmount: '2.00' }],
    });
    expect(payment.unapplied).toBe('0.00');
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.status).toBe('paid');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Earlier-payment credits while editing (C4)
// ---------------------------------------------------------------------------

describe('editing a payment can use earlier payments (no longer dropped)', () => {
  it('applies the earlier payment, even after switching to another customer', async () => {
    const first = (await createCustomer(ctx, { displayName: 'Edit First' })).id;
    const second = (await createCustomer(ctx, { displayName: 'Edit Second' })).id;
    const inv = await invoiceFor(second, '100.00', '2026-06-10');
    // An overpayment by the second customer: 30.00 left unapplied.
    const earlier = await receivePayment(ctx, { customerId: second, date: D('2026-06-11'), method: 'check', amount: '30.00', applications: [] });
    // A payment entered against the wrong customer.
    const wrong = await receivePayment(ctx, { customerId: first, date: D('2026-06-12'), method: 'check', amount: '70.00', applications: [] });

    await updatePayment(ctx, wrong.payment.id, {
      customerId: second,
      date: D('2026-06-12'),
      method: 'check',
      amount: '70.00',
      applications: [{ invoiceId: inv.id, amountApplied: '70.00' }],
      paymentCredits: [{ paymentId: earlier.payment.id, invoiceId: inv.id, amount: '30.00' }],
    });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('0.00');
    const [e] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, earlier.payment.id));
    expect(e.unapplied).toBe('0.00');
    await expectBooksTied();

    // A payment can't be used as a credit on itself.
    await expect(
      updatePayment(ctx, wrong.payment.id, {
        customerId: second,
        date: D('2026-06-12'),
        method: 'check',
        amount: '70.00',
        applications: [],
        paymentCredits: [{ paymentId: wrong.payment.id, invoiceId: inv.id, amount: '1.00' }],
      }),
    ).rejects.toThrow(/itself/);
  });
});

// ---------------------------------------------------------------------------
// General Journal credit -> General Journal charge (I11 follow-up)
// ---------------------------------------------------------------------------

describe('a General Journal A/R credit can be applied to a General Journal A/R charge', () => {
  let cust: string;
  let chargeLine: string;
  let creditLine: string;
  let chargeEntry: string;
  let creditEntry: string;

  beforeAll(async () => {
    cust = (await createCustomer(ctx, { displayName: 'JE Offset Customer' })).id;
    const charge = await createManualEntry(ctx, {
      date: D('2026-07-01'),
      description: 'Rebill',
      lines: [
        { accountId: code['1200'], debit: '100.00', entityType: 'customer', entityId: cust },
        { accountId: code['4000'], credit: '100.00' },
      ],
    });
    const credit = await createManualEntry(ctx, {
      date: D('2026-07-02'),
      description: 'Goodwill credit',
      lines: [
        { accountId: code['4000'], debit: '40.00' },
        { accountId: code['1200'], credit: '40.00', entityType: 'customer', entityId: cust },
      ],
    });
    chargeEntry = charge.id;
    creditEntry = credit.id;
    chargeLine = (await lineOf(charge.id, '1200')).id;
    creditLine = (await lineOf(credit.id, '1200')).id;
  });

  it('in Receive Payments: credit 40 on the charge + cash 60 closes both lines', async () => {
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-07-05'),
      method: 'check',
      amount: '60.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLine, amount: '60.00' }],
      journalOffsets: [{ journalLineId: creditLine, chargeLineId: chargeLine, amount: '40.00' }],
    });
    const open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.charges).toHaveLength(0);
    expect(open.credits).toHaveLength(0);
    const detail = await getPayment(ctx, payment.id);
    expect(detail.journalOffsets).toEqual([{ journalLineId: creditLine, chargeLineId: chargeLine, amount: '40.00' }]);
    await expectBooksTied();

    // The entries can't be voided while applied.
    await expect(voidEntry(ctx, creditEntry)).rejects.toThrow(/applied/);

    // Editing without mentioning the offsets keeps them.
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: D('2026-07-05'),
      method: 'check',
      amount: '60.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLine, amount: '60.00' }],
    });
    expect((await getPayment(ctx, payment.id)).journalOffsets).toHaveLength(1);

    // Voiding the payment reopens both lines.
    await voidPayment(ctx, payment.id);
    const reopened = await listJournalOpenItems(ctx, 'ar', cust);
    expect(reopened.charges[0].open).toBe('100.00');
    expect(reopened.credits[0].open).toBe('40.00');
    await expectBooksTied();
  });

  it('over-applying the credit or the charge is refused', async () => {
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-07-06'),
        method: 'check',
        amount: '0',
        applications: [],
        journalOffsets: [{ journalLineId: creditLine, chargeLineId: chargeLine, amount: '40.01' }],
      }),
    ).rejects.toThrow(/only has 40.00 left open/);
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-07-06'),
        method: 'check',
        amount: '0',
        applications: [],
        // a charge used as a credit
        journalOffsets: [{ journalLineId: chargeLine, chargeLineId: creditLine, amount: '1.00' }],
      }),
    ).rejects.toThrow(/not a credit/);
  });

  it('standalone apply and unapply move both lines together', async () => {
    const app = await applyJournalCredit(ctx, { journalLineId: creditLine, chargeLineId: chargeLine, amount: '25.00', date: D('2026-07-10') });
    let open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.charges[0].open).toBe('75.00');
    expect(open.credits[0].open).toBe('15.00');
    const rows = await db.select().from(journalItemApplications).where(eq(journalItemApplications.pairId, app.pairId!));
    expect(rows).toHaveLength(2);
    await expectBooksTied();

    await unapplyJournalApplication(ctx, rows[1].id);
    open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.charges[0].open).toBe('100.00');
    expect(open.credits[0].open).toBe('40.00');
    expect(await db.select().from(journalItemApplications).where(eq(journalItemApplications.pairId, app.pairId!))).toHaveLength(0);
    // Unapplied, the entry can be voided again.
    await voidEntry(ctx, chargeEntry);
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Pay Bills: one transaction; A/P General Journal credit -> amount owed
// ---------------------------------------------------------------------------

describe('Pay Bills saves credits and payment together', () => {
  let vendorId: string;
  beforeAll(async () => {
    vendorId = (await createVendor(ctx, { displayName: 'P1 Vendor' })).id;
  });

  it('a refused payment leaves the vendor credit unapplied (all or nothing)', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-01'), billNumber: 'P1-1', lines: [{ accountId: code['6000'], amount: '100.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-02'), lines: [{ accountId: code['6000'], amount: '30.00' }] });
    // 30 credit + 80 cash > 100 owed: the payment part is refused.
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-05'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [{ billId: bill.id, amountApplied: '80.00' }],
        vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '30.00' }],
      }),
    ).rejects.toThrow(/exceeds balance due/);
    const [vcRow] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(vcRow.unapplied).toBe('30.00');
    const [b1] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b1.balanceDue).toBe('100.00');

    // The right amounts save both together.
    const { payment, creditsApplied } = await payBillsWithCredits(ctx, {
      vendorId,
      date: D('2026-08-05'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [{ billId: bill.id, amountApplied: '70.00' }],
      vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '30.00' }],
    });
    expect(payment?.amount).toBe('70.00');
    expect(creditsApplied).toBe('30.00');
    const [b2] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b2.status).toBe('paid');
    await expectBooksTied();
  });

  it('credits only: no bill payment, no money moves', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-10'), billNumber: 'P1-2', lines: [{ accountId: code['6000'], amount: '20.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-10'), lines: [{ accountId: code['6000'], amount: '20.00' }] });
    const res = await payBillsWithCredits(ctx, {
      vendorId,
      date: D('2026-08-11'),
      method: 'check',
      paymentAccountId: '',
      applications: [],
      vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '20.00' }],
    });
    expect(res.payment).toBeNull();
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.status).toBe('paid');
    await expectBooksTied();
  });

  it('a discount with no cash on the bill is refused instead of silently dropped', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-12'), billNumber: 'P1-3', lines: [{ accountId: code['6000'], amount: '20.00' }] });
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-12'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [{ billId: bill.id, amountApplied: '0', discountTaken: '1.00' }],
      }),
    ).rejects.toThrow(/discount needs a cash payment/);
  });

  it('a General Journal vendor credit applied to a General Journal amount owed', async () => {
    const owed = await createManualEntry(ctx, {
      date: D('2026-08-15'),
      description: 'Accrued fee',
      lines: [
        { accountId: code['6000'], debit: '80.00' },
        { accountId: code['2000'], credit: '80.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const credit = await createManualEntry(ctx, {
      date: D('2026-08-16'),
      description: 'Vendor rebate',
      lines: [
        { accountId: code['2000'], debit: '30.00', entityType: 'vendor', entityId: vendorId },
        { accountId: code['6000'], credit: '30.00' },
      ],
    });
    const owedLine = (await lineOf(owed.id, '2000')).id;
    const creditLine = (await lineOf(credit.id, '2000')).id;

    const { payment } = await payBillsWithCredits(ctx, {
      vendorId,
      date: D('2026-08-20'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: owedLine, amount: '50.00' }],
      journalOffsets: [{ journalLineId: creditLine, chargeLineId: owedLine, amount: '30.00' }],
    });
    expect(payment?.amount).toBe('50.00');
    let open = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(open.charges).toHaveLength(0);
    expect(open.credits).toHaveLength(0);
    await expectBooksTied();

    await voidBillPayment(ctx, payment!.id);
    open = await listJournalOpenItems(ctx, 'ap', vendorId);
    expect(open.charges[0].open).toBe('80.00');
    expect(open.credits[0].open).toBe('30.00');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Income Tracker as of a past day
// ---------------------------------------------------------------------------

describe('Income Tracker honours as-of in every bucket', () => {
  let cust: string;
  const asOf = D('2026-09-15');
  let estOld: string;
  let estNew: string;
  let soId: string;
  let timeId: string;
  let invPaidLater: string;
  let invAfter: string;
  let bouncedPayment: string;

  beforeAll(async () => {
    cust = (await createCustomer(ctx, { displayName: 'Tracker As-Of' })).id;
    // Estimate dated before the day, converted after it (convert dates the invoice today).
    estOld = (await createEstimate(ctx, { customerId: cust, date: D('2026-09-01'), lines: [{ description: 'Quote', quantity: 1, rate: 300 }] })).id;
    await convertEstimate(ctx, estOld, { overrideCreditLimit: true });
    // Estimate dated after the day.
    estNew = (await createEstimate(ctx, { customerId: cust, date: D('2026-09-20'), lines: [{ description: 'Later quote', quantity: 1, rate: 50 }] })).id;
    // Sales order dated before, invoiced after the day.
    soId = (await createSalesOrder(ctx, { customerId: cust, date: D('2026-09-02'), lines: [{ description: 'Order', quantity: 2, rate: '25' }] })).id;
    await convertSalesOrder(ctx, soId, { date: D('2026-09-25'), overrideCreditLimit: true });
    // Billable time before the day, billed after it.
    const te = await createTimeEntry(ctx, { customerId: cust, date: D('2026-09-03'), hours: 2, billable: true, rate: 40, description: 'Consulting' });
    timeId = te.id;
    const timeInv = await invoiceFor(cust, '80.00', '2026-09-26');
    await db.execute(sql`UPDATE time_entries SET invoiced_invoice_id = ${timeInv.id} WHERE id = ${timeId}`);
    // Invoice due before the day, paid after it.
    invPaidLater = (await invoiceFor(cust, '200.00', '2026-09-05', { dueDate: D('2026-09-10') })).id;
    await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-09-20'),
      method: 'check',
      amount: '200.00',
      applications: [{ invoiceId: invPaidLater, amountApplied: '200.00' }],
    });
    // Invoice dated after the day.
    invAfter = (await invoiceFor(cust, '75.00', '2026-09-18')).id;
    // A check received before the day that bounced after it.
    const p = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-09-08'),
      method: 'check',
      amount: '33.00',
      depositAccountId: code['1000'],
      applications: [],
    });
    bouncedPayment = p.payment.id;
    await recordBouncedCheck(ctx, { paymentId: bouncedPayment, date: D('2026-09-22') });
  });

  it('rebuilds unbilled, open, overdue and paid for the day', async () => {
    const t = await incomeTracker(ctx, { asOf, customerId: cust });
    expect(t.asOf).toBe('2026-09-15');
    const find = (type: string, id: string) => t.rows.find((r) => r.type === type && r.id === id);

    // Unbilled: the estimate and order invoiced later, the time billed later; not the later estimate.
    expect(find('estimate', estOld)).toMatchObject({ bucket: 'unbilled', openBalance: '300.00' });
    expect(find('estimate', estNew)).toBeUndefined();
    expect(find('sales_order', soId)).toMatchObject({ bucket: 'unbilled', openBalance: '50.00' });
    expect(find('time', timeId)).toMatchObject({ bucket: 'unbilled', openBalance: '80.00' });

    // Overdue on the day with its full balance (the payment came later); later invoice left out.
    expect(find('invoice', invPaidLater)).toMatchObject({ bucket: 'overdue', openBalance: '200.00', daysOverdue: 5 });
    expect(find('invoice', invAfter)).toBeUndefined();

    // Paid: the check that bounced after the day had been received on it.
    expect(find('payment', bouncedPayment)).toMatchObject({ bucket: 'paid', openBalance: '33.00' });
    expect(t.rows.every((r) => r.date <= '2026-09-15')).toBe(true);
  });

  it('today the same documents are billed / paid', async () => {
    const t = await incomeTracker(ctx, { customerId: cust });
    const find = (type: string, id: string) => t.rows.find((r) => r.type === type && r.id === id);
    expect(find('estimate', estOld)).toBeUndefined();
    expect(find('sales_order', soId)).toBeUndefined();
    expect(find('time', timeId)).toBeUndefined();
    expect(find('invoice', invPaidLater)).toBeUndefined();
    expect(find('estimate', estNew)).toMatchObject({ bucket: 'unbilled' });
    expect(t.rows.some((r) => r.type === 'payment' && r.id === bouncedPayment)).toBe(false);
  });
});
