/**
 * wave2 sales — independent QA, round 2. Adversarial coverage the first QA suite did not reach:
 *   C1 estimate edits (scope, conversion lock, no GL side effects, audit old/new), sales-receipt
 *      deposit-account moves, payment edit idempotency + rollback of over-application.
 *   C2 credit-limit warning on EDIT and on posting a pending invoice.
 *   C3 discount account guards (A/R, other company), discount-only full payoff.
 *   C4 a credit memo used inside Receive Payments cannot be voided / shrunk under the use.
 *   C5 statement charges on open-item statements, A/R aging and Collections Center; customer lock.
 *   C6 batch invoicing in a closed period posts nothing; per-customer subledger stays exact.
 *   C7 email: missing recipient, network policy refusal — flags untouched, nothing audited as sent.
 *   C9 tracker convert idempotency, cross-company isolation, collection-note scoping.
 *   F2 bounce dated before the payment, bounce twice, historical A/R aging before the bounce.
 *   Migration 0027 re-runnable (idempotent) and journaled at idx 27.
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
  auditLogs,
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
import { arAging } from './reportsExtra';
import { createInvoice, getInvoice, postDraftInvoice, updateInvoice } from './invoices';
import { getPayment, receivePayment, recordBouncedCheck, updatePayment, voidPayment } from './payments';
import { createCreditMemo, updateCreditMemo, voidCreditMemo } from './creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createEstimate, convertToInvoice as convertEstimate, getEstimate, updateEstimate } from './estimates';
import { createBatchInvoices, createStatementCharge, updateStatementCharge } from './batchInvoicing';
import { openItemStatement } from './statements';
import { emailCustomerStatement, emailSalesForm, setSendFlags } from './salesForms';
import { addCollectionNote, collectionsCenter, incomeTracker, runTrackerAction, setCollectionNoteDone } from './incomeTracker';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-wave2-qa2');
let ctx: ServiceContext;
let ctx2: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
const acct2: Record<string, string> = {};
let custA: string;
let custB: string;
let custNoEmail: string;
let custLimited: string;
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
  ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
  ['6200', 'Discounts Expense', 'expense', 'operating_expenses'],
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

async function newInvoice(customerId: string, amount: number | string, date = '2026-03-01', extra: Record<string, unknown> = {}) {
  return createInvoice(ctx, {
    customerId,
    date: new Date(date),
    dueDate: new Date(new Date(date).getTime() + 30 * 86_400_000),
    lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    ...extra,
  });
}

async function jeCount(c: ServiceContext = ctx) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, c.companyId));
  return Number(row.n);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('wave2 sales — QA round 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'sales-qa2@test.local', name: 'QA2', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'QA2 Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'QA2 Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    for (const [code, name, type, subtype] of ACCOUNT_DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      acct2[code] = (await createAccount(ctx2, { code, name, type: type as never, subtype })).id;
    }
    custA = (await db.insert(customers).values({ companyId: company.id, displayName: 'QA2 Acme', terms: '2_10_net_30', email: 'a@acme.test' }).returning())[0].id;
    custB = (await db.insert(customers).values({ companyId: company.id, displayName: 'QA2 Bolt', email: 'b@bolt.test' }).returning())[0].id;
    custNoEmail = (await db.insert(customers).values({ companyId: company.id, displayName: 'QA2 No Email' }).returning())[0].id;
    custLimited = (
      await db.insert(customers).values({ companyId: company.id, displayName: 'QA2 Limited', creditLimit: '100.00' }).returning()
    )[0].id;
    cust2 = (await db.insert(customers).values({ companyId: company2.id, displayName: 'QA2 Foreign' }).returning())[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ================================================================ migration
  describe('migration 0027', () => {
    it('is journaled once at idx 27 and can be re-applied without error (idempotent)', async () => {
      const journal = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      const mine = journal.entries.filter((e) => e.tag === '0027_wave2_sales');
      expect(mine).toHaveLength(1);
      expect(mine[0].idx).toBe(27);
      expect(journal.entries.filter((e) => e.idx === 27)).toHaveLength(1);

      const sqlText = fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0027_wave2_sales.sql'), 'utf8');
      const statements = sqlText.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(10);
      for (const stmt of statements) {
        await db.execute(sql.raw(stmt));
      }
      await assertBooks();
    });
  });

  // ================================================================ C1 estimates
  describe('C1 edit estimates', () => {
    it('edits lines with no GL side effects, records old/new, and locks after conversion', async () => {
      const est = await createEstimate(ctx, {
        customerId: custA,
        date: new Date('2026-03-02'),
        lines: [{ description: 'Quote', quantity: 2, rate: 50 }],
      });
      const jeBefore = await jeCount();
      const arBefore = await balanceOf(acct['1200']);
      const upd = await updateEstimate(ctx, est.id, {
        customerId: custA,
        date: new Date('2026-03-03'),
        lines: [{ description: 'Quote v2', quantity: 3, rate: '33.335' }],
      });
      // 3 x 33.335 → whole cents only, and the header equals the sum of its (rounded) lines.
      expect(upd.total).toMatch(/^\d+\.\d{2}$/);
      expect(['100.00', '100.01', '100.02']).toContain(upd.total);
      const lineSum = upd.lines.reduce((acc: ReturnType<typeof Money.zero>, l: { amount: string }) => acc.plus(Money.of(l.amount)), Money.zero());
      expect(Money.round2(lineSum).toFixed(2)).toBe(upd.total);
      expect(await jeCount()).toBe(jeBefore);
      expect(await balanceOf(acct['1200'])).toBe(arBefore);

      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, est.id), eq(auditLogs.action, 'update')));
      const a = audits.find((x) => (x.oldValues as { total?: string } | null)?.total === '100.00');
      expect(a).toBeTruthy();
      expect((a!.newValues as { total?: string }).total).toBe(upd.total);

      // Another company cannot edit it; a foreign customer cannot be put on it.
      await expect(
        updateEstimate(ctx2, est.id, { customerId: cust2, date: new Date('2026-03-03'), lines: [{ description: 'x', quantity: 1, rate: 1 }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const foreign = await caught(
        updateEstimate(ctx, est.id, { customerId: cust2, date: new Date('2026-03-03'), lines: [{ description: 'x', quantity: 1, rate: 1 }] }),
      );
      expect(foreign).toMatchObject({ code: expect.stringMatching(/NOT_FOUND|VALIDATION/) });
      expect((await getEstimate(ctx, est.id)).customerId).toBe(custA);

      // Empty / negative input never saves.
      await expect(updateEstimate(ctx, est.id, { customerId: custA, date: new Date('2026-03-03'), lines: [] })).rejects.toBeTruthy();
      expect((await getEstimate(ctx, est.id)).total).toBe(upd.total);

      const inv = await convertEstimate(ctx, est.id);
      await assertBooks();
      await expect(
        updateEstimate(ctx, est.id, { customerId: custA, date: new Date('2026-03-03'), lines: [{ description: 'late', quantity: 1, rate: 1 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // The invoice must bill exactly what was quoted (sub-cent rates must not drift on conversion).
      expect((await getInvoice(ctx, inv.id)).total).toBe(upd.total);
    });
  });

  // ================================================================ C2 credit limit on edit / post
  describe('C2 credit-limit warning on edits and pending invoices', () => {
    it('editing an invoice above the limit warns and changes nothing; override saves and is audited', async () => {
      const inv = await newInvoice(custLimited, 60, '2026-03-05');
      const err = await caught(
        updateInvoice(ctx, inv.id, {
          customerId: custLimited,
          date: new Date('2026-03-05'),
          lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: 160, taxable: false }],
        }),
      );
      expect(err).toMatchObject({ code: 'VALIDATION', details: { warning: 'CREDIT_LIMIT', overBy: '60.00' } });
      expect((await getInvoice(ctx, inv.id)).total).toBe('60.00');
      await assertBooks();

      const ok = await updateInvoice(ctx, inv.id, {
        customerId: custLimited,
        date: new Date('2026-03-05'),
        overrideCreditLimit: true,
        lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: 160, taxable: false }],
      });
      expect(ok.total).toBe('160.00');
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, inv.id));
      expect(
        audits.some((a) => (a.newValues as { creditLimitOverride?: { warning?: string } } | null)?.creditLimitOverride?.warning === 'CREDIT_LIMIT'),
      ).toBe(true);
      await assertBooks();
      // Clean up so later tests start from zero exposure.
      await updateInvoice(ctx, inv.id, {
        customerId: custLimited,
        date: new Date('2026-03-05'),
        lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: 1, taxable: false }],
      });
    });

    it('posting a pending invoice that breaks the limit warns; the draft stays a draft until overridden', async () => {
      const draft = await createInvoice(ctx, {
        customerId: custLimited,
        date: new Date('2026-03-06'),
        status: 'draft',
        // Saving the pending invoice may itself warn; acknowledge it so we can test posting.
        overrideCreditLimit: true,
        lines: [{ accountId: acct['4000'], description: 'Pending', quantity: 1, rate: 250, taxable: false }],
      } as never);
      expect(draft.status).toBe('draft');
      const arBefore = await balanceOf(acct['1200']);
      const err = await caught(postDraftInvoice(ctx, draft.id));
      expect(err).toMatchObject({ code: 'VALIDATION', details: { warning: 'CREDIT_LIMIT' } });
      expect((await getInvoice(ctx, draft.id)).status).toBe('draft');
      expect(await balanceOf(acct['1200'])).toBe(arBefore);

      await postDraftInvoice(ctx, draft.id, { overrideCreditLimit: true });
      expect((await getInvoice(ctx, draft.id)).status).not.toBe('draft');
      expect(await balanceOf(acct['1200'])).toBe(Money.of(arBefore).plus(250).toFixed(2));
      await assertBooks();
    });
  });

  // ================================================================ C3 discount guards
  describe('C3 discount account guards', () => {
    it('refuses A/R or another company\'s account as the discount account; discount-only payoff closes the invoice', async () => {
      const inv = await newInvoice(custA, 10, '2026-04-01');
      const base = { customerId: custA, date: new Date('2026-04-02'), method: 'check' as const, amount: '0' };
      await expect(
        receivePayment(ctx, { ...base, discountAccountId: acct['1200'], applications: [{ invoiceId: inv.id, amountApplied: 0, discountAmount: '10' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        receivePayment(ctx, { ...base, discountAccountId: acct2['6200'], applications: [{ invoiceId: inv.id, amountApplied: 0, discountAmount: '10' }] }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|VALIDATION/) });
      // Over-discounting (discount > balance) is refused.
      await expect(
        receivePayment(ctx, { ...base, discountAccountId: acct['6200'], applications: [{ invoiceId: inv.id, amountApplied: 0, discountAmount: '10.01' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('10.00');
      await assertBooks();

      const discBefore = await balanceOf(acct['6200']);
      const { payment } = await receivePayment(ctx, {
        ...base,
        discountAccountId: acct['6200'],
        applications: [{ invoiceId: inv.id, amountApplied: 0, discountAmount: '10' }],
      });
      const after = await getInvoice(ctx, inv.id);
      expect(after.balanceDue).toBe('0.00');
      expect(after.status).toBe('paid');
      expect(await balanceOf(acct['6200'])).toBe(Money.of(discBefore).plus(10).toFixed(2));
      await assertBooks();
      // A discount-only "payment" never reached a bank, so it cannot bounce.
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-04-05') })).rejects.toBeTruthy();
      await voidPayment(ctx, payment.id);
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('10.00');
      expect(await balanceOf(acct['6200'])).toBe(discBefore);
      await assertBooks();
    });
  });

  // ================================================================ C1 payment edits
  describe('C1 payment edits', () => {
    it('re-saving an unchanged payment is idempotent; an over-application edit rolls back completely', async () => {
      const inv1 = await newInvoice(custB, 100, '2026-04-10');
      const inv2 = await newInvoice(custB, 40, '2026-04-10');
      const input = {
        customerId: custB,
        date: new Date('2026-04-12'),
        method: 'check' as const,
        amount: '120',
        depositAccountId: acct['1000'],
        applications: [
          { invoiceId: inv1.id, amountApplied: '100' },
          { invoiceId: inv2.id, amountApplied: '20' },
        ],
      };
      const { payment } = await receivePayment(ctx, input);
      const bank = await balanceOf(acct['1000']);
      const ar = await balanceOf(acct['1200']);
      for (let i = 0; i < 2; i++) {
        await updatePayment(ctx, payment.id, input);
        expect(await balanceOf(acct['1000'])).toBe(bank);
        expect(await balanceOf(acct['1200'])).toBe(ar);
        expect((await getInvoice(ctx, inv1.id)).balanceDue).toBe('0.00');
        expect((await getInvoice(ctx, inv2.id)).balanceDue).toBe('20.00');
        await assertBooks();
      }
      const p = await getPayment(ctx, payment.id);
      expect(p.applications).toHaveLength(2);
      // Only the latest version's entry stays posted.
      const [je] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, p.postedEntryId!));
      expect(je.status).toBe('posted');

      // Edit tries to put 50 on inv2 (balance only 40 once the old version is undone) → refused.
      const err = await caught(
        updatePayment(ctx, payment.id, {
          ...input,
          amount: '150',
          applications: [
            { invoiceId: inv1.id, amountApplied: '100' },
            { invoiceId: inv2.id, amountApplied: '50' },
          ],
        }),
      );
      expect(err).toMatchObject({ code: 'VALIDATION' });
      const again = await getPayment(ctx, payment.id);
      expect(again.amount).toBe('120.00');
      expect(again.postedEntryId).toBe(p.postedEntryId);
      expect(again.applications).toHaveLength(2);
      expect((await getInvoice(ctx, inv2.id)).balanceDue).toBe('20.00');
      expect(await balanceOf(acct['1000'])).toBe(bank);
      await assertBooks();
    });

    it('malformed amounts are refused without side effects', async () => {
      const inv = await newInvoice(custB, 30, '2026-04-10');
      const jeBefore = await jeCount();
      for (const amount of ['-1', 'abc', 'NaN', 'Infinity']) {
        await expect(
          receivePayment(ctx, {
            customerId: custB, date: new Date('2026-04-12'), method: 'cash', amount,
            applications: [{ invoiceId: inv.id, amountApplied: '1' }],
          }),
        ).rejects.toBeTruthy();
      }
      expect(await jeCount()).toBe(jeBefore);
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('30.00');
      await assertBooks();
    });
  });

  // ================================================================ C4 credits used in payments
  describe('C4 credit memo used inside Receive Payments', () => {
    it('cannot be voided or shrunk below the used part while the payment stands', async () => {
      const inv = await newInvoice(custA, 80, '2026-04-15');
      const memo = await createCreditMemo(ctx, {
        customerId: custA,
        date: new Date('2026-04-15'),
        lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 30 }],
      } as never);
      const { payment } = await receivePayment(ctx, {
        customerId: custA, date: new Date('2026-04-16'), method: 'check', amount: '50',
        applications: [{ invoiceId: inv.id, amountApplied: '50' }],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '30' }],
      });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      await assertBooks();

      await expect(voidCreditMemo(ctx, memo.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        updateCreditMemo(ctx, memo.id, {
          customerId: custA, date: new Date('2026-04-15'),
          lines: [{ accountId: acct['4000'], description: 'Return', quantity: 1, rate: 20 }],
        } as never),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooks();

      // Voiding the payment releases the credit; then the memo can be voided cleanly.
      await voidPayment(ctx, payment.id);
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('80.00');
      await voidCreditMemo(ctx, memo.id);
      await assertBooks();
    });
  });

  // ================================================================ C5 statement charges
  describe('C5 statement charges', () => {
    it('show on open-item statements, aging and Collections Center; customer cannot move once paid', async () => {
      const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'QA2 Register', terms: 'net_15' }).returning())[0].id;
      const charge = await createStatementCharge(ctx, {
        customerId: cust, date: new Date('2026-01-10'), accountId: acct['4000'], description: 'Monthly service', rate: '45.50',
      });
      expect(charge.isStatementCharge).toBe(true);
      expect(charge.dueDate?.toISOString().slice(0, 10)).toBe('2026-01-25');
      await assertBooks();

      const st = await openItemStatement(ctx, cust, new Date('2026-03-01'));
      expect(st.totalDue).toBe('45.50');
      expect(Object.values(st.aging).map(String).some((v) => v === '45.50')).toBe(true);

      const aging = await arAging(ctx, new Date('2026-03-01'));
      const json = JSON.stringify(aging);
      expect(json).toContain('QA2 Register');

      const cc = await collectionsCenter(ctx, { asOf: new Date('2026-03-01') });
      const row = cc.overdue.find((c) => c.customerId === cust);
      expect(row?.invoices[0]).toMatchObject({ id: charge.id, isStatementCharge: true, balanceDue: '45.50' });

      await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-03-02'), method: 'cash', amount: '20',
        applications: [{ invoiceId: charge.id, amountApplied: '20' }],
      });
      await expect(
        updateStatementCharge(ctx, charge.id, { customerId: custB, date: new Date('2026-01-10'), accountId: acct['4000'], rate: '45.50' }),
      ).rejects.toBeTruthy();
      const after = await getInvoice(ctx, charge.id);
      expect(after.customerId).toBe(cust);
      expect(after.balanceDue).toBe('25.50');
      await assertBooks();

      // A statement charge cannot be created for another company's customer.
      await expect(
        createStatementCharge(ctx, { customerId: cust2, date: new Date('2026-01-10'), accountId: acct['4000'], rate: 5 }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ================================================================ C6 batch invoicing
  describe('C6 batch invoicing', () => {
    it('in a closed period every customer is skipped and nothing posts', async () => {
      const jeBefore = await jeCount();
      await setClosingDate('2026-02-28');
      let res;
      try {
        res = await createBatchInvoices(ctx, {
          customerIds: [custA, custB],
          date: new Date('2026-02-15'),
          lines: [{ accountId: acct['4000'], description: 'Dues', quantity: 1, rate: 25, taxable: false }],
        });
      } catch (e) {
        res = { created: [], skipped: [], error: e };
      } finally {
        await setClosingDate(null);
      }
      expect(res.created).toHaveLength(0);
      expect(await jeCount()).toBe(jeBefore);
      await assertBooks();
    });

    it('rounds per invoice and keeps every customer\'s subledger equal to the GL', async () => {
      const arBefore = await balanceOf(acct['1200']);
      const res = await createBatchInvoices(ctx, {
        customerIds: [custA, custB, custNoEmail, custA],
        date: new Date('2026-04-20'),
        lines: [{ accountId: acct['4000'], description: 'Dues', quantity: 3, rate: '3.333', taxable: false }],
      });
      expect(res.created).toHaveLength(3);
      for (const c of res.created) expect(c.total).toBe('10.00');
      expect(await balanceOf(acct['1200'])).toBe(Money.of(arBefore).plus(30).toFixed(2));
      await assertBooks();
      await expect(
        createBatchInvoices(ctx, { customerIds: [custA], date: new Date('2026-04-20'), lines: [] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // ================================================================ C7 email
  describe('C7 email guards', () => {
    const SMTP = { SMTP_HOST: '8.8.8.8', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'books@qa.test' };
    async function withSmtp<T>(fn: () => Promise<T>): Promise<T> {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(SMTP)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      try {
        return await fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it('no recipient → plain VALIDATION; public SMTP without opt-in → FORBIDDEN; flags stay set', async () => {
      const inv = await newInvoice(custNoEmail, 12, '2026-04-21', { toBeEmailed: true });
      await withSmtp(async () => {
        await expect(emailSalesForm(ctx, 'invoice', inv.id)).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(emailSalesForm(ctx, 'invoice', inv.id, 'someone@example.com')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(emailCustomerStatement(ctx, custB)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        // Another company's form cannot be emailed.
        await expect(emailSalesForm(ctx2, 'invoice', inv.id, 'x@example.com')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });
      const after = await getInvoice(ctx, inv.id);
      expect(after.toBeEmailed).toBe(true);
      expect(after.lastEmailedAt ?? null).toBeNull();
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, inv.id));
      expect(audits.some((a) => (a.newValues as { action?: string } | null)?.action === 'emailed')).toBe(false);
    });

    it('flags reject unknown form ids and empty changes', async () => {
      await expect(setSendFlags(ctx, 'sales_order', '00000000-0000-0000-0000-000000000000', { toBePrinted: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const inv = await newInvoice(custB, 5, '2026-04-21');
      await expect(setSendFlags(ctx, 'invoice', inv.id, {})).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // ================================================================ C1 sales receipts
  describe('C1 sales receipt deposit-account move', () => {
    it('moving an undeposited receipt to the bank moves the money, not duplicates it', async () => {
      const r = await createSalesReceipt(ctx, {
        customerId: custB, date: new Date('2026-04-22'),
        lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: 75 }],
      } as never);
      const uf = await balanceOf(acct['1050']);
      const bank = await balanceOf(acct['1010']);
      const income = await balanceOf(acct['4000']);
      await updateSalesReceipt(ctx, r.id, {
        customerId: custB, date: new Date('2026-04-22'), depositAccountId: acct['1010'],
        lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: 75 }],
      } as never);
      expect(await balanceOf(acct['1050'])).toBe(Money.of(uf).minus(75).toFixed(2));
      expect(await balanceOf(acct['1010'])).toBe(Money.of(bank).plus(75).toFixed(2));
      expect(await balanceOf(acct['4000'])).toBe(income);
      expect((await getSalesReceipt(ctx, r.id)).depositAccountId).toBe(acct['1010']);
      await assertBooks();
      // Depositing a sales receipt "into" Accounts Receivable (or Inventory Asset) would debit the
      // A/R control account with no open invoice behind it — control != subledger. Must be refused
      // (Receive Payments already refuses these accounts).
      for (const bad of [acct['1200'], acct['1300']]) {
        const res = await caught(
          updateSalesReceipt(ctx, r.id, {
            customerId: custB, date: new Date('2026-04-22'), depositAccountId: bad,
            lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: 75 }],
          } as never),
        );
        if (!res) {
          // Restore so the rest of the suite is not polluted, then fail.
          await updateSalesReceipt(ctx, r.id, {
            customerId: custB, date: new Date('2026-04-22'), depositAccountId: acct['1010'],
            lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: 75 }],
          } as never);
        }
        expect(res).toMatchObject({ code: 'VALIDATION' });
      }
      const created = await caught(
        createSalesReceipt(ctx, {
          customerId: custB, date: new Date('2026-04-22'), depositAccountId: acct['1200'],
          lines: [{ accountId: acct['4000'], description: 'Counter sale', quantity: 1, rate: 5 }],
        } as never),
      );
      if (!created) {
        // Undo pollution: void the receipt that was wrongly accepted.
        const { salesReceipts } = await import('@/lib/db/schema');
        const { voidSalesReceipt } = await import('./salesReceipts');
        const rows = await db.select({ id: salesReceipts.id }).from(salesReceipts)
          .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(salesReceipts.depositAccountId, acct['1200'])));
        for (const row of rows) await voidSalesReceipt(ctx, row.id);
      }
      expect(created).toMatchObject({ code: 'VALIDATION' });
      expect((await getSalesReceipt(ctx, r.id)).depositAccountId).toBe(acct['1010']);
      await assertBooks();
    });
  });

  // ================================================================ C9
  describe('C9 tracker + collections', () => {
    it('converting the same estimate twice in one batch makes exactly one invoice', async () => {
      const est = await createEstimate(ctx, { customerId: custB, date: new Date('2026-04-23'), lines: [{ description: 'Q', quantity: 1, rate: 17 }] });
      const before = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, custB));
      const res = await runTrackerAction(ctx, 'convert', [
        { type: 'estimate', id: est.id },
        { type: 'estimate', id: est.id },
      ]);
      expect(res.done).toHaveLength(1);
      expect(res.failed).toHaveLength(1);
      const after = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, custB));
      expect(after.length).toBe(before.length + 1);
      await assertBooks();

      // Another company cannot convert / queue it.
      const other = await runTrackerAction(ctx2, 'convert', [{ type: 'estimate', id: est.id }]);
      expect(other.done).toHaveLength(0);
      const q = await runTrackerAction(ctx2, 'queue_print', [{ type: 'invoice', id: after[0].id }]);
      expect(q.done).toHaveLength(0);
      await expect(runTrackerAction(ctx, 'convert', [])).rejects.toMatchObject({ code: 'VALIDATION' });

      const t2 = await incomeTracker(ctx2, { asOf: new Date('2026-12-31') });
      expect(t2.rows).toHaveLength(0);
    });

    it('notes: invoice must belong to the customer; other company cannot mark done; overlong note refused', async () => {
      const invA = await newInvoice(custA, 9, '2026-01-01');
      await expect(addCollectionNote(ctx, { customerId: custB, invoiceId: invA.id, note: 'wrong customer' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(addCollectionNote(ctx, { customerId: custA, note: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'VALIDATION' });
      const n = await addCollectionNote(ctx, { customerId: custA, invoiceId: invA.id, note: 'Left voicemail', followUpDate: new Date('2026-05-01') });
      await expect(setCollectionNoteDone(ctx2, n.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const cc = await collectionsCenter(ctx, { asOf: new Date('2026-04-30') });
      expect(cc.overdue.find((c) => c.customerId === custA)?.nextFollowUp).toBe('2026-05-01');
      await setCollectionNoteDone(ctx, n.id, true);
      const cc2 = await collectionsCenter(ctx, { asOf: new Date('2026-04-30') });
      expect(cc2.overdue.find((c) => c.customerId === custA)?.nextFollowUp ?? null).not.toBe('2026-05-01');
      // Out-of-range almostDueDays is clamped, not an error.
      const cc3 = await collectionsCenter(ctx, { asOf: new Date('2026-04-30'), almostDueDays: 10_000 });
      expect(cc3.almostDueDays).toBe(90);
    });
  });

  // ================================================================ F2
  describe('F2 bounced checks', () => {
    it('cannot bounce twice; double bounce never double-charges the bank', async () => {
      const inv = await newInvoice(custB, 65, '2026-05-01');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-05-02'), method: 'check', amount: '65', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '65' }],
      });
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-06'), bankFee: '12', customerFee: '25' });
      const bank = await balanceOf(acct['1000']);
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-07'), bankFee: '12' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await balanceOf(acct['1000'])).toBe(bank);
      await expect(voidPayment(ctx, payment.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('65.00');
      await assertBooks();
    });

    it('refuses a bounce dated before the payment was received', async () => {
      const inv = await newInvoice(custB, 44, '2026-05-01');
      const { payment } = await receivePayment(ctx, {
        customerId: custB, date: new Date('2026-05-10'), method: 'check', amount: '44', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '44' }],
      });
      await expect(recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-03') })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getPayment(ctx, payment.id)).bouncedAt).toBeNull();
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      await assertBooks();
    });

    it('A/R aging as of a date between the payment and the bounce still shows the invoice as paid', async () => {
      const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'QA2 Bouncer' }).returning())[0].id;
      const inv = await newInvoice(cust, 210, '2026-05-01');
      const { payment } = await receivePayment(ctx, {
        customerId: cust, date: new Date('2026-05-05'), method: 'check', amount: '210', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '210' }],
      });
      const agingRowTotal = async (asOf: string) => {
        const rep = await arAging(ctx, new Date(asOf));
        const rows = rep.rows;
        const r = rows.find((x) => x.id === cust);
        return r ? Money.round2(r.total).toFixed(2) : '0.00';
      };
      expect(await agingRowTotal('2026-05-07')).toBe('0.00');
      await recordBouncedCheck(ctx, { paymentId: payment.id, date: new Date('2026-05-12') });
      expect(await agingRowTotal('2026-05-20')).toBe('210.00');
      // Before the bounce the customer had paid — historical aging must not change retroactively.
      expect(await agingRowTotal('2026-05-07')).toBe('0.00');
      await assertBooks();
    });
  });
});
