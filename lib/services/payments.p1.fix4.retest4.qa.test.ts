/**
 * P1 payments, re-test round 4 (adversarial): fix 4 says a document whose free-text Currency
 * column holds the HOME code in any case is a home document everywhere it is settled.
 *
 * Covers the reviewer r3 issues end to end and around them:
 *  - credit memo -> 'usd'/'Usd'/'USD' invoice (direct, via Receive Payments, then edit, then void),
 *    with a discount and penny amounts, A/R control == open-document sub-ledger after every step;
 *  - every other Receive Payments entry point that touches such an invoice (earlier-payment
 *    credits, Apply unapplied payment, unapply);
 *  - vendor credit -> 'usd' bill (direct, atomic Pay Bills mixing a blank and a 'usd' bill, edit,
 *    void), A/P control == open-document sub-ledger;
 *  - genuinely foreign codes are still refused with nothing saved;
 *  - isolation: "home" is per company (a company whose home is EUR treats 'eur' as home and
 *    'usd' as foreign).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  bills,
  creditApplications,
  creditMemos,
  invoices,
  paymentsReceived,
  users,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { applyToInvoice, createCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { applyPayment, receivePayment, unapplyFromInvoice, updatePayment, voidPayment } from './payments';
import { payBillsWithCredits, updateBillPayment, voidBillPayment } from './billPayments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1-fix4-retest4');
const AS_OF = new Date('2027-12-31T23:59:59Z');
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;

let db: DB;
let ownerId: string;
let seq = 0;

interface Co {
  c: ServiceContext;
  code: Record<string, string>;
  cust: string;
  vendor: string;
}

async function freshCompany(home = 'USD'): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `Retest4 ${seq}`, ownerId });
  const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) code[a.code] = a.id;
  if (home === 'USD') {
    await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
  } else {
    await setBaseCurrency(c, { code: 'EUR', name: 'Euro' });
    await upsertCurrency(c, { code: 'USD', name: 'US Dollar', rateToBase: '0.900000' });
  }
  const cust = (await createCustomer(c, { displayName: `R4 Cust ${seq}` })).id;
  const vendor = (await createVendor(c, { displayName: `R4 Vendor ${seq}` })).id;
  return { c, code, cust, vendor };
}

async function control(c: ServiceContext, subtype: string): Promise<number> {
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
  return r2(total);
}

/** A/R sub-ledger (all home docs): open invoice balances - unapplied memos - unapplied payments. */
async function arSubledger(c: ServiceContext): Promise<number> {
  const inv = await db
    .select({ b: invoices.balanceDue, s: invoices.status })
    .from(invoices)
    .where(eq(invoices.companyId, c.companyId));
  const cms = await db
    .select({ u: creditMemos.unapplied })
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, c.companyId), ne(creditMemos.status, 'void')));
  const pays = await db
    .select({ u: paymentsReceived.unapplied })
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, c.companyId), isNull(paymentsReceived.voidedAt)));
  let t = 0;
  for (const i of inv) if (i.s !== 'void' && i.s !== 'draft') t += Number(i.b);
  for (const m of cms) t -= Number(m.u);
  for (const p of pays) t -= Number(p.u);
  return r2(t);
}

/** A/P sub-ledger as a debit-positive number: -(open bill balances) + unapplied vendor credits. */
async function apSubledger(c: ServiceContext): Promise<number> {
  const bs = await db.select({ b: bills.balanceDue, s: bills.status }).from(bills).where(eq(bills.companyId, c.companyId));
  const vcs = await db
    .select({ u: vendorCredits.unapplied })
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, c.companyId), ne(vendorCredits.status, 'void')));
  let t = 0;
  for (const b of bs) if (b.s !== 'void' && b.s !== 'draft') t -= Number(b.b);
  for (const v of vcs) t += Number(v.u);
  return r2(t);
}

async function tiesOut(co: Co) {
  expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(await arSubledger(co.c), 2);
  expect(await control(co.c, 'accounts_payable')).toBeCloseTo(await apSubledger(co.c), 2);
}

const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const billRow = async (id: string) => (await db.select().from(bills).where(eq(bills.id, id)))[0];
const memoRow = async (id: string) => (await db.select().from(creditMemos).where(eq(creditMemos.id, id)))[0];
const vcRow = async (id: string) => (await db.select().from(vendorCredits).where(eq(vendorCredits.id, id)))[0];

