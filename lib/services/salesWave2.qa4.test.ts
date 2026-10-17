/**
 * wave2 sales — independent QA, re-test (round 2 of re-tests) after fix commit 8fc092a.
 * Paths the earlier QA files do not reach:
 *   - Bounce of an OVERPAYMENT (unapplied leftover): A/R control == subledger, aging history.
 *   - Bounce of a check whose receipt also used a credit memo (credits[]).
 *   - Bounce of an earlier payment that was later used as credit via paymentCredits.
 *   - paymentCredits: more than the earlier payment's unapplied, cash + earlier credit over
 *     the invoice balance (atomic rollback), another customer's invoice, edit refusal.
 *   - Credits-only payment cannot be recorded as bounced.
 *   - receivePaymentSchema validation of paymentCredits.
 * Invariant after every mutation: trial balance balanced AND A/R control == open-item subledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  companies,
  creditMemos,
  customers,
  invoices,
  journalEntries,
  paymentsReceived,
  users,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { arAging, arAgingDetail } from './reportsExtra';
import { createInvoice, getInvoice } from './invoices';
import { getPayment, receivePayment, recordBouncedCheck, updatePayment, voidPayment } from './payments';
import { createCreditMemo, getCreditMemo } from './creditMemos';
import { receivePaymentSchema } from '@/lib/validation/payments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-wave2-qa4');
let ctx: ServiceContext;
let ctx2: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
const acct2: Record<string, string> = {};
let custA: string;
let cust2: string;

const ACCOUNT_DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1010', 'Savings', 'asset', 'savings'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['1300', 'Inventory Asset', 'asset', 'inventory'],
  ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales Income', 'revenue', 'sales'],
  ['4950', 'Sales Discounts', 'revenue', 'sales'],
  ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
];

async function balanceOf(id: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return Money.round2(row.balance).toFixed(2);
}

async function assertBooks(c: ServiceContext = ctx, a: Record<string, string> = acct) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const invRows = await db
    .select({ balanceDue: invoices.balanceDue, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.companyId, c.companyId));
  const payRows = await db
    .select({ unapplied: paymentsReceived.unapplied })
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, c.companyId), isNull(paymentsReceived.voidedAt)));
  const memoRows = await db
    .select({ unapplied: creditMemos.unapplied, status: creditMemos.status })
    .from(creditMemos)
    .where(eq(creditMemos.companyId, c.companyId));
  let expected = Money.zero();
  for (const r of invRows) if (r.status !== 'draft' && r.status !== 'void') expected = expected.plus(Money.of(r.balanceDue));
  for (const r of payRows) expected = expected.minus(Money.of(r.unapplied));
  for (const r of memoRows) if (r.status !== 'void') expected = expected.minus(Money.of(r.unapplied));
  expect(await balanceOf(a['1200'])).toBe(Money.round2(expected).toFixed(2));
}

async function setClosingDate(date: string | null) {
  await db
    .update(companies)
    .set({ settings: (date ? { closingDate: date } : {}) as never })
    .where(eq(companies.id, ctx.companyId));
}

async function newCustomer(name: string, extra: Record<string, unknown> = {}) {
  return (await db.insert(customers).values({ companyId: ctx.companyId, displayName: name, ...extra }).returning())[0].id;
}

async function newInvoice(customerId: string, amount: number | string, date = '2026-03-01', extra: Record<string, unknown> = {}) {
  return createInvoice(ctx, {
    customerId,
    date: new Date(date),
    dueDate: new Date(new Date(date).getTime() + 30 * 86_400_000),
    lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    ...extra,
  } as never);
}

async function jeCount(c: ServiceContext = ctx) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, c.companyId));
  return Number(row.n);
}

function linesConsistent(doc: { total: string; lines: Array<{ quantity: string; rate: string; amount: string }> }) {
  let sum = Money.zero();
  for (const l of doc.lines) {
    // Stored at 4 decimals max, and the amount is exactly round2(qty x rate) of the STORED values.
    expect(l.quantity).toMatch(/^-?\d+(\.\d{1,4})?$/);
    expect(l.rate).toMatch(/^-?\d+(\.\d{1,4})?$/);
    expect(Money.round2(Money.mul(l.quantity, l.rate)).toFixed(2)).toBe(Money.of(l.amount).toFixed(2));
    sum = sum.plus(Money.of(l.amount));
  }
  return Money.round2(sum).toFixed(2);
}

describe('wave2 sales — QA re-test round 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'sales-qa4@test.local', name: 'QA4', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'QA4 Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'QA4 Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    for (const [code, name, type, subtype] of ACCOUNT_DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      acct2[code] = (await createAccount(ctx2, { code, name, type: type as never, subtype })).id;
    }
    custA = await newCustomer('QA4 Acme', { email: 'a@acme.test' });
    cust2 = (await db.insert(customers).values({ companyId: company2.id, displayName: 'QA4 Foreign' }).returning())[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const ar = async (cust: string, d: string) => {
    const r = (await arAging(ctx, new Date(d))).rows.find((x) => x.id === cust);
    return r ? Money.round2(r.total).toFixed(2) : '0.00';
  };
  const arDetail = async (invId: string, d: string) => {
    const rows = (await arAgingDetail(ctx, new Date(d))).rows.filter((x) => x.docId === invId);
    return rows.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2);
  };

  // ================================================================ F2 bounce edge cases
  describe('F2 bounced checks: overpayments, credits and earlier payments', () => {
    it('bouncing an overpayment reverses the whole check, clears the leftover credit, and keeps the books tied', async () => {
      const cust = await newCustomer('QA4 Overpay');
      const inv = await newInvoice(cust, 100, '2026-05-01');
      const bank0 = await balanceOf(acct['1000']);
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-03'), method: 'check', amount: '150', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '100' }],
      });
      expect((await getPayment(ctx, payment.id)).unapplied).toBe('50.00');
      await assertBooks();
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-09') });
      const after = await getPayment(ctx, payment.id);
      expect(after.bouncedAt).not.toBeNull();
      // The bank takes back all 150, so no unapplied credit may survive.
      expect(Money.of(after.unapplied).toFixed(2)).toBe('0.00');
      expect(await balanceOf(acct['1000'])).toBe(bank0);
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('100.00');
      await assertBooks();
      // History: open before the payment, paid between payment and bounce, open after.
      expect(await ar(cust, '2026-05-02')).toBe('100.00');
      // Between payment and bounce the customer held the 50.00 overpayment as a credit: A/R in the GL
      // was 100 - 150 = -50.00 then (review round 4 — this used to read 0.00, the bounce having erased
      // the credit from every earlier as-of aging, so the aging disagreed with the balance sheet).
      expect(await ar(cust, '2026-05-05')).toBe('-50.00');
      expect(await arDetail(inv.id, '2026-05-05')).toBe('0.00');
      expect(await ar(cust, '2026-05-10')).toBe('100.00');
    });

    it('bouncing a check whose receipt also used a credit memo only reopens the cash part (books tie)', async () => {
      const cust = await newCustomer('QA4 Bounce+Credit');
      const inv = await newInvoice(cust, 100, '2026-05-01');
      const memo = await createCreditMemo(ctx, {
        customerId: cust, date: new Date('2026-05-02'),
        lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 30 }],
      } as never);
      const bank0 = await balanceOf(acct['1000']);
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-03'), method: 'check', amount: '70', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '70' }],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '30' }],
      });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      await assertBooks();
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-06') });
      expect(await balanceOf(acct['1000'])).toBe(bank0);
      // Either the credit stays on the invoice (balance 70) or it is released back to the memo
      // (balance 100, memo unapplied 30): invoice balance minus memo credit left must be 70.
      const bal = (await getInvoice(ctx, inv.id)).balanceDue;
      const memoLeft = (await getCreditMemo(ctx, memo.id)).unapplied;
      expect(Money.of(bal).minus(Money.of(memoLeft)).toFixed(2)).toBe('70.00');
      await assertBooks();
    });

    it('an earlier payment used as credit inside Receive Payments can bounce; the invoice reopens and history holds', async () => {
      const cust = await newCustomer('QA4 Earlier Bounce');
      const i1 = await newInvoice(cust, 80, '2026-05-01');
      const bank0 = await balanceOf(acct['1000']);
      const early = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-02'), method: 'check', amount: '80', depositAccountId: acct['1000'],
        applications: [],
      });
      await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-04'), method: 'other', amount: '0', applications: [],
        paymentCredits: [{ paymentId: early.payment.id, invoiceId: i1.id, amount: '80' }],
      });
      expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('0.00');
      expect((await getPayment(ctx, early.payment.id)).unapplied).toBe('0.00');
      await assertBooks();
      await recordBouncedCheck(ctx, { paymentId: early.payment.id, date: new Date('2026-05-12') });
      expect(await balanceOf(acct['1000'])).toBe(bank0);
      expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('80.00');
      expect(Money.of((await getPayment(ctx, early.payment.id)).unapplied).toFixed(2)).toBe('0.00');
      await assertBooks();
      expect(await ar(cust, '2026-05-08')).toBe('0.00');
      expect(await ar(cust, '2026-05-13')).toBe('80.00');
    });

    it('a credits-only payment cannot be recorded as bounced (no money ever reached a bank)', async () => {
      const cust = await newCustomer('QA4 CreditsOnly Bounce');
      const inv = await newInvoice(cust, 40, '2026-05-01');
      const memo = await createCreditMemo(ctx, {
        customerId: cust, date: new Date('2026-05-02'),
        lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 40 }],
      } as never);
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-03'), method: 'other', amount: '0', applications: [],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '40' }],
      });
      const je = await jeCount();
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-05') })).rejects.toBeTruthy();
      expect(await jeCount()).toBe(je);
      expect((await getPayment(ctx, payment.id)).bouncedAt).toBeNull();
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      await assertBooks();
    });
  });

  // ================================================================ C4 limits and atomicity
  describe('C4 earlier payments: limits and atomicity', () => {
    it('cannot use more than the earlier payment has left, nor overpay an invoice with cash + earlier credit', async () => {
      const cust = await newCustomer('QA4 Earlier Limits');
      const inv = await newInvoice(cust, 100, '2026-06-01');
      const early = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-02'), method: 'check', amount: '40', applications: [],
      });
      await assertBooks();
      const je = await jeCount();
      const nPay = (await db.select().from(paymentsReceived).where(eq(paymentsReceived.customerId, cust))).length;

      // 1. More than the 40 left on the earlier payment.
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'other', amount: '0', applications: [],
          paymentCredits: [{ paymentId: early.payment.id, invoiceId: inv.id, amount: '40.01' }],
        }),
      ).rejects.toBeTruthy();
      // 2. Split entries that together exceed the 40.
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'other', amount: '0', applications: [],
          paymentCredits: [
            { paymentId: early.payment.id, invoiceId: inv.id, amount: '25' },
            { paymentId: early.payment.id, invoiceId: inv.id, amount: '25' },
          ],
        }),
      ).rejects.toBeTruthy();
      // 3. Earlier credit 40 (fine alone) + new cash 61 on a 100 invoice: over by 1. The
      //    earlier-payment application runs first, so it must roll back too.
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'cash', amount: '61',
          applications: [{ invoiceId: inv.id, amountApplied: '61' }],
          paymentCredits: [{ paymentId: early.payment.id, invoiceId: inv.id, amount: '40' }],
        }),
      ).rejects.toBeTruthy();

      expect(await jeCount()).toBe(je);
      expect((await db.select().from(paymentsReceived).where(eq(paymentsReceived.customerId, cust))).length).toBe(nPay);
      expect((await getPayment(ctx, early.payment.id)).unapplied).toBe('40.00');
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('100.00');
      await assertBooks();

      // Exactly 40 + 60 pays it off.
      await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-05'), method: 'cash', amount: '60',
        applications: [{ invoiceId: inv.id, amountApplied: '60' }],
        paymentCredits: [{ paymentId: early.payment.id, invoiceId: inv.id, amount: '40' }],
      });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      expect((await getPayment(ctx, early.payment.id)).unapplied).toBe('0.00');
      await assertBooks();
    });

    it('refuses another customer invoice; nothing changes (P1: paymentCredits on edit are applied)', async () => {
      const cust = await newCustomer('QA4 Earlier Owner');
      const other = await newCustomer('QA4 Earlier Other');
      const otherInv = await newInvoice(other, 50, '2026-06-01');
      const ownInv = await newInvoice(cust, 50, '2026-06-01');
      const early = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-02'), method: 'check', amount: '50', applications: [],
      });
      const p = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-03'), method: 'cash', amount: '10',
        applications: [{ invoiceId: ownInv.id, amountApplied: '10' }],
      });
      const je = await jeCount();
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'other', amount: '0', applications: [],
          paymentCredits: [{ paymentId: early.payment.id, invoiceId: otherInv.id, amount: '10' }],
        }),
      ).rejects.toBeTruthy();
      // Posing as the other customer (the earlier payment belongs to cust).
      await expect(
        receivePayment(ctx, {
          customerId: other, date: new Date('2026-06-05'), method: 'other', amount: '0', applications: [],
          paymentCredits: [{ paymentId: early.payment.id, invoiceId: otherInv.id, amount: '10' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await jeCount()).toBe(je);
      expect((await getPayment(ctx, early.payment.id)).unapplied).toBe('50.00');
      expect((await getInvoice(ctx, otherInv.id)).balanceDue).toBe('50.00');
      expect((await getInvoice(ctx, ownInv.id)).balanceDue).toBe('40.00');
      await assertBooks();
      // P1 (PARITY C4): earlier-payment credits picked while editing used to be refused / dropped;
      // QuickBooks applies them, so they are applied now (from the earlier payment, no new GL).
      await updatePayment(ctx, p.payment.id, {
        customerId: cust, date: new Date('2026-06-03'), method: 'cash', amount: '10',
        applications: [{ invoiceId: ownInv.id, amountApplied: '10' }],
        paymentCredits: [{ paymentId: early.payment.id, invoiceId: ownInv.id, amount: '5' }],
      });
      expect((await getPayment(ctx, early.payment.id)).unapplied).toBe('45.00');
      expect((await getInvoice(ctx, ownInv.id)).balanceDue).toBe('35.00');
      await assertBooks();
    });

    it('receivePaymentSchema rejects malformed paymentCredits', () => {
      const base = {
        customerId: '00000000-0000-4000-8000-000000000001',
        date: '2026-06-05', method: 'cash', amount: '0', applications: [],
      };
      const ok = { paymentId: '00000000-0000-4000-8000-000000000002', invoiceId: '00000000-0000-4000-8000-000000000003', amount: '5' };
      expect(receivePaymentSchema.safeParse({ ...base, paymentCredits: [ok] }).success).toBe(true);
      for (const bad of [
        { ...ok, amount: '0' },
        { ...ok, amount: '-1' },
        { ...ok, amount: 'abc' },
        { ...ok, paymentId: 'not-a-uuid' },
        { ...ok, invoiceId: undefined },
      ]) {
        expect(receivePaymentSchema.safeParse({ ...base, paymentCredits: [bad] }).success).toBe(false);
      }
    });
  });
});
