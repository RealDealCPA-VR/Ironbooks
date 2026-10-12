/**
 * fix/sales — TESTER re-test round 2 (independent adversarial QA).
 *
 * Round 2 added an over-billing check + estimate re-stamp to every invoice path (createInvoice,
 * updateInvoice, postDraftInvoice) and made voidJournalEntry on a `refund:<id>` entry give the
 * customer their credit back. These tests attack those changes: split lines, two drafts racing
 * for the same estimate line, allowOverBilling, voids, edits that add/remove links, closing
 * date, other companies, rejected estimates, and — for refunds — every follow-up action after a
 * voided refund (re-refund, apply, void the memo / payment), with A/R control == customers' GL ==
 * aging == statements and verifyIntegrity clean throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  taxAgencies,
  taxRates,
  invoices,
  journalEntries,
  creditMemos,
  paymentsReceived,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';
import { createInvoice, getInvoice, voidInvoice, updateInvoice, postDraftInvoice } from './invoices';
import { createEstimate, createProgressInvoice, getEstimate, updateEstimateStatus } from './estimates';
import { receivePayment, refundPayment, voidPayment, applyPayment } from './payments';
import { createCreditMemo, applyToInvoice, refundCreditMemo, voidCreditMemo } from './creditMemos';
import { voidEntry, reverseEntry } from './journal';
import { voidJournalEntry } from './posting';
import { customerStatement, customerArLedgerBalance } from './statements';
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { overBillingError } from './estimateBilling';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fix-sales-rt2-' + Date.now());
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

let db: DB;
let userId: string;

interface Co {
  ctx: ServiceContext;
  acct: Record<string, string>;
}

async function newCompany(name: string): Promise<Co> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['4000', 'Sales Income', 'revenue', 'sales'],
  ];
  for (const [code, n, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name: n, type: type as never, subtype });
    acct[code] = row.id;
  }
  const [agency] = await db
    .insert(taxAgencies)
    .values({ companyId: company.id, name: 'State', liabilityAccountId: acct['2200'] })
    .returning();
  await db
    .insert(taxRates)
    .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id, isActive: true });
  return { ctx, acct };
}

async function newCustomer(co: Co, name: string) {
  const [c] = await db
    .insert(customers)
    .values({ companyId: co.ctx.companyId, displayName: name, taxable: true })
    .returning();
  return c.id;
}
async function invoiceCount(co: Co) {
  const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, co.ctx.companyId));
  return rows.length;
}
async function setClosing(co: Co, date: string | null) {
  await db
    .update(companies)
    .set({ settings: (date ? { closingDate: date } : {}) as never })
    .where(eq(companies.id, co.ctx.companyId));
}
async function arControl(co: Co) {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, co.acct['1200']));
  return Money.of(row?.b ?? '0').toFixed(2);
}
async function assertBooks(co: Co) {
  const tb = await trialBalance(co.ctx);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  const integ = await verifyIntegrity(co.ctx);
  const bad = integ.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  expect(bad).toEqual([]);
}
/** statement closing == customer GL balance == aging row total. */
async function assertCustomerTies(co: Co, customerId: string, asOf: Date) {
  const st = await customerStatement(co.ctx, customerId, { to: asOf });
  const gl = await customerArLedgerBalance(co.ctx, customerId, asOf);
  const aging = await arAging(co.ctx, asOf);
  const row = aging.rows.find((r) => r.id === customerId);
  expect(st.closingBalance, 'statement == GL').toBe(gl);
  expect(Money.of(row?.total ?? '0').toFixed(2), 'aging == GL').toBe(gl);
  return gl;
}
/** Company-wide: A/R control == sum of every customer's GL balance == aging total (as of today). */
async function assertCompanyTies(co: Co) {
  const custs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, co.ctx.companyId));
  let gl = Money.zero();
  for (const c of custs) gl = gl.plus(Money.of(await customerArLedgerBalance(co.ctx, c.id)));
  const aging = await arAging(co.ctx, d('2035-01-01'));
  const agingTotal = aging.rows.reduce((s, r) => s.plus(Money.of(r.total)), Money.zero());
  expect(gl.toFixed(2), 'customers GL == A/R control').toBe(await arControl(co));
  expect(agingTotal.toFixed(2), 'aging == A/R control').toBe(await arControl(co));
}
async function refundEntries(co: Co, docId: string) {
  return db
    .select({ id: journalEntries.id, status: journalEntries.status, date: journalEntries.date })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, co.ctx.companyId), eq(journalEntries.sourceRef, `refund:${docId}`)))
    .orderBy(journalEntries.date);
}
async function memoRow(id: string) {
  const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, id));
  return m;
}
async function paymentRow(id: string) {
  const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id));
  return p;
}

