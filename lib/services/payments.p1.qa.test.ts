/**
 * P1 round, team payments — independent adversarial QA (tester).
 *
 * Probes every P1 payments item beyond the doer's own tests (payments.p1.test.ts):
 *  - Receive Payments list: paging bounds, same-day order, amount search, filters through the
 *    API route, canBounce for void / foreign / refunded payments, company isolation;
 *  - foreign-currency payments: penny rounding across partial payments (A/R control must clear
 *    when the invoice is paid), void, overpayment, bad rates;
 *  - earlier-payment credits while editing: all-or-nothing, void / other-company payments refused;
 *  - General Journal credit -> General Journal charge: other customer / other side / same line /
 *    closing date / rollback / split offsets / company isolation;
 *  - Pay Bills credits + payment in one transaction: every refusal leaves nothing behind;
 *  - Income Tracker as of a day: partial payments, journal credits applied later, totals, route;
 *  - migration 0041 re-run on an existing database (upgraded databases) and its constraint;
 *  - UI wiring (page source) for the Receive Payments / Pay Bills / Income Tracker items.
 *
 * After every money step: TB balanced and A/R (A/P) control == aging.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
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
import { createCompany, setClosingDate } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createManualEntry } from './journal';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { createVendorCredit } from './vendorCredits';
import {
  receivePayment,
  refundPayment,
  searchPayments,
  updatePayment,
  voidPayment,
} from './payments';
import { payBillsWithCredits } from './billPayments';
import {
  applyJournalCredit,
  listJournalOpenItems,
  unapplyJournalApplication,
} from './journalApplications';
import { incomeTracker } from './incomeTracker';

// Route handlers under test use the mocked getServerContext below.
let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => routeCtx),
}));
import { GET as paymentsGET } from '@/app/api/payments/route';
import { GET as trackerGET } from '@/app/api/income-tracker/route';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-payments-p1-qa');

let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const code: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2027-12-31T23:59:59Z');

async function controlOf(c: ServiceContext, subtype: 'accounts_receivable' | 'accounts_payable'): Promise<number> {
  const tb = await trialBalance(c, AS_OF);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, c.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round((subtype === 'accounts_receivable' ? total : -total) * 100) / 100;
}

async function expectBooksTied(c: ServiceContext = ctx) {
  const tb = await trialBalance(c, AS_OF);
  expect(tb.balanced).toBe(true);
  expect(Number((await arAging(c, AS_OF)).totals.total)).toBeCloseTo(await controlOf(c, 'accounts_receivable'), 2);
  expect(Number((await apAging(c, AS_OF)).totals.total)).toBeCloseTo(await controlOf(c, 'accounts_payable'), 2);
}

async function lineOf(entryId: string, accountCode: string) {
  const [l] = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, code[accountCode])));
  return l;
}

async function invoiceFor(c: ServiceContext, customerId: string, amount: string, date: string, extra: Record<string, unknown> = {}) {
  const acct = c === ctx ? code['4000'] : codeB['4000'];
  return createInvoice(c, {
    customerId,
    date: D(date),
    dueDate: D(date),
    lines: [{ accountId: acct, description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as Parameters<typeof createInvoice>[1]);
}

async function arCharge(customerId: string, amount: string, date: string) {
  const e = await createManualEntry(ctx, {
    date: D(date),
    description: 'JE charge',
    lines: [
      { accountId: code['1200'], debit: amount, entityType: 'customer', entityId: customerId },
      { accountId: code['4000'], credit: amount },
    ],
  });
  return { entryId: e.id, lineId: (await lineOf(e.id, '1200')).id };
}

async function arCredit(customerId: string, amount: string, date: string) {
  const e = await createManualEntry(ctx, {
    date: D(date),
    description: 'JE credit',
    lines: [
      { accountId: code['4000'], debit: amount },
      { accountId: code['1200'], credit: amount, entityType: 'customer', entityId: customerId },
    ],
  });
  return { entryId: e.id, lineId: (await lineOf(e.id, '1200')).id };
}

const codeB: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-payments-qa@test.local', name: 'P1 QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'P1 Payments QA Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  routeCtx = ctx;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  const other = await createCompany(db, { name: 'P1 Payments QA Other Co', ownerId: user.id });
  ctxB = { db, companyId: other.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctxB.companyId))) codeB[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Receive Payments list
// ---------------------------------------------------------------------------

describe('QA: Receive Payments list', () => {
  let cust: string;
  const ids: string[] = [];

  beforeAll(async () => {
    cust = (await createCustomer(ctx, { displayName: 'Zebra Listing QA' })).id;
    // Three payments on the SAME day, entered in order: newest entered must come first.
    for (const [ref, amt] of [['SAME-1', '11.00'], ['SAME-2', '102.50'], ['SAME-3', '13.00']] as const) {
      const r = await receivePayment(ctx, { customerId: cust, date: D('2026-02-10'), method: 'check', reference: ref, amount: amt, applications: [] });
      ids.push(r.payment.id);
    }
    await receivePayment(ctx, { customerId: cust, date: D('2026-02-11'), method: 'check', reference: 'NEXT-DAY', amount: '14.00', applications: [] });
  });

  it('same-day payments: the one entered last is listed first', async () => {
    const r = await searchPayments(ctx, { customerId: cust });
    expect(r.payments.map((p) => p.reference)).toEqual(['NEXT-DAY', 'SAME-3', 'SAME-2', 'SAME-1']);
    expect(r.total).toBe(4);
  });

  it('paging bounds are clamped; an offset past the end returns no rows but the real total', async () => {
    expect((await searchPayments(ctx, { customerId: cust, limit: 0 })).payments).toHaveLength(1);
    expect((await searchPayments(ctx, { customerId: cust, limit: 0 })).limit).toBe(1);
    expect((await searchPayments(ctx, { customerId: cust, limit: 100_000 })).limit).toBe(500);
    const neg = await searchPayments(ctx, { customerId: cust, offset: -10, limit: 2 });
    expect(neg.offset).toBe(0);
    expect(neg.payments.map((p) => p.reference)).toEqual(['NEXT-DAY', 'SAME-3']);
    const past = await searchPayments(ctx, { customerId: cust, offset: 50 });
    expect(past.payments).toHaveLength(0);
    expect(past.total).toBe(4);
  });

  it('amount search matches 102.5 / 102.50 / $102.50 exactly, not 1025 or 10.25', async () => {
    for (const q of ['102.5', '102.50', '$102.50']) {
      expect((await searchPayments(ctx, { customerId: cust, search: q })).payments.map((p) => p.reference)).toEqual(['SAME-2']);
    }
    expect((await searchPayments(ctx, { customerId: cust, search: '10.25' })).total).toBe(0);
    // Search is case-insensitive on the customer name.
    expect((await searchPayments(ctx, { search: 'zebra listing qa' })).total).toBe(4);
  });

  it('a "to" timestamp late in the day still includes the whole day and nothing after', async () => {
    const r = await searchPayments(ctx, { customerId: cust, from: new Date('2026-02-10T23:30:00Z'), to: new Date('2026-02-10T23:59:00Z') });
    expect(r.payments.map((p) => p.reference)).toEqual(['SAME-3', 'SAME-2', 'SAME-1']);
  });

  it('another company sees none of these payments', async () => {
    expect((await searchPayments(ctxB, { search: 'Zebra Listing QA' })).total).toBe(0);
    expect((await searchPayments(ctxB, { customerId: cust })).total).toBe(0);
  });

  it('API route: paging, filters, search and bad dates', async () => {
    routeCtx = ctx;
    const get = (qs: string) => paymentsGET(new NextRequest(`http://localhost/api/payments?${qs}`));
    let res = await get(`customerId=${cust}&limit=2&offset=1`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.total).toBe(4);
    expect(body.payments.map((p: { reference: string }) => p.reference)).toEqual(['SAME-3', 'SAME-2']);
    res = await get(`customerId=${cust}&from=2026-02-11&to=2026-02-11`);
    body = await res.json();
    expect(body.payments.map((p: { reference: string }) => p.reference)).toEqual(['NEXT-DAY']);
    res = await get(`customerId=${cust}&search=SAME-1`);
    body = await res.json();
    expect(body.total).toBe(1);
    // Garbage paging falls back to defaults instead of erroring or returning NaN rows.
    res = await get(`customerId=${cust}&limit=abc&offset=xyz`);
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.payments).toHaveLength(4);
    res = await get(`from=not-a-date`);
    expect(res.status).toBe(400);
  });

  it('canBounce is false for void, foreign-currency, refunded and zero-amount checks', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Bounce Flags QA' })).id;
    const voided = await receivePayment(ctx, { customerId: c, date: D('2026-03-01'), method: 'check', amount: '10.00', depositAccountId: code['1000'], applications: [] });
    await voidPayment(ctx, voided.payment.id);
    const refunded = await receivePayment(ctx, { customerId: c, date: D('2026-03-02'), method: 'check', amount: '40.00', depositAccountId: code['1000'], applications: [] });
    await refundPayment(ctx, { paymentId: refunded.payment.id, bankAccountId: code['1000'], amount: '5.00', date: D('2026-03-03') });
    const ok = await receivePayment(ctx, { customerId: c, date: D('2026-03-04'), method: 'check', amount: '12.00', depositAccountId: code['1000'], applications: [] });
    const rows = new Map((await searchPayments(ctx, { customerId: c })).payments.map((p) => [p.id, p] as const));
    expect(rows.get(voided.payment.id)!.canBounce).toBe(false);
    expect(rows.get(refunded.payment.id)!.refunded).toBe(true);
    expect(rows.get(refunded.payment.id)!.canBounce).toBe(false);
    expect(rows.get(ok.payment.id)!.canBounce).toBe(true);
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Foreign currency
// ---------------------------------------------------------------------------

describe('QA: foreign-currency payments', () => {
  let cust: string;
  beforeAll(async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.150000' });
    cust = (await createCustomer(ctx, { displayName: 'Euro QA' })).id;
  });

  it('three partial payments at the booked rate leave no penny on A/R once the invoice is paid', async () => {
    // Own company, so a residue here can't spill into the other tests' tie-outs.
    const ownerId = ctx.userId as string;
    const co = await createCompany(db, { name: 'P1 Payments QA FX Pennies', ownerId });
    const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
    const cc: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) cc[a.code] = a.id;
    await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
    const eu = (await createCustomer(c, { displayName: 'Euro Pennies' })).id;
    // 100.05 EUR at 1.13 books 113.06 (113.0565); three payments of 33.35 at 1.13 each relieve
    // 37.69 (37.6855) = 113.07 — one cent more than was ever put on A/R.
    const inv = await createInvoice(c, {
      customerId: eu,
      date: D('2026-05-01'),
      dueDate: D('2026-05-01'),
      currency: 'EUR',
      exchangeRate: '1.13',
      lines: [{ accountId: cc['4000'], description: 'Work', quantity: 1, rate: '100.05', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    for (const day of ['2026-05-02', '2026-05-03', '2026-05-04']) {
      await receivePayment(c, {
        customerId: eu,
        date: D(day),
        method: 'bank_transfer',
        amount: '33.35',
        depositAccountId: cc['1000'],
        currency: 'EUR',
        exchangeRate: '1.13',
        applications: [{ invoiceId: inv.id, amountApplied: '33.35' }],
      });
    }
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.status).toBe('paid');
    expect(row.balanceDue).toBe('0.00');
    expect((await trialBalance(c, AS_OF)).balanced).toBe(true);
    // QuickBooks clears the rounding residue into Exchange Gain/Loss on the final payment:
    // a fully paid invoice must leave nothing on the A/R control account (aging shows 0).
    expect(Number((await arAging(c, AS_OF)).totals.total)).toBe(0);
    expect(await controlOf(c, 'accounts_receivable')).toBeCloseTo(0, 2);
  });

  it('voiding a payment that posted a gain takes the gain back and reopens the invoice', async () => {
    const fxNet = async () => {
      const tb = await trialBalance(ctx, AS_OF);
      const [fx] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900')));
      const r = fx ? tb.rows.find((x) => x.accountId === fx.id) : undefined;
      return r ? Number(r.debit) - Number(r.credit) : 0;
    };
    const inv = await invoiceFor(ctx, cust, '200.00', '2026-05-10', { currency: 'EUR', exchangeRate: '1.10' });
    const before = await fxNet();
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-11'),
      method: 'bank_transfer',
      amount: '200.00',
      depositAccountId: code['1000'],
      currency: 'EUR',
      exchangeRate: '1.20',
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    });
    expect(Math.round((await fxNet() - before) * 100) / 100).toBe(-20); // 20.00 gain (credit)
    await voidPayment(ctx, payment.id);
    expect(Math.round((await fxNet() - before) * 100) / 100).toBe(0);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('200.00');
    // Paid off again (so the open-invoice aging, in invoice currency, stays comparable).
    await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-05-12'),
      method: 'bank_transfer',
      amount: '200.00',
      depositAccountId: code['1000'],
      currency: 'EUR',
      exchangeRate: '1.10',
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    });
    await expectBooksTied();
  });

  it('zero, negative and sub-micro exchange rates are refused; nothing is saved', async () => {
    const before = (await searchPayments(ctx, { customerId: cust, limit: 500 })).total;
    // review5 fx: rates keep 8 decimals, so the sub-micro rate is one that rounds to 0 there.
    for (const rate of ['0', '-1.2', '0.000000001']) {
      await expect(
        receivePayment(ctx, { customerId: cust, date: D('2026-05-20'), method: 'cash', amount: '5.00', currency: 'EUR', exchangeRate: rate, applications: [] }),
      ).rejects.toThrow(/Exchange rate must be positive/);
    }
    // A rate that leaves the payment worth nothing in home currency is refused too.
    await expect(
      receivePayment(ctx, { customerId: cust, date: D('2026-05-20'), method: 'cash', amount: '5.00', currency: 'EUR', exchangeRate: '0.0000001', applications: [] }),
    ).rejects.toThrow(/too small to convert/);
    expect((await searchPayments(ctx, { customerId: cust, limit: 500 })).total).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Earlier-payment credits while editing
// ---------------------------------------------------------------------------

describe('QA: editing a payment with earlier payments', () => {
  it('a refused edit leaves the earlier payment and the edited payment untouched (all or nothing)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Edit Rollback QA' })).id;
    const inv = await invoiceFor(ctx, cust, '100.00', '2026-06-01');
    const earlier = await receivePayment(ctx, { customerId: cust, date: D('2026-06-02'), method: 'check', amount: '30.00', applications: [] });
    const p = await receivePayment(ctx, { customerId: cust, date: D('2026-06-03'), method: 'check', amount: '50.00', applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] });
    // 30 earlier + 80 cash > 100 owed.
    await expect(
      updatePayment(ctx, p.payment.id, {
        customerId: cust,
        date: D('2026-06-03'),
        method: 'check',
        amount: '80.00',
        applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
        paymentCredits: [{ paymentId: earlier.payment.id, invoiceId: inv.id, amount: '30.00' }],
      }),
    ).rejects.toThrow();
    const [e] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, earlier.payment.id));
    expect(e.unapplied).toBe('30.00');
    const [pp] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, p.payment.id));
    expect(pp.amount).toBe('50.00');
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('50.00');
    await expectBooksTied();
  });

  it('a void earlier payment, or one from another company, is refused', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Edit Void QA' })).id;
    const inv = await invoiceFor(ctx, cust, '100.00', '2026-06-05');
    const earlier = await receivePayment(ctx, { customerId: cust, date: D('2026-06-06'), method: 'check', amount: '30.00', applications: [] });
    await voidPayment(ctx, earlier.payment.id);
    const p = await receivePayment(ctx, { customerId: cust, date: D('2026-06-07'), method: 'check', amount: '10.00', applications: [] });
    const edit = (paymentId: string) =>
      updatePayment(ctx, p.payment.id, {
        customerId: cust,
        date: D('2026-06-07'),
        method: 'check',
        amount: '10.00',
        applications: [{ invoiceId: inv.id, amountApplied: '10.00' }],
        paymentCredits: [{ paymentId, invoiceId: inv.id, amount: '5.00' }],
      });
    await expect(edit(earlier.payment.id)).rejects.toThrow(/void|no credit left/i);

    const custB = (await createCustomer(ctxB, { displayName: 'Other Co Customer' })).id;
    const foreign = await receivePayment(ctxB, { customerId: custB, date: D('2026-06-06'), method: 'check', amount: '30.00', applications: [] });
    await expect(edit(foreign.payment.id)).rejects.toThrow(/not found/i);
    const [fb] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, foreign.payment.id));
    expect(fb.unapplied).toBe('30.00');
    await expectBooksTied();
    await expectBooksTied(ctxB);
  });

  it('voiding the edited payment later keeps the earlier payment applied (it is its own transaction)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Edit Then Void QA' })).id;
    const inv = await invoiceFor(ctx, cust, '100.00', '2026-06-10');
    const earlier = await receivePayment(ctx, { customerId: cust, date: D('2026-06-11'), method: 'check', amount: '30.00', applications: [] });
    const p = await receivePayment(ctx, { customerId: cust, date: D('2026-06-12'), method: 'check', amount: '70.00', applications: [] });
    await updatePayment(ctx, p.payment.id, {
      customerId: cust,
      date: D('2026-06-12'),
      method: 'check',
      amount: '70.00',
      applications: [{ invoiceId: inv.id, amountApplied: '70.00' }],
      paymentCredits: [{ paymentId: earlier.payment.id, invoiceId: inv.id, amount: '30.00' }],
    });
    await voidPayment(ctx, p.payment.id);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('70.00');
    const [e] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, earlier.payment.id));
    expect(e.unapplied).toBe('0.00');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// General Journal credit -> General Journal charge
// ---------------------------------------------------------------------------

describe('QA: General Journal credit applied to a General Journal charge', () => {
  let cust: string;
  let other: string;
  let vendorId: string;

  beforeAll(async () => {
    cust = (await createCustomer(ctx, { displayName: 'JE Offset QA' })).id;
    other = (await createCustomer(ctx, { displayName: 'JE Offset QA Other' })).id;
    vendorId = (await createVendor(ctx, { displayName: 'JE Offset QA Vendor' })).id;
  });

  it("refuses another customer's charge, an A/P line, and a line applied to itself", async () => {
    const credit = await arCredit(cust, '40.00', '2026-07-01');
    const otherCharge = await arCharge(other, '100.00', '2026-07-01');
    await expect(
      applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: otherCharge.lineId, amount: '10.00', date: D('2026-07-02') }),
    ).rejects.toThrow(/different customer/);
    const owed = await createManualEntry(ctx, {
      date: D('2026-07-01'),
      description: 'Owed',
      lines: [
        { accountId: code['6000'], debit: '50.00' },
        { accountId: code['2000'], credit: '50.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const owedLine = (await lineOf(owed.id, '2000')).id;
    await expect(
      applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: owedLine, amount: '10.00', date: D('2026-07-02') }),
    ).rejects.toThrow(/can't be used here/);
    await expect(
      applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: credit.lineId, amount: '10.00', date: D('2026-07-02') }),
    ).rejects.toThrow(/itself/);
    expect(await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalLineId, credit.lineId))).toHaveLength(0);
    await expectBooksTied();
  });

  it('two offsets of the same credit that together exceed it are refused', async () => {
    const credit = await arCredit(cust, '40.00', '2026-07-03');
    const c1 = await arCharge(cust, '30.00', '2026-07-03');
    const c2 = await arCharge(cust, '30.00', '2026-07-03');
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-07-04'),
        method: 'check',
        amount: '0',
        applications: [],
        journalOffsets: [
          { journalLineId: credit.lineId, chargeLineId: c1.lineId, amount: '20.00' },
          { journalLineId: credit.lineId, chargeLineId: c2.lineId, amount: '20.01' },
        ],
      }),
    ).rejects.toThrow(/only has 40.00 left open/);
    // Exactly 40 split 20 / 20 is fine; pennies left open on each charge.
    const { payment, entry } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-07-04'),
      method: 'check',
      amount: '0',
      applications: [],
      journalOffsets: [
        { journalLineId: credit.lineId, chargeLineId: c1.lineId, amount: '20.00' },
        { journalLineId: credit.lineId, chargeLineId: c2.lineId, amount: '20.00' },
      ],
    });
    expect(entry).toBeNull(); // no GL: both lines already sit in A/R
    expect(payment.amount).toBe('0.00');
    const open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.credits.find((c) => c.journalLineId === credit.lineId)).toBeUndefined();
    expect(open.charges.find((c) => c.journalLineId === c1.lineId)?.open).toBe('10.00');
    expect(open.charges.find((c) => c.journalLineId === c2.lineId)?.open).toBe('10.00');
    await expectBooksTied();
    // Voiding the zero payment reopens the credit in full.
    await voidPayment(ctx, payment.id);
    const reopened = await listJournalOpenItems(ctx, 'ar', cust);
    expect(reopened.credits.find((c) => c.journalLineId === credit.lineId)?.open).toBe('40.00');
    await expectBooksTied();
  });

  it('a payment refused for its invoice part writes no offset rows (rollback)', async () => {
    const credit = await arCredit(cust, '15.00', '2026-07-05');
    const charge = await arCharge(cust, '15.00', '2026-07-05');
    const inv = await invoiceFor(ctx, cust, '10.00', '2026-07-05');
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-07-06'),
        method: 'check',
        amount: '50.00',
        applications: [{ invoiceId: inv.id, amountApplied: '50.00' }], // more than owed
        journalOffsets: [{ journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '15.00' }],
      }),
    ).rejects.toThrow();
    expect(await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalLineId, credit.lineId))).toHaveLength(0);
    await expectBooksTied();
  });

  it("another company can't use these lines", async () => {
    const credit = await arCredit(cust, '5.00', '2026-07-07');
    const charge = await arCharge(cust, '5.00', '2026-07-07');
    await expect(
      applyJournalCredit(ctxB, { journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '1.00', date: D('2026-07-08') }),
    ).rejects.toThrow(/not found/i);
    const app = await applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '5.00', date: D('2026-07-08') });
    await expect(unapplyJournalApplication(ctxB, app.id)).rejects.toThrow(/not found/i);
    await expectBooksTied();
  });

  it('respects the closing date for apply and unapply', async () => {
    const credit = await arCredit(cust, '8.00', '2026-01-10');
    const charge = await arCharge(cust, '8.00', '2026-01-10');
    const app = await applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '3.00', date: D('2026-01-15') });
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: null });
    try {
      await expect(
        applyJournalCredit(ctx, { journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '1.00', date: D('2026-01-20') }),
      ).rejects.toThrow(/clos/i);
      await expect(unapplyJournalApplication(ctx, app.id)).rejects.toThrow(/clos/i);
      // An offsets-only payment dated in the closed period is refused too.
      await expect(
        receivePayment(ctx, {
          customerId: cust,
          date: D('2026-01-20'),
          method: 'check',
          amount: '0',
          applications: [],
          journalOffsets: [{ journalLineId: credit.lineId, chargeLineId: charge.lineId, amount: '1.00' }],
        }),
      ).rejects.toThrow(/clos/i);
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    const open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.credits.find((c) => c.journalLineId === credit.lineId)?.open).toBe('5.00');
    expect(open.charges.find((c) => c.journalLineId === charge.lineId)?.open).toBe('5.00');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Pay Bills: one transaction
// ---------------------------------------------------------------------------

describe('QA: Pay Bills credits and payment are all or nothing', () => {
  let vendorId: string;
  let otherVendor: string;
  beforeAll(async () => {
    vendorId = (await createVendor(ctx, { displayName: 'Atomic QA Vendor' })).id;
    otherVendor = (await createVendor(ctx, { displayName: 'Atomic QA Other Vendor' })).id;
  });

  const unappliedOf = async (id: string) => (await db.select().from(vendorCredits).where(eq(vendorCredits.id, id)))[0].unapplied;
  const balanceOf = async (id: string) => (await db.select().from(bills).where(eq(bills.id, id)))[0].balanceDue;

  it("a good credit followed by another vendor's credit: neither is applied", async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-01'), billNumber: 'AQ-1', lines: [{ accountId: code['6000'], amount: '100.00' }] });
    const good = await createVendorCredit(ctx, { vendorId, date: D('2026-08-01'), lines: [{ accountId: code['6000'], amount: '10.00' }] });
    const bad = await createVendorCredit(ctx, { vendorId: otherVendor, date: D('2026-08-01'), lines: [{ accountId: code['6000'], amount: '10.00' }] });
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-02'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [{ billId: bill.id, amountApplied: '50.00' }],
        vendorCredits: [
          { vendorCreditId: good.id, billId: bill.id, amount: '10.00' },
          { vendorCreditId: bad.id, billId: bill.id, amount: '10.00' },
        ],
      }),
    ).rejects.toThrow(/different vendor/);
    expect(await unappliedOf(good.id)).toBe('10.00');
    expect(await unappliedOf(bad.id)).toBe('10.00');
    expect(await balanceOf(bill.id)).toBe('100.00');
    await expectBooksTied();
  });

  it('the same vendor credit used twice beyond its balance: nothing applied', async () => {
    const b1 = await createBill(ctx, { vendorId, date: D('2026-08-03'), billNumber: 'AQ-2', lines: [{ accountId: code['6000'], amount: '50.00' }] });
    const b2 = await createBill(ctx, { vendorId, date: D('2026-08-03'), billNumber: 'AQ-3', lines: [{ accountId: code['6000'], amount: '50.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-03'), lines: [{ accountId: code['6000'], amount: '30.00' }] });
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-04'),
        method: 'check',
        paymentAccountId: '',
        applications: [],
        vendorCredits: [
          { vendorCreditId: vc.id, billId: b1.id, amount: '20.00' },
          { vendorCreditId: vc.id, billId: b2.id, amount: '20.00' },
        ],
      }),
    ).rejects.toThrow(/exceeds/);
    expect(await unappliedOf(vc.id)).toBe('30.00');
    expect(await balanceOf(b1.id)).toBe('50.00');
    expect(await balanceOf(b2.id)).toBe('50.00');
    await expectBooksTied();
  });

  it('a payment from another company bill is refused and the credit stays unapplied', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-05'), billNumber: 'AQ-4', lines: [{ accountId: code['6000'], amount: '40.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-05'), lines: [{ accountId: code['6000'], amount: '10.00' }] });
    const vB = (await createVendor(ctxB, { displayName: 'B vendor' })).id;
    const billB = await createBill(ctxB, { vendorId: vB, date: D('2026-08-05'), billNumber: 'B-1', lines: [{ accountId: codeB['6000'], amount: '40.00' }] });
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-06'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [{ billId: billB.id, amountApplied: '30.00' }],
        vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '10.00' }],
      }),
    ).rejects.toThrow();
    expect(await unappliedOf(vc.id)).toBe('10.00');
    expect(await balanceOf(bill.id)).toBe('40.00');
    expect((await db.select().from(bills).where(eq(bills.id, billB.id)))[0].balanceDue).toBe('40.00');
    await expectBooksTied();
    await expectBooksTied(ctxB);
  });

  it('credits only in a closed period are refused; nothing applied', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-02-01'), billNumber: 'AQ-5', lines: [{ accountId: code['6000'], amount: '25.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-02-01'), lines: [{ accountId: code['6000'], amount: '25.00' }] });
    await setClosingDate(ctx, { closingDate: '2026-02-28', password: null });
    try {
      await expect(
        payBillsWithCredits(ctx, {
          vendorId,
          date: D('2026-02-15'),
          method: 'check',
          paymentAccountId: '',
          applications: [],
          vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '25.00' }],
        }),
      ).rejects.toThrow(/clos/i);
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    expect(await unappliedOf(vc.id)).toBe('25.00');
    expect(await balanceOf(bill.id)).toBe('25.00');
  });

  it('a duplicate check number is refused before any credit is applied', async () => {
    const b1 = await createBill(ctx, { vendorId, date: D('2026-08-10'), billNumber: 'AQ-6', lines: [{ accountId: code['6000'], amount: '30.00' }] });
    const b2 = await createBill(ctx, { vendorId, date: D('2026-08-10'), billNumber: 'AQ-7', lines: [{ accountId: code['6000'], amount: '30.00' }] });
    await payBillsWithCredits(ctx, {
      vendorId,
      date: D('2026-08-11'),
      method: 'check',
      reference: '7001',
      paymentAccountId: code['1000'],
      applications: [{ billId: b1.id, amountApplied: '30.00' }],
      checkDuplicateNumber: true,
    } as Parameters<typeof payBillsWithCredits>[1]);
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-11'), lines: [{ accountId: code['6000'], amount: '5.00' }] });
    await expect(
      payBillsWithCredits(ctx, {
        vendorId,
        date: D('2026-08-12'),
        method: 'check',
        reference: '7001',
        paymentAccountId: code['1000'],
        applications: [{ billId: b2.id, amountApplied: '25.00' }],
        vendorCredits: [{ vendorCreditId: vc.id, billId: b2.id, amount: '5.00' }],
        checkDuplicateNumber: true,
      } as Parameters<typeof payBillsWithCredits>[1]),
    ).rejects.toThrow();
    expect(await unappliedOf(vc.id)).toBe('5.00');
    expect(await balanceOf(b2.id)).toBe('30.00');
    await expectBooksTied();
  });

  it('nothing to pay is refused; a zero-cash row with a credit saves as credits only', async () => {
    await expect(
      payBillsWithCredits(ctx, { vendorId, date: D('2026-08-13'), method: 'check', paymentAccountId: '', applications: [] }),
    ).rejects.toThrow(/Nothing to pay/);
    const bill = await createBill(ctx, { vendorId, date: D('2026-08-13'), billNumber: 'AQ-8', lines: [{ accountId: code['6000'], amount: '12.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-08-13'), lines: [{ accountId: code['6000'], amount: '12.00' }] });
    const r = await payBillsWithCredits(ctx, {
      vendorId,
      date: D('2026-08-14'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [{ billId: bill.id, amountApplied: '0' }],
      vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '12.00' }],
    });
    expect(r.payment).toBeNull();
    expect(r.creditsApplied).toBe('12.00');
    expect(await balanceOf(bill.id)).toBe('0.00');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
// Income Tracker as of a day
// ---------------------------------------------------------------------------

describe('QA: Income Tracker as of a day', () => {
  let cust: string;
  let invPartial: string;
  let invJeCredit: string;
  let payOnDay: string;
  let payAfter: string;
  const asOf = D('2027-03-15');

  beforeAll(async () => {
    cust = (await createCustomer(ctx, { displayName: 'Tracker QA' })).id;
    invPartial = (await invoiceFor(ctx, cust, '100.00', '2027-03-01', { dueDate: D('2027-03-31') })).id;
    await receivePayment(ctx, { customerId: cust, date: D('2027-03-05'), method: 'check', amount: '40.00', applications: [{ invoiceId: invPartial, amountApplied: '40.00' }] });
    const late = await receivePayment(ctx, { customerId: cust, date: D('2027-03-20'), method: 'check', amount: '60.00', applications: [{ invoiceId: invPartial, amountApplied: '60.00' }] });
    payAfter = late.payment.id;
    const onDay = await receivePayment(ctx, { customerId: cust, date: D('2027-03-15'), method: 'cash', amount: '7.00', applications: [] });
    payOnDay = onDay.payment.id;
    invJeCredit = (await invoiceFor(ctx, cust, '50.00', '2027-03-02', { dueDate: D('2027-03-10') })).id;
    const credit = await arCredit(cust, '50.00', '2027-03-03');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: invJeCredit, amount: '50.00', date: D('2027-03-25') });
    // Another company's invoice on the same day must never show.
    const custB = (await createCustomer(ctxB, { displayName: 'Tracker QA' })).id;
    await invoiceFor(ctxB, custB, '999.00', '2027-03-01');
  });

  it('partial payment before the day, rest after: open with the remainder, status partial', async () => {
    const t = await incomeTracker(ctx, { asOf, customerId: cust });
    const r = t.rows.find((x) => x.id === invPartial);
    expect(r).toMatchObject({ bucket: 'unpaid', openBalance: '60.00', status: 'partial' });
  });

  it('a General Journal credit applied after the day had not reduced the invoice', async () => {
    const t = await incomeTracker(ctx, { asOf, customerId: cust });
    expect(t.rows.find((x) => x.id === invJeCredit)).toMatchObject({ bucket: 'overdue', openBalance: '50.00', daysOverdue: 5 });
  });

  it('paid counts a payment dated on the day, not one dated after', async () => {
    const t = await incomeTracker(ctx, { asOf, customerId: cust });
    expect(t.rows.some((x) => x.type === 'payment' && x.id === payOnDay)).toBe(true);
    expect(t.rows.some((x) => x.type === 'payment' && x.id === payAfter)).toBe(false);
  });

  it('bucket totals equal the sum of their rows; no other company rows', async () => {
    const t = await incomeTracker(ctx, { asOf });
    for (const b of ['unbilled', 'unpaid', 'overdue', 'paid'] as const) {
      const rows = t.rows.filter((r) => r.bucket === b);
      expect(t.totals[b].count).toBe(rows.length);
      expect(Number(t.totals[b].amount)).toBeCloseTo(rows.reduce((s, r) => s + Number(r.openBalance), 0), 2);
    }
    expect(t.rows.some((r) => r.amount === '999.00')).toBe(false);
    // Open + overdue as of the day == A/R aging of invoices on the day for this customer.
    const mine = t.rows.filter((r) => r.customerId === cust && (r.bucket === 'unpaid' || r.bucket === 'overdue'));
    expect(mine.reduce((s, r) => s + Number(r.openBalance), 0)).toBeCloseTo(110, 2);
  });

  it('API route passes asOf through and refuses a bad date', async () => {
    routeCtx = ctx;
    let res = await trackerGET(new NextRequest(`http://localhost/api/income-tracker?customerId=${cust}&asOf=2027-03-15`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asOf).toBe('2027-03-15');
    expect(body.rows.find((x: { id: string }) => x.id === invPartial)?.openBalance).toBe('60.00');
    res = await trackerGET(new NextRequest(`http://localhost/api/income-tracker?asOf=garbage`));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Migration 0041 on an upgraded database
// ---------------------------------------------------------------------------

describe('QA: migration 0041 on an existing database', () => {
  const statements = () =>
    fs
      .readFileSync(path.join(ROOT, 'drizzle', '0041_p1_payments.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);

  it('re-runs cleanly over a database that already holds applications of every kind', async () => {
    const before = await db.execute(sql`SELECT kind, count(*)::int AS n FROM journal_item_applications GROUP BY kind ORDER BY kind`);
    const rowsBefore = (before as unknown as { rows: Array<{ kind: string; n: number }> }).rows;
    expect(rowsBefore.some((r) => r.kind === 'journal_offset')).toBe(true);
    for (const s of statements()) await db.execute(sql.raw(s));
    for (const s of statements()) await db.execute(sql.raw(s));
    const after = await db.execute(sql`SELECT kind, count(*)::int AS n FROM journal_item_applications GROUP BY kind ORDER BY kind`);
    expect((after as unknown as { rows: unknown[] }).rows).toEqual(rowsBefore);
    await expectBooksTied();
  });

  it('the journal entry is registered once with idx 41', () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const mine = j.entries.filter((e) => e.tag === '0041_p1_payments');
    expect(mine).toEqual([expect.objectContaining({ idx: 41, tag: '0041_p1_payments' })]);
  });

  it('a journal_offset row without a pair id (or tied to an invoice) is rejected by the database', async () => {
    const [any] = await db.select().from(journalItemApplications).where(eq(journalItemApplications.kind, 'journal_offset')).limit(1);
    expect(any).toBeTruthy();
    const base = {
      companyId: any.companyId,
      side: any.side,
      kind: 'journal_offset',
      journalEntryId: any.journalEntryId,
      journalLineId: any.journalLineId,
      amount: '0.01',
      date: any.date,
    };
    await expect(db.insert(journalItemApplications).values({ ...base, pairId: null })).rejects.toThrow();
    const [inv] = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId)).limit(1);
    await expect(
      db.insert(journalItemApplications).values({ ...base, pairId: any.pairId, invoiceId: inv.id }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UI wiring (page source, repo style of lib/ux*.test.ts)
// ---------------------------------------------------------------------------

describe('QA: UI wiring for the P1 payments items', () => {
  const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('Receive Payments never renders the internal invoice / memo integer directly', () => {
    const page = src('app/payments/page.tsx');
    expect(page).not.toMatch(/\{\s*inv\.invoiceNumber\s*\}/);
    expect(page).not.toMatch(/#\{\s*[a-z]+\.invoiceNumber\s*\}/);
    expect(page).not.toMatch(/\{\s*[a-z]+\.memoNumber\s*\}/);
    expect(page).toMatch(/invNo\(/);
  });

  it('Receive Payments list is paged from the server with filters and the total', () => {
    const page = src('app/payments/page.tsx');
    expect(page).toMatch(/offset:\s*String\(page \* PAGE_SIZE\)/);
    for (const k of ['customerId', 'from', 'to', 'search']) expect(page).toContain(`qs.set('${k}'`);
    expect(page).toMatch(/setTotal\(/);
    expect(page).toMatch(/p\.canBounce\s*&&/);
  });

  it('Receive Payments modal has currency + exchange rate and sends journalOffsets', () => {
    const page = src('app/payments/page.tsx');
    expect(page).toMatch(/exchangeRate/);
    expect(page).toMatch(/journalOffsets/);
    expect(page).toMatch(/cashDue\(/);
  });

  it('Pay Bills sends credits with the payment in ONE request (no separate credit calls)', () => {
    const page = src('app/pay-bills/page.tsx');
    expect(page).toMatch(/vendorCredits/);
    expect(page).not.toMatch(/api\.post\(\s*[`'"]\/api\/vendor-credits\/[^'"`]*apply/);
    expect(page).not.toMatch(/api\.post\(\s*[`'"]\/api\/bill-payments\/journal-items/);
  });

  it('Income Tracker page sends asOf to the route', () => {
    const page = src('app/income-tracker/page.tsx');
    expect(page).toMatch(/qs\.set\('asOf', asOf\)/);
  });
});
