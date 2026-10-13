/**
 * P1 payments, fix round 1: a foreign-currency invoice (or bill) paid in parts must leave no
 * rounding penny on the A/R (A/P) control account once it is paid off. The application that
 * pays it off relieves exactly the home amount still open; the difference goes to Exchange
 * Gain/Loss, as QuickBooks does on the final payment.
 *
 * 100.05 EUR at 1.13 books 113.06 (113.0565). Three part-payments of 33.35 at 1.13 would each
 * relieve 37.69 (37.6855) = 113.07 if converted one by one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, invoices, journalEntryLines, paymentApplications, paymentsReceived, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { applyPayment, receivePayment, unapplyFromInvoice, updatePayment, voidPayment } from './payments';
import { payBills, voidBillPayment } from './billPayments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1-fxpenny');
const AS_OF = new Date('2027-12-31T23:59:59Z');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ownerId: string;
let seq = 0;

interface Co {
  c: ServiceContext;
  code: Record<string, string>;
  cust: string;
}

/** A fresh company per test, so a residue in one can't hide or cause one in another. */
async function freshCompany(): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `FX Penny Co ${seq}`, ownerId });
  const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) code[a.code] = a.id;
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
  const cust = (await createCustomer(c, { displayName: 'Euro Pennies' })).id;
  return { c, code, cust };
}

