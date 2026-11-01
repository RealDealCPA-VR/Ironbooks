/**
 * Team salesar (sub-builder "payments") — Receive Payments at QuickBooks parity:
 *  C3  the suggested early-payment discount is the terms' percent of the invoice AMOUNT (not of the
 *      balance left), from the invoice's Terms list entry (free text only for terms not on the list),
 *      less any discount already taken on the invoice, never more than it still owes; the discount
 *      actually taken can be edited but never exceeds the open balance.
 *  C4  one credit (credit memo, earlier unapplied payment, General Journal credit) split across
 *      several invoices in one payment, never above what the credit has left; a foreign-currency
 *      unapplied payment used on invoices in its own currency (FX by the fx subledger rules), mixed
 *      currencies refused.
 *  B7  the payments API routes pass the Payment Method list entry through.
 *  Deep link /payments?customerId=&invoiceId= (Income Tracker / Collections Center "Receive Payment").
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, creditMemos, invoices, journalEntries, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createCreditMemo, listCreditApplications } from './creditMemos';
import {
  getPayment,
  listAvailableCredits,
  receivePayment,
  suggestEarlyPaymentDiscounts,
  updatePayment,
  voidPayment,
} from './payments';
import { createEntry, listEntries } from './lists/simpleLists';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { createManualEntry } from './journal';
import { listJournalOpenItems } from './journalApplications';
import { trialBalance } from './reports';
import { arAging } from './reportsExtra';
import { parseReceivePaymentLink, prefillFromLink, receivePaymentHref } from '@/app/payments/deepLink';
import {
  type CreditUse,
  JE_PREFIX,
  creditLeftFor,
  creditRequest,
  creditUseFromPayment,
  creditUsed,
  fillCreditsFor,
  overdrawnCredits,
  setCreditPart,
} from '@/app/payments/creditSplit';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as paymentsPOST } from '@/app/api/payments/route';
import { PUT as paymentPUT } from '@/app/api/payments/[id]/route';
import { GET as discountsGET } from '@/app/api/payments/discounts/route';
import { GET as creditsGET } from '@/app/api/payments/credits/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-payments');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const AS_OF = new Date('2027-12-31T23:59:59Z');

function req(url: string, method = 'GET', body?: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

async function customer(name: string, extra: Record<string, unknown> = {}) {
  return (await createCustomer(ctx, { displayName: `${name} ${seq}`, ...extra } as never)).id;
}

async function invoice(customerId: string, amount: string, date: string, extra: Record<string, unknown> = {}) {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    dueDate: new Date(d(date).getTime() + 30 * 86_400_000),
    lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as never);
}

const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const payRow = async (id: string) => (await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id)))[0];

/** A/R control (home) at AS_OF. */
async function arControl(asOf: Date = AS_OF): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = 'accounts_receivable'`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round(total * 100) / 100;
}

/** Trial balance balanced and A/R aging (home) == A/R control, as of the date. */
async function expectBooksTied(asOf: Date = AS_OF) {
  expect((await trialBalance(ctx, asOf)).balanced).toBe(true);
  expect(Number((await arAging(ctx, asOf)).totals.total)).toBeCloseTo(await arControl(asOf), 2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-payments@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Payments ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

// ---------------------------------------------------------------------------
describe('C3. Early-payment discount suggested from the invoice amount and its Terms list entry', () => {
  it('suggests the terms percent of the invoice amount, not of the balance left after a part payment', async () => {
    const cust = await customer('Disc');
    const inv = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-03'),
      method: 'check',
      amount: '500.00',
      applications: [{ invoiceId: inv.id, amountApplied: '500.00' }],
    });
    const [s] = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust, paymentDate: d('2026-03-05'), invoiceIds: [inv.id] });
    expect(s).toMatchObject({
      invoiceId: inv.id,
      eligible: true,
      suggested: '20.00', // 2% of 1,000.00 (was 2% of the 500.00 left: 10.00)
      discountDate: '2026-03-11',
      percent: '2',
      invoiceAmount: '1000.00',
      openBalance: '500.00',
      alreadyTaken: '0.00',
      termsSource: 'list',
    });
  });

  it('never suggests more than the invoice still owes, nor a discount already taken on it', async () => {
    const cust = await customer('Cap');
    const nearlyPaid = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    const tookAll = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    const tookPart = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      method: 'check',
      amount: '1480.00',
      applications: [
        { invoiceId: nearlyPaid.id, amountApplied: '990.00' },
        { invoiceId: tookAll.id, amountApplied: '490.00', discountAmount: '20.00' },
      ],
    });
    await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      method: 'check',
      amount: '500.00',
      applications: [{ invoiceId: tookPart.id, amountApplied: '500.00', discountAmount: '5.00' }],
    });
    const byId = new Map(
      (await suggestEarlyPaymentDiscounts(ctx, { customerId: cust, paymentDate: d('2026-03-05') })).map((s) => [s.invoiceId, s]),
    );
    expect(byId.get(nearlyPaid.id)).toMatchObject({ eligible: true, suggested: '10.00', openBalance: '10.00' });
    expect(byId.get(tookAll.id)).toMatchObject({ eligible: true, suggested: '0.00', alreadyTaken: '20.00' });
    expect(byId.get(tookPart.id)).toMatchObject({ eligible: true, suggested: '15.00', alreadyTaken: '5.00' });
  });

  it("uses the invoice's Terms list entry by name (list values win over the text); free text not on the list still works", async () => {
    const cust = await customer('Terms', { terms: '2% 10 Net 30' });
    await createEntry(ctx, 'terms', { name: 'Prompt Pay', kind: 'standard', netDays: 30, discountPercent: '3', discountDays: 15 });
    // A list entry whose name reads like other terms: its own percent / days are what count.
    await createEntry(ctx, 'terms', { name: '2/10 n/30', kind: 'standard', netDays: 30, discountPercent: '1.5', discountDays: 5 });
    await createEntry(ctx, 'terms', {
      name: 'Due 25th, 2% by the 10th',
      kind: 'date_driven',
      dueDayOfMonth: 25,
      discountDayOfMonth: 10,
      discountPercent: '2',
    });
    const prompt = await invoice(cust, '200.00', '2026-03-01', { terms: 'Prompt Pay' });
    const lookalike = await invoice(cust, '1000.00', '2026-03-01', { terms: '2/10 n/30' });
    const legacy = await invoice(cust, '300.00', '2026-03-01', { terms: '1/15 n/45' });
    const net = await invoice(cust, '400.00', '2026-03-01', { terms: 'Net 30' });
    const dateDriven = await invoice(cust, '500.00', '2026-03-03', { terms: 'Due 25th, 2% by the 10th' });

    const on = async (day: string) =>
      new Map((await suggestEarlyPaymentDiscounts(ctx, { customerId: cust, paymentDate: d(day) })).map((s) => [s.invoiceId, s]));
    const day4 = await on('2026-03-04');
    expect(day4.get(prompt.id)).toMatchObject({ eligible: true, suggested: '6.00', discountDate: '2026-03-16', termsSource: 'list' });
    expect(day4.get(lookalike.id)).toMatchObject({ eligible: true, suggested: '15.00', discountDate: '2026-03-06', percent: '1.5', termsSource: 'list' });
    expect(day4.get(legacy.id)).toMatchObject({ eligible: true, suggested: '3.00', discountDate: '2026-03-16', termsSource: 'text' });
    // The invoice's own terms decide, not the customer's.
    expect(day4.get(net.id)).toMatchObject({ eligible: false, suggested: '0.00', discountDate: null });
    expect(day4.get(dateDriven.id)).toMatchObject({ eligible: true, suggested: '10.00', discountDate: '2026-03-10' });

    const day17 = await on('2026-03-17');
    expect(day17.get(prompt.id)).toMatchObject({ eligible: false, suggested: '0.00', discountDate: '2026-03-16' });
  });

  it("an invoice saved without terms falls back to the customer's Terms list entry", async () => {
    const terms = await listEntries(ctx, 'terms');
    const oneTen = terms.find((t) => t.name === '1% 10 Net 30')!;
    const cust = await customer('Legacy', { termsId: oneTen.id });
    const inv = await invoice(cust, '250.00', '2026-03-01');
    const [s] = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust, paymentDate: d('2026-03-11'), invoiceIds: [inv.id] });
    expect(s).toMatchObject({ eligible: true, suggested: '2.50', discountDate: '2026-03-11', termsSource: 'list' });
  });

  it("while editing a payment its own discount is offered again (it is not counted as already taken)", async () => {
    const cust = await customer('Edit');
    const inv = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '980.00',
      applications: [{ invoiceId: inv.id, amountApplied: '980.00', discountAmount: '20.00' }],
    });
    const [others] = await suggestEarlyPaymentDiscounts(ctx, { customerId: cust, paymentDate: d('2026-03-05'), invoiceIds: [inv.id] });
    expect(others).toBeUndefined(); // paid: not an open invoice any more
    const [mine] = await suggestEarlyPaymentDiscounts(ctx, {
      customerId: cust,
      paymentDate: d('2026-03-05'),
      invoiceIds: [inv.id],
      paymentId: payment.id,
    });
    expect(mine).toMatchObject({ eligible: true, suggested: '20.00', openBalance: '1000.00', alreadyTaken: '0.00' });
  });

  it('the discount taken can be edited above the suggestion but never exceeds what the invoice owes', async () => {
    const cust = await customer('Taken');
    const inv = await invoice(cust, '100.00', '2026-03-01', { terms: '2% 10 Net 30' });
    await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '95.00',
      applications: [{ invoiceId: inv.id, amountApplied: '95.00', discountAmount: '5.00' }],
    });
    expect((await invRow(inv.id)).status).toBe('paid');
    const inv2 = await invoice(cust, '100.00', '2026-03-01', { terms: '2% 10 Net 30' });
    const before = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: d('2026-03-05'),
        method: 'other',
        amount: '0',
        applications: [{ invoiceId: inv2.id, amountApplied: '0', discountAmount: '100.01' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const after = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(after.length).toBe(before.length);
    expect((await invRow(inv2.id)).balanceDue).toBe('100.00');
    await expectBooksTied();
  });

  it("GET /api/payments/discounts takes the payment being edited and defaults to the company's today", async () => {
    await updateCompany(ctx, { settings: { timezone: 'America/Los_Angeles' } as never });
    const cust = await customer('Route');
    const inv = await invoice(cust, '1000.00', '2026-03-01', { terms: '2% 10 Net 30' });
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '980.00',
      applications: [{ invoiceId: inv.id, amountApplied: '980.00', discountAmount: '20.00' }],
    });
    const res = await discountsGET(req(`/api/payments/discounts?customerId=${cust}&date=2026-03-05&paymentId=${payment.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discounts).toEqual([expect.objectContaining({ invoiceId: inv.id, suggested: '20.00', eligible: true })]);

    // 9 PM on Mar 11 in Los Angeles is already Mar 12 in UTC: the last discount day is still today.
    const open = await invoice(cust, '500.00', '2026-03-01', { terms: '2% 10 Net 30' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-12T04:00:00.000Z'));
    const res2 = await discountsGET(req(`/api/payments/discounts?customerId=${cust}`));
    vi.useRealTimers();
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.discounts.find((s: { invoiceId: string }) => s.invoiceId === open.id)).toMatchObject({ eligible: true, suggested: '10.00' });
  });
});

