/**
 * P1 round, team FX — fix round 2: the home amount still open on a foreign invoice comes from what
 * was actually relieved on A/R (payment_fx_reliefs), and payments, applyPayment, unapplyFromInvoice,
 * the A/R aging / Home Currency Adjustment subledger and Verify Data all use it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices, paymentFxReliefs } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment, applyPayment, unapplyFromInvoice, updatePayment } from './payments';
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix2');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
async function invariants() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
  expect(Money.of((await arAging(ctx, d('2027-12-31'))).totals.total).toFixed(2)).toBe(await bal('1200'));
  const res = await verifyIntegrity(ctx);
  expect(res.checks.filter((c) => !c.ok)).toEqual([]);
}
async function customer(name: string) {
  const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return c;
}
async function eurInvoice(customerId: string, date: string, amount: string, rate: string) {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: acct['4000'], quantity: 1, rate: amount }],
  } as never);
}
function eurPaymentInput(customerId: string, date: string, amount: string, rate: string, apps: Array<{ invoiceId: string; amountApplied: string }>) {
  return {
    customerId,
    date: d(date),
    method: 'check',
    amount,
    currency: 'EUR',
    exchangeRate: rate,
    depositAccountId: acct['1050'],
    applications: apps,
  } as never;
}
async function balanceDue(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return Money.of(row.balanceDue).toFixed(2);
}

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
];

describe('P1 FX — fix round 2: home open amount from the A/R actually relieved', () => {
  let user: { id: string };
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    [user] = await db.insert(users).values({ email: 'p1fx-fix2@test.local', name: 'FX F2', passwordHash: 'x' }).returning();
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX F2 Co ${seq}`, ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '100000.00' },
        { accountId: acct['3000'], credit: '100000.00' },
      ],
    });
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('unapply part of a payment at another rate, then apply it again: A/R == aging at every step and clears to zero', async () => {
    const c = await customer('Unapply Payer');
    const inv = await eurInvoice(c.id, '2026-02-01', '100', '1.07');
    const { payment } = await receivePayment(ctx, eurPaymentInput(c.id, '2026-02-02', '100.00', '1.2345', [{ invoiceId: inv.id, amountApplied: '100.00' }]));
    expect(await bal('1200')).toBe('0.00');
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '33.33' });
    // Invoice: 33.33 EUR open at 1.07 = 35.66; credit: 33.33 EUR at 1.2345 = 41.15.
    expect(await balanceDue(inv.id)).toBe('33.33');
    expect(await bal('1200')).toBe('-5.49');
    await invariants();
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('several partial applications of one leftover credit keep the credit and the invoice exact', async () => {
    const c = await customer('Credit Splitter');
    const inv = await eurInvoice(c.id, '2026-02-10', '100', '1.07');
    const { payment } = await receivePayment(ctx, eurPaymentInput(c.id, '2026-02-11', '100.00', '1.2345', []));
    for (const amt of ['33.33', '33.33', '33.34']) {
      await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt }] });
      await invariants();
    }
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
  });

  it('editing a middle partial payment to a different rate keeps A/R exact; the last payment clears it', async () => {
    const c = await customer('Middle Editor');
    const inv = await eurInvoice(c.id, '2026-03-01', '100', '1.07');
    const ids: string[] = [];
    for (const [i, amt] of ['33.33', '33.33'].entries()) {
      const { payment } = await receivePayment(ctx, eurPaymentInput(c.id, `2026-03-0${i + 2}`, amt, '1.07', [{ invoiceId: inv.id, amountApplied: amt }]));
      ids.push(payment.id);
    }
    await updatePayment(ctx, ids[0], eurPaymentInput(c.id, '2026-03-02', '20.00', '1.15', [{ invoiceId: inv.id, amountApplied: '20.00' }]));
    await invariants();
    await receivePayment(ctx, eurPaymentInput(c.id, '2026-03-05', '46.67', '1.09', [{ invoiceId: inv.id, amountApplied: '46.67' }]));
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
    await voidPayment(ctx, ids[1]);
    await invariants();
  });

  it('an application made before relief records existed (upgraded company) still finishes cleanly', async () => {
    const c = await customer('Legacy Payer');
    const inv = await eurInvoice(c.id, '2026-04-01', '100', '1.07');
    // 33.33 x 1.07 = 35.66 either way; drop the record to look like a pre-upgrade application.
    const { payment } = await receivePayment(ctx, eurPaymentInput(c.id, '2026-04-02', '40.00', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    await db.delete(paymentFxReliefs).where(eq(paymentFxReliefs.paymentId, payment.id));
    await invariants();
    const [open] = (await foreignOpenReceivables(ctx, d('2027-12-31'))).filter((i) => i.kind === 'invoice');
    expect(open.homeOpen.toFixed(2)).toBe('71.34');
    // Change the legacy application (apply its leftover, then unapply some): baseline kept.
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '6.67' }] });
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '10.00' });
    await invariants();
    await receivePayment(ctx, eurPaymentInput(c.id, '2026-04-05', '70.00', '1.11', [{ invoiceId: inv.id, amountApplied: '70.00' }]));
    expect(await balanceDue(inv.id)).toBe('0.00');
    await invariants();
  });

  it('Verify Data passes with a partly paid foreign invoice and an unapplied foreign payment', async () => {
    const c = await customer('Open Mix');
    const inv = await eurInvoice(c.id, '2026-05-01', '1000', '1.10');
    await receivePayment(ctx, eurPaymentInput(c.id, '2026-05-02', '333.33', '1.12', [{ invoiceId: inv.id, amountApplied: '333.33' }]));
    await receivePayment(ctx, eurPaymentInput(c.id, '2026-05-03', '50.00', '1.13', []));
    await invariants();
  });
});
