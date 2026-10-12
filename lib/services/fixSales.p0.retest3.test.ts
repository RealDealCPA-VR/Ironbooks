/**
 * fix/sales — TESTER re-test round 3 (independent adversarial QA).
 *
 * Round 3: no invoice path may bill a REJECTED estimate (createInvoice, updateInvoice,
 * postDraftInvoice — progress invoicing and conversion already refused), and the estimate keeps
 * its 'rejected' status; voiding a foreign-currency overpayment refund restores exactly the
 * refunded amount (read from the refund's own record, not base / rate).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  taxAgencies,
  taxRates,
  invoices,
  estimates,
  journalEntries,
  paymentsReceived,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';
import { createInvoice, getInvoice, voidInvoice, updateInvoice, postDraftInvoice } from './invoices';
import {
  createEstimate,
  createProgressInvoice,
  convertToInvoice,
  getEstimate,
  updateEstimateStatus,
} from './estimates';
import { receivePayment, refundPayment } from './payments';
import { voidJournalEntry } from './posting';
import { verifyIntegrity } from './integrity';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fix-sales-rt3-' + Date.now());
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
async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('fix/sales P0 — re-test round 3', () => {
  let E: Co;
  let F: Co;
  let G: Co;

  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa@fix-sales-rt3.test', name: 'QA', passwordHash: 'x' })
      .returning();
    userId = user.id;
    E = await newCompany('RT3 Estimates');
    F = await newCompany('RT3 FX refunds');
    G = await newCompany('RT3 Other');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function twoLineEstimate(co: Co, name: string, customerId?: string) {
    const cid = customerId ?? (await newCustomer(co, name));
    const est = await createEstimate(co.ctx, {
      customerId: cid,
      date: d('2025-04-01'),
      lines: [
        { description: 'Labor', quantity: 10, rate: 50, taxable: false },
        { description: 'Permit', quantity: 1, rate: 120, taxable: false },
      ],
    });
    const e = await getEstimate(co.ctx, est.id);
    return {
      customerId: cid,
      estimateId: est.id,
      estimateNumber: e.estimateNumber,
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
  const permitLine = (estimateLineId: string) => ({
    description: 'Permit',
    quantity: 1,
    rate: 120,
    taxable: false,
    estimateLineId,
  });

  // ===========================================================================
  // Rejected estimates
  // ===========================================================================
  describe('rejected estimates', () => {
    it("auditor's repro: the plain invoice is refused, nothing posts, the estimate stays rejected", async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Repro Rita');
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      const n = await invoiceCount(E);
      const ar = await arControl(E);
      const err = await catchErr(
        createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] }),
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('CONFLICT');
      expect((err as Error).message).toMatch(/rejected/);
      // A hard stop, not a soft over-billing warning the user can click through.
      expect(((err as ServiceError).details as { warning?: string } | undefined)?.warning).toBeUndefined();
      expect(routeErrorWithWarnings(err, 'test').status).not.toBe(200);
      expect(await invoiceCount(E)).toBe(n);
      expect(await arControl(E)).toBe(ar);
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.status).toBe('rejected');
      expect(Money.of(e.amountInvoiced ?? '0').toFixed(2)).toBe('0.00');
      await assertBooks(E);
    });

    it('allowOverBilling does not get around the rejection on createInvoice / updateInvoice', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Override Otto');
      const plain = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-05'),
        lines: [{ description: 'Other', quantity: 1, rate: 10, taxable: false }],
      });
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      await expect(
        createInvoice(E.ctx, {
          customerId,
          date: d('2025-04-05'),
          allowOverBilling: true,
          lines: [laborLine(labor.id, 5)],
        } as never),
      ).rejects.toThrow(/rejected/);
      await expect(
        updateInvoice(E.ctx, plain.id, {
          customerId,
          date: d('2025-04-05'),
          allowOverBilling: true,
          lines: [laborLine(labor.id, 5)],
        } as never),
      ).rejects.toThrow(/rejected/);
      // The edit rolled back: the invoice still has its own line and total.
      const inv = await getInvoice(E.ctx, plain.id);
      expect(inv.lines).toHaveLength(1);
      expect(inv.lines[0].estimateLineId ?? null).toBeNull();
      expect(Money.of(inv.total).toFixed(2)).toBe('10.00');
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('rejected');
      await assertBooks(E);
    });

    it('one invoice billing an accepted estimate AND a rejected one is refused whole; the accepted one is untouched', async () => {
      const customerId = await newCustomer(E, 'Mixed Max');
      const good = await twoLineEstimate(E, '', customerId);
      const bad = await twoLineEstimate(E, '', customerId);
      await updateEstimateStatus(E.ctx, good.estimateId, 'accepted');
      await updateEstimateStatus(E.ctx, bad.estimateId, 'rejected');
      const n = await invoiceCount(E);
      const ar = await arControl(E);
      const err = await catchErr(
        createInvoice(E.ctx, {
          customerId,
          date: d('2025-04-05'),
          lines: [laborLine(good.labor.id, 5), permitLine(bad.permit.id)],
        }),
      );
      expect((err as Error)?.message).toMatch(/rejected/);
      // The message names the rejected estimate, not the good one.
      expect((err as Error).message).toContain(String(bad.estimateNumber));
      expect(await invoiceCount(E)).toBe(n);
      expect(await arControl(E)).toBe(ar);
      const g = await getEstimate(E.ctx, good.estimateId);
      expect(g.status).toBe('accepted');
      expect(g.lines.find((l) => l.id === good.labor.id)!.amountInvoiced).toBe('0.00');
      expect((await getEstimate(E.ctx, bad.estimateId)).status).toBe('rejected');
      // Billing just the accepted one works.
      await createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(good.labor.id, 5)] });
      expect((await getEstimate(E.ctx, good.estimateId)).status).toBe('partial');
      await assertBooks(E);
    });

    it('a pending invoice linked before the rejection: dropping the link lets it save and post; the estimate stays rejected', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Pending Pia');
      const draft = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-05'),
        status: 'draft',
        lines: [laborLine(labor.id, 4)],
      });
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      // Keeping the link on edit is refused...
      await expect(
        updateInvoice(E.ctx, draft.id, {
          customerId,
          date: d('2025-04-05'),
          status: 'draft',
          lines: [laborLine(labor.id, 3)],
        } as never),
      ).rejects.toThrow(/rejected/);
      expect(Money.of((await getInvoice(E.ctx, draft.id)).lines[0].quantity).toFixed(2)).toBe('4.00');
      // An edit that omits the link (older API clients) keeps it by content, so posting is
      // still refused...
      await updateInvoice(E.ctx, draft.id, {
        customerId,
        date: d('2025-04-05'),
        status: 'draft',
        lines: [{ description: 'Labor', quantity: 4, rate: 50, taxable: false }],
      } as never);
      await expect(postDraftInvoice(E.ctx, draft.id)).rejects.toThrow(/rejected/);
      expect((await getInvoice(E.ctx, draft.id)).status).toBe('draft');
      // ...dropping it explicitly (what the invoice form sends) is fine, and the invoice posts.
      await updateInvoice(E.ctx, draft.id, {
        customerId,
        date: d('2025-04-05'),
        status: 'draft',
        lines: [{ description: 'Labor', quantity: 4, rate: 50, taxable: false, estimateLineId: null }],
      } as never);
      await postDraftInvoice(E.ctx, draft.id);
      expect((await getInvoice(E.ctx, draft.id)).status).not.toBe('draft');
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.status).toBe('rejected');
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      await assertBooks(E);
    });

    it('a pending invoice linked to a now-rejected estimate can still be voided; the estimate stays rejected', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Void Vera');
      const draft = await createInvoice(E.ctx, {
        customerId,
        date: d('2025-04-05'),
        status: 'draft',
        lines: [laborLine(labor.id, 4)],
      });
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      const ar = await arControl(E);
      await voidInvoice(E.ctx, draft.id);
      expect(await arControl(E)).toBe(ar);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('rejected');
      await assertBooks(E);
    });

    it('progress invoicing and conversion still refuse a rejected estimate; accept -> bill -> cannot reject while billed', async () => {
      const { estimateId } = await twoLineEstimate(E, 'Cycle Cy');
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      const n = await invoiceCount(E);
      await expect(createProgressInvoice(E.ctx, estimateId, { percent: 50, date: d('2025-04-05') })).rejects.toThrow();
      await expect(convertToInvoice(E.ctx, estimateId)).rejects.toThrow();
      expect(await invoiceCount(E)).toBe(n);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('rejected');

      await updateEstimateStatus(E.ctx, estimateId, 'accepted');
      const { invoice } = await createProgressInvoice(E.ctx, estimateId, { percent: 50, date: d('2025-04-05') });
      expect(await invoiceCount(E)).toBe(n + 1);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('partial');
      await expect(updateEstimateStatus(E.ctx, estimateId, 'rejected')).rejects.toThrow();
      // Void the progress bill: open again, now it can be rejected, and billing is refused again.
      await voidInvoice(E.ctx, invoice.id);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('accepted');
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      await expect(createProgressInvoice(E.ctx, estimateId, { percent: 10, date: d('2025-04-06') })).rejects.toThrow();
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('rejected');
      await assertBooks(E);
    });

    it('legacy link: an invoice that billed an estimate later marked rejected can be voided; status stays rejected, billed amount goes to 0', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(E, 'Legacy Lou');
      const inv = await createInvoice(E.ctx, { customerId, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] });
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('partial');
      // Simulate data from before the fix (the bug let this state exist).
      await db.update(estimates).set({ status: 'rejected' }).where(eq(estimates.id, estimateId));
      await voidInvoice(E.ctx, inv.id);
      const e = await getEstimate(E.ctx, estimateId);
      expect(e.status).toBe('rejected');
      expect(Money.of(e.amountInvoiced ?? '0').toFixed(2)).toBe('0.00');
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      await assertBooks(E);
    });

    it("another company cannot link this company's rejected estimate line, and the refusal does not reveal it", async () => {
      const { estimateId, labor } = await twoLineEstimate(E, 'Secret Sam');
      await updateEstimateStatus(E.ctx, estimateId, 'rejected');
      const gCust = await newCustomer(G, 'G Gus');
      const n = await invoiceCount(G);
      const err = await catchErr(
        createInvoice(G.ctx, { customerId: gCust, date: d('2025-04-05'), lines: [laborLine(labor.id, 5)] }),
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as Error).message).not.toMatch(/rejected/);
      expect(await invoiceCount(G)).toBe(n);
      expect((await getEstimate(E.ctx, estimateId)).status).toBe('rejected');
      await assertBooks(G);
      await assertBooks(E);
    });
  });

  // ===========================================================================
  // Voided foreign-currency refunds
  // ===========================================================================
  describe('voided foreign-currency overpayment refunds', () => {
    async function eurPayment(co: Co, amount: string, rate: string) {
      const customerId = await newCustomer(co, 'Euro ' + amount + ' ' + rate);
      const { payment } = await receivePayment(co.ctx, {
        customerId,
        date: d('2026-03-02'),
        method: 'bank_transfer',
        amount,
        depositAccountId: co.acct['1000'],
        applications: [],
        currency: 'EUR',
        exchangeRate: rate,
      });
      return payment;
    }
    async function unapplied(id: string) {
      const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id));
      return p.unapplied;
    }

    it('two refunds at an awkward rate: voiding each restores exactly its own amount, in any order', async () => {
      const p = await eurPayment(F, '50.00', '0.300000');
      const r1 = await refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '10.05', date: d('2026-03-03') });
      const r2 = await refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '0.05', date: d('2026-03-04') });
      expect(await unapplied(p.id)).toBe('39.90');
      // Void the FIRST refund (the lookup must match by entry, not "latest refund").
      await voidJournalEntry(F.ctx, r1.entry.id);
      expect(await unapplied(p.id)).toBe('49.95');
      await voidJournalEntry(F.ctx, r2.entry.id);
      expect(await unapplied(p.id)).toBe('50.00');
      // Full refund now possible, and not one cent more.
      await expect(
        refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '50.01' }),
      ).rejects.toThrow();
      await refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '50.00' });
      expect(await unapplied(p.id)).toBe('0.00');
      await assertBooks(F);
    });

    it('voiding the same FX refund twice restores it only once', async () => {
      const p = await eurPayment(F, '20.00', '1.333333');
      const r = await refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '7.77', date: d('2026-03-03') });
      await voidJournalEntry(F.ctx, r.entry.id);
      expect(await unapplied(p.id)).toBe('20.00');
      await catchErr(voidJournalEntry(F.ctx, r.entry.id));
      expect(await unapplied(p.id)).toBe('20.00');
      await assertBooks(F);
    });

    it('home-currency refund void still restores exactly (rate 1 path unchanged)', async () => {
      const customerId = await newCustomer(F, 'Home Hal');
      const { payment } = await receivePayment(F.ctx, {
        customerId,
        date: d('2026-03-02'),
        method: 'check',
        amount: '33.33',
        depositAccountId: F.acct['1000'],
        applications: [],
      });
      const r = await refundPayment(F.ctx, { paymentId: payment.id, bankAccountId: F.acct['1000'], amount: '11.11' });
      await voidJournalEntry(F.ctx, r.entry.id);
      expect(await unapplied(payment.id)).toBe('33.33');
      await assertBooks(F);
    });

    it("another company cannot void this company's FX refund; the owner can, exactly once", async () => {
      const p = await eurPayment(F, '10.00', '0.300000');
      const r = await refundPayment(F.ctx, { paymentId: p.id, bankAccountId: F.acct['1000'], amount: '3.35' });
      await expect(voidJournalEntry(G.ctx, r.entry.id)).rejects.toThrow();
      expect(await unapplied(p.id)).toBe('6.65');
      const [je] = await db
        .select({ status: journalEntries.status })
        .from(journalEntries)
        .where(eq(journalEntries.id, r.entry.id));
      expect(je.status).not.toBe('void');
      await voidJournalEntry(F.ctx, r.entry.id);
      expect(await unapplied(p.id)).toBe('10.00');
      await assertBooks(F);
      await assertBooks(G);
    });
  });
});