// ---------------------------------------------------------------------------
describe('C4. One credit split across several invoices in one payment', () => {
  it('a credit memo is split across two invoices, and voiding the payment gives it all back', async () => {
    const cust = await customer('Split memo');
    const i1 = await invoice(cust, '100.00', '2026-03-01');
    const i2 = await invoice(cust, '80.00', '2026-03-02');
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-03'),
      lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: '90.00', taxable: false }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '90.00',
      applications: [
        { invoiceId: i1.id, amountApplied: '50.00' },
        { invoiceId: i2.id, amountApplied: '40.00' },
      ],
      credits: [
        { creditMemoId: memo.id, invoiceId: i1.id, amount: '50.00' },
        { creditMemoId: memo.id, invoiceId: i2.id, amount: '40.00' },
      ],
    });
    expect((await invRow(i1.id)).status).toBe('paid');
    expect((await invRow(i2.id)).status).toBe('paid');
    const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id));
    expect(m.unapplied).toBe('0.00');
    const detail = await getPayment(ctx, payment.id);
    expect(detail.credits.map((c) => [c.invoiceId, c.amount]).sort()).toEqual([[i1.id, '50.00'], [i2.id, '40.00']].sort());
    await expectBooksTied();

    // Edit: the same memo re-split (60 / 30) — the old parts come back first.
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '90.00',
      applications: [
        { invoiceId: i1.id, amountApplied: '40.00' },
        { invoiceId: i2.id, amountApplied: '50.00' },
      ],
      credits: [
        { creditMemoId: memo.id, invoiceId: i1.id, amount: '60.00' },
        { creditMemoId: memo.id, invoiceId: i2.id, amount: '30.00' },
      ],
    });
    expect((await listCreditApplications(ctx, { creditMemoId: memo.id })).map((a) => a.amount).sort()).toEqual(['30.00', '60.00']);
    await expectBooksTied();

    await voidPayment(ctx, payment.id);
    expect((await invRow(i1.id)).balanceDue).toBe('100.00');
    expect((await invRow(i2.id)).balanceDue).toBe('80.00');
    expect((await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id)))[0].unapplied).toBe('90.00');
    await expectBooksTied();
  });

  it('the parts of one credit can never add up to more than it has left (nothing is saved)', async () => {
    const cust = await customer('Over');
    const i1 = await invoice(cust, '100.00', '2026-03-01');
    const i2 = await invoice(cust, '100.00', '2026-03-01');
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      lines: [{ accountId: acct['4000'], description: 'Credit', quantity: 1, rate: '70.00', taxable: false }],
    } as never);
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: d('2026-03-05'),
        method: 'other',
        amount: '0',
        applications: [],
        credits: [
          { creditMemoId: memo.id, invoiceId: i1.id, amount: '40.00' },
          { creditMemoId: memo.id, invoiceId: i2.id, amount: '30.01' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // An earlier unapplied payment: 50 left, 30 + 25 asked for.
    const { payment: over } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-03'),
      method: 'check',
      amount: '50.00',
      applications: [],
    });
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: d('2026-03-05'),
        method: 'other',
        amount: '0',
        applications: [],
        paymentCredits: [
          { paymentId: over.id, invoiceId: i1.id, amount: '30.00' },
          { paymentId: over.id, invoiceId: i2.id, amount: '25.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await invRow(i1.id)).balanceDue).toBe('100.00');
    expect((await invRow(i2.id)).balanceDue).toBe('100.00');
    expect((await payRow(over.id)).unapplied).toBe('50.00');
    expect((await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id)))[0].unapplied).toBe('70.00');
    await expectBooksTied();
  });

  it('an earlier unapplied payment and a General Journal credit are each split across two invoices', async () => {
    const cust = await customer('Split others');
    const i1 = await invoice(cust, '100.00', '2026-03-01');
    const i2 = await invoice(cust, '100.00', '2026-03-01');
    const { payment: over } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      method: 'check',
      amount: '60.00',
      applications: [],
    });
    await createManualEntry(ctx, {
      date: d('2026-03-02'),
      description: 'Goodwill credit',
      lines: [
        { accountId: acct['4000'], debit: '40.00' },
        { accountId: acct['1200'], credit: '40.00', entityType: 'customer', entityId: cust },
      ],
    } as never);
    const jeCredit = (await listJournalOpenItems(ctx, 'ar', cust)).credits[0];
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '100.00',
      applications: [
        { invoiceId: i1.id, amountApplied: '50.00' },
        { invoiceId: i2.id, amountApplied: '50.00' },
      ],
      paymentCredits: [
        { paymentId: over.id, invoiceId: i1.id, amount: '35.00' },
        { paymentId: over.id, invoiceId: i2.id, amount: '25.00' },
      ],
      journalCredits: [
        { journalLineId: jeCredit.journalLineId, invoiceId: i1.id, amount: '15.00' },
        { journalLineId: jeCredit.journalLineId, invoiceId: i2.id, amount: '25.00' },
      ],
    });
    expect((await invRow(i1.id)).status).toBe('paid');
    expect((await invRow(i2.id)).status).toBe('paid');
    expect((await payRow(over.id)).unapplied).toBe('0.00');
    expect((await listJournalOpenItems(ctx, 'ar', cust)).credits).toHaveLength(0);
    expect((await getPayment(ctx, payment.id)).journalApplications.filter((j) => j.kind === 'invoice_credit')).toHaveLength(2);
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
describe('C4. Foreign-currency credits in Receive Payments', () => {
  async function eurSetup() {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
    const cust = await customer('Euro');
    const eur = (amount: string, date: string, rate: string) =>
      invoice(cust, amount, date, { currency: 'EUR', exchangeRate: rate });
    return { cust, eur };
  }

  it('an unapplied EUR payment is offered as a EUR credit and split across EUR invoices, with the FX on the payment date', async () => {
    const { cust, eur } = await eurSetup();
    const a = await eur('100.00', '2026-05-01', '1.10');
    const b = await eur('60.00', '2026-05-02', '1.10');
    const c = await eur('40.00', '2026-05-03', '1.12');
    // Overpaid: EUR 200 at 1.20 on invoice A (100) leaves a EUR 100 credit.
    const { payment: p1 } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-05-05'),
      method: 'ach',
      amount: '200.00',
      currency: 'EUR',
      exchangeRate: '1.20',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: a.id, amountApplied: '100.00' }],
    });
    expect((await payRow(p1.id)).unapplied).toBe('100.00');
    const credits = await listAvailableCredits(ctx, cust, { includeForeign: true });
    expect(credits.find((x) => x.id === p1.id)).toMatchObject({ kind: 'payment', currency: 'EUR', available: '100.00' });
    // Home-only callers (the credit-limit check) still get home credits only.
    expect((await listAvailableCredits(ctx, cust)).find((x) => x.id === p1.id)).toBeUndefined();
    const routeRes = await creditsGET(req(`/api/payments/credits?customerId=${cust}`));
    expect((await routeRes.json()).credits.find((x: { id: string }) => x.id === p1.id)).toMatchObject({ currency: 'EUR' });

    // A new EUR payment: EUR 10 cash on B, the old credit split 50 on B and 40 on C.
    const { payment: p2 } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-05-10'),
      method: 'ach',
      amount: '10.00',
      currency: 'EUR',
      exchangeRate: '1.15',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: b.id, amountApplied: '10.00' }],
      paymentCredits: [
        { paymentId: p1.id, invoiceId: b.id, amount: '50.00' },
        { paymentId: p1.id, invoiceId: c.id, amount: '40.00' },
      ],
    });
    expect(p2.currency).toBe('EUR');
    expect((await invRow(b.id)).status).toBe('paid');
    expect((await invRow(c.id)).status).toBe('paid');
    expect((await payRow(p1.id)).unapplied).toBe('10.00');
    // The realized FX on the credit used is dated with the payment that used it, not today.
    const plugs = await db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `payment:${p1.id}`)));
    expect(plugs.length).toBeGreaterThan(0);
    for (const p of plugs) expect(p.date.toISOString().slice(0, 10)).toBe('2026-05-10');
    await expectBooksTied();
    await expectBooksTied(new Date('2026-05-31T23:59:59Z'));
  });

  it('refuses to mix currencies: a EUR credit on a home payment, a home credit memo on a EUR payment', async () => {
    const { cust, eur } = await eurSetup();
    const a = await eur('100.00', '2026-05-01', '1.10');
    const home = await invoice(cust, '100.00', '2026-05-01');
    const { payment: p1 } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-05-05'),
      method: 'ach',
      amount: '50.00',
      currency: 'EUR',
      exchangeRate: '1.20',
      depositAccountId: acct['1000'],
      applications: [],
    });
    // A home payment on the home invoice that also tries to use the EUR credit on the EUR invoice.
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: d('2026-05-10'),
        method: 'check',
        amount: '100.00',
        applications: [{ invoiceId: home.id, amountApplied: '100.00' }],
        paymentCredits: [{ paymentId: p1.id, invoiceId: a.id, amount: '50.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/EUR/) });
    expect((await payRow(p1.id)).unapplied).toBe('50.00');
    expect((await invRow(home.id)).balanceDue).toBe('100.00');

    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-05-02'),
      lines: [{ accountId: acct['4000'], description: 'Credit', quantity: 1, rate: '20.00', taxable: false }],
    } as never);
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: d('2026-05-10'),
        method: 'ach',
        amount: '80.00',
        currency: 'EUR',
        exchangeRate: '1.15',
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: a.id, amountApplied: '80.00' }],
        credits: [{ creditMemoId: memo.id, invoiceId: a.id, amount: '20.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await invRow(a.id)).balanceDue).toBe('100.00');
    await expectBooksTied();
  });
});

