/**
 * P1 payments, fix round 4: a document whose free-text Currency field holds the HOME code
 * (any case) is a home-currency document. Credit memos (A/R) and vendor credits
 * (A/P) must still apply to it, directly and through Receive Payments / Pay Bills; only a
 * genuinely foreign document is refused, and the refusal names the normalised code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, creditApplications, creditMemos, invoices, users, vendorCredits } from '@/lib/db/schema';
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
import { receivePayment } from './payments';
import { payBillsWithCredits } from './billPayments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1-fix4');
const AS_OF = new Date('2027-12-31T23:59:59Z');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ownerId: string;
let seq = 0;

interface Co {
  c: ServiceContext;
  code: Record<string, string>;
  cust: string;
  vendor: string;
}

async function freshCompany(): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `Fix4 ${seq}`, ownerId });
  const c: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, c.companyId))) code[a.code] = a.id;
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.130000' });
  const cust = (await createCustomer(c, { displayName: `Fix4 Cust ${seq}` })).id;
  const vendor = (await createVendor(c, { displayName: `Fix4 Vendor ${seq}` })).id;
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
  return Math.round(total * 100) / 100;
}

const balanced = async (co: Co) => expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];
const billRow = async (id: string) => (await db.select().from(bills).where(eq(bills.id, id)))[0];

async function homeInvoice(co: Co, amount: string, currency: string) {
  return createInvoice(co.c, {
    customerId: co.cust,
    date: D('2026-05-01'),
    dueDate: D('2026-05-31'),
    currency,
    exchangeRate: '1',
    lines: [{ accountId: co.code['4000'], description: 'Home', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
}

async function memo(co: Co, amt: string) {
  return createCreditMemo(co.c, {
    customerId: co.cust,
    date: D('2026-05-02'),
    lines: [{ accountId: co.code['4000'], description: 'Credit', quantity: 1, rate: amt, taxable: false }],
  } as Parameters<typeof createCreditMemo>[1]);
}

/** A home bill whose currency column holds `raw` (as an upgraded or imported database may). */
async function billWithRawCurrency(co: Co, amount: string, raw: string) {
  const b = await createBill(co.c, {
    vendorId: co.vendor,
    date: D('2026-08-01'),
    billNumber: `F4-${seq}-${raw.trim()}`,
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

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-fix4@test.local', name: 'Fix4', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Fix 4: credit memos on invoices whose currency is the home code', () => {
  it('a mixed-case home code (Usd) is home: direct apply works', async () => {
    const co = await freshCompany();
    const inv = await homeInvoice(co, '100.05', 'Usd');
    const m = await memo(co, '10.00');
    await applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' });
    expect((await invRow(inv.id)).balanceDue).toBe('90.05');
    await balanced(co);
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(90.05, 2);
  });

  it('Receive Payments with a memo credit on a lower-case usd invoice closes A/R to 0', async () => {
    const co = await freshCompany();
    const inv = await homeInvoice(co, '100.05', 'usd');
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
    expect(await control(co.c, 'accounts_receivable')).toBeCloseTo(0, 2);
  });

  it('a genuinely foreign invoice saved as lower-case eur is still refused, naming EUR, nothing changes', async () => {
    const co = await freshCompany();
    const inv = await createInvoice(co.c, {
      customerId: co.cust,
      date: D('2026-05-01'),
      dueDate: D('2026-05-31'),
      currency: 'eur',
      exchangeRate: '1.13',
      lines: [{ accountId: co.code['4000'], description: 'Work', quantity: 1, rate: '100.05', taxable: false }],
      overrideCreditLimit: true,
    } as Parameters<typeof createInvoice>[1]);
    const before = (await invRow(inv.id)).balanceDue;
    const m = await memo(co, '10.00');
    await expect(applyToInvoice(co.c, { creditMemoId: m.id, invoiceId: inv.id, amount: '10.00' })).rejects.toThrow(
      /This invoice is in EUR\./,
    );
    expect((await invRow(inv.id)).balanceDue).toBe(before);
    expect((await db.select().from(creditMemos).where(eq(creditMemos.id, m.id)))[0].unapplied).toBe('10.00');
    expect(
      await db.select().from(creditApplications).where(eq(creditApplications.companyId, co.c.companyId)),
    ).toHaveLength(0);
    await balanced(co);
  });
});

describe('Fix 4: vendor credits on bills whose currency is the home code', () => {
  it('direct applyToBill on a bill stored as lower-case usd works', async () => {
    const co = await freshCompany();
    const b = await billWithRawCurrency(co, '100.00', 'usd');
    const vc = await vcredit(co, '10.00');
    await applyToBill(co.c, { vendorCreditId: vc.id, billId: b.id, amount: '10.00' });
    expect((await billRow(b.id)).balanceDue).toBe('90.00');
    await balanced(co);
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(-90, 2);
  });

  it('Pay Bills (one transaction) with a vendor credit on a bill stored as mixed-case uSD pays it off', async () => {
    const co = await freshCompany();
    const b = await billWithRawCurrency(co, '100.00', 'uSD');
    const vc = await vcredit(co, '10.00');
    const res = await payBillsWithCredits(co.c, {
      vendorId: co.vendor,
      date: D('2026-08-02'),
      method: 'check',
      paymentAccountId: co.code['1000'],
      applications: [{ billId: b.id, amountApplied: '90.00' }],
      vendorCredits: [{ vendorCreditId: vc.id, billId: b.id, amount: '10.00' }],
    } as Parameters<typeof payBillsWithCredits>[1]);
    expect(res.payment).not.toBeNull();
    expect((await billRow(b.id)).balanceDue).toBe('0.00');
    await balanced(co);
    expect(await control(co.c, 'accounts_payable')).toBeCloseTo(0, 2);
  });

  it('a bill stored as lower-case eur is refused naming EUR; Pay Bills saves nothing', async () => {
    const co = await freshCompany();
    const b = await billWithRawCurrency(co, '100.00', 'eur');
    const vc = await vcredit(co, '10.00');
    await expect(applyToBill(co.c, { vendorCreditId: vc.id, billId: b.id, amount: '10.00' })).rejects.toThrow(
      /This bill is in EUR\./,
    );
    await expect(
      payBillsWithCredits(co.c, {
        vendorId: co.vendor,
        date: D('2026-08-02'),
        method: 'check',
        paymentAccountId: co.code['1000'],
        applications: [],
        vendorCredits: [{ vendorCreditId: vc.id, billId: b.id, amount: '10.00' }],
      } as Parameters<typeof payBillsWithCredits>[1]),
    ).rejects.toThrow(/This bill is in EUR\./);
    expect((await billRow(b.id)).balanceDue).toBe('100.00');
    expect((await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id)))[0].unapplied).toBe('10.00');
    await balanced(co);
  });
});
