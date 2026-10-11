/**
 * wave2 sales — independent QA (tester) suite. Adversarial checks for the A/R parity package:
 * C1 edits (closing date both sides, rollback, cross-customer), C2 credit-limit warning +
 * audited override, C3 discounts (rounding, boundary, account validation), C4 credits inside
 * Receive Payments (misuse), C5 statement charges, C6 batch invoicing, C7/C8 forms isolation,
 * C9 Income Tracker / Collections Center, F2 bounced checks, permission mapping.
 *
 * Invariant after every mutation: trial balance balanced AND A/R control == open-item subledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  companies,
  creditMemos,
  customers,
  invoices,
  items,
  journalEntries,
  paymentsReceived,
  users,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, getInvoice, updateInvoice } from './invoices';
import {
  getPayment,
  receivePayment,
  recordBouncedCheck,
  suggestEarlyPaymentDiscounts,
  updatePayment,
  voidPayment,
} from './payments';
import { createCreditMemo, getCreditMemo, updateCreditMemo, voidCreditMemo } from './creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { convertToInvoice as convertSalesOrder, createSalesOrder, getSalesOrder, updateSalesOrder } from './salesOrders';
import { createDeposit, voidDeposit } from './deposits';
import { createBatchInvoices, createStatementCharge, updateStatementCharge } from './batchInvoicing';
import { listSendQueue, renderSalesForm, setSendFlags } from './salesForms';
import { addCollectionNote, incomeTracker, setCollectionNoteDone } from './incomeTracker';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-wave2-qa');
let ctx: ServiceContext;
let ctx2: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
const acct2: Record<string, string> = {};
let custA: string;
let custB: string;
let custLimited: string;
let cust2: string;
let svcItem: string;

const ACCOUNT_DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['1300', 'Inventory Asset', 'asset', 'inventory'],
  ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales Income', 'revenue', 'sales'],
  ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
  ['6200', 'Discounts Expense', 'expense', 'operating_expenses'],
];

async function balanceOf(id: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return Money.round2(row.balance).toFixed(2);
}

/** Trial balance balanced + A/R control == subledger (open invoices − unapplied payments − unapplied memos). */
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