/** Home invoice created normally, then its Currency column forced to `raw` (upgraded/imported data). */
async function invoiceWithRawCurrency(co: Co, amount: string, raw: string, extra: Record<string, unknown> = {}) {
  const inv = await createInvoice(co.c, {
    customerId: co.cust,
    date: D('2026-05-01'),
    dueDate: D('2026-05-31'),
    lines: [{ accountId: co.code['4000'], description: 'Home', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as Parameters<typeof createInvoice>[1]);
  await db.update(invoices).set({ currency: raw }).where(eq(invoices.id, inv.id));
  expect((await invRow(inv.id)).currency).toBe(raw);
  return inv;
}

async function memo(co: Co, amt: string) {
  return createCreditMemo(co.c, {
    customerId: co.cust,
    date: D('2026-05-02'),
    lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: amt, taxable: false }],
  } as Parameters<typeof createCreditMemo>[1]);
}

async function billWithRawCurrency(co: Co, amount: string, raw: string | null) {
  seq += 1;
  const b = await createBill(co.c, {
    vendorId: co.vendor,
    date: D('2026-08-01'),
    billNumber: `R4-${seq}`,
    lines: [{ accountId: co.code['6000'], amount }],
  });
  await db.update(bills).set({ currency: raw }).where(eq(bills.id, b.id));
  return b;
}

async function vcredit(co: Co, amt: string) {
  return createVendorCredit(co.c, {
    vendorId: co.vendor,
    date: D('2026-08-01'),
    lines: [{ accountId: co.code['6000'], amount: amt }],
  });
}

function pay(co: Co, extra: Partial<Parameters<typeof receivePayment>[1]>) {
  return {
    customerId: co.cust,
    date: D('2026-05-03'),
    method: 'check',
    amount: '0',
    depositAccountId: co.code['1000'],
    applications: [],
    ...extra,
  } as Parameters<typeof receivePayment>[1];
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-retest4@test.local', name: 'Retest4', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Retest 4 (A/R): credit memos on an invoice whose Currency holds the home code', () => {
  it.each(['USD', 'usd', 'Usd', 'uSd'])('direct apply works on a %s invoice and ties out', async (raw) => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '100.05', raw);
    const m = await memo(co, '33.35');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '33.35' });
    expect((await invRow(inv.id)).balanceDue).toBe('66.70');
    expect((await memoRow(m.id)).unapplied).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(66.7, 2);
    await tiesOut(co);
  });

  it('two memos (penny split) close a usd invoice exactly to 0.00 and mark it paid', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '100.01', 'usd');
    const m1 = await memo(co, '50.00');
    const m2 = await memo(co, '50.01');
    await applyToInvoice(co.c, { creditMemoId: m1.id, invoiceId: inv.id, amount: '50.00' });
    await applyToInvoice(co.c, { creditMemoId: m2.id, invoiceId: inv.id, amount: '50.01' });
    const row = await invRow(inv.id);
    expect(row.balanceDue).toBe('0.00');
    expect(row.status).toBe('paid');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('over-applying a memo to a usd invoice is still refused (normalisation does not bypass the balance guard)', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '20.00', 'usd');
    const m = await memo(co, '25.00');
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '25.00' })).rejects.toThrow();
    expect((await invRow(inv.id)).balanceDue).toBe('20.00');
    expect((await memoRow(m.id)).unapplied).toBe('25.00');
    await tiesOut(co);
  });

  it('Receive Payments: cash + discount + memo on a Usd invoice, then edit, then void — ties out at every step', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '200.03', 'Usd');
    const m = await memo(co, '20.01');
    const p = await receivePayment(
      co.c,
      pay(co, {
        amount: '176.02',
        applications: [{ invoiceId: inv.id, amountApplied: '176.02', discountAmount: '4.00' }],
        credits: [{ creditMemoId: m.id, invoiceId: inv.id, amount: '20.01' }],
      }),
    );
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await invRow(inv.id)).status).toBe('paid');
    expect((await memoRow(m.id)).unapplied).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await tiesOut(co);

    // Edit: smaller cash, same credit -> invoice reopens by the difference.
    await updatePayment(
      co.c,
      p.payment.id,
      pay(co, {
        amount: '100.00',
        applications: [{ invoiceId: inv.id, amountApplied: '100.00', discountAmount: '4.00' }],
        credits: [{ creditMemoId: m.id, invoiceId: inv.id, amount: '20.01' }],
      }),
    );
    expect((await invRow(inv.id)).balanceDue).toBe('76.02');
    await tiesOut(co);

    // Void: cash and discount come back off; the sub-ledger still ties to A/R whatever happens to the credit.
    await voidPayment(co.c, p.payment.id);
    const after = await invRow(inv.id);
    expect(Number(after.balanceDue)).toBeGreaterThanOrEqual(180.02);
    await tiesOut(co);
  });

  it('Receive Payments: a memo on a usd invoice and a memo on a blank invoice in one payment', async () => {
    const co = await freshCompany();
    const a = await invoiceWithRawCurrency(co, '50.00', 'usd');
    const b = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-31'),
      lines: [{ accountId: co.code['4000'], description: 'Blank', quantity: 1, rate: '30.00', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    const m = await memo(co, '15.00');
    await receivePayment(
      co.c,
      pay(co, {
        amount: '65.00',
        applications: [
          { invoiceId: a.id, amountApplied: '40.00' },
          { invoiceId: b.id, amountApplied: '25.00' },
        ],
        credits: [
          { creditMemoId: m.id, invoiceId: a.id, amount: '10.00' },
          { creditMemoId: m.id, invoiceId: b.id, amount: '5.00' },
        ],
      }),
    );
    expect((await invRow(a.id)).balanceDue).toBe('0.00');
    expect((await invRow(b.id)).balanceDue).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('a genuinely foreign invoice (eur, home USD) via Receive Payments with a memo saves nothing', async () => {
    const co = await freshCompany();
    const inv = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-31'),
      currency: 'EUR',
      exchangeRate: '1.13',
      lines: [{ accountId: co.code['4000'], description: 'EUR', quantity: 1, rate: '100.00', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    await db.update(invoices).set({ currency: 'eur' }).where(eq(invoices.id, inv.id));
    const m = await memo(co, '10.00');
    const arBefore = await control(co.c, 'accounts_receivable');
    await expect(
      receivePayment(
        co.c,
        pay(co, {
          amount: '90.00',
          currency: 'EUR',
          exchangeRate: '1.13',
          applications: [{ invoiceId: inv.id, amountApplied: '90.00' }],
          credits: [{ creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' }],
        }),
      ),
    ).rejects.toThrow();
    expect((await invRow(inv.id)).balanceDue).toBe('100.00');
    expect((await memoRow(m.id)).unapplied).toBe('10.00');
    expect(
      await db.select().from(paymentsReceived).where(eq(paymentsReceived.companyId, co.c.companyId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(creditApplications).where(eq(creditApplications.companyId, co.c.companyId)),
    ).toHaveLength(0);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(arBefore, 2);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });
});

describe('Retest 4 (A/R): other Receive Payments entry points on a usd invoice', () => {
  it('earlier-payment credit (overpayment) is applied to a usd invoice from Receive Payments', async () => {
    const co = await freshCompany();
    const over = await receivePayment(co.c, pay(co, { amount: '40.00', date: D('2026-04-01') }));
    expect((await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, over.payment.id)))[0].unapplied).toBe(
      '40.00',
    );
    const inv = await invoiceWithRawCurrency(co, '100.00', 'usd');
    await receivePayment(
      co.c,
      pay(co, {
        amount: '60.00',
        applications: [{ invoiceId: inv.id, amountApplied: '60.00' }],
        paymentCredits: [{ paymentId: over.payment.id, invoiceId: inv.id, amount: '40.00' }],
      } as Partial<Parameters<typeof receivePayment>[1]>),
    );
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('Apply (applyPayment) an unapplied home payment to a usd invoice', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '100.00', 'usd');
    const p = await receivePayment(co.c, pay(co, { amount: '100.00' }));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('Apply (applyPayment) an unapplied home payment to an upper-case USD invoice', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '100.00', 'USD');
    const p = await receivePayment(co.c, pay(co, { amount: '100.00' }));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    await tiesOut(co);
  });

  it('Apply (applyPayment) an unapplied EUR payment to a foreign invoice stored as lower-case eur', async () => {
    const co = await freshCompany();
    const inv = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-31'),
      currency: 'EUR',
      exchangeRate: '1.13',
      lines: [{ accountId: co.code['4000'], description: 'EUR', quantity: 1, rate: '100.00', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    await db.update(invoices).set({ currency: 'eur' }).where(eq(invoices.id, inv.id));
    const p = await receivePayment(co.c, pay(co, { amount: '100.00', currency: 'EUR', exchangeRate: '1.13' }));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });

  it('unapply a payment from a usd invoice restores the balance and keeps A/R tied', async () => {
    const co = await freshCompany();
    const inv = await invoiceWithRawCurrency(co, '100.00', 'usd');
    const p = await receivePayment(
      co.c,
      pay(co, { amount: '100.00', applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] }),
    );
    await unapplyFromInvoice(co.c, { paymentId: p.payment.id, invoiceId: inv.id, amount: '30.01' });
    expect((await invRow(inv.id)).balanceDue).toBe('30.01');
    await tiesOut(co);
  });
});

describe('Retest 4 (A/P): vendor credits and Pay Bills on bills whose Currency holds the home code', () => {
  it.each(['USD', 'usd', 'Usd'])('direct applyToBill works on a %s bill and ties out', async (raw) => {
    const co = await freshCompany();
    const b = await billWithRawCurrency(co, '100.05', raw);
    const vc = await vcredit(co, '33.35');
    await applyToBill(co.c, { vendorCreditId: vc.id, billId: b.id, amount: '33.35' });
    expect((await billRow(b.id)).balanceDue).toBe('66.70');
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(-66.7, 2);
    await tiesOut(co);
  });

  it('atomic Pay Bills: a blank bill and a usd bill, a credit on each, one check — closes A/P to 0', async () => {
    const co = await freshCompany();
    const b1 = await billWithRawCurrency(co, '100.00', null);
    const b2 = await billWithRawCurrency(co, '50.03', 'usd');
    const vc = await vcredit(co, '15.01');
    const res = await payBillsWithCredits(co.c, {
      vendorId: co.vendor,
      date: D('2026-08-02'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [
        { billId: b1.id, amountApplied: '90.00' },
        { billId: b2.id, amountApplied: '45.02' },
      ],
      vendorCredits: [
        { vendorCreditId: vc.id, billId: b1.id, amount: '10.00' },
        { vendorCreditId: vc.id, billId: b2.id, amount: '5.01' },
      ],
    } as Parameters<typeof payBillsWithCredits>[1]);
    expect(res.payment).not.toBeNull();
    expect((await billRow(b1.id)).balanceDue).toBe('0.00');
    expect((await billRow(b2.id)).balanceDue).toBe('0.00');
    expect((await vcRow(vc.id)).unapplied).toBe('0.00');
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('Pay Bills on a usd bill with a credit, then edit, then void — ties out at every step', async () => {
    const co = await freshCompany();
    const b = await billWithRawCurrency(co, '100.00', 'usd');
    const vc = await vcredit(co, '10.00');
    const res = await payBillsWithCredits(co.c, {
      vendorId: co.vendor,
      date: D('2026-08-02'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [{ billId: b.id, amountApplied: '90.00' }],
      vendorCredits: [{ vendorCreditId: vc.id, billId: b.id, amount: '10.00' }],
    } as Parameters<typeof payBillsWithCredits>[1]);
    const payId = (res.payment as { id: string }).id;
    expect((await billRow(b.id)).balanceDue).toBe('0.00');
    await tiesOut(co);

    await updateBillPayment(co.c, payId, {
      vendorId: co.vendor,
      date: D('2026-08-02'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [{ billId: b.id, amountApplied: '60.00' }],
    } as Parameters<typeof updateBillPayment>[2]);
    expect((await billRow(b.id)).balanceDue).toBe('30.00');
    await tiesOut(co);

    await voidBillPayment(co.c, payId);
    expect((await billRow(b.id)).balanceDue).toBe('90.00');
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(-90, 2);
    await tiesOut(co);
  });

  it('Pay Bills mixing a usd bill with an eur bill in one home check is refused, nothing saved', async () => {
    const co = await freshCompany();
    const b1 = await billWithRawCurrency(co, '100.00', 'usd');
    const b2 = await billWithRawCurrency(co, '50.00', 'eur');
    const vc = await vcredit(co, '10.00');
    const apBefore = await control(co.c, 'accounts_payable');
    await expect(
      payBillsWithCredits(co.c, {
        vendorId: co.vendor,
        date: D('2026-08-02'),
        method: 'check',
        paymentAccountId: co.code['1000'],
        applications: [
          { billId: b1.id, amountApplied: '90.00' },
          { billId: b2.id, amountApplied: '50.00' },
        ],
        vendorCredits: [{ vendorCreditId: vc.id, billId: b1.id, amount: '10.00' }],
      } as Parameters<typeof payBillsWithCredits>[1]),
    ).rejects.toThrow();
    expect((await billRow(b1.id)).balanceDue).toBe('100.00');
    expect((await billRow(b2.id)).balanceDue).toBe('50.00');
    expect((await vcRow(vc.id)).unapplied).toBe('10.00');
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(apBefore, 2);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });
});

describe('Retest 4: "home" is per company (isolation)', () => {
  it('a company whose home is EUR treats an eur invoice/bill as home and a usd one as foreign', async () => {
    const usdCo = await freshCompany('USD');
    const eurCo = await freshCompany('EUR');

    // EUR-home company: 'eur' is home -> credits apply.
    const inv = await invoiceWithRawCurrency(eurCo, '80.00', 'eur');
    const m = await memo(eurCo, '8.00');
    await applyToInvoice(eurCo.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '8.00' });
    expect((await invRow(inv.id)).balanceDue).toBe('72.00');
    const b = await billWithRawCurrency(eurCo, '80.00', 'Eur');
    const vc = await vcredit(eurCo, '8.00');
    await applyToBill(eurCo.c, { vendorCreditId: vc.id, billId: b.id, amount: '8.00' });
    expect((await billRow(b.id)).balanceDue).toBe('72.00');
    await tiesOut(eurCo);

    // EUR-home company: 'usd' is foreign -> refused naming USD.
    const inv2 = await invoiceWithRawCurrency(eurCo, '80.00', 'usd');
    const m2 = await memo(eurCo, '8.00');
    await expect(applyToInvoice(eurCo.c, { creditMemoId: m2.id, invoiceId: inv2.id, amount: '8.00' })).rejects.toThrow(
      /This invoice is in USD\./,
    );
    const b2 = await billWithRawCurrency(eurCo, '80.00', 'usd');
    const vc2 = await vcredit(eurCo, '8.00');
    await expect(applyToBill(eurCo.c, { vendorCreditId: vc2.id, billId: b2.id, amount: '8.00' })).rejects.toThrow(
      /This bill is in USD\./,
    );
    expect((await invRow(inv2.id)).balanceDue).toBe('80.00');
    expect((await billRow(b2.id)).balanceDue).toBe('80.00');

    // USD-home company is unaffected by the EUR company's settings.
    const inv3 = await invoiceWithRawCurrency(usdCo, '80.00', 'usd');
    const m3 = await memo(usdCo, '8.00');
    await applyToInvoice(usdCo.c, { creditMemoId: m3.id, invoiceId: inv3.id, amount: '8.00' });
    expect((await invRow(inv3.id)).balanceDue).toBe('72.00');
    await tiesOut(usdCo);
  });

  it('a memo from another company cannot be applied to this company\'s usd invoice', async () => {
    const a = await freshCompany();
    const b = await freshCompany();
    const inv = await invoiceWithRawCurrency(a, '50.00', 'usd');
    const foreignMemo = await memo(b, '10.00');
    await expect(
      applyToInvoice(a.c, { creditMemoId: foreignMemo.id, invoiceId: inv.id, amount: '10.00' }),
    ).rejects.toThrow();
    expect((await invRow(inv.id)).balanceDue).toBe('50.00');
    expect((await memoRow(foreignMemo.id)).unapplied).toBe('10.00');
    await tiesOut(a);
    await tiesOut(b);
  });
});
