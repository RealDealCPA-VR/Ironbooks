/**
 * P1 payments, re-test round 5 (adversarial): fix 5 says applyPayment (Apply an unapplied payment,
 * and earlier-payment credits from Receive Payments / editing a payment) compares NORMALISED
 * currency codes for the invoice and the payment.
 *
 * Around the fix:
 *  - FX: an 'eur' invoice booked at 1.13, an EUR payment at 1.20 applied later -> realized gain,
 *    A/R closes to 0, bank holds the settled home amount;
 *  - penny split applies merged into one application row on a 'Usd' invoice, then void -> restored;
 *  - unapply then re-apply on a 'USD' invoice;
 *  - earlier-payment credit on a 'uSd' invoice from a legacy 'usd' payment row, then edit, then void;
 *  - rollback: a Receive Payments save that fails after the earlier-payment credit applied leaves
 *    nothing behind;
 *  - guards still hold on normalised invoices: over-application, other customer, voided invoice,
 *    a mixed batch (usd + genuinely foreign eur) is refused atomically;
 *  - isolation: another company's invoice can't be reached; home is per company (legacy 'EUR'
 *    payment row in a EUR-home company is home).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, creditMemos, invoices, paymentApplications, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { trialBalance } from './reports';
import { createInvoice, voidInvoice } from './invoices';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { applyPayment, receivePayment, unapplyFromInvoice, updatePayment, voidPayment } from './payments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1-fix5-retest5');
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
  cust2: string;
}

async function freshCompany(home = 'USD'): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `Retest5 ${seq}`, ownerId });
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
  const cust = (await createCustomer(c, { displayName: `R5 Cust ${seq}` })).id;
  const cust2 = (await createCustomer(c, { displayName: `R5 Other ${seq}` })).id;
  return { c, code, cust, cust2 };
}

async function balanceOf(c: ServiceContext, accountId: string): Promise<number> {
  const tb = await trialBalance(c, AS_OF);
  const row = tb.rows.find((r) => r.accountId === accountId);
  return row ? r2(Number(row.debit) - Number(row.credit)) : 0;
}

async function arControl(c: ServiceContext): Promise<number> {
  const tb = await trialBalance(c, AS_OF);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, c.companyId), sql`${accounts.subtype} = 'accounts_receivable'`))
    ).map((r) => r.id),
  );
  let t = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) t += Number(r.debit) - Number(r.credit);
  return r2(t);
}

/** Home-only A/R sub-ledger: open invoices - unapplied memos - unapplied payments. */
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

async function tiesOut(co: Co) {
  expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  expect(await arControl(co.c)).toBeCloseTo(await arSubledger(co.c), 2);
}

const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const payRow = async (id: string) => (await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id)))[0];
const appsOf = async (paymentId: string) =>
  db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, paymentId));

async function invoice(
  co: Co,
  amount: string,
  raw: string | null,
  opts: { foreign?: { currency: string; rate: string }; customerId?: string } = {},
) {
  const inv = await createInvoice(co.c, {
    customerId: opts.customerId ?? co.cust,
    date: D('2026-05-01'),
    dueDate: D('2026-05-31'),
    ...(opts.foreign ? { currency: opts.foreign.currency, exchangeRate: opts.foreign.rate } : {}),
    lines: [{ accountId: co.code['4000'], description: 'Line', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
  await db.update(invoices).set({ currency: raw }).where(eq(invoices.id, inv.id));
  expect((await invRow(inv.id)).currency).toBe(raw);
  return inv;
}

function pay(co: Co, extra: Record<string, unknown>) {
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
    .values({ email: 'p1-retest5@test.local', name: 'Retest5', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Retest 5: Apply on invoices whose Currency is a different case of the code', () => {
  it('FX: an EUR payment at 1.20 applied later to an eur invoice booked at 1.13 posts a realized gain and closes A/R', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '100.00', 'eur', { foreign: { currency: 'EUR', rate: '1.13' } });
    expect(await arControl(co.c)).toBeCloseTo(113, 2);
    const p = await receivePayment(co.c, pay(co, { amount: '100.00', currency: 'EUR', exchangeRate: '1.20' }));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await payRow(p.payment.id)).unapplied).toBe('0.00');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    expect(await balanceOf(co.c, co.code['1000'])).toBeCloseTo(120, 2);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });

  it('penny split applies (33.33 + 33.33 + 33.34) on a Usd invoice merge into one row; void restores everything', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '100.00', 'Usd');
    const p = await receivePayment(co.c, pay(co, { amount: '100.00' }));
    for (const amt of ['33.33', '33.33', '33.34']) {
      await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt }] });
      await tiesOut(co);
    }
    const apps = await appsOf(p.payment.id);
    expect(apps).toHaveLength(1);
    expect(apps[0].amountApplied).toBe('100.00');
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await invRow(inv.id)).status).toBe('paid');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);

    await voidPayment(co.c, p.payment.id);
    expect((await invRow(inv.id)).balanceDue).toBe('100.00');
    expect(await arControl(co.c)).toBeCloseTo(100, 2);
    expect(await balanceOf(co.c, co.code['1000'])).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('unapply then re-apply on a USD invoice keeps A/R tied at each step', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '80.00', 'USD');
    const p = await receivePayment(
      co.c,
      pay(co, { amount: '80.00', applications: [{ invoiceId: inv.id, amountApplied: '80.00' }] }),
    );
    await unapplyFromInvoice(co.c, { paymentId: p.payment.id, invoiceId: inv.id, amount: '20.01' });
    expect((await invRow(inv.id)).balanceDue).toBe('20.01');
    expect((await payRow(p.payment.id)).unapplied).toBe('20.01');
    await tiesOut(co);
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '20.01' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await payRow(p.payment.id)).unapplied).toBe('0.00');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    await tiesOut(co);
  });

  it('a legacy payment row in mixed case ("uSD") still applies to a blank invoice', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '12.34', null);
    const p = await receivePayment(co.c, pay(co, { amount: '12.34' }));
    await db.update(paymentsReceived).set({ currency: 'uSD' }).where(eq(paymentsReceived.id, p.payment.id));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '12.34' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    await tiesOut(co);
  });
});

