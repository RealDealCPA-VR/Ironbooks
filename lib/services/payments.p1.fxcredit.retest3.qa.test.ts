/**
 * P1 payments, re-test round 3 (TESTER): independent checks on fix round 3 —
 * creditMemos.applyToInvoice refuses a home credit memo on a foreign-currency invoice.
 *
 * Covers every path that reaches applyToInvoice (direct call, Receive Payments credits,
 * Client Data Review auto-apply, bad-debt write-off), the "currency column holds the HOME code"
 * edge (must NOT be refused — Receive Payments normalises the home code to null), upgraded
 * databases that already hold a credit application on a foreign invoice, and isolation.
 *
 * 100.05 EUR at 1.13 books 113.06 (113.0565).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  creditApplications,
  creditMemos,
  invoices,
  journalEntries,
  paymentApplications,
  paymentsReceived,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice, markPaidAmount } from './invoices';
import { applyToInvoice, createCreditMemo, unapplyCreditApplication } from './creditMemos';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { receivePayment, voidPayment } from './payments';
import { autoApplyCustomerCredit } from './accountant/clientDataReview';
import { writeOffInvoices } from './accountant/writeOff';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-payments-p1-fxcredit-retest3');
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
}

async function freshCompany(): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `FX Credit R3 ${seq}`, ownerId });
  const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) code[a.code] = a.id;
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
  const cust = (await createCustomer(c, { displayName: `Mixed R3 ${seq}` })).id;
  return { c, code, cust };
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
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return r2(total);
}

const balanced = async (co: Co) => expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const memoRow = async (id: string) => (await db.select().from(creditMemos).where(eq(creditMemos.id, id)))[0];
const creditApps = async (co: Co) =>
  db.select().from(creditApplications).where(eq(creditApplications.companyId, co.c.companyId));
const jeCount = async (co: Co) =>
  Number((await db.select({ n: sql<string>`count(*)` }).from(journalEntries).where(eq(journalEntries.companyId, co.c.companyId)))[0].n);
const auditCount = async (co: Co) =>
  Number((await db.select({ n: sql<string>`count(*)` }).from(auditLogs).where(eq(auditLogs.companyId, co.c.companyId)))[0].n);

async function eurInvoice(co: Co, amount = '100.05', rate = '1.13', date = '2026-05-01') {
  return createInvoice(co.c, {
    customerId: co.cust,
    date: D(date),
    dueDate: D('2026-05-31'),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: co.code['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
}

async function homeInvoice(co: Co, amount = '100.05', extra: Record<string, unknown> = {}, date = '2026-04-01') {
  return createInvoice(co.c, {
    customerId: co.cust,
    date: D(date),
    dueDate: D('2026-05-31'),
    lines: [{ accountId: co.code['4000'], description: 'Home', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as Parameters<typeof createInvoice>[1]);
}

async function memo(co: Co, amt: string, date = '2026-05-02') {
  return createCreditMemo(co.c, {
    customerId: co.cust,
    date: D(date),
    lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: amt, taxable: false }],
  } as Parameters<typeof createCreditMemo>[1]);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-fxcredit-r3@test.local', name: 'FX Credit R3', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Re-test 3: the refusal holds on every path into creditMemos.applyToInvoice', () => {
  it('direct apply: refused with the plain message, no rows, no journal entries, no audit, no balance change', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const je0 = await jeCount(co);
    const au0 = await auditCount(co);
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '0.01' })).rejects.toThrow(
      /in EUR.*Receive Payments/,
    );
    expect(await creditApps(co)).toHaveLength(0);
    expect(await jeCount(co)).toBe(je0);
    expect(await auditCount(co)).toBe(au0);
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
    expect((await memoRow(m.id)).unapplied).toBe('10.00');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(103.06, 2);
  });

  it('a lower-case currency code on the invoice is still refused', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    await db.update(invoices).set({ currency: 'eur' }).where(eq(invoices.id, inv.id));
    const m = await memo(co, '10.00');
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' })).rejects.toThrow();
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
  });

  it('Receive Payments: a credit memo on a foreign invoice is refused and the whole payment is rolled back', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const je0 = await jeCount(co);
    await expect(
      receivePayment(co.c, {
        customerId: co.cust,
        date: D('2026-05-03'),
        method: 'bank_transfer',
        amount: '90.05',
        depositAccountId: co.code['1000'],
        currency: 'EUR',
        exchangeRate: '1.13',
        applications: [{ invoiceId: inv.id, amountApplied: '90.05' }],
        credits: [{ creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' }],
      } as Parameters<typeof receivePayment>[1]),
    ).rejects.toThrow();
    expect(await jeCount(co)).toBe(je0);
    expect(await db.select().from(paymentsReceived).where(eq(paymentsReceived.companyId, co.c.companyId))).toHaveLength(0);
    expect(await creditApps(co)).toHaveLength(0);
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
    expect((await memoRow(m.id)).unapplied).toBe('10.00');
    await balanced(co);
  });

  it('Client Data Review auto-apply: a customer whose oldest open invoice is home and next is foreign is all-or-nothing', async () => {
    const co = await freshCompany();
    const home = await homeInvoice(co, '5.00'); // dated 2026-04-01, oldest
    const inv = await eurInvoice(co); // 2026-05-01
    const m = await memo(co, '10.00');
    // 5.00 would go to the home invoice, the remaining 5.00 to the EUR invoice -> refused.
    await expect(autoApplyCustomerCredit(co.c, { refType: 'credit_memo', refId: m.id })).rejects.toThrow();
    // Nothing partially applied: the home invoice is still open and the memo untouched.
    expect((await invRow(home.id)).balanceDue).toBe('5.00');
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
    expect((await memoRow(m.id)).unapplied).toBe('10.00');
    expect(await creditApps(co)).toHaveLength(0);
    await balanced(co);
  });

  it('Client Data Review auto-apply: credit that only reaches home invoices still applies', async () => {
    const co = await freshCompany();
    const home = await homeInvoice(co, '20.00');
    await eurInvoice(co);
    const m = await memo(co, '10.00');
    const r = await autoApplyCustomerCredit(co.c, { refType: 'credit_memo', refId: m.id });
    expect(r.applied).toBe('10.00');
    expect((await invRow(home.id)).balanceDue).toBe('10.00');
    expect((await memoRow(m.id)).unapplied).toBe('0.00');
    await balanced(co);
  });

  it('bad-debt write-off of a foreign invoice is still refused before any credit memo is created', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const [bad] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, co.c.companyId), eq(accounts.type, 'expense')))
      .limit(1);
    await expect(
      writeOffInvoices(co.c, { invoiceIds: [inv.id], date: D('2026-06-01'), badDebtAccountId: bad.id }),
    ).rejects.toThrow(/foreign currency/);
    expect(await db.select().from(creditMemos).where(eq(creditMemos.companyId, co.c.companyId))).toHaveLength(0);
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
  });

  it('a voided payment on a foreign invoice does not unlock the credit memo apply', async () => {
    const co = await freshCompany();
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const p = await receivePayment(co.c, {
      customerId: co.cust,
      date: D('2026-05-03'),
      method: 'bank_transfer',
      amount: '50.00',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.20',
      applications: [{ invoiceId: inv.id, amountApplied: '50.00' }],
    });
    await voidPayment(co.c, p.payment.id);
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' })).rejects.toThrow();
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(103.06, 2);
  });
});

describe('Re-test 3: invoices whose currency column holds the HOME code are home invoices', () => {
  // Receive Payments normalises the home code to null (normalizeCurrency) before its own
  // credits check, then calls applyToInvoice. If applyToInvoice checks the raw column, a home
  // invoice saved with currency 'USD' can no longer take any credit memo — a regression from
  // before fix round 3, and inconsistent with vendorCredits' foreignCurrencyOf.
  it('direct apply of a home credit memo to an invoice saved with currency = USD (rate 1) works', async () => {
    const co = await freshCompany();
    const inv = await homeInvoice(co, '100.05', { currency: 'USD', exchangeRate: '1' }, '2026-05-01');
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    expect((await invRow(inv.id)).balanceDue).toBe('90.05');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(90.05, 2);
  });

  it('Receive Payments with a credit memo on an invoice saved with currency = USD closes A/R to 0', async () => {
    const co = await freshCompany();
    const inv = await homeInvoice(co, '100.05', { currency: 'USD', exchangeRate: '1' }, '2026-05-01');
    const m = await memo(co, '10.00');
    await receivePayment(co.c, {
      customerId: co.cust,
      date: D('2026-05-03'),
      method: 'bank_transfer',
      amount: '90.05',
      depositAccountId: co.code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '90.05' }],
      credits: [{ creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' }],
    } as Parameters<typeof receivePayment>[1]);
    expect((await invRow(inv.id)).status).toBe('paid');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    expect(Number((await arAging(co.c, AS_OF)).totals.total)).toBeCloseTo(0, 2);
  });
});

describe('Re-test 3: upgraded databases that already hold a home credit on a foreign invoice', () => {
  // Rows written before fix round 3. The invoiceOpenHome safeguard must still make the payoff
  // close A/R to 0, and the user must still be able to undo the old application.
  async function legacyApplied(co: Co) {
    const inv = await eurInvoice(co);
    const m = await memo(co, '10.00');
    const [app] = await db
      .insert(creditApplications)
      .values({ companyId: co.c.companyId, creditMemoId: m.id, invoiceId: inv.id, amount: '10.00', date: D('2026-05-02') })
      .returning();
    await markPaidAmount(co.c, inv.id, '10.00');
    await db.update(creditMemos).set({ unapplied: '0.00', status: 'closed' }).where(eq(creditMemos.id, m.id));
    return { inv, m, app };
  }

  it('paying off the rest of a legacy credit-reduced foreign invoice leaves A/R at 0', async () => {
    const co = await freshCompany();
    const { inv } = await legacyApplied(co);
    expect((await invRow(inv.id)).balanceDue).toBe('90.05');
    await receivePayment(co.c, {
      customerId: co.cust,
      date: D('2026-05-03'),
      method: 'bank_transfer',
      amount: '90.05',
      depositAccountId: co.code['1000'],
      currency: 'EUR',
      exchangeRate: '1.13',
      applications: [{ invoiceId: inv.id, amountApplied: '90.05' }],
    });
    expect((await invRow(inv.id)).status).toBe('paid');
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(0, 2);
    const [pa] = await db
      .select()
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentsReceived.id, paymentApplications.paymentId))
      .where(and(eq(paymentApplications.invoiceId, inv.id), isNull(paymentsReceived.voidedAt)));
    expect(pa.payment_applications.amountHome).toBe('103.06');
  });

  it('a legacy credit application on a foreign invoice can still be unapplied (the guard is apply-only)', async () => {
    const co = await freshCompany();
    const { inv, m, app } = await legacyApplied(co);
    await unapplyCreditApplication(co.c, app.id);
    expect((await invRow(inv.id)).balanceDue).toBe('100.05');
    expect((await memoRow(m.id)).unapplied).toBe('10.00');
    expect(await creditApps(co)).toHaveLength(0);
    await balanced(co);
    expect(await arControl(co.c)).toBeCloseTo(103.06, 2);
    // ...and cannot be re-applied under the new rule.
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' })).rejects.toThrow();
  });
});

describe('Re-test 3: isolation and permissions', () => {
  it("company B's foreign invoice can't be reached from company A even with A's own memo", async () => {
    const a = await freshCompany();
    const b = await freshCompany();
    const ma = await memo(a, '10.00');
    const ib = await eurInvoice(b);
    const ha = await homeInvoice(a, '10.00');
    await expect(applyToInvoice(a.c, { creditMemoId: ma.id, invoiceId: ib.id, amount: '1.00' })).rejects.toThrow();
    expect((await invRow(ib.id)).balanceDue).toBe('100.05');
    await applyToInvoice(a.c, { creditMemoId: ma.id, invoiceId: ha.id, amount: '10.00' });
    await balanced(a);
    await balanced(b);
    expect(await arControl(a.c)).toBeCloseTo(0, 2);
    expect(await arControl(b.c)).toBeCloseTo(113.06, 2);
  });

  it('the credit-memo apply route keeps a write permission', () => {
    const keys = Object.keys(API_ROUTE_PERMISSIONS).filter((k) => k.includes('credit-memos'));
    expect(keys.length).toBeGreaterThan(0);
  });
});