describe('fix/sales P0 — re-test round 2', () => {
  let E: Co; // estimates / over-billing
  let F: Co; // refunds
  let G: Co; // other company

  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa@fix-sales-rt2.test', name: 'QA', passwordHash: 'x' })
      .returning();
    userId = user.id;
    E = await newCompany('RT2 Estimates');
    F = await newCompany('RT2 Refunds');
    G = await newCompany('RT2 Other');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function twoLineEstimate(co: Co, name: string) {
    const customerId = await newCustomer(co, name);
    const est = await createEstimate(co.ctx, {
      customerId,
      date: d('2025-04-01'),
      lines: [
        { description: 'Labor', quantity: 10, rate: 50, taxable: false }, // 500
        { description: 'Permit', quantity: 1, rate: 120, taxable: false }, // 120
      ],
    });
    const e = await getEstimate(co.ctx, est.id);
    return {
      customerId,
      estimateId: est.id,
      labor: e.lines.find((l) => l.description === 'Labor')!,
      permit: e.lines.find((l) => l.description === 'Permit')!,
    };
  }
  const laborLine = (estimateLineId: string, quantity: number, rate = 50) => ({
    description: 'Labor',
    quantity,
    rate,
    taxable: false,
    estimateLineId,
  });

  // ===========================================================================
  // Over-billing on every invoice path
  // ===========================================================================
  describe('over-billing on every invoice path', () => {
    it('one estimate line split over two lines of the same plain invoice (60% + 60%) is refused; nothing saved', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Split Sam');
      const before = await invoiceCount(E);
      const arBefore = await arControl(E);
      await expect(
        createInvoice(E.ctx, {
          customerId,
          date: d('2025-04-05'),
          lines: [laborLine(labor.id, 6), laborLine(labor.id, 6)],
        }),
      ).rejects.toThrow(/more than 100%/);
      expect(await invoiceCount(E)).toBe(before);
      expect(await arControl(E)).toBe(arBefore);
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.amountInvoiced).toBe('0.00');
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
    });

    it('over-billing by AMOUNT with the quantity in range (10 x $60 against 10 x $50) is refused', async () => {
      const { customerId, labor } = await twoLineEstimate(E, 'Rate Rob');
      await expect(
        createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 10, 60)] }),
      ).rejects.toThrow(/more than 100%/);
    });

    it('the refusal is a soft PROGRESS_OVERBILL warning the API answers with 409, carrying the line detail', async () => {
      const { customerId, labor } = await twoLineEstimate(E, 'Warn Wendy');
      let err: unknown;
      try {
        await createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 12)] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ServiceError);
      const details = (err as ServiceError).details as { warning: string; lines: Array<{ lineId: string; percentBilled: string }> };
      expect(details.warning).toBe('PROGRESS_OVERBILL');
      expect(details.lines).toHaveLength(1);
      expect(details.lines[0].lineId).toBe(labor.id);
      expect(details.lines[0].percentBilled).toBe('120.00');
      const res = routeErrorWithWarnings(err, 'test');
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('PROGRESS_OVERBILL');
      // Same shape from the helper used everywhere.
      const res2 = routeErrorWithWarnings(overBillingError([]), 'test');
      expect(res2.status).toBe(409);
    });

    it('allowOverBilling saves a 120% plain invoice; the estimate header shows it and closes; books balance', async () => {
      const { customerId, estimateId, labor, permit } = await twoLineEstimate(E, 'Allow Al');
      await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-05'),
        allowOverBilling: true,
        lines: [
          laborLine(labor.id, 12), // 600
          { description: 'Permit', quantity: 1, rate: 120, taxable: false, estimateLineId: permit.id },
        ],
      });
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('600.00');
      expect(e.amountInvoiced).toBe('720.00');
      expect(e.status).toBe('closed');
      await assertBooks(E);
    });

    it('two pending invoices each billing 60%: both save, the first posts, the second is refused at posting and stays pending', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Twin Drafts Tia');
      const d1 = await createInvoice(E.ctx, { customerId, date: d('2025-04-06'), status: 'draft', lines: [laborLine(labor.id, 6)] });
      const d2 = await createInvoice(E.ctx, { customerId, date: d('2025-04-06'), status: 'draft', lines: [laborLine(labor.id, 6)] });
      await postDraftInvoice(E.ctx, d1.id);
      const arBefore = await arControl(E);
      await expect(postDraftInvoice(E.ctx, d2.id)).rejects.toThrow(/more than 100%/);
      expect((await getInvoice(E.ctx, d2.id)).status).toBe('draft');
      expect(await arControl(E)).toBe(arBefore);
      let e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('300.00');
      expect(e.amountInvoiced).toBe('300.00');
      expect(e.status).toBe('partial');
      // QB lets you go ahead after the warning.
      await postDraftInvoice(E.ctx, d2.id, { allowOverBilling: true });
      e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('600.00');
      expect(e.amountInvoiced).toBe('600.00');
      await assertBooks(E);
    });

    it('voiding a plain invoice that billed an estimate re-opens the estimate header and allows billing 100% again without a warning', async () => {
      const { customerId, estimateId, labor, permit } = await twoLineEstimate(E, 'Void Vic');
      const inv = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-07'),
        lines: [
          laborLine(labor.id, 10),
          { description: 'Permit', quantity: 1, rate: 120, taxable: false, estimateLineId: permit.id },
        ],
      });
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('closed');
      await voidInvoice(E.ctx, inv.id);
      let e = await getEstimate(E.ctx, estimateId);
      expect(e.amountInvoiced).toBe('0.00');
      expect(e.status).not.toBe('closed');
      expect(e.status).not.toBe('partial');
      await createInvoice(E.ctx, { customerId, date: d('2025-04-08'), lines: [laborLine(labor.id, 10)] });
      e = await getEstimate(E.ctx, estimateId);
      expect(e.amountInvoiced).toBe('500.00');
      expect(e.status).toBe('partial');
      await assertBooks(E);
    });

    it('editing a plain invoice to ADD an estimate link re-stamps the estimate; removing the link un-stamps it', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Link Later Lou');
      const inv = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-09'),
        lines: [{ description: 'Labor', quantity: 4, rate: 50, taxable: false }],
      });
      await updateInvoice(E.ctx, inv.id, { customerId, date: d('2025-04-09'), lines: [laborLine(labor.id, 4)] });
      let e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('200.00');
      expect(e.amountInvoiced).toBe('200.00');
      expect(e.status).toBe('partial');
      await updateInvoice(E.ctx, inv.id, {
        customerId,
        date: d('2025-04-09'),
        lines: [{ description: 'Labor', quantity: 4, rate: 50, taxable: false, estimateLineId: null }],
      });
      e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      expect(e.amountInvoiced).toBe('0.00');
      expect(e.status).not.toBe('partial');
      await assertBooks(E);
    });

    it('editing a progress invoice DOWN and then back up to exactly 100% never warns (its own old lines are not counted twice)', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Down Up Dora');
      const r = await createProgressInvoice(E.ctx, estimateId, { percent: 100, date: d('2025-04-10') });
      const inv = await getInvoice(E.ctx, r.invoice.id);
      const lines = (laborQty: number) =>
        inv.lines.map((x) => ({
          description: x.description,
          quantity: x.estimateLineId === labor.id ? laborQty : x.quantity,
          rate: x.rate,
          taxable: false,
          estimateLineId: x.estimateLineId,
        }));
      await updateInvoice(E.ctx, r.invoice.id, { customerId, date: d('2025-04-10'), lines: lines(4) });
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('partial');
      await updateInvoice(E.ctx, r.invoice.id, { customerId, date: d('2025-04-10'), lines: lines(10) });
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('500.00');
      expect(e.amountInvoiced).toBe('620.00');
      expect(e.status).toBe('closed');
      await assertBooks(E);
    });

    it('penny rounding: three plain invoices of 1 x $33.33 against 3 x $33.33 close the estimate without a warning', async () => {
      const customerId = await newCustomer(E, 'Penny Pam');
      const est = await createEstimate(E.ctx, {
        customerId,
        date: d('2025-04-01'),
        lines: [{ description: 'Visit', quantity: 3, rate: '33.33', taxable: false }],
      });
      const line = (await getEstimate(E.ctx, est.id)).lines[0];
      for (const day of ['11', '12', '13']) {
        await createInvoice(E.ctx, {
          customerId,
          date: d(`2025-04-${day}`),
          lines: [{ description: 'Visit', quantity: 1, rate: '33.33', taxable: false, estimateLineId: line.id }],
        });
      }
      const e = await getEstimate(E.ctx, est.id);
      expect(e.lines[0].amountInvoiced).toBe('99.99');
      expect(e.amountInvoiced).toBe('99.99');
      expect(e.status).toBe('closed');
      // One more cent is over-billing.
      await expect(
        createInvoice(E.ctx, {
          customerId,
          date: d('2025-04-14'),
          lines: [{ description: 'Visit', quantity: 1, rate: '0.01', taxable: false, estimateLineId: line.id }],
        }),
      ).rejects.toThrow(/more than 100%/);
    });

    it('closing date: a plain invoice that bills an estimate in a closed period is refused and the estimate is untouched', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Closed Cleo');
      await setClosing(E, '2025-04-30');
      try {
        await expect(
          createInvoice(E.ctx, { customerId, date: d('2025-04-15'), lines: [laborLine(labor.id, 5)] }),
        ).rejects.toThrow();
      } finally {
        await setClosing(E, null);
      }
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.amountInvoiced).toBe('0.00');
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
    });

    it('another company cannot bill (or over-bill) this estimate line through a plain invoice', async () => {
      const { estimateId, labor } = await twoLineEstimate(E, 'Tenant Tom');
      const otherCustomer = await newCustomer(G, 'Tenant Tom (other co)');
      const before = await invoiceCount(G);
      await expect(
        createInvoice(G.ctx, { customerId: otherCustomer, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] }),
      ).rejects.toThrow();
      expect(await invoiceCount(G)).toBe(before);
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
    });

    it('a rejected estimate cannot be billed through a plain invoice either (progress invoicing refuses it)', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Rejected Rhea');
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      await expect(createProgressInvoice(E.ctx, estimateId, { percent: 50, date: d('2025-04-05') })).rejects.toThrow();
      let refused = false;
      try {
        await createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] });
      } catch {
        refused = true;
      }
      const e = await getEstimate(E.ctx, estimateId);
      // Either the link is refused, or the estimate at least stays rejected (it must not silently
      // turn into a 'partial' estimate the user had turned down).
      if (!refused) expect(e.status).toBe('rejected');
    });

    it('doer round 3: every invoice path refuses links to a rejected estimate and the status stays rejected', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Rejected Rory');
      // Pending invoice saved while the estimate was still open...
      const draft = await createInvoice(E.ctx, { customerId, date: d('2025-04-05'), status: 'draft', lines: [laborLine(labor.id, 5)] });
      // ...and an unlinked posted invoice for the same customer.
      const plain = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-05'),
        lines: [{ description: 'Extra', quantity: 1, rate: 10, taxable: false }],
      });
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      const arBefore = await arControl(E);

      await expect(
        createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] }),
      ).rejects.toThrow(/rejected/);
      await expect(
        updateInvoice(E.ctx, plain.id, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] }),
      ).rejects.toThrow(/rejected/);
      await expect(postDraftInvoice(E.ctx, draft.id)).rejects.toThrow(/rejected/);
      await expect(postDraftInvoice(E.ctx, draft.id, { allowOverBilling: true })).rejects.toThrow(/rejected/);
      expect((await getInvoice(E.ctx, draft.id)).status).toBe('draft');
      expect(await arControl(E)).toBe(arBefore);

      const e = await getEstimate(E.ctx, estimateId);
      expect(e.status).toBe('rejected');
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      // The rejection can still be undone, after which billing works as usual.
      await updateEstimateStatus(E.ctx, estimateId, 'accepted');
      await postDraftInvoice(E.ctx, draft.id);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('partial');
      await assertBooks(E);
    });
  });

  // ===========================================================================
  // Voided refunds give the credit back — and everything after that still ties
  // ===========================================================================
  describe('voided refunds', () => {
    it('credit memo: two partial refunds, void only the second — memo gets exactly that amount back; ties at every cut', async () => {
      const customerId = await newCustomer(F, 'Two Refunds Tara');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-05-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: '100.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '30.00', date: d('2025-05-05') });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '25.55', date: d('2025-05-10') });
      const [, second] = await refundEntries(F, cm.id);
      await voidEntry(F.ctx, second.id); // through the journal-entry screen's void
      const m = await memoRow(cm.id);
      expect(m.unapplied).toBe('70.00');
      expect(m.refundedAmount).toBe('30.00');
      expect(m.status).toBe('open');
      expect(await assertCustomerTies(F, customerId, d('2025-05-03'))).toBe('-100.00');
      expect(await assertCustomerTies(F, customerId, d('2025-05-07'))).toBe('-70.00');
      expect(await assertCustomerTies(F, customerId, d('2025-05-31'))).toBe('-70.00');
      await assertBooks(F);
      await assertCompanyTies(F);
    });

    it('voiding the same refund twice gives the credit back only once', async () => {
      const customerId = await newCustomer(F, 'Twice Tom');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-05-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: '80.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '80.00', date: d('2025-05-02') });
      expect((await memoRow(cm.id)).status).toBe('paid');
      const [je] = await refundEntries(F, cm.id);
      await voidJournalEntry(F.ctx, je.id);
      await voidJournalEntry(F.ctx, je.id);
      await voidEntry(F.ctx, je.id).catch(() => undefined);
      const m = await memoRow(cm.id);
      expect(m.unapplied).toBe('80.00');
      expect(m.refundedAmount).toBe('0.00');
      expect(await assertCustomerTies(F, customerId, d('2025-05-31'))).toBe('-80.00');
      await assertBooks(F);
    });

    it('after a voided refund the memo can be refunded again, applied to an invoice, and the rest voided out — ties throughout', async () => {
      const customerId = await newCustomer(F, 'Again Ana');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-06-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: '90.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '90.00', date: d('2025-06-02') });
      const [je] = await refundEntries(F, cm.id);
      await voidJournalEntry(F.ctx, je.id);
      // Refund part again, apply the rest.
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '20.00', date: d('2025-06-03') });
      const inv = await createInvoice(F.ctx, {
        customerId,
        date: d('2025-06-04'),
        dueDate: d('2025-07-04'),
        lines: [{ description: 'Svc', quantity: 1, rate: 100, taxable: false }],
      });
      await applyToInvoice(F.ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '70.00' });
      expect((await memoRow(cm.id)).unapplied).toBe('0.00');
      expect((await getInvoice(F.ctx, inv.id)).balanceDue).toBe('30.00');
      // More than what is left can never be refunded.
      await expect(
        refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '0.01', date: d('2025-06-05') }),
      ).rejects.toThrow();
      expect(await assertCustomerTies(F, customerId, d('2025-06-30'))).toBe('30.00');
      await assertBooks(F);
      await assertCompanyTies(F);
    });

    it('a memo whose only refund was voided can then be voided itself; customer back to zero, books clean', async () => {
      const customerId = await newCustomer(F, 'Memo Void Mo');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-06-10'),
        lines: [{ description: 'Credit', quantity: 1, rate: '45.45', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '45.45', date: d('2025-06-11') });
      await expect(voidCreditMemo(F.ctx, cm.id)).rejects.toThrow(/refund/i);
      const [je] = await refundEntries(F, cm.id);
      await voidJournalEntry(F.ctx, je.id);
      await voidCreditMemo(F.ctx, cm.id);
      expect((await memoRow(cm.id)).status).toBe('void');
      expect(await assertCustomerTies(F, customerId, d('2025-06-30'))).toBe('0.00');
      await assertBooks(F);
      await assertCompanyTies(F);
    });

    it('overpayment: void the refund, apply the restored credit to a new invoice, then everything ties', async () => {
      const customerId = await newCustomer(F, 'Overpay Ola');
      const pay = await receivePayment(F.ctx, {
        customerId,
        date: d('2025-07-01'),
        method: 'check',
        reference: 'OP-1',
        amount: '75.00',
        depositAccountId: F.acct['1000'],
        applications: [],
      });
      await refundPayment(F.ctx, { paymentId: pay.payment.id, bankAccountId: F.acct['1000'], amount: '25.00', date: d('2025-07-02') });
      await refundPayment(F.ctx, { paymentId: pay.payment.id, bankAccountId: F.acct['1000'], amount: '10.10', date: d('2025-07-03') });
      const refunds = await refundEntries(F, pay.payment.id);
      expect(refunds).toHaveLength(2);
      await voidJournalEntry(F.ctx, refunds[0].id); // the $25 one
      expect((await paymentRow(pay.payment.id)).unapplied).toBe('64.90');
      expect(await assertCustomerTies(F, customerId, d('2025-07-31'))).toBe('-64.90');
      const inv = await createInvoice(F.ctx, {
        customerId,
        date: d('2025-07-05'),
        dueDate: d('2025-08-05'),
        lines: [{ description: 'Svc', quantity: 1, rate: '64.90', taxable: false }],
      });
      await applyPayment(F.ctx, { paymentId: pay.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '64.90' }] });
      expect((await getInvoice(F.ctx, inv.id)).balanceDue).toBe('0.00');
      expect((await paymentRow(pay.payment.id)).unapplied).toBe('0.00');
      expect(await assertCustomerTies(F, customerId, d('2025-07-31'))).toBe('0.00');
      await assertBooks(F);
      await assertCompanyTies(F);
    });

    it('overpayment: once its refund is voided the payment itself can be voided; customer at zero, books clean', async () => {
      const customerId = await newCustomer(F, 'Pay Void Pia');
      const pay = await receivePayment(F.ctx, {
        customerId,
        date: d('2025-07-10'),
        method: 'check',
        reference: 'PV-1',
        amount: '40.00',
        depositAccountId: F.acct['1000'],
        applications: [],
      });
      await refundPayment(F.ctx, { paymentId: pay.payment.id, bankAccountId: F.acct['1000'], amount: '40.00', date: d('2025-07-11') });
      await expect(voidPayment(F.ctx, pay.payment.id)).rejects.toThrow(/refund/i);
      const [je] = await refundEntries(F, pay.payment.id);
      await voidJournalEntry(F.ctx, je.id);
      await voidPayment(F.ctx, pay.payment.id);
      expect(await assertCustomerTies(F, customerId, d('2025-07-31'))).toBe('0.00');
      await assertBooks(F);
      await assertCompanyTies(F);
    });

    it('closing date: voiding a refund dated in a closed period is refused and the memo keeps its refunded amount', async () => {
      const customerId = await newCustomer(F, 'Closed Refund Cal');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-03-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: '50.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '20.00', date: d('2025-03-02') });
      const [je] = await refundEntries(F, cm.id);
      await setClosing(F, '2025-03-31');
      try {
        await expect(voidJournalEntry(F.ctx, je.id)).rejects.toThrow();
      } finally {
        await setClosing(F, null);
      }
      const m = await memoRow(cm.id);
      expect(m.unapplied).toBe('30.00');
      expect(m.refundedAmount).toBe('20.00');
      expect((await refundEntries(F, cm.id))[0].status).toBe('posted');
      expect(await assertCustomerTies(F, customerId, d('2025-03-31'))).toBe('-30.00');
      await assertBooks(F);
    });

    it('a refund entry cannot be "reversed" around the subledger (Reverse on the journal screen keeps A/R tied)', async () => {
      const customerId = await newCustomer(F, 'Reverse Rae');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-08-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: '60.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '60.00', date: d('2025-08-02') });
      const [je] = await refundEntries(F, cm.id);
      await reverseEntry(F.ctx, je.id, d('2025-08-03')).catch(() => undefined);
      await assertCompanyTies(F);
      await assertBooks(F);
    });

    it('another company cannot void this company\'s refund entry or touch its memo', async () => {
      const customerId = await newCustomer(F, 'Iso Ida');
      const cm = await createCreditMemo(F.ctx, {
        customerId,
        date: d('2025-08-10'),
        lines: [{ description: 'Credit', quantity: 1, rate: '33.00', taxable: false }],
      });
      await refundCreditMemo(F.ctx, { creditMemoId: cm.id, bankAccountId: F.acct['1000'], amount: '33.00', date: d('2025-08-11') });
      const [je] = await refundEntries(F, cm.id);
      await expect(voidJournalEntry(G.ctx, je.id)).rejects.toThrow();
      await expect(voidEntry(G.ctx, je.id)).rejects.toThrow();
      const m = await memoRow(cm.id);
      expect(m.unapplied).toBe('0.00');
      expect(m.refundedAmount).toBe('33.00');
      expect((await refundEntries(F, cm.id))[0].status).toBe('posted');
    });

    it('company-wide at the end: A/R control == customers GL == aging; verifyIntegrity clean in every company', async () => {
      for (const co of [E, F, G]) {
        await assertCompanyTies(co);
        await assertBooks(co);
      }
    });
  });
});