describe('C4. Credits only, no payment of its own', () => {
  it('a foreign earlier payment used alone (no currency named) applies in its own currency, FX dated with the request', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
    const cust = await customer('Euro only');
    const a = await invoice(cust, '30.00', '2026-05-01', { currency: 'EUR', exchangeRate: '1.10' });
    const b = await invoice(cust, '20.00', '2026-05-01', { currency: 'EUR', exchangeRate: '1.10' });
    const { payment: p1 } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-05-02'),
      method: 'ach',
      amount: '50.00',
      currency: 'EUR',
      exchangeRate: '1.20',
      depositAccountId: acct['1000'],
      applications: [],
    });
    const { payment, entry } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-05-06'),
      method: 'other',
      amount: '0',
      applications: [],
      paymentCredits: [
        { paymentId: p1.id, invoiceId: a.id, amount: '30.00' },
        { paymentId: p1.id, invoiceId: b.id, amount: '20.00' },
      ],
    });
    expect(entry).toBeNull();
    expect(payment.id).toBe(p1.id); // no new payment recorded (as in QuickBooks)
    expect((await payRow(p1.id)).unapplied).toBe('0.00');
    expect((await invRow(a.id)).status).toBe('paid');
    expect((await invRow(b.id)).status).toBe('paid');
    const plugs = await db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `payment:${p1.id}`)));
    expect(plugs.length).toBeGreaterThan(0);
    for (const p of plugs) expect(p.date.toISOString().slice(0, 10)).toBe('2026-05-06');
    await expectBooksTied();
  });
});

