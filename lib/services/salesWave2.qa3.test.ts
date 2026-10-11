/**
 * wave2 sales — independent QA, re-test round 1 (after fix commit 8fc092a).
 * Adversarial coverage of the fixes themselves, not just the original repro:
 *   - 4-decimal line precision: >4-decimal input, sub-precision quantities, SO partial invoicing,
 *     sales receipts and credit memos re-price exactly; header == sum of lines.
 *   - Sales receipt deposit account: A/R / Inventory refused on create AND edit (no side effects).
 *   - Bounce date: before the deposit refused; same-day bounce allowed.
 *   - As-of A/R aging (summary + detail) around a bounce of a discounted payment.
 *   - Credits-only payment: void / edit respect the closing date and roll back cleanly.
 *   - Draft invoices: credits[] in Receive Payments, credit memo apply, earlier-payment credits.
 *   - Deposit void after bounce refused (bank unchanged).
 *   - Income Tracker paid bucket: payments and sales receipts after asOf excluded, on asOf included.
 *   - C4 earlier payments: voided / bounced / other-company earlier payment, partial failure
 *     rolls the whole receipt back, duplicates combine, draft invoice refused.
 *
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
import { applyToInvoice, createCreditMemo, getCreditMemo } from './creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createEstimate, convertToInvoice as convertEstimate } from './estimates';
import { createSalesOrder, convertToInvoice as convertSalesOrder, getSalesOrder } from './salesOrders';
import { createDeposit, voidDeposit } from './deposits';
import { incomeTracker } from './incomeTracker';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-wave2-qa3');
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

describe('wave2 sales — QA re-test round 1', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'sales-qa3@test.local', name: 'QA3', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'QA3 Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'QA3 Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    for (const [code, name, type, subtype] of ACCOUNT_DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      acct2[code] = (await createAccount(ctx2, { code, name, type: type as never, subtype })).id;
    }
    custA = await newCustomer('QA3 Acme', { email: 'a@acme.test' });
    cust2 = (await db.insert(customers).values({ companyId: company2.id, displayName: 'QA3 Foreign' }).returning())[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ================================================================ line precision
  describe('4-decimal line precision', () => {
    it('rates/quantities with more than 4 decimals are stored at 4 and the amount follows the stored values', async () => {
      const inv = await createInvoice(ctx, {
        customerId: custA, date: new Date('2026-02-01'), dueDate: new Date('2026-03-01'),
        lines: [
          { accountId: acct['4000'], description: 'a', quantity: '3', rate: '10.12345', taxable: false },
          { accountId: acct['4000'], description: 'b', quantity: '1.33335', rate: '7', taxable: false },
        ],
      } as never);
      const full = await getInvoice(ctx, inv.id);
      expect(linesConsistent(full as never)).toBe(full.total);
      await assertBooks();
    });

    it('a quantity that rounds to zero at 4 decimals is refused, not saved as a 0.00 line', async () => {
      const before = await jeCount();
      await expect(
        createInvoice(ctx, {
          customerId: custA, date: new Date('2026-02-01'), dueDate: new Date('2026-03-01'),
          lines: [{ accountId: acct['4000'], description: 'tiny', quantity: '0.00001', rate: '100', taxable: false }],
        } as never),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await jeCount()).toBe(before);
    });

    it('estimate -> invoice bills exactly the quote for awkward fractions', async () => {
      const est = await createEstimate(ctx, {
        customerId: custA, date: new Date('2026-02-02'),
        lines: [
          { description: 'x', quantity: '7', rate: '14.28571' },
          { description: 'y', quantity: '0.3333', rate: '3' },
          { description: 'z', quantity: '2.5', rate: '0.0049' },
        ],
      });
      expect(linesConsistent(est as never)).toBe(est.total);
      const inv = await convertEstimate(ctx, est.id);
      const full = await getInvoice(ctx, inv.id);
      expect(full.total).toBe(est.total);
      expect(linesConsistent(full as never)).toBe(full.total);
      await assertBooks();
    });

    it('a sales order invoiced in fractional parts bills, in total, exactly the order', async () => {
      const so = await createSalesOrder(ctx, {
        customerId: custA, date: new Date('2026-02-03'),
        lines: [{ description: 'Widget', quantity: '3', rate: '33.3333' }],
      });
      const full = await getSalesOrder(ctx, so.id);
      const lineId = full.lines[0].id;
      const i1 = await convertSalesOrder(ctx, so.id, { lines: [{ lineId, quantity: '1.5' }], overrideCreditLimit: true });
      const i2 = await convertSalesOrder(ctx, so.id, { lines: [{ lineId, quantity: '1.5' }], overrideCreditLimit: true });
      const t1 = (await getInvoice(ctx, i1.id)).total;
      const t2 = (await getInvoice(ctx, i2.id)).total;
      // 1.5 x 33.3333 = 49.99995 -> 50.00 each; the order totals 99.9999 -> 100.00.
      expect(Money.of(t1).plus(Money.of(t2)).toFixed(2)).toBe(Money.of(full.total).toFixed(2));
      expect((await getSalesOrder(ctx, so.id)).status).toBe('closed');
      // Nothing left to invoice.
      await expect(convertSalesOrder(ctx, so.id, { lines: [{ lineId, quantity: '0.0001' }] })).rejects.toBeTruthy();
      await assertBooks();
    });

    it('sales receipts and credit memos keep header == sum of stored lines', async () => {
      const sr = await createSalesReceipt(ctx, {
        customerId: custA, date: new Date('2026-02-04'), depositAccountId: acct['1000'],
        lines: [{ accountId: acct['4000'], description: 'counter', quantity: '3', rate: '0.33335' }],
      } as never);
      const srFull = await getSalesReceipt(ctx, sr.id);
      expect(linesConsistent(srFull as never)).toBe(srFull.total);
      const cm = await createCreditMemo(ctx, {
        customerId: custA, date: new Date('2026-02-04'),
        lines: [{ accountId: acct['4000'], description: 'return', quantity: '3', rate: '16.66666' }],
      } as never);
      const cmFull = await getCreditMemo(ctx, cm.id);
      expect(linesConsistent(cmFull as never)).toBe(cmFull.total);
      await assertBooks();
    });
  });

  // ================================================================ sales receipt deposit account
  describe('sales receipt deposit account', () => {
    it('A/R and Inventory are refused on create and on edit; a refused edit changes nothing', async () => {
      for (const bad of ['1200', '1300']) {
        await expect(
          createSalesReceipt(ctx, {
            customerId: custA, date: new Date('2026-02-05'), depositAccountId: acct[bad],
            lines: [{ accountId: acct['4000'], description: 'x', quantity: 1, rate: 10 }],
          } as never),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      const sr = await createSalesReceipt(ctx, {
        customerId: custA, date: new Date('2026-02-05'), depositAccountId: acct['1000'],
        lines: [{ accountId: acct['4000'], description: 'x', quantity: 1, rate: 10 }],
      } as never);
      const bank = await balanceOf(acct['1000']);
      const ar = await balanceOf(acct['1200']);
      const je = await jeCount();
      for (const bad of ['1200', '1300']) {
        await expect(
          updateSalesReceipt(ctx, sr.id, {
            customerId: custA, date: new Date('2026-02-05'), depositAccountId: acct[bad],
            lines: [{ accountId: acct['4000'], description: 'x', quantity: 1, rate: 10 }],
          } as never),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      // Another company's bank is not usable either.
      await expect(
        updateSalesReceipt(ctx, sr.id, {
          customerId: custA, date: new Date('2026-02-05'), depositAccountId: acct2['1000'],
          lines: [{ accountId: acct['4000'], description: 'x', quantity: 1, rate: 10 }],
        } as never),
      ).rejects.toBeTruthy();
      expect(await balanceOf(acct['1000'])).toBe(bank);
      expect(await balanceOf(acct['1200'])).toBe(ar);
      expect(await jeCount()).toBe(je);
      expect((await getSalesReceipt(ctx, sr.id)).depositAccountId).toBe(acct['1000']);
      await assertBooks();
    });
  });

  // ================================================================ bounced checks
  describe('F2 bounce dates, aging and deposits', () => {
    it('refuses a bounce dated before the deposit; same-day bounce is fine; deposit cannot then be voided', async () => {
      const cust = await newCustomer('QA3 Bouncer 1');
      const inv = await newInvoice(cust, 300, '2026-04-01');
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-04-03'), method: 'check', amount: '300',
        applications: [{ invoiceId: inv.id, amountApplied: '300' }],
      });
      const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-04-06'), paymentIds: [payment.id] });
      const bank0 = await balanceOf(acct['1000']);
      // After the payment but before the deposit -> refused.
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-04-05') })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getPayment(ctx, payment.id)).bouncedAt).toBeNull();
      expect(await balanceOf(acct['1000'])).toBe(bank0);
      // Same day as the deposit -> allowed.
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-04-06') });
      expect(await balanceOf(acct['1000'])).toBe(Money.of(bank0).minus(300).toFixed(2));
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('300.00');
      const bank1 = await balanceOf(acct['1000']);
      const uf1 = await balanceOf(acct['1050']);
      await expect(voidDeposit(ctx, dep.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await balanceOf(acct['1000'])).toBe(bank1);
      expect(await balanceOf(acct['1050'])).toBe(uf1);
      await assertBooks();
    });

    it('as-of aging (summary and detail) around the bounce of a discounted payment', async () => {
      const cust = await newCustomer('QA3 Bouncer 2', { terms: '2_10_net_30' });
      const inv = await newInvoice(cust, 500, '2026-04-10');
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-04-12'), method: 'check', amount: '490', depositAccountId: acct['1000'],
        discountAccountId: acct['4950'],
        applications: [{ invoiceId: inv.id, amountApplied: '490', discountAmount: '10' }],
      } as never);
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-04-20') });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('500.00');

      const summary = async (d: string) => {
        const r = (await arAging(ctx, new Date(d))).rows.find((x) => x.id === cust);
        return r ? Money.round2(r.total).toFixed(2) : '0.00';
      };
      const detail = async (d: string) => {
        const rows = (await arAgingDetail(ctx, new Date(d))).rows.filter((x) => x.docId === inv.id);
        return rows.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2);
      };
      expect(await summary('2026-04-11')).toBe('500.00'); // before payment
      expect(await detail('2026-04-11')).toBe('500.00');
      expect(await summary('2026-04-15')).toBe('0.00'); // paid (incl. discount), not yet bounced
      expect(await detail('2026-04-15')).toBe('0.00');
      expect(await summary('2026-04-25')).toBe('500.00'); // after bounce
      expect(await detail('2026-04-25')).toBe('500.00');
      // The aging total must agree with the GL A/R as of each date for this company.
      // GL A/R moves by exactly the bounce on the bounce date, and aging for this customer agrees.
      const glAr = async (d: string) => {
        const tb = await trialBalance(ctx, new Date(d));
        const r = tb.rows.find((x) => x.accountId === acct['1200']);
        return r ? Money.of(r.debit).minus(Money.of(r.credit)) : Money.zero();
      };
      const glDelta = (await glAr('2026-04-25')).minus(await glAr('2026-04-15'));
      expect(glDelta.toFixed(2)).toBe('500.00');
      expect(Money.of(await summary('2026-04-25')).minus(Money.of(await summary('2026-04-15'))).toFixed(2)).toBe(glDelta.toFixed(2));
      await assertBooks();
    });
  });

  // ================================================================ credits-only payments + closing date
  describe('credits-only payment and the closing date', () => {
    it('cannot be voided or edited once its date is closed; nothing changes', async () => {
      const cust = await newCustomer('QA3 Credits Only');
      const inv = await newInvoice(cust, 80, '2026-01-10');
      const memo = await createCreditMemo(ctx, {
        customerId: cust, date: new Date('2026-01-11'),
        lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 30 }],
      } as never);
      const { payment, entry } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-01-15'), method: 'other', amount: '0', applications: [],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '30' }],
      });
      expect(entry).toBeNull();
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('50.00');
      await setClosingDate('2026-01-31');
      try {
        await expect(voidPayment(ctx, payment.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        await expect(
          updatePayment(ctx, payment.id, {
            customerId: cust, date: new Date('2026-02-15'), method: 'other', amount: '0', applications: [],
            credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '20' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        // Moving an open-period credits-only payment INTO the closed period is refused too.
        const inv2 = await newInvoice(cust, 40, '2026-02-02');
        const memo2 = await createCreditMemo(ctx, {
          customerId: cust, date: new Date('2026-02-03'),
          lines: [{ accountId: acct['4000'], description: 'Return 2', quantity: 1, rate: 15 }],
        } as never);
        const p2 = await receivePayment(ctx, {
          customerId: cust, date: new Date('2026-02-05'), method: 'other', amount: '0', applications: [],
          credits: [{ creditMemoId: memo2.id, invoiceId: inv2.id, amount: '15' }],
        });
        await expect(
          updatePayment(ctx, p2.payment.id, {
            customerId: cust, date: new Date('2026-01-20'), method: 'other', amount: '0', applications: [],
            credits: [{ creditMemoId: memo2.id, invoiceId: inv2.id, amount: '15' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        expect((await getInvoice(ctx, inv2.id)).balanceDue).toBe('25.00');
        expect((await getCreditMemo(ctx, memo2.id)).unapplied).toBe('0.00');
        expect(new Date((await getPayment(ctx, p2.payment.id)).date).toISOString().slice(0, 10)).toBe('2026-02-05');
      } finally {
        await setClosingDate(null);
      }
      expect((await getPayment(ctx, payment.id)).voidedAt).toBeNull();
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('50.00');
      expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('0.00');
      await assertBooks();
    });
  });

  // ================================================================ draft invoices
  describe('draft invoices cannot be paid by any route', () => {
    it('credits in Receive Payments, credit memo apply, and earlier payments are all refused', async () => {
      const cust = await newCustomer('QA3 Draft');
      const draft = await newInvoice(cust, 60, '2026-03-05', { status: 'draft' });
      expect((await getInvoice(ctx, draft.id)).status).toBe('draft');
      const memo = await createCreditMemo(ctx, {
        customerId: cust, date: new Date('2026-03-06'),
        lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 20 }],
      } as never);
      const posted = await newInvoice(cust, 10, '2026-03-05');
      const over = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-03-07'), method: 'check', amount: '40',
        applications: [{ invoiceId: posted.id, amountApplied: '10' }],
      });
      expect(over.payment.unapplied).toBe('30.00');
      await assertBooks();
      const je = await jeCount();

      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-03-08'), method: 'other', amount: '0', applications: [],
          credits: [{ creditMemoId: memo.id, invoiceId: draft.id, amount: '20' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: draft.id, amount: '20' } as never)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-03-08'), method: 'other', amount: '0', applications: [],
          paymentCredits: [{ paymentId: over.payment.id, invoiceId: draft.id, amount: '30' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      expect(await jeCount()).toBe(je);
      expect((await getInvoice(ctx, draft.id)).balanceDue).toBe('60.00');
      expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('20.00');
      expect((await getPayment(ctx, over.payment.id)).unapplied).toBe('30.00');
      await assertBooks();
    });
  });

  // ================================================================ C4 earlier payments
  describe('C4 earlier payments inside Receive Payments', () => {
    it('voided, bounced or other-company earlier payments are refused; a partial failure rolls back everything', async () => {
      const cust = await newCustomer('QA3 Earlier');
      const i1 = await newInvoice(cust, 100, '2026-06-01');
      const i2 = await newInvoice(cust, 100, '2026-06-01');
      const good = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-02'), method: 'check', amount: '50', applications: [],
      });
      const voided = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-02'), method: 'check', amount: '25', applications: [],
      });
      await voidPayment(ctx, voided.payment.id);
      const bounced = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-02'), method: 'check', amount: '35', depositAccountId: acct['1000'], applications: [],
      });
      await recordBouncedCheck(ctx, { paymentId: bounced.payment.id, date: new Date('2026-06-04') });
      await assertBooks();
      const je = await jeCount();
      const payCount = (await db.select().from(paymentsReceived).where(eq(paymentsReceived.customerId, cust))).length;

      // Good earlier credit first, then a voided one: the good application must roll back too.
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'cash', amount: '10',
          applications: [{ invoiceId: i2.id, amountApplied: '10' }],
          paymentCredits: [
            { paymentId: good.payment.id, invoiceId: i1.id, amount: '50' },
            { paymentId: voided.payment.id, invoiceId: i1.id, amount: '5' },
          ],
        }),
      ).rejects.toBeTruthy();
      await expect(
        receivePayment(ctx, {
          customerId: cust, date: new Date('2026-06-05'), method: 'cash', amount: '0', applications: [],
          paymentCredits: [{ paymentId: bounced.payment.id, invoiceId: i1.id, amount: '1' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // Another company's ctx cannot use this company's payment (and vice versa).
      await expect(
        receivePayment(ctx2, {
          customerId: cust2, date: new Date('2026-06-05'), method: 'cash', amount: '0', applications: [],
          paymentCredits: [{ paymentId: good.payment.id, invoiceId: i1.id, amount: '1' }],
        }),
      ).rejects.toBeTruthy();
      // Malformed amounts.
      for (const bad of ['0', '-5', 'abc']) {
        await expect(
          receivePayment(ctx, {
            customerId: cust, date: new Date('2026-06-05'), method: 'cash', amount: '0', applications: [],
            paymentCredits: [{ paymentId: good.payment.id, invoiceId: i1.id, amount: bad }],
          }),
        ).rejects.toBeTruthy();
      }

      expect(await jeCount()).toBe(je);
      expect((await db.select().from(paymentsReceived).where(eq(paymentsReceived.customerId, cust))).length).toBe(payCount);
      expect((await getPayment(ctx, good.payment.id)).unapplied).toBe('50.00');
      expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('100.00');
      expect((await getInvoice(ctx, i2.id)).balanceDue).toBe('100.00');
      await assertBooks();

      // Split entries for the same payment+invoice combine; across two invoices works too.
      await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-06-06'), method: 'cash', amount: '0', applications: [],
        paymentCredits: [
          { paymentId: good.payment.id, invoiceId: i1.id, amount: '20' },
          { paymentId: good.payment.id, invoiceId: i1.id, amount: '10' },
          { paymentId: good.payment.id, invoiceId: i2.id, amount: '20' },
        ],
      });
      expect((await getPayment(ctx, good.payment.id)).unapplied).toBe('0.00');
      expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('70.00');
      expect((await getInvoice(ctx, i2.id)).balanceDue).toBe('80.00');
      expect(await jeCount()).toBe(je);
      await assertBooks();

      // Voiding the earlier payment now puts both invoices back.
      await voidPayment(ctx, good.payment.id);
      expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('100.00');
      expect((await getInvoice(ctx, i2.id)).balanceDue).toBe('100.00');
      await assertBooks();
    });
  });

  // ================================================================ income tracker
  describe('Income Tracker paid bucket', () => {
    it('counts payments and sales receipts on asOf, but nothing after asOf or older than 30 days', async () => {
      const cust = await newCustomer('QA3 Tracker');
      const inv = await newInvoice(cust, 300, '2026-08-01');
      const pOn = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-08-20'), method: 'cash', amount: '100',
        applications: [{ invoiceId: inv.id, amountApplied: '100' }],
      });
      const pAfter = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-08-21'), method: 'cash', amount: '100',
        applications: [{ invoiceId: inv.id, amountApplied: '100' }],
      });
      const pOld = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-07-10'), method: 'cash', amount: '100',
        applications: [{ invoiceId: inv.id, amountApplied: '100' }],
      });
      const srAfter = await createSalesReceipt(ctx, {
        customerId: cust, date: new Date('2026-08-25'),
        lines: [{ accountId: acct['4000'], description: 'later sale', quantity: 1, rate: 7 }],
      } as never);
      const srOn = await createSalesReceipt(ctx, {
        customerId: cust, date: new Date('2026-08-20'),
        lines: [{ accountId: acct['4000'], description: 'sale', quantity: 1, rate: 9 }],
      } as never);
      const t = await incomeTracker(ctx, { asOf: new Date('2026-08-20'), customerId: cust });
      const paidIds = t.rows.filter((r) => r.bucket === 'paid').map((r) => r.id);
      expect(paidIds).toContain(pOn.payment.id);
      expect(paidIds).toContain(srOn.id);
      expect(paidIds).not.toContain(pAfter.payment.id);
      expect(paidIds).not.toContain(pOld.payment.id);
      expect(paidIds).not.toContain(srAfter.id);
      expect(t.totals.paid.amount).toBe('109.00');
      await assertBooks();
    });
  });
});