async function control(c: ServiceContext, subtype: 'accounts_receivable' | 'accounts_payable'): Promise<number> {
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

/**
 * Home-currency A/R subledger: each posted invoice's A/R (its entry's net A/R debit) minus the
 * home amounts its live applications relieved, minus each live payment's unapplied balance at
 * the payment's rate. (A/R aging lists foreign open items in their own currency, so it can only
 * be compared with the control account once every foreign item is closed.)
 */
async function arHomeSubledger(co: Co): Promise<number> {
  const invs = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, co.c.companyId), sql`${invoices.status} NOT IN ('void', 'draft')`));
  let total = 0;
  for (const inv of invs) {
    const [net] = await db
      .select({ v: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0) - COALESCE(${journalEntryLines.credit}, 0)), 0)` })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, inv.postedEntryId!), eq(journalEntryLines.accountId, co.code['1200'])));
    total += Number(net.v);
    const apps = await db
      .select({ home: paymentApplications.amountHome })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentsReceived.id, paymentApplications.paymentId))
      .where(and(eq(paymentApplications.invoiceId, inv.id), isNull(paymentsReceived.voidedAt)));
    for (const a of apps) total -= Number(a.home);
  }
  const pays = await db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, co.c.companyId), isNull(paymentsReceived.voidedAt)));
  for (const p of pays) total -= Math.round(Number(p.unapplied) * Number(p.exchangeRate ?? 1) * 100) / 100;
  return Math.round(total * 100) / 100;
}

/** TB balanced and the A/R control account equals the home-currency subledger. */
async function expectTied(co: Co) {
  expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(await arHomeSubledger(co), 2);
}

/** Everything foreign is closed: aging must equal the control accounts too. */
async function expectAgingTied(c: ServiceContext) {
  expect((await trialBalance(c, AS_OF)).balanced).toBe(true);
  expect(Number((await arAging(c, AS_OF)).totals.total)).toBeCloseTo(await control(c, 'accounts_receivable'), 2);
  expect(Number((await apAging(c, AS_OF)).totals.total)).toBeCloseTo(await control(c, 'accounts_payable'), 2);
}

async function fxNet(c: ServiceContext): Promise<number> {
  const tb = await trialBalance(c, AS_OF);
  const [fx] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '6900')));
  const r = fx ? tb.rows.find((x) => x.accountId === fx.id) : undefined;
  return r ? Math.round((Number(r.debit) - Number(r.credit)) * 100) / 100 : 0;
}

async function eurInvoice(co: Co, amount = '100.05', date = '2026-05-01') {
  return createInvoice(co.c, {
    customerId: co.cust,
    date: D(date),
    dueDate: D(date),
    currency: 'EUR',
    exchangeRate: '1.13',
    lines: [{ accountId: co.code['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
}

function pay(co: Co, date: string, amount: string, applications: Array<{ invoiceId: string; amountApplied: string }>) {
  return receivePayment(co.c, {
    customerId: co.cust,
    date: D(date),
    method: 'bank_transfer',
    amount,
    depositAccountId: co.code['1000'],
    currency: 'EUR',
    exchangeRate: '1.13',
    applications,
  });
}

async function invoiceRow(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-fxpenny@test.local', name: 'FX Penny', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Receive Payments: the payoff payment clears the rounding penny', () => {
  it('three part-payments: A/R ends at 0 and the penny is an exchange loss', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(113.06, 2);
    for (const day of ['2026-05-02', '2026-05-03', '2026-05-04']) {
      await pay(co, day, '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
      await expectTied(co);
    }
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
    // Cash received 3 x 37.69 = 113.07 against 113.06 booked: the extra cent is a realized gain.
    expect(await fxNet(co.c)).toBeCloseTo(-0.01, 2);
    // The stored home amounts add up to what the invoice put on A/R.
    const apps = await db.select().from(paymentApplications).where(eq(paymentApplications.invoiceId, inv.id));
    expect(apps.reduce((s, a) => s + Number(a.amountHome), 0)).toBeCloseTo(113.06, 2);
  });

  it('voiding the middle payment and paying again still clears A/R to 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const mid = await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
    await voidPayment(co.c, mid.payment.id);
    await expectTied(co);
    expect((await invoiceRow(inv.id)).balanceDue).toBe('33.35');
    await pay(co, '2026-05-05', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
  });

  it('editing the payoff payment keeps A/R at 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const last = await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await updatePayment(co.c, last.payment.id, {
      customerId: co.cust,
      date: D('2026-05-06'),
      method: 'bank_transfer',
      amount: '33.35',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.20',
      applications: [{ invoiceId: inv.id, amountApplied: '33.35' }],
    });
    await expectTied(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
  });

  it('applying an unapplied balance later (applyPayment) as the payoff clears A/R to 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    // A payment left unapplied (an open customer credit), then applied to the invoice.
    const later = await pay(co, '2026-05-04', '33.35', []);
    await expectTied(co);
    await applyPayment(co.c, { paymentId: later.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.35' }] });
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
  });

  it('unapplying the payoff application and applying it again keeps A/R tied, then 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const last = await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);

    // Whole application back: the invoice's open home amount (37.68) returns to A/R, and the
    // 33.35 EUR now sits as a customer credit at the payment rate (37.69).
    await unapplyFromInvoice(co.c, { paymentId: last.payment.id, invoiceId: inv.id });
    await expectTied(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(37.68 - 37.69, 2);

    // Part of it back in, then the rest (the rest is the payoff).
    await applyPayment(co.c, { paymentId: last.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '10.00' }] });
    await expectTied(co);
    await unapplyFromInvoice(co.c, { paymentId: last.payment.id, invoiceId: inv.id, amount: '5.00' });
    await expectTied(co);
    await applyPayment(co.c, { paymentId: last.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '28.35' }] });
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);

    // Voiding everything unwinds every FX plug: A/R back to the full invoice, no FX left.
    const [{ id: p1 }, { id: p2 }] = (
      await db
        .select({ id: paymentApplications.paymentId })
        .from(paymentApplications)
        .where(eq(paymentApplications.invoiceId, inv.id))
    ).filter((r) => r.id !== last.payment.id);
    for (const id of [p1, p2, last.payment.id]) await voidPayment(co.c, id);
    await expectTied(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(113.06, 2);
    expect(await fxNet(co.c)).toBeCloseTo(0, 2);
  });

  it('a home-currency invoice paid in parts is unchanged (exact amounts, no exchange lines)', async () => {
    const co = await freshCompany();
    const inv = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-01'),
      lines: [{ accountId: co.code['4000'], description: 'Work', quantity: 1, rate: '100.05', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    for (const [day, amt] of [['2026-05-02', '33.35'], ['2026-05-03', '33.35'], ['2026-05-04', '33.35']] as const) {
      await receivePayment(co.c, {
        customerId: co.cust,
        date: D(day),
        method: 'check',
        amount: amt,
        depositAccountId: co.code['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: amt }],
      });
    }
    await expectTied(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
    expect(await fxNet(co.c)).toBe(0);
  });
});

describe('Pay Bills mirror: the payoff payment clears the rounding penny on A/P', () => {
  it('three part-payments on a EUR bill: A/P ends at 0, void and re-pay too', async () => {
    const co = await freshCompany();
    const [v] = await db
      .insert(vendors)
      .values({ companyId: co.c.companyId, displayName: 'Euro Vendor', currency: 'EUR' } as never)
      .returning();
    const bill = await createBill(co.c, {
      vendorId: v.id,
      date: D('2026-06-01'),
      exchangeRate: '1.13',
      lines: [{ accountId: co.code['6300'] ?? co.code['6000'], amount: '100.05' }],
    } as Parameters<typeof createBill>[1]);
    const apBooked = await control(co.c, 'accounts_payable');
    expect(apBooked).toBeCloseTo(113.06, 2);
    const payIds: string[] = [];
    for (const day of ['2026-06-02', '2026-06-03', '2026-06-04']) {
      const p = await payBills(co.c, {
        vendorId: v.id,
        date: D(day),
        method: 'ach',
        paymentAccountId: co.code['1000'],
        exchangeRate: '1.13',
        applications: [{ billId: bill.id, amountApplied: '33.35' }],
      });
      payIds.push(p.id);
      await expectTied(co);
    }
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.status).toBe('paid');
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);

    await voidBillPayment(co.c, payIds[1]);
    await expectTied(co);
    await payBills(co.c, {
      vendorId: v.id,
      date: D('2026-06-05'),
      method: 'ach',
      paymentAccountId: co.code['1000'],
      exchangeRate: '1.13',
      applications: [{ billId: bill.id, amountApplied: '33.35' }],
    });
    await expectTied(co);
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(0, 2);
    await expectAgingTied(co.c);
  });
});

// Reviewer minor: light page-source wiring checks (repo style of lib/ux*.test.ts) for the
// Receive Payments button fixes. The server-side refusals have their own tests.
describe('Receive Payments page: buttons only offer what the server accepts', () => {
  const page = () => fs.readFileSync(path.join(process.cwd(), 'app', 'payments', 'page.tsx'), 'utf8');

  it('Apply (unapplied balance) lists only posted, owing invoices in the payment currency', () => {
    expect(page()).toMatch(
      /inv\.status !== 'void' &&\s*inv\.status !== 'draft' &&\s*Number\(inv\.balanceDue\) > 0 &&\s*norm\(inv\.currency\) === norm\(payment\.currency\)/,
    );
  });

  it('Refund lists bank / cash accounts only (no Undeposited Funds)', () => {
    expect(page()).toMatch(/depositTargets\(accounts\)\.filter\(\(a\) => a\.code !== '1050' && a\.subtype !== 'undeposited_funds'\)/);
  });

  it('Pay all marks the amounts as chosen by the user', () => {
    expect(page()).toMatch(/function payAll\(\) \{[\s\S]{0,200}setAppsTouched\(true\)/);
  });

  it('switching customer cancels the previous customer load', () => {
    const src = page();
    expect(src).toMatch(/let cancelled = false;[\s\S]{0,400}if \(cancelled\) return;/);
    expect(src).toMatch(/return \(\) => \{\s*cancelled = true;\s*\};/);
  });
});