// ---------------------------------------------------------------------------
describe('C4. The Receive Payments form: one credit in parts on several invoices (creditSplit)', () => {
  const memo = { kind: 'credit_memo' as const, id: 'm1', available: '90.00', currency: null };
  const pay = { kind: 'payment' as const, id: 'p1', available: '50.00', currency: null };
  const je = { kind: 'journal_entry' as const, id: 'j1', available: '40.00', currency: null };

  it('turns the parts into the request arrays (credit memos, earlier payments, journal credits and offsets)', () => {
    let use: CreditUse = {};
    use = setCreditPart(use, 'm1', 'i1', '50');
    use = setCreditPart(use, 'm1', 'i2', '40.00');
    use = setCreditPart(use, 'p1', 'i1', '10');
    use = setCreditPart(use, 'p1', `${JE_PREFIX}c1`, '5');
    use = setCreditPart(use, 'j1', 'i2', '15');
    use = setCreditPart(use, 'j1', `${JE_PREFIX}c1`, '25');
    use = setCreditPart(use, 'gone', 'i1', '99'); // a credit no longer offered is dropped
    use = setCreditPart(use, 'm1', 'i3', '0.'); // being typed: kept, counts as nothing
    const req = creditRequest([memo, pay, je], use);
    expect(req.credits).toEqual([
      { creditMemoId: 'm1', invoiceId: 'i1', amount: '50' },
      { creditMemoId: 'm1', invoiceId: 'i2', amount: '40.00' },
    ]);
    expect(req.paymentCredits).toEqual([
      { paymentId: 'p1', invoiceId: 'i1', amount: '10' },
      { paymentId: 'p1', journalLineId: 'c1', amount: '5' },
    ]);
    expect(req.journalCredits).toEqual([{ journalLineId: 'j1', invoiceId: 'i2', amount: '15' }]);
    expect(req.journalOffsets).toEqual([{ journalLineId: 'j1', chargeLineId: 'c1', amount: '25' }]);
    expect(use.m1.i3).toBe('0.');
    expect(setCreditPart(use, 'm1', 'i3', '').m1.i3).toBeUndefined();
  });

  it('what a credit has left for an invoice, and credits used for more than they have', () => {
    let use: CreditUse = {};
    use = setCreditPart(use, 'm1', 'i1', '60');
    expect(creditLeftFor(memo, use, 'i2').toFixed(2)).toBe('30.00');
    expect(creditLeftFor(memo, use, 'i1').toFixed(2)).toBe('90.00');
    expect(overdrawnCredits([memo], use)).toEqual([]);
    use = setCreditPart(use, 'm1', 'i2', '30.01');
    expect(overdrawnCredits([memo, pay], use).map((c) => c.id)).toEqual(['m1']);
    expect(creditUsed(use, 'm1').toFixed(2)).toBe('90.01');
  });

  it('"Use available credits" on an invoice takes the oldest credits first, up to what it owes and they have left', () => {
    let use: CreditUse = setCreditPart({}, 'm1', 'i1', '70');
    use = fillCreditsFor([memo, pay, je], use, 'i2', '45.00');
    expect(use.m1).toEqual({ i1: '70', i2: '20.00' });
    expect(use.p1).toEqual({ i2: '25.00' });
    expect(use.j1).toBeUndefined();
    // A General Journal charge takes only General Journal credits and earlier payments.
    const onCharge = fillCreditsFor([memo, pay, je], {}, `${JE_PREFIX}c1`, '60');
    expect(onCharge.m1).toBeUndefined();
    expect(onCharge.p1).toEqual({ [`${JE_PREFIX}c1`]: '50.00' });
    expect(onCharge.j1).toEqual({ [`${JE_PREFIX}c1`]: '10.00' });
  });

  it("an edited payment's saved parts come back per credit and invoice", () => {
    const use = creditUseFromPayment({
      credits: [
        { creditMemoId: 'm1', invoiceId: 'i1', amount: '50.00' },
        { creditMemoId: 'm1', invoiceId: 'i2', amount: '40.00' },
        { creditMemoId: 'm1', invoiceId: 'i1', amount: '5.00' },
      ],
      journalApplications: [
        { kind: 'invoice_credit', journalLineId: 'j1', invoiceId: 'i2', amount: '15.00' },
        { kind: 'payment', journalLineId: 'c9', invoiceId: null, amount: '7.00' },
      ],
      journalOffsets: [{ journalLineId: 'j1', chargeLineId: 'c1', amount: '25.00' }],
    });
    expect(use).toEqual({ m1: { i1: '55.00', i2: '40.00' }, j1: { i2: '15.00', [`${JE_PREFIX}c1`]: '25.00' } });
  });
});