describe('Retest 5: earlier-payment credits on a different-case invoice', () => {
  it('a legacy usd overpayment used on a uSd invoice from Receive Payments, then edit, then void — ties out', async () => {
    const co = await freshCompany();
    const over = await receivePayment(co.c, pay(co, { amount: '40.00', date: D('2026-04-01') }));
    await db.update(paymentsReceived).set({ currency: 'usd' }).where(eq(paymentsReceived.id, over.payment.id));
    const inv = await invoice(co, '100.00', 'uSd');
    const main = await receivePayment(
      co.c,
      pay(co, {
        amount: '60.00',
        applications: [{ invoiceId: inv.id, amountApplied: '60.00' }],
        paymentCredits: [{ paymentId: over.payment.id, invoiceId: inv.id, amount: '40.00' }],
      }),
    );
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await payRow(over.payment.id)).unapplied).toBe('0.00');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    await tiesOut(co);

    // Edit: pay 50 cash, leave 10 open.
    await updatePayment(
      co.c,
      main.payment.id,
      pay(co, { amount: '50.00', applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] }),
    );
    const after = await invRow(inv.id);
    // Earlier credit of 40 stays applied (it lives on the earlier payment), cash now 50.
    expect(after.balanceDue).toBe('10.00');
    await tiesOut(co);

    await voidPayment(co.c, main.payment.id);
    expect((await invRow(inv.id)).balanceDue).toBe('60.00');
    expect((await payRow(over.payment.id)).unapplied).toBe('0.00');
    await tiesOut(co);
  });

  it('editing a payment adds an earlier-payment credit on a USD invoice (edit path calls applyPayment)', async () => {
    const co = await freshCompany();
    const over = await receivePayment(co.c, pay(co, { amount: '25.00', date: D('2026-04-01') }));
    const inv = await invoice(co, '100.00', 'USD');
    const main = await receivePayment(
      co.c,
      pay(co, { amount: '50.00', applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] }),
    );
    await updatePayment(
      co.c,
      main.payment.id,
      pay(co, {
        amount: '50.00',
        applications: [{ invoiceId: inv.id, amountApplied: '50.00' }],
        paymentCredits: [{ paymentId: over.payment.id, invoiceId: inv.id, amount: '25.00' }],
      }),
    );
    expect((await invRow(inv.id)).balanceDue).toBe('25.00');
    expect((await payRow(over.payment.id)).unapplied).toBe('0.00');
    await tiesOut(co);
  });

  it('rollback: a save that fails after the earlier credit applied leaves the earlier payment and invoice untouched', async () => {
    const co = await freshCompany();
    const over = await receivePayment(co.c, pay(co, { amount: '40.00', date: D('2026-04-01') }));
    const inv = await invoice(co, '100.00', 'usd');
    const arBefore = await arControl(co.c);
    await expect(
      receivePayment(
        co.c,
        pay(co, {
          amount: '70.00',
          // 40 credit + 70 cash = 110 > 100 balance: must be refused after the credit was applied.
          applications: [{ invoiceId: inv.id, amountApplied: '70.00' }],
          paymentCredits: [{ paymentId: over.payment.id, invoiceId: inv.id, amount: '40.00' }],
        }),
      ),
    ).rejects.toThrow();
    expect((await invRow(inv.id)).balanceDue).toBe('100.00');
    expect((await payRow(over.payment.id)).unapplied).toBe('40.00');
    expect(await appsOf(over.payment.id)).toHaveLength(0);
    expect(await arControl(co.c)).toBeCloseTo(arBefore, 2);
    await tiesOut(co);
  });
});