async function newInvoice(customerId: string, amount: number | string, date = '2026-03-01', c: ServiceContext = ctx) {
  const a = c === ctx ? acct : acct2;
  return createInvoice(c, {
    customerId,
    date: new Date(date),
    dueDate: new Date(new Date(date).getTime() + 30 * 86_400_000),
    lines: [{ accountId: a['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
  });
}

async function jeStatus(id: string) {
  const [je] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, id));
  return je?.status;
}

describe('wave2 sales — QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'sales-qa@test.local', name: 'QA', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'QA Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    for (const [code, name, type, subtype] of ACCOUNT_DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      acct2[code] = (await createAccount(ctx2, { code, name, type: type as never, subtype })).id;
    }
    custA = (await db.insert(customers).values({ companyId: company.id, displayName: 'QA Acme', terms: '2_10_net_30', email: 'a@acme.test' }).returning())[0].id;
    custB = (await db.insert(customers).values({ companyId: company.id, displayName: 'QA Bolt' }).returning())[0].id;
    custLimited = (
      await db.insert(customers).values({ companyId: company.id, displayName: 'QA Limited', creditLimit: '100.00' }).returning()
    )[0].id;
    cust2 = (await db.insert(customers).values({ companyId: company2.id, displayName: 'Foreign Co Customer' }).returning())[0].id;
    svcItem = (
      await db
        .insert(items)
        .values({ companyId: company.id, name: 'QA Service', type: 'service', salesPrice: '10.00', incomeAccountId: acct['4000'] })
        .returning()
    )[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ================================================================ permissions
  describe('permission mapping', () => {
    const cases: Array<[string, string, string]> = [
      ['/api/invoices/batch', 'POST', 'create'],
      ['/api/invoices/statement-charges', 'POST', 'create'],
      ['/api/invoices/statement-charges/00000000-0000-0000-0000-000000000000', 'PUT', 'modify'],
      ['/api/payments/00000000-0000-0000-0000-000000000000', 'PUT', 'modify'],
      ['/api/payments/00000000-0000-0000-0000-000000000000', 'PATCH', 'modify'],
      ['/api/payments/00000000-0000-0000-0000-000000000000', 'POST', 'modify'],
      ['/api/sales-receipts/00000000-0000-0000-0000-000000000000', 'PUT', 'modify'],
      ['/api/credit-memos/00000000-0000-0000-0000-000000000000', 'PUT', 'modify'],
      ['/api/sales-orders/00000000-0000-0000-0000-000000000000', 'PUT', 'modify'],
      ['/api/estimates/00000000-0000-0000-0000-000000000000', 'PATCH', 'modify'],
      ['/api/sales-forms/invoice/00000000-0000-0000-0000-000000000000/pdf', 'GET', 'print'],
      ['/api/sales-forms/invoice/00000000-0000-0000-0000-000000000000/email', 'POST', 'print'],
      ['/api/sales-forms/invoice/00000000-0000-0000-0000-000000000000/flags', 'PATCH', 'modify'],
      ['/api/sales-forms/queue', 'GET', 'print'],
      ['/api/income-tracker', 'GET', 'view'],
      ['/api/income-tracker/actions', 'POST', 'create'],
      ['/api/collections', 'GET', 'view'],
      ['/api/collections/notes', 'POST', 'create'],
      ['/api/collections/notes/00000000-0000-0000-0000-000000000000', 'PATCH', 'modify'],
      ['/api/payments/credits', 'GET', 'view'],
      ['/api/payments/discounts', 'GET', 'view'],
    ];
    it.each(cases)('%s %s → customers:%s', (p, method, action) => {
      const rule = apiRuleFor(p, method);
      expect(rule).toEqual({ area: 'customers', action });
    });

    it('does not let read-only verbs mutate (no DELETE on new read endpoints)', () => {
      expect(apiRuleFor('/api/income-tracker', 'DELETE')).toBeNull();
      expect(apiRuleFor('/api/collections', 'POST')).toBeNull();
      expect(apiRuleFor('/api/payments/discounts', 'POST')).toBeNull();
    });

    it('maps every new page to the customers area', () => {
      for (const p of ['/income-tracker', '/collections-center', '/invoices/batch', '/invoices/send-forms', '/invoices/statement-charges']) {
        expect(pageAreasFor(p), p).toEqual(['customers']);
      }
    });
  });

  // ================================================================ C2 credit limit
  describe('C2 credit limit warning', () => {
    it('warns (VALIDATION + warning payload), saves nothing, then saves with an audited override', async () => {
      const before = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, custLimited));
      let caught: unknown;
      try {
        await newInvoice(custLimited, 150);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ code: 'VALIDATION', details: { warning: 'CREDIT_LIMIT', creditLimit: '100.00', overBy: '50.00' } });
      const after = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, custLimited));
      expect(after.length).toBe(before.length);

      const inv = await createInvoice(ctx, {
        customerId: custLimited,
        date: new Date('2026-03-01'),
        overrideCreditLimit: true,
        lines: [{ accountId: acct['4000'], description: 'Big job', quantity: 1, rate: 150, taxable: false }],
      });
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, inv.id));
      expect(audits.some((a) => (a.newValues as { creditLimitOverride?: { warning?: string } } | null)?.creditLimitOverride?.warning === 'CREDIT_LIMIT')).toBe(true);
      await assertBooks();

      // Editing that invoice without increasing it still counts the customer's OTHER balance only
      // (150 > 100 still warns) — but an under-limit edit must not warn about its own old balance.
      const edited = await updateInvoice(ctx, inv.id, {
        customerId: custLimited,
        date: new Date('2026-03-01'),
        lines: [{ accountId: acct['4000'], description: 'Smaller job', quantity: 1, rate: 90, taxable: false }],
      });
      expect(edited.total).toBe('90.00');
      await assertBooks();
    });
  });

  // ================================================================ C3 discounts
  describe('C3 early-payment discounts', () => {
    it('rounds the suggestion to cents and honours the last discount day exactly', async () => {
      const inv = await newInvoice(custA, '33.33', '2026-04-01');
      const day10 = await suggestEarlyPaymentDiscounts(ctx, { customerId: custA, paymentDate: new Date('2026-04-11'), invoiceIds: [inv.id] });
      expect(day10[0]).toMatchObject({ eligible: true, suggested: '0.67' });
      const day11 = await suggestEarlyPaymentDiscounts(ctx, { customerId: custA, paymentDate: new Date('2026-04-12'), invoiceIds: [inv.id] });
      expect(day11[0]).toMatchObject({ eligible: false, suggested: '0.00' });
    });

    it('posts a discount to a chosen expense account, discount-only (zero cash) included', async () => {
      const inv = await newInvoice(custA, 100, '2026-04-02');
      const { payment, entry } = await receivePayment(ctx, {
        customerId: custA,
        date: new Date('2026-04-03'),
        method: 'other',
        amount: '0',
        applications: [{ invoiceId: inv.id, amountApplied: '0', discountAmount: '2.00' }],
        discountAccountId: acct['6200'],
      });
      expect(entry).not.toBeNull();
      expect(payment.discountAccountId).toBe(acct['6200']);
      expect(await balanceOf(acct['6200'])).toBe('2.00');
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('98.00');
      await assertBooks();
      await voidPayment(ctx, payment.id);
      expect(await balanceOf(acct['6200'])).toBe('0.00');
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('100.00');
      await assertBooks();
    });

    it('rejects bad discount accounts and negative discounts without touching the books', async () => {
      const inv = await newInvoice(custA, 50, '2026-04-02');
      const base = { customerId: custA, date: new Date('2026-04-03'), method: 'cash' as const, amount: '49.00' };
      await expect(
        receivePayment(ctx, { ...base, applications: [{ invoiceId: inv.id, amountApplied: '49.00', discountAmount: '1.00' }], discountAccountId: acct['1000'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        receivePayment(ctx, { ...base, applications: [{ invoiceId: inv.id, amountApplied: '49.00', discountAmount: '1.00' }], discountAccountId: acct2['6200'] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        receivePayment(ctx, { ...base, applications: [{ invoiceId: inv.id, amountApplied: '49.00', discountAmount: '-1.00' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('50.00');
      await assertBooks();
    });
  });

  // ================================================================ C4 credits
  describe('C4 credits inside Receive Payments', () => {
    it('refuses misuse of credit memos (other customer, voided, over-split, over-invoice) atomically', async () => {
      const invA = await newInvoice(custA, 100, '2026-04-05');
      const invA2 = await newInvoice(custA, 100, '2026-04-05');
      const memoB = await createCreditMemo(ctx, { customerId: custB, date: new Date('2026-04-05'), lines: [{ description: 'B credit', quantity: 1, rate: 30 }] });
      const memoA = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-04-05'), lines: [{ description: 'A credit', quantity: 1, rate: 30 }] });
      const memoVoid = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-04-05'), lines: [{ description: 'void', quantity: 1, rate: 5 }] });
      await voidCreditMemo(ctx, memoVoid.id);
      const base = { customerId: custA, date: new Date('2026-04-06'), method: 'check' as const };

      await expect(receivePayment(ctx, { ...base, amount: '0', applications: [], credits: [{ creditMemoId: memoB.id, invoiceId: invA.id, amount: '10' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(receivePayment(ctx, { ...base, amount: '0', applications: [], credits: [{ creditMemoId: memoVoid.id, invoiceId: invA.id, amount: '1' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
      // Split one 30.00 memo as 20 + 20 over two invoices.
      await expect(
        receivePayment(ctx, {
          ...base, amount: '0', applications: [],
          credits: [{ creditMemoId: memoA.id, invoiceId: invA.id, amount: '20' }, { creditMemoId: memoA.id, invoiceId: invA2.id, amount: '20' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // Cash 90 + credit 20 on a 100 invoice.
      await expect(
        receivePayment(ctx, { ...base, amount: '90', applications: [{ invoiceId: invA.id, amountApplied: '90' }], credits: [{ creditMemoId: memoA.id, invoiceId: invA.id, amount: '20' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // A credit against another company's invoice.
      const foreign = await newInvoice(cust2, 10, '2026-04-05', ctx2);
      await expect(
        receivePayment(ctx, { ...base, amount: '0', applications: [], credits: [{ creditMemoId: memoA.id, invoiceId: foreign.id, amount: '5' }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect((await getCreditMemo(ctx, memoA.id)).unapplied).toBe('30.00');
      expect((await getInvoice(ctx, invA.id)).balanceDue).toBe('100.00');
      await assertBooks();
      await assertBooks(ctx2, acct2);
    });

    it('a credits-only payment cannot be dated inside the closed period', async () => {
      const inv = await newInvoice(custB, 40, '2026-04-07');
      const memo = await createCreditMemo(ctx, { customerId: custB, date: new Date('2026-04-07'), lines: [{ description: 'c', quantity: 1, rate: 10 }] });
      await setClosingDate('2026-04-30');
      try {
        await expect(
          receivePayment(ctx, {
            customerId: custB, date: new Date('2026-04-20'), method: 'other', amount: '0', applications: [],
            credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '10' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('10.00');
      await assertBooks();
    });

    it('refuses to apply a payment to a draft (unposted) invoice', async () => {
      // Own company so a failure here cannot cascade into the shared books of later tests.
      const [co3] = await db.insert(companies).values({ name: 'Draft Co', ownerId: ctx.userId! }).returning();
      const ctx3: ServiceContext = { db, companyId: co3.id, userId: ctx.userId };
      const acct3: Record<string, string> = {};
      for (const [code, name, type, subtype] of ACCOUNT_DEFS) {
        acct3[code] = (await createAccount(ctx3, { code, name, type: type as never, subtype })).id;
      }
      const [c3] = await db.insert(customers).values({ companyId: co3.id, displayName: 'Draft Cust' }).returning();
      const draft = await createInvoice(ctx3, {
        customerId: c3.id, date: new Date('2026-04-08'), status: 'draft',
        lines: [{ accountId: acct3['4000'], description: 'Pending', quantity: 1, rate: 70, taxable: false }],
      });
      await expect(
        receivePayment(ctx3, {
          customerId: c3.id, date: new Date('2026-04-08'), method: 'cash', amount: '70',
          applications: [{ invoiceId: draft.id, amountApplied: '70' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // Same for a credit memo applied to the draft from inside Receive Payments.
      const memo = await createCreditMemo(ctx3, { customerId: c3.id, date: new Date('2026-04-08'), lines: [{ description: 'c', quantity: 1, rate: 10 }] });
      await expect(
        receivePayment(ctx3, {
          customerId: c3.id, date: new Date('2026-04-08'), method: 'other', amount: '0', applications: [],
          credits: [{ creditMemoId: memo.id, invoiceId: draft.id, amount: '10' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getInvoice(ctx3, draft.id)).status).toBe('draft');
      await assertBooks(ctx3, acct3);
    });
  });

  // ================================================================ C1 payment edits
  describe('C1 edit received payments', () => {
    it('refuses to move a payment INTO the closed period (old date open) and rolls back fully', async () => {
      const inv = await newInvoice(custB, 60, '2026-05-01');
      const { payment, entry } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-05-10'), method: 'cash', amount: '60',
        applications: [{ invoiceId: inv.id, amountApplied: '60' }],
      });
      await setClosingDate('2026-04-30');
      try {
        await expect(
          updatePayment(ctx, payment.id, {
            customerId: custB, date: new Date('2026-04-15'), method: 'cash', amount: '60',
            applications: [{ invoiceId: inv.id, amountApplied: '60' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      expect(await jeStatus(entry!.id)).toBe('posted');
      const p = await getPayment(ctx, payment.id);
      expect(p.date.toISOString().slice(0, 10)).toBe('2026-05-10');
      expect(p.applications).toHaveLength(1);
      expect((await getInvoice(ctx, inv.id)).status).toBe('paid');
      await assertBooks();
    });

    it('refuses to edit a payment onto another customer\'s invoices (rollback)', async () => {
      const invB = await newInvoice(custB, 25, '2026-05-02');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-05-03'), method: 'cash', amount: '25',
        applications: [{ invoiceId: invB.id, amountApplied: '25' }],
      });
      await expect(
        updatePayment(ctx, payment.id, {
          customerId: custA, date: new Date('2026-05-03'), method: 'cash', amount: '25',
          applications: [{ invoiceId: invB.id, amountApplied: '25' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getPayment(ctx, payment.id)).customerId).toBe(custB);
      expect((await getInvoice(ctx, invB.id)).status).toBe('paid');
      await assertBooks();
    });

    it('an edit can drop a credit and add a discount; voided payments cannot be edited', async () => {
      const inv = await newInvoice(custA, 200, '2026-05-04');
      const memo = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-05-04'), lines: [{ description: 'x', quantity: 1, rate: 50 }] });
      const { payment } = await receivePayment(ctx, {
        customerId: custA, date: new Date('2026-05-05'), method: 'check', amount: '150',
        applications: [{ invoiceId: inv.id, amountApplied: '150' }],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '50' }],
      });
      expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('0.00');
      await assertBooks();

      await updatePayment(ctx, payment.id, {
        customerId: custA, date: new Date('2026-05-05'), method: 'check', amount: '196',
        applications: [{ invoiceId: inv.id, amountApplied: '196', discountAmount: '4' }],
      });
      expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('50.00');
      expect((await getInvoice(ctx, inv.id)).status).toBe('paid');
      const p = await getPayment(ctx, payment.id);
      expect(p.credits).toHaveLength(0);
      expect(p.amount).toBe('196.00');
      await assertBooks();

      await voidPayment(ctx, payment.id);
      // idempotent void
      await voidPayment(ctx, payment.id);
      await expect(
        updatePayment(ctx, payment.id, {
          customerId: custA, date: new Date('2026-05-05'), method: 'check', amount: '1',
          applications: [],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooks();
    });

    it('rejects an edit of a payment that belongs to another company', async () => {
      const inv2 = await newInvoice(cust2, 10, '2026-05-06', ctx2);
      const { payment } = await receivePayment(ctx2, {
        customerId: cust2, date: new Date('2026-05-06'), method: 'cash', amount: '10',
        applications: [{ invoiceId: inv2.id, amountApplied: '10' }],
      });
      await expect(
        updatePayment(ctx, payment.id, { customerId: cust2, date: new Date('2026-05-06'), method: 'cash', amount: '10', applications: [] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await assertBooks(ctx2, acct2);
    });
  });

  // ================================================================ F2 bounced checks
  describe('F2 record bounced check', () => {
    it('handles unapplied remainder + discount: A/R back up by cash + discount, discount cancelled', async () => {
      const inv = await newInvoice(custA, 500, '2026-06-01');
      const discBefore = await balanceOf(acct['6200']);
      const bankBefore = await balanceOf(acct['1000']);
      const { payment } = await receivePayment(ctx, {
        customerId: custA, date: new Date('2026-06-05'), method: 'check', reference: 'NSF-QA', amount: '600',
        depositAccountId: acct['1000'],
        discountAccountId: acct['6200'],
        applications: [{ invoiceId: inv.id, amountApplied: '490', discountAmount: '10' }],
      });
      expect((await getPayment(ctx, payment.id)).unapplied).toBe('110.00');
      await assertBooks();
      const arBefore = await balanceOf(acct['1200']);

      const bc = await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-06-10') });
      expect(bc.amount).toBe('600.00');
      expect(await balanceOf(acct['1000'])).toBe(bankBefore);
      expect(await balanceOf(acct['6200'])).toBe(discBefore);
      expect(await balanceOf(acct['1200'])).toBe(Money.of(arBefore).plus(610).toFixed(2));
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('500.00');
      expect((await getPayment(ctx, payment.id)).unapplied).toBe('0.00');
      await assertBooks();
      await expect(
        updatePayment(ctx, payment.id, { customerId: custA, date: new Date('2026-06-05'), method: 'check', amount: '1', applications: [] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('refuses a bounce dated in the closed period and changes nothing', async () => {
      const inv = await newInvoice(custB, 80, '2026-06-01');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-06-02'), method: 'check', amount: '80', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '80' }],
      });
      await setClosingDate('2026-06-30');
      try {
        await expect(
          recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-06-15'), bankFee: '10', customerFee: '20' }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      const p = await getPayment(ctx, payment.id);
      expect(p.bouncedAt).toBeNull();
      expect(p.bounced).toBeNull();
      expect((await getInvoice(ctx, inv.id)).status).toBe('paid');
      await assertBooks();
    });

    it('validates fees and fee accounts', async () => {
      const inv = await newInvoice(custB, 15, '2026-06-01');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-06-02'), method: 'check', amount: '15', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '15' }],
      });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, bankFee: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, bankFee: '5', bankFeeAccountId: acct['4000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, customerFee: '5', customerFeeAccountId: acct['6200'] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, bankFee: '5', bankFeeAccountId: acct2['6200'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await getPayment(ctx, payment.id)).bouncedAt).toBeNull();
      await assertBooks();
    });

    it('once bounced, the deposit that carried the check can no longer be voided (money would be double-counted)', async () => {
      const inv = await newInvoice(custB, 120, '2026-06-01');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-06-03'), method: 'check', amount: '120',
        applications: [{ invoiceId: inv.id, amountApplied: '120' }],
      });
      const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-06-04'), paymentIds: [payment.id] });
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-06-08') });
      const ufBefore = await balanceOf(acct['1050']);
            await expect(voidDeposit(ctx, dep.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await balanceOf(acct['1050'])).toBe(ufBefore);
      await assertBooks();
    });
  });

  // ================================================================ C1 sales receipts
  describe('C1 edit sales receipts', () => {
    it('refuses an edit into the closed period and keeps the old posting', async () => {
      const r = await createSalesReceipt(ctx, { customerId: custB, date: new Date('2026-07-05'), lines: [{ itemId: svcItem, quantity: 1, rate: 10 }] });
      await setClosingDate('2026-06-30');
      try {
        await expect(
          updateSalesReceipt(ctx, r.id, { customerId: custB, date: new Date('2026-06-20'), lines: [{ itemId: svcItem, quantity: 3, rate: 10 }] }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      expect(await jeStatus(r.postedEntryId!)).toBe('posted');
      expect((await getSalesReceipt(ctx, r.id)).total).toBe('10.00');
      await assertBooks();
    });

    it('cannot edit a voided receipt or another company\'s receipt', async () => {
      const r = await createSalesReceipt(ctx, { customerId: custB, date: new Date('2026-07-06'), lines: [{ description: 'v', quantity: 1, rate: 4 }] });
      await voidSalesReceipt(ctx, r.id);
      await expect(
        updateSalesReceipt(ctx, r.id, { customerId: custB, date: new Date('2026-07-06'), lines: [{ description: 'v', quantity: 1, rate: 5 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        updateSalesReceipt(ctx2, r.id, { date: new Date('2026-07-06'), lines: [{ description: 'v', quantity: 1, rate: 5 }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await assertBooks();
    });

    it('records old and new totals in the audit trail', async () => {
      const r = await createSalesReceipt(ctx, { customerId: custB, date: new Date('2026-07-07'), lines: [{ description: 'a', quantity: 1, rate: 7 }] });
      await updateSalesReceipt(ctx, r.id, { customerId: custB, date: new Date('2026-07-07'), lines: [{ description: 'a', quantity: 2, rate: 7 }] });
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, r.id), eq(auditLogs.action, 'update')));
      expect(audits.some((a) => (a.oldValues as { total?: string })?.total === '7.00' && (a.newValues as { total?: string })?.total === '14.00')).toBe(true);
      await assertBooks();
    });
  });

  // ================================================================ C1 credit memos
  describe('C1 edit credit memos', () => {
    it('blocks changing the customer of a used credit; allows it when unused', async () => {
      const inv = await newInvoice(custA, 40, '2026-07-01');
      const used = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-07-01'), lines: [{ description: 'u', quantity: 1, rate: 20 }] });
      await receivePayment(ctx, { customerId: custA, date: new Date('2026-07-02'), method: 'other', amount: '0', applications: [], credits: [{ creditMemoId: used.id, invoiceId: inv.id, amount: '5' }] });
      await expect(
        updateCreditMemo(ctx, used.id, { customerId: custB, date: new Date('2026-07-01'), lines: [{ description: 'u', quantity: 1, rate: 20 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const unused = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-07-01'), lines: [{ description: 'n', quantity: 1, rate: 12 }] });
      const moved = await updateCreditMemo(ctx, unused.id, { customerId: custB, date: new Date('2026-07-01'), lines: [{ description: 'n', quantity: 1, rate: 12 }] });
      expect(moved.customerId).toBe(custB);
      expect(moved.unapplied).toBe('12.00');
      await assertBooks();
    });

    it('refuses an edit into the closed period and edits of voided memos', async () => {
      const m = await createCreditMemo(ctx, { customerId: custB, date: new Date('2026-07-10'), lines: [{ description: 'c', quantity: 1, rate: 9 }] });
      await setClosingDate('2026-06-30');
      try {
        await expect(
          updateCreditMemo(ctx, m.id, { customerId: custB, date: new Date('2026-06-01'), lines: [{ description: 'c', quantity: 1, rate: 9 }] }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      expect((await getCreditMemo(ctx, m.id)).date.toISOString().slice(0, 10)).toBe('2026-07-10');
      await voidCreditMemo(ctx, m.id);
      await expect(
        updateCreditMemo(ctx, m.id, { customerId: custB, date: new Date('2026-07-10'), lines: [{ description: 'c', quantity: 1, rate: 9 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooks();
    });
  });

  // ================================================================ C1 sales orders
  describe('C1 edit sales orders', () => {
    it('refuses removing or re-iteming an invoiced line', async () => {
      const so = await createSalesOrder(ctx, {
        customerId: custB, date: new Date('2026-07-11'),
        lines: [{ itemId: svcItem, description: 'A', quantity: 10, rate: 10 }, { description: 'B', quantity: 2, rate: 5 }],
      });
      const loaded = await getSalesOrder(ctx, so.id);
      const a = loaded.lines.find((l) => l.description === 'A')!;
      const b = loaded.lines.find((l) => l.description === 'B')!;
      await convertSalesOrder(ctx, so.id, { lines: [{ lineId: a.id, quantity: 3 }] });

      await expect(
        updateSalesOrder(ctx, so.id, { customerId: custB, date: new Date('2026-07-11'), lines: [{ id: b.id, description: 'B', quantity: 2, rate: 5 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        updateSalesOrder(ctx, so.id, { customerId: custB, date: new Date('2026-07-11'), lines: [{ id: a.id, itemId: null, description: 'A', quantity: 10, rate: 10 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        updateSalesOrder(ctx, so.id, { customerId: custA, date: new Date('2026-07-11'), lines: [{ id: a.id, itemId: svcItem, description: 'A', quantity: 10, rate: 10 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const after = await getSalesOrder(ctx, so.id);
      expect(after.lines).toHaveLength(2);
      expect(after.lines.find((l) => l.description === 'A')!.quantityInvoiced).toBe('3.0000');

      // Dropping the uninvoiced line and keeping A is fine; still partial.
      const ok = await updateSalesOrder(ctx, so.id, { customerId: custB, date: new Date('2026-07-11'), lines: [{ id: a.id, itemId: svcItem, description: 'A', quantity: 8, rate: 10 }] });
      expect(ok.status).toBe('partial');
      expect(ok.lines).toHaveLength(1);
      await assertBooks();
    });
  });

  // ================================================================ C5 statement charges
  describe('C5 statement charges', () => {
    it('rejects zero/negative charges and closed-period dates', async () => {
      await expect(createStatementCharge(ctx, { customerId: custB, date: new Date('2026-07-01'), rate: '0' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createStatementCharge(ctx, { customerId: custB, date: new Date('2026-07-01'), rate: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createStatementCharge(ctx, { customerId: custB, date: new Date('2026-07-01'), rate: '5', quantity: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createStatementCharge(ctx, { customerId: cust2, date: new Date('2026-07-01'), rate: '5' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await setClosingDate('2026-06-30');
      try {
        await expect(createStatementCharge(ctx, { customerId: custB, date: new Date('2026-06-15'), rate: '5' })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(null);
      }
      await assertBooks();
    });

    it('cannot be edited below what has been paid, and a normal invoice is not a statement charge', async () => {
      const sc = await createStatementCharge(ctx, { customerId: custB, date: new Date('2026-07-01'), description: 'Fee', rate: '45.00' });
      await receivePayment(ctx, { customerId: custB, date: new Date('2026-07-02'), method: 'cash', amount: '30', applications: [{ invoiceId: sc.id, amountApplied: '30' }] });
      await expect(
        updateStatementCharge(ctx, sc.id, { customerId: custB, date: new Date('2026-07-01'), description: 'Fee', rate: '20.00' }),
      ).rejects.toBeTruthy();
      expect((await getInvoice(ctx, sc.id)).total).toBe('45.00');
      const plain = await newInvoice(custB, 5, '2026-07-01');
      await expect(
        updateStatementCharge(ctx, plain.id, { customerId: custB, date: new Date('2026-07-01'), rate: '6' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await assertBooks();
    });
  });

  // ================================================================ C6 batch invoicing
  describe('C6 batch invoicing', () => {
    it('validates input, de-duplicates customers and skips unknown / foreign / inactive ones', async () => {
      await expect(createBatchInvoices(ctx, { customerIds: [], date: new Date('2026-07-15'), lines: [{ itemId: svcItem, quantity: 1, rate: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createBatchInvoices(ctx, { customerIds: [custA], date: new Date('2026-07-15'), lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });

      const [inactive] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'QA Gone', isActive: false }).returning();
      const res = await createBatchInvoices(ctx, {
        customerIds: [custA, custA, custB, cust2, inactive.id, '00000000-0000-0000-0000-000000000000'],
        date: new Date('2026-07-15'),
        lines: [{ itemId: svcItem, quantity: 2, rate: 10 }],
      });
      expect(res.created.map((c) => c.customerId).sort()).toEqual([custA, custB].sort());
      expect(res.created.every((c) => c.total === '20.00')).toBe(true);
      const skippedCodes = Object.fromEntries(res.skipped.map((s) => [s.customerId, s.code]));
      expect(skippedCodes[cust2]).toBe('NOT_FOUND');
      expect(skippedCodes[inactive.id]).toBe('VALIDATION');
      // Nothing was invoiced to the other company's customer in either company.
      const leaked = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, cust2), eq(invoices.companyId, ctx.companyId)));
      expect(leaked).toHaveLength(0);
      await assertBooks();
    });
  });

  // ================================================================ C7 / C8 forms
  describe('C7/C8 forms isolation', () => {
    it('cannot render or flag another company\'s forms; malformed ids are NOT_FOUND', async () => {
      const inv2 = await newInvoice(cust2, 10, '2026-07-01', ctx2);
      await expect(renderSalesForm(ctx, 'invoice', inv2.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(setSendFlags(ctx, 'invoice', inv2.id, { toBePrinted: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(renderSalesForm(ctx, 'credit_memo', 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const inv = await newInvoice(custB, 10, '2026-07-01');
      await expect(setSendFlags(ctx, 'invoice', inv.id, {})).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('voided forms never sit in the print queue', async () => {
      const r = await createSalesReceipt(ctx, { customerId: custB, date: new Date('2026-07-01'), toBePrinted: true, lines: [{ description: 'q', quantity: 1, rate: 3 }] });
      expect((await listSendQueue(ctx, 'print')).some((q) => q.id === r.id)).toBe(true);
      await voidSalesReceipt(ctx, r.id);
      expect((await listSendQueue(ctx, 'print')).some((q) => q.id === r.id)).toBe(false);
      expect((await listSendQueue(ctx2, 'print')).some((q) => q.id === r.id)).toBe(false);
    });

    it('PDFs render for docs with long text and unusual ship-to values', async () => {
      const so = await createSalesOrder(ctx, {
        customerId: custB, date: new Date('2026-07-01'), shipVia: 'Ünïcödé Fréight', poNumber: 'PO-ÆØÅ', fob: 'Dest',
        shipTo: { line1: 'x'.repeat(200), city: 'São Paulo' },
        lines: [{ description: 'Long '.repeat(200), quantity: 1, rate: 1 }],
      });
      const f = await renderSalesForm(ctx, 'sales_order', so.id);
      expect(Buffer.from(f.bytes.slice(0, 5)).toString()).toBe('%PDF-');
    });
  });

  // ================================================================ C9
  describe('C9 Income Tracker / Collections Center', () => {
    it('paid bucket only counts the 30 days up to asOf; voided/bounced payments never count', async () => {
      const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'QA Tracker' }).returning();
      const i1 = await newInvoice(c.id, 10, '2026-08-01');
      const i2 = await newInvoice(c.id, 20, '2026-08-01');
      const later = await receivePayment(ctx, { customerId: c.id, date: new Date('2026-09-20'), method: 'cash', amount: '10', applications: [{ invoiceId: i1.id, amountApplied: '10' }] });
      const voided = await receivePayment(ctx, { customerId: c.id, date: new Date('2026-08-10'), method: 'cash', amount: '20', applications: [{ invoiceId: i2.id, amountApplied: '20' }] });
      await voidPayment(ctx, voided.payment.id);
      const voidInv = await newInvoice(c.id, 5, '2026-08-01');
      const { voidInvoice } = await import('./invoices');
      await voidInvoice(ctx, voidInv.id);

      const t = await incomeTracker(ctx, { asOf: new Date('2026-08-31'), customerId: c.id });
      expect(t.rows.some((r) => r.id === later.payment.id)).toBe(false);
      expect(t.rows.some((r) => r.id === voided.payment.id)).toBe(false);
      expect(t.rows.some((r) => r.id === voidInv.id)).toBe(false);
      expect(t.rows.find((r) => r.id === i2.id)).toMatchObject({ bucket: 'unpaid', openBalance: '20.00' });
      await assertBooks();
    });

    it('collection notes are company/customer scoped', async () => {
      const inv2 = await newInvoice(cust2, 10, '2026-07-01', ctx2);
      const invB = await newInvoice(custB, 10, '2026-07-01');
      await expect(addCollectionNote(ctx, { customerId: cust2, note: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(addCollectionNote(ctx, { customerId: custA, invoiceId: invB.id, note: 'wrong customer' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(addCollectionNote(ctx, { customerId: custB, invoiceId: inv2.id, note: 'foreign invoice' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(addCollectionNote(ctx, { customerId: custB, note: 'y'.repeat(4001) })).rejects.toMatchObject({ code: 'VALIDATION' });
      const n = await addCollectionNote(ctx2, { customerId: cust2, note: 'their note' });
      await expect(setCollectionNoteDone(ctx, n.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