// ---------------------------------------------------------------------------
describe('B7. The payments API routes pass the Payment Method list entry', () => {
  it('POST /api/payments and PUT /api/payments/:id store the entry and its type', async () => {
    const methods = await listEntries(ctx, 'payment-methods');
    const visa = methods.find((m) => m.name === 'Visa')!;
    const echeck = methods.find((m) => m.name === 'E-Check')!;
    const cust = await customer('Route pm');
    const inv = await invoice(cust, '80.00', '2026-03-01');
    const body = {
      customerId: cust,
      date: '2026-03-05',
      method: 'check',
      paymentMethodId: visa.id,
      amount: '80.00',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    };
    const res = await paymentsPOST(req('/api/payments', 'POST', body));
    expect(res.status).toBe(201);
    const { payment } = await res.json();
    expect(payment).toMatchObject({ paymentMethodId: visa.id, method: 'credit_card' });

    const put = await paymentPUT(req(`/api/payments/${payment.id}`, 'PUT', { ...body, method: 'ach', paymentMethodId: echeck.id }), {
      params: Promise.resolve({ id: payment.id }),
    });
    expect(put.status).toBe(200);
    expect(await payRow(payment.id)).toMatchObject({ paymentMethodId: echeck.id, method: 'ach' });

    // A payment saved before the list (bare type): an edit naming no entry keeps the type.
    const put2 = await paymentPUT(req(`/api/payments/${payment.id}`, 'PUT', { ...body, method: 'cash', paymentMethodId: null }), {
      params: Promise.resolve({ id: payment.id }),
    });
    expect(put2.status).toBe(200);
    expect(await payRow(payment.id)).toMatchObject({ paymentMethodId: null, method: 'cash' });
  });
});