describe('Retest 5: guards still hold on normalised invoices', () => {
  it('over-application on a usd invoice is refused and nothing changes', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'usd');
    const p = await receivePayment(co.c, pay(co, { amount: '80.00' }));
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '50.01' }] }),
    ).rejects.toThrow(/exceeds its balance due/);
    expect((await invRow(inv.id)).balanceDue).toBe('50.00');
    expect((await payRow(p.payment.id)).unapplied).toBe('80.00');
    await tiesOut(co);
  });

  it('applying more than the payment has unapplied is refused', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'USD');
    const p = await receivePayment(co.c, pay(co, { amount: '30.00' }));
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '30.01' }] }),
    ).rejects.toThrow(/unapplied balance/);
    await tiesOut(co);
  });

  it('another customer\'s usd invoice is refused', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'usd', { customerId: co.cust2 });
    const p = await receivePayment(co.c, pay(co, { amount: '50.00' }));
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] }),
    ).rejects.toThrow(/does not belong/);
    expect((await invRow(inv.id)).balanceDue).toBe('50.00');
  });

  it('a voided usd invoice is refused', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'usd');
    await voidInvoice(co.c, inv.id);
    const p = await receivePayment(co.c, pay(co, { amount: '50.00' }));
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] }),
    ).rejects.toThrow(/voided/);
    expect((await payRow(p.payment.id)).unapplied).toBe('50.00');
    await tiesOut(co);
  });

  it('a batch mixing a usd invoice and a genuinely foreign eur invoice is refused atomically', async () => {
    const co = await freshCompany();
    const home = await invoice(co, '30.00', 'usd');
    const foreign = await invoice(co, '20.00', 'eur', { foreign: { currency: 'EUR', rate: '1.13' } });
    const p = await receivePayment(co.c, pay(co, { amount: '50.00' }));
    const arBefore = await arControl(co.c);
    await expect(
      applyPayment(co.c, {
        paymentId: p.payment.id,
        applications: [
          { invoiceId: home.id, amountApplied: '30.00' },
          { invoiceId: foreign.id, amountApplied: '20.00' },
        ],
      }),
    ).rejects.toThrow(/currency \(EUR\) does not match payment currency \(home\)/);
    expect((await invRow(home.id)).balanceDue).toBe('30.00');
    expect((await invRow(foreign.id)).balanceDue).toBe('20.00');
    expect((await payRow(p.payment.id)).unapplied).toBe('50.00');
    expect(await appsOf(p.payment.id)).toHaveLength(0);
    expect(await arControl(co.c)).toBeCloseTo(arBefore, 2);
  });

  it('an EUR payment is refused on a usd (home) invoice; the message names home', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'usd');
    const p = await receivePayment(co.c, pay(co, { amount: '50.00', currency: 'EUR', exchangeRate: '1.13' }));
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] }),
    ).rejects.toThrow(/currency \(home\) does not match payment currency \(EUR\)/);
    expect((await invRow(inv.id)).balanceDue).toBe('50.00');
  });
});

describe('Retest 5: isolation', () => {
  it('another company\'s usd invoice cannot be reached from this company\'s payment', async () => {
    const a = await freshCompany();
    const b = await freshCompany();
    const invB = await invoice(b, '50.00', 'usd');
    const pA = await receivePayment(a.c, pay(a, { amount: '50.00' }));
    await expect(
      applyPayment(a.c, { paymentId: pA.payment.id, applications: [{ invoiceId: invB.id, amountApplied: '50.00' }] }),
    ).rejects.toThrow(/not found/i);
    expect((await invRow(invB.id)).balanceDue).toBe('50.00');
    await tiesOut(a);
    await tiesOut(b);
  });

  it('EUR-home company: a legacy payment row stored as EUR (its home code) applies to a blank invoice', async () => {
    const co = await freshCompany('EUR');
    const inv = await invoice(co, '45.00', null);
    const p = await receivePayment(co.c, pay(co, { amount: '45.00' }));
    await db.update(paymentsReceived).set({ currency: 'EUR' }).where(eq(paymentsReceived.id, p.payment.id));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '45.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    await tiesOut(co);
  });
});
