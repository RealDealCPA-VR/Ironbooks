/**
 * P1 payments, re-test round 1 (TESTER): adversarial checks on the FX rounding-penny fix
 * (payment_applications.amount_home + payoff relief in postPayment / applyPayment /
 * unapplyFromInvoice). Independent of the doer's payments.p1.fxpenny.test.ts.
 *
 * Invariant after every money step: TB balanced and the A/R control account equals the
 * home-currency subledger (each posted invoice's A/R minus the home amounts its live payment
 * applications relieved, minus each live payment's unapplied balance at its own rate).
 * Once every foreign item is closed, A/R control must also equal A/R aging (0 here).
 *
 * 100.05 EUR at 1.13 books 113.06 (113.0565).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, invoices, journalEntryLines, paymentApplications, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice, unapplyCreditApplication } from './creditMemos';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { applyPayment, receivePayment, unapplyFromInvoice, updatePayment, voidPayment } from './payments';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-payments-p1-fxpenny-qa');
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

async function freshCompany(): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `FX Penny QA ${seq}`, ownerId });
  const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) code[a.code] = a.id;
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
  const cust = (await createCustomer(c, { displayName: `Euro QA ${seq}` })).id;
  return { c, code, cust };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

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
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return r2(total);
}

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
    const rate = Number(inv.exchangeRate ?? 1);
    const apps = await db
      .select({ home: paymentApplications.amountHome, applied: paymentApplications.amountApplied, disc: paymentApplications.discountAmount })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentsReceived.id, paymentApplications.paymentId))
      .where(and(eq(paymentApplications.invoiceId, inv.id), isNull(paymentsReceived.voidedAt)));
    for (const a of apps) {
      total -= a.home !== null ? Number(a.home) : r2(Number(a.applied) * rate) + r2(Number(a.disc ?? 0) * rate);
    }
  }
  const pays = await db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, co.c.companyId), isNull(paymentsReceived.voidedAt)));
  for (const p of pays) total -= r2(Number(p.unapplied) * Number(p.exchangeRate ?? 1));
  return r2(total);
}

async function expectTied(co: Co) {
  expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  expect(await arControl(co.c)).toBeCloseTo(await arHomeSubledger(co), 2);
}

async function expectAllClosed(co: Co) {
  expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  expect(await arControl(co.c)).toBeCloseTo(0, 2);
  expect(Number((await arAging(co.c, AS_OF)).totals.total)).toBeCloseTo(0, 2);
}

async function fxNet(c: ServiceContext): Promise<number> {
  const tb = await trialBalance(c, AS_OF);
  const [fx] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '6900')));
  const r = fx ? tb.rows.find((x) => x.accountId === fx.id) : undefined;
  return r ? r2(Number(r.debit) - Number(r.credit)) : 0;
}

async function eurInvoice(co: Co, amount = '100.05', rate = '1.13') {
  return createInvoice(co.c, {
    customerId: co.cust,
    date: D('2026-05-01'),
    dueDate: D('2026-05-31'),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: co.code['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
}

function pay(
  co: Co,
  date: string,
  amount: string,
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount?: string }>,
  rate = '1.13',
) {
  return receivePayment(co.c, {
    customerId: co.cust,
    date: D(date),
    method: 'bank_transfer',
    amount,
    depositAccountId: co.code['1000'],
    currency: 'EUR',
    exchangeRate: rate,
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
    .values({ email: 'p1-fxpenny-qa@test.local', name: 'FX Penny QA', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Re-test: payoff relief across payment rates, multi-invoice payments and discounts', () => {
  it('part-payments at three different rates: A/R 0, FX = cash in home minus 113.06', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }], '1.10');
    await expectTied(co);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }], '1.20');
    await expectTied(co);
    await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }], '1.157');
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await expectAllClosed(co);
    // More home cash came in than was booked: the difference is a realized gain (a credit).
    const cash = r2(33.35 * 1.1) + r2(33.35 * 1.2) + r2(33.35 * 1.157);
    expect(await fxNet(co.c)).toBeCloseTo(-r2(cash - 113.06), 2);
  });

  it('one payment paying off two part-paid foreign invoices and part-paying a third', async () => {
    const co = await freshCompany();
    const a = await eurInvoice(co, '100.05');
    const b = await eurInvoice(co, '0.07'); // books 0.08 (0.0791); 0.03 then 0.04 would relieve 0.03 + 0.05
    const c = await eurInvoice(co, '10.01');
    await pay(co, '2026-05-02', '66.73', [
      { invoiceId: a.id, amountApplied: '66.70' },
      { invoiceId: b.id, amountApplied: '0.03' },
    ]);
    await expectTied(co);
    await pay(co, '2026-05-03', '38.39', [
      { invoiceId: a.id, amountApplied: '33.35' },
      { invoiceId: b.id, amountApplied: '0.04' },
      { invoiceId: c.id, amountApplied: '5.00' },
    ]);
    await expectTied(co);
    expect((await invoiceRow(a.id)).status).toBe('paid');
    expect((await invoiceRow(b.id)).status).toBe('paid');
    // Stored home relief per paid invoice adds up to exactly what the invoice put on A/R.
    for (const inv of [a, b]) {
      const apps = await db.select().from(paymentApplications).where(eq(paymentApplications.invoiceId, inv.id));
      const booked = r2(Number(inv.total) * 1.13);
      expect(r2(apps.reduce((s, x) => s + Number(x.amountHome), 0))).toBeCloseTo(booked, 2);
    }
    await pay(co, '2026-05-04', '5.01', [{ invoiceId: c.id, amountApplied: '5.01' }]);
    await expectTied(co);
    await expectAllClosed(co);
  });

  it('payoff taken partly as an early-payment discount clears A/R to 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-04', '30.34', [{ invoiceId: inv.id, amountApplied: '30.34', discountAmount: '3.01' }]);
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await expectAllClosed(co);
  });

  it('editing the payoff payment down to a part-payment, then paying the rest, still ends at 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const last = await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await expectAllClosed(co);
    await updatePayment(co.c, last.payment.id, {
      customerId: co.cust,
      date: D('2026-05-04'),
      method: 'bank_transfer',
      amount: '30.00',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.13',
      applications: [{ invoiceId: inv.id, amountApplied: '30.00' }],
    });
    await expectTied(co);
    expect((await invoiceRow(inv.id)).balanceDue).toBe('3.35');
    expect(await arControl(co.c)).toBeGreaterThan(0);
    await pay(co, '2026-05-05', '3.35', [{ invoiceId: inv.id, amountApplied: '3.35' }]);
    await expectTied(co);
    await expectAllClosed(co);
  });

  it('editing an EARLIER part-payment after the invoice is paid off keeps A/R tied; re-paying ends at 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const first = await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    await updatePayment(co.c, first.payment.id, {
      customerId: co.cust,
      date: D('2026-05-02'),
      method: 'bank_transfer',
      amount: '20.00',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.13',
      applications: [{ invoiceId: inv.id, amountApplied: '20.00' }],
    });
    await expectTied(co);
    await pay(co, '2026-05-06', '13.35', [{ invoiceId: inv.id, amountApplied: '13.35' }], '1.25');
    await expectTied(co);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await expectAllClosed(co);
  });

  it('void every payment out of order after a payoff: A/R back to 113.06, FX back to 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const ids: string[] = [];
    for (const [d, r] of [
      ['2026-05-02', '1.11'],
      ['2026-05-03', '1.19'],
      ['2026-05-04', '1.13'],
    ] as const) {
      ids.push((await pay(co, d, '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }], r)).payment.id);
    }
    await expectAllClosed(co);
    for (const id of [ids[0], ids[2], ids[1]]) {
      await voidPayment(co.c, id);
      await expectTied(co);
    }
    expect(await arControl(co.c)).toBeCloseTo(113.06, 2);
    expect(await fxNet(co.c)).toBeCloseTo(0, 2);
    expect((await invoiceRow(inv.id)).balanceDue).toBe('100.05');
  });

  it('unapply small parts of a NON-payoff application, apply them back, then pay off: A/R 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const p1 = await pay(co, '2026-05-02', '50.00', [{ invoiceId: inv.id, amountApplied: '50.00' }], '1.20');
    await unapplyFromInvoice(co.c, { paymentId: p1.payment.id, invoiceId: inv.id, amount: '0.01' });
    await expectTied(co);
    await unapplyFromInvoice(co.c, { paymentId: p1.payment.id, invoiceId: inv.id, amount: '0.01' });
    await expectTied(co);
    await applyPayment(co.c, { paymentId: p1.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '0.02' }] });
    await expectTied(co);
    await pay(co, '2026-05-05', '50.05', [{ invoiceId: inv.id, amountApplied: '50.05' }]);
    await expectTied(co);
    await expectAllClosed(co);
  });

  it('a single payment for the whole invoice relieves exactly the booked 113.06', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const p = await pay(co, '2026-05-02', '100.05', [{ invoiceId: inv.id, amountApplied: '100.05' }]);
    const [app] = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, p.payment.id));
    expect(app.amountHome).toBe('113.06');
    await expectAllClosed(co);
    expect(await fxNet(co.c)).toBeCloseTo(0, 2);
  });
});

describe('Re-test: upgraded databases (rows written before amount_home existed)', () => {
  it('legacy applications with amount_home NULL fall back to amount x rate; the payoff still clears A/R', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const p1 = await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const p2 = await pay(co, '2026-05-03', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    // Simulate rows written by the previous version.
    await db.execute(
      sql`UPDATE payment_applications SET amount_home = NULL WHERE payment_id IN (${p1.payment.id}, ${p2.payment.id})`,
    );
    await expectTied(co);
    const p3 = await pay(co, '2026-05-04', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const [app] = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, p3.payment.id));
    expect(app.amountHome).toBe('37.68'); // 113.06 - 2 x 37.69
    await expectAllClosed(co);
    // Voiding a legacy payment restores its legacy relief.
    await voidPayment(co.c, p1.payment.id);
    await expectTied(co);
    expect(await arControl(co.c)).toBeCloseTo(37.69, 2);
  });

  it('re-running 0041 twice keeps amount_home values (ADD COLUMN IF NOT EXISTS does not reset data)', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const p = await pay(co, '2026-05-02', '33.35', [{ invoiceId: inv.id, amountApplied: '33.35' }]);
    const stmts = fs
      .readFileSync(path.join(ROOT, 'drizzle', '0041_p1_payments.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);
    expect(stmts.some((s) => /ADD COLUMN IF NOT EXISTS "amount_home"/.test(s))).toBe(true);
    for (const s of stmts) await db.execute(sql.raw(s));
    for (const s of stmts) await db.execute(sql.raw(s));
    const [app] = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, p.payment.id));
    expect(app.amountHome).toBe('37.69');
    const col = await db.execute(
      sql`SELECT data_type, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns WHERE table_name = 'payment_applications' AND column_name = 'amount_home'`,
    );
    expect((col as unknown as { rows: unknown[] }).rows).toEqual([
      { data_type: 'numeric', numeric_precision: 15, numeric_scale: 2, is_nullable: 'YES' },
    ]);
    await expectTied(co);
  });

  it('the 0041 journal entry is still the only idx 41 entry', () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(j.entries.filter((e) => e.idx === 41).map((e) => e.tag)).toEqual(['0041_p1_payments']);
  });
});

describe('Re-test: company isolation', () => {
  it('identical invoices in two companies, payments interleaved: each company ends at 0 on its own', async () => {
    const a = await freshCompany();
    const b = await freshCompany();
    const ia = await eurInvoice(a);
    const ib = await eurInvoice(b);
    await pay(a, '2026-05-02', '33.35', [{ invoiceId: ia.id, amountApplied: '33.35' }]);
    await pay(b, '2026-05-02', '50.00', [{ invoiceId: ib.id, amountApplied: '50.00' }], '1.30');
    await pay(a, '2026-05-03', '33.35', [{ invoiceId: ia.id, amountApplied: '33.35' }]);
    await pay(b, '2026-05-03', '50.05', [{ invoiceId: ib.id, amountApplied: '50.05' }]);
    await expectAllClosed(b);
    await expectTied(a);
    await pay(a, '2026-05-04', '33.35', [{ invoiceId: ia.id, amountApplied: '33.35' }]);
    await expectAllClosed(a);
    await expectAllClosed(b);
    // A payment in one company can't touch the other's invoice.
    await expect(pay(b, '2026-05-05', '1.00', [{ invoiceId: ia.id, amountApplied: '1.00' }])).rejects.toThrow();
    await expectAllClosed(a);
  });
});

describe('Re-test: other documents that reduce a foreign invoice balance', () => {
  // A credit memo has no currency (home only), and the payoff relief only subtracts earlier
  // PAYMENT applications from the invoice's booked A/R. If a home credit memo can be applied to
  // a foreign invoice, the payoff payment re-relieves the credit-memo part and A/R goes negative.
  // Either the apply must be refused (as Receive Payments and General Journal credits already
  // refuse it) or the books must still close to 0.
  it('a home credit memo applied to a foreign invoice is refused, or the payoff still leaves A/R at 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const memo = await createCreditMemo(co.c, {
      customerId: co.cust,
      date: D('2026-05-02'),
      lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: '10.00', taxable: false }],
    } as Parameters<typeof createCreditMemo>[1]);
    let applied = true;
    try {
      await applyToInvoice(co.c, { creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00' });
    } catch {
      applied = false;
    }
    if (!applied) {
      await expectTied(co);
      return;
    }
    // Applied: pay off the rest. The credit memo (10.00 home) and the invoice are both closed.
    await pay(co, '2026-05-03', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }]);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
  });
});

describe('Fix round 2: home credit memos on a foreign invoice still close A/R to 0', () => {
  async function memo(co: Co, amt: string) {
    return createCreditMemo(co.c, {
      customerId: co.cust,
      date: D('2026-05-02'),
      lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: amt, taxable: false }],
    } as Parameters<typeof createCreditMemo>[1]);
  }

  it('credit, then a part-payment at a new rate, then the payoff', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    await pay(co, '2026-05-03', '40.00', [{ invoiceId: inv.id, amountApplied: '40.00' }], '1.20');
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
    await pay(co, '2026-05-04', '50.05', [{ invoiceId: inv.id, amountApplied: '50.05' }], '1.05');
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
  });

  it('a credit unapplied before the payoff is no longer subtracted', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const res = await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    await unapplyCreditApplication(co.c, res.application.id);
    await pay(co, '2026-05-03', '100.05', [{ invoiceId: inv.id, amountApplied: '100.05' }]);
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    // The memo's 10.00 credit is still open on A/R (unapplied), everything else is closed.
    expect(await arControl(co.c)).toBeCloseTo(-10, 2);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });
});

describe('Re-test round 2: home credit memos on foreign invoices (invoiceOpenHome subtracts credit applications)', () => {
  // A/R control with home credit memos in play: booked invoice A/R - live payment relief
  // - payments' unapplied - every memo's posted credit. Each step must stay balanced and the
  // books must close exactly when every document is closed.
  async function memo(co: Co, amt: string, date = '2026-05-02') {
    return createCreditMemo(co.c, {
      customerId: co.cust,
      date: D(date),
      lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: amt, taxable: false }],
    } as Parameters<typeof createCreditMemo>[1]);
  }
  const balanced = async (co: Co) => expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);

  it('two credits from two memos, then the payoff: A/R 0, FX = cash home - (113.06 - credits)', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m1 = await memo(co, '10.00');
    const m2 = await memo(co, '7.33');
    await applyToInvoice(co.c, { creditMemoId: m1.id, invoiceId: inv.id, amount: '6.00' });
    await applyToInvoice(co.c, { creditMemoId: m2.id, invoiceId: inv.id, amount: '7.33' });
    // m1 still has 4.00 unapplied: it stays on A/R as a credit.
    await pay(co, '2026-05-03', '86.72', [{ invoiceId: inv.id, amountApplied: '86.72' }], '1.21');
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(-4, 2);
    // FX: A/R relieved 113.06 - 13.33 = 99.73; cash 86.72 x 1.21 = 104.93 -> 5.20 gain (a credit).
    expect(await fxNet(co.c)).toBeCloseTo(-r2(r2(86.72 * 1.21) - 99.73), 2);
    // Use the rest of m1 on a home invoice: everything closes.
    const home = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-04'),
      dueDate: D('2026-05-31'),
      lines: [{ accountId: co.code['4000'], description: 'Home', quantity: 1, rate: '4.00', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    await applyToInvoice(co.c, { creditMemoId: m1.id, invoiceId: home.id, amount: '4.00' });
    await expectAllClosed(co);
  });

  it('void the payoff after a credit: A/R back to 113.06 - credit, FX 0; re-pay closes to 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    const p = await pay(co, '2026-05-03', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }], '1.25');
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    await voidPayment(co.c, p.payment.id);
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(103.06, 2);
    expect(await fxNet(co.c)).toBeCloseTo(0, 2);
    expect((await invoiceRow(inv.id)).balanceDue).toBe('90.05');
    await pay(co, '2026-05-05', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }], '1.02');
    await balanced(co);
    await expectAllClosed(co);
  });

  it('edit the payoff (after a credit) to another rate and still pay off: A/R stays 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    const p = await pay(co, '2026-05-03', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }]);
    await updatePayment(co.c, p.payment.id, {
      customerId: co.cust,
      date: D('2026-05-03'),
      method: 'bank_transfer',
      amount: '90.05',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.40',
      applications: [{ invoiceId: inv.id, amountApplied: '90.05' }],
    });
    await balanced(co);
    await expectAllClosed(co);
    expect(await fxNet(co.c)).toBeCloseTo(-r2(r2(90.05 * 1.4) - 103.06), 2);
  });

  it('credit, then an unapplied payment applied later as the payoff (applyPayment path): A/R 0', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    const p = await pay(co, '2026-05-03', '90.05', [], '1.18');
    await balanced(co);
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '90.05' }] });
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await balanced(co);
    await expectAllClosed(co);
  });

  it('credit + payoff, unapply the payoff, unapply the credit, pay in full: A/R -10 (memo open) and balanced', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const ca = await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    const p = await pay(co, '2026-05-03', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }]);
    await unapplyFromInvoice(co.c, { paymentId: p.payment.id, invoiceId: inv.id, amount: '90.05' });
    await balanced(co);
    await unapplyCreditApplication(co.c, ca.application.id);
    await balanced(co);
    expect((await invoiceRow(inv.id)).balanceDue).toBe('100.05');
    await pay(co, '2026-05-04', '10.00', [{ invoiceId: inv.id, amountApplied: '10.00' }]);
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '90.05' }] });
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(-10, 2);
  });

  it('a credit on a HOME invoice is unaffected (rate 1 path): credit + payment close A/R to 0, no FX', async () => {
    const co = await freshCompany();
    const home = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-31'),
      lines: [{ accountId: co.code['4000'], description: 'Home', quantity: 1, rate: '100.05', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: home.id, amount: '10.00' });
    await receivePayment(co.c, {
      customerId: co.cust,
      date: D('2026-05-03'),
      method: 'bank_transfer',
      amount: '90.05',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: home.id, amountApplied: '90.05' }],
    });
    await expectAllClosed(co);
    expect(await fxNet(co.c)).toBeCloseTo(0, 2);
  });

  it('credit applications in another company never reduce this company\'s open home A/R', async () => {
    const a = await freshCompany();
    const b = await freshCompany();
    const ia = await eurInvoice(a);
    const ib = await eurInvoice(b);
    const mb = await memo(b, '10.00');
    await applyToInvoice(b.c, { creditMemoId: mb.id, invoiceId: ib.id, amount: '10.00' });
    // A memo from B can't be applied to A's invoice, from either company.
    await expect(applyToInvoice(a.c, { creditMemoId: mb.id, invoiceId: ia.id, amount: '1.00' })).rejects.toThrow();
    await expect(applyToInvoice(b.c, { creditMemoId: mb.id, invoiceId: ia.id, amount: '1.00' })).rejects.toThrow();
    await pay(a, '2026-05-03', '100.05', [{ invoiceId: ia.id, amountApplied: '100.05' }]);
    await expectAllClosed(a);
    await pay(b, '2026-05-03', '90.05', [{ invoiceId: ib.id, amountApplied: '90.05' }]);
    await expectAllClosed(b);
  });

  // Gap outside this team's files (creditMemos.applyToInvoice): when the CREDIT is the document
  // that closes a part-paid foreign invoice, nothing clears the home rate difference left on A/R,
  // so the invoice shows paid while A/R control is not 0. Refusing the apply also passes.
  it('a home credit that pays off the LAST part of a foreign invoice leaves A/R at 0 (or is refused)', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await pay(co, '2026-05-02', '90.05', [{ invoiceId: inv.id, amountApplied: '90.05' }]);
    const m = await memo(co, '10.00', '2026-05-03');
    let applied = true;
    try {
      await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    } catch {
      applied = false;
    }
    await balanced(co);
    if (!applied) return;
    expect((await invoiceRow(inv.id)).status).toBe('paid');
    expect(Number((await arAging(co.c, AS_OF)).totals.total)).toBeCloseTo(0, 2);
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
  });
});