// ---------------------------------------------------------------------------
describe('Deep link: /payments?customerId=&invoiceId= opens a new Receive Payment', () => {
  const C = '11111111-2222-4333-8444-555555555555';
  const I = '66666666-7777-4888-9999-aaaaaaaaaaaa';

  it('builds and reads the link (bad ids are ignored)', () => {
    expect(receivePaymentHref(C, I)).toBe(`/payments?customerId=${C}&invoiceId=${I}`);
    expect(receivePaymentHref(C)).toBe(`/payments?customerId=${C}`);
    expect(parseReceivePaymentLink(new URLSearchParams(`customerId=${C}&invoiceId=${I}`))).toEqual({ customerId: C, invoiceId: I });
    expect(parseReceivePaymentLink(new URLSearchParams(`customerId=${C}`))).toEqual({ customerId: C, invoiceId: null });
    expect(parseReceivePaymentLink(new URLSearchParams(`customerId=nope&invoiceId=${I}`))).toBeNull();
    expect(parseReceivePaymentLink(new URLSearchParams(`customerId=${C}&invoiceId=nope`))).toEqual({ customerId: C, invoiceId: null });
    expect(parseReceivePaymentLink(new URLSearchParams(`focus=${C}`))).toBeNull();
  });

  it("selects the invoice with its open amount, only when it is one of the customer's open invoices", () => {
    const open = [
      { id: I, balanceDue: '125.40' },
      { id: 'other', balanceDue: '10.00' },
    ];
    expect(prefillFromLink(open, I)).toEqual({ applications: { [I]: '125.40' }, amount: '125.40' });
    expect(prefillFromLink(open, 'missing')).toBeNull();
    expect(prefillFromLink(open, null)).toBeNull();
    expect(prefillFromLink([{ id: I, balanceDue: '0.00' }], I)).toBeNull();
  });
});
