/**
 * P1 payments fix 5: applyPayment (Apply an unapplied payment, and earlier-payment credits from
 * Receive Payments) compares NORMALISED currency codes (the home code in any case or blank is
 * home, a foreign code in any case is that code) for both the invoice and the payment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, invoices, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { applyPayment, receivePayment } from './payments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payments-p1-fix5');
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

async function freshCompany(home = 'USD'): Promise<Co> {
  seq += 1;
  const co = await createCompany(db, { name: `Fix5 ${seq}`, ownerId });
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
  const cust = (await createCustomer(c, { displayName: `F5 Cust ${seq}` })).id;
  return { c, code, cust };
}

const invRow = async (id: string) => (await db.select().from(invoices).where(eq(invoices.id, id)))[0];

async function invoice(co: Co, amount: string, raw: string | null, foreign?: { currency: string; rate: string }) {
  const inv = await createInvoice(co.c, {
    customerId: co.cust,
    date: D('2026-05-01'),
    dueDate: D('2026-05-31'),
    ...(foreign ? { currency: foreign.currency, exchangeRate: foreign.rate } : {}),
    lines: [{ accountId: co.code['4000'], description: 'Line', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
  await db.update(invoices).set({ currency: raw }).where(eq(invoices.id, inv.id));
  return inv;
}

async function unappliedPayment(co: Co, amount: string, extra: Record<string, unknown> = {}) {
  return receivePayment(co.c, {
    customerId: co.cust,
    date: D('2026-05-03'),
    method: 'check',
    amount,
    depositAccountId: co.code['1000'],
    applications: [],
    ...extra,
  } as Parameters<typeof receivePayment>[1]);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-fix5@test.local', name: 'Fix5', passwordHash: 'x' })
    .returning();
  ownerId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Fix 5: applyPayment compares normalised currency codes', () => {
  it('Apply a home payment to an invoice stored as mixed-case Usd', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '50.00', 'Usd');
    const p = await unappliedPayment(co, '50.00');
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });

  it('a legacy payment row whose currency holds the home code (usd) applies to a blank invoice', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '75.00', null);
    const p = await unappliedPayment(co, '75.00');
    await db.update(paymentsReceived).set({ currency: 'usd' }).where(eq(paymentsReceived.id, p.payment.id));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '75.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });

  it('a legacy EUR payment stored as lower-case eur applies to an EUR invoice', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '100.00', 'EUR', { currency: 'EUR', rate: '1.13' });
    const p = await unappliedPayment(co, '100.00', { currency: 'EUR', exchangeRate: '1.13' });
    await db.update(paymentsReceived).set({ currency: 'eur' }).where(eq(paymentsReceived.id, p.payment.id));
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    expect((await invRow(inv.id)).balanceDue).toBe('0.00');
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });

  it('a home payment is still refused on a genuinely foreign eur invoice; the message names EUR; nothing changes', async () => {
    const co = await freshCompany();
    const inv = await invoice(co, '100.00', 'eur', { currency: 'EUR', rate: '1.13' });
    const p = await unappliedPayment(co, '100.00');
    await expect(
      applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] }),
    ).rejects.toThrow(/currency \(EUR\) does not match payment currency \(home\)/);
    expect((await invRow(inv.id)).balanceDue).toBe('100.00');
    const [pr] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, p.payment.id));
    expect(pr.unapplied).toBe('100.00');
  });

  it('home is per company: in a EUR-home company an eur invoice takes a home payment and a usd one is refused', async () => {
    const co = await freshCompany('EUR');
    const homeInv = await invoice(co, '40.00', 'eur');
    const p = await unappliedPayment(co, '40.00');
    await applyPayment(co.c, { paymentId: p.payment.id, applications: [{ invoiceId: homeInv.id, amountApplied: '40.00' }] });
    expect((await invRow(homeInv.id)).balanceDue).toBe('0.00');

    const usdInv = await invoice(co, '30.00', 'usd', { currency: 'USD', rate: '0.9' });
    const p2 = await unappliedPayment(co, '30.00');
    await expect(
      applyPayment(co.c, { paymentId: p2.payment.id, applications: [{ invoiceId: usdInv.id, amountApplied: '30.00' }] }),
    ).rejects.toThrow(/currency \(USD\)/);
    expect((await trialBalance(co.c, AS_OF)).balanced).toBe(true);
  });
});
