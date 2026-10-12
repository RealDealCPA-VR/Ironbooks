/**
 * fix/sales — TESTER (independent adversarial QA) for the four P0 sales bugs.
 *
 * Written against the doer's diff without trusting its own tests. Every scenario checks the
 * accounting invariants as well as the feature: trial balance balanced, A/R control == the
 * customers' GL balances == aging == statements, inventory units/value follow what was billed,
 * nothing changes when a save is refused (rollback), the closing date is respected, and one
 * company never sees another's documents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  items,
  taxAgencies,
  taxRates,
  invoices,
  classes,
  journalEntries,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { adjustInventory } from './inventory';
import { Money } from '@/lib/money';
import { createInvoice, getInvoice, voidInvoice, updateInvoice, postDraftInvoice } from './invoices';
import { createEstimate, createProgressInvoice, getEstimate, convertToInvoice } from './estimates';
import { receivePayment, refundPayment } from './payments';
import { createCreditMemo, applyToInvoice, refundCreditMemo } from './creditMemos';
import { createManualEntry } from './journal';
import { voidJournalEntry } from './posting';
import { assessFinanceCharges } from './financeCharges';
import { setStartingDocNumber } from './docNumbers';
import { customerStatement, customerArLedgerBalance, batchStatements } from './statements';
import { arAging, arAgingDetail } from './reportsExtra';
import { verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fix-sales-adv-' + Date.now());
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

let db: DB;
let userId: string;

interface Co {
  ctx: ServiceContext;
  acct: Record<string, string>;
  taxRateId: string;
}

async function newCompany(name: string): Promise<Co> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['1300', 'Inventory Asset', 'asset', 'inventory'],
    ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['4000', 'Sales Income', 'revenue', 'sales'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
  ];
  for (const [code, n, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name: n, type: type as never, subtype });
    acct[code] = row.id;
  }
  const [agency] = await db
    .insert(taxAgencies)
    .values({ companyId: company.id, name: 'State', liabilityAccountId: acct['2200'] })
    .returning();
  const [tr] = await db
    .insert(taxRates)
    .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id, isActive: true })
    .returning();
  return { ctx, acct, taxRateId: tr.id };
}

async function bal(co: Co, code: string) {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, co.acct[code]));
  return Money.of(row?.b ?? '0');
}
async function qoh(itemId: string) {
  const [row] = await db.select({ q: items.quantityOnHand }).from(items).where(eq(items.id, itemId));
  return Money.of(row?.q ?? '0');
}
async function newCustomer(co: Co, name: string) {
  const [c] = await db.insert(customers).values({ companyId: co.ctx.companyId, displayName: name, taxable: true }).returning();
  return c.id;
}
async function newInventoryItem(co: Co, name: string, qty: number, cost: number) {
  const [w] = await db
    .insert(items)
    .values({
      companyId: co.ctx.companyId,
      name,
      type: 'inventory',
      salesPrice: '20.00',
      incomeAccountId: co.acct['4000'],
      quantityOnHand: '0',
      averageCost: '0',
    })
    .returning();
  await adjustInventory(co.ctx, { itemId: w.id, quantityChange: qty, unitCost: cost, date: d('2025-01-01') });
  return w.id;
}
async function invoiceCount(co: Co) {
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(invoices)
    .where(eq(invoices.companyId, co.ctx.companyId));
  return Number(r.n);
}
async function setClosing(co: Co, date: string | null) {
  await db
    .update(companies)
    .set({ settings: (date ? { closingDate: date } : {}) as never })
    .where(eq(companies.id, co.ctx.companyId));
}
async function assertBooks(co: Co) {
  const tb = await trialBalance(co.ctx);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  const integ = await verifyIntegrity(co.ctx);
  const bad = integ.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  expect(bad).toEqual([]);
}
/** statement closing == GL balance for the customer == aging row total. */
async function assertCustomerTies(co: Co, customerId: string, asOf: Date) {
  const st = await customerStatement(co.ctx, customerId, { to: asOf });
  const gl = await customerArLedgerBalance(co.ctx, customerId, asOf);
  const aging = await arAging(co.ctx, asOf);
  const row = aging.rows.find((r) => r.id === customerId);
  expect(st.closingBalance).toBe(gl);
  expect(Money.of(row?.total ?? '0').toFixed(2)).toBe(gl);
  return gl;
}

describe('fix/sales P0 — adversarial QA', () => {
  let A: Co;
  let B: Co;

  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa@fix-sales-adv.test', name: 'QA', passwordHash: 'x' })
      .returning();
    userId = user.id;
    A = await newCompany('Adv Co A');
    B = await newCompany('Adv Co B');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===========================================================================
  // P0-1 / P0-2: progress invoicing
  // ===========================================================================
  describe('progress invoicing', () => {
    it('30% / 30% / remaining on a taxed inventory + classed service estimate: tax, income, COGS, units, class all exact', async () => {
      const gizmo = await newInventoryItem(A, 'Gizmo', 50, 6);
      const [cls] = await db.insert(classes).values({ companyId: A.ctx.companyId, name: 'East' }).returning();
      const customerId = await newCustomer(A, 'Progress Pam');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-01'),
        taxRateId: A.taxRateId,
        lines: [
          { itemId: gizmo, description: 'Gizmo', quantity: 10, rate: 20, taxable: true }, // 200 (+20 tax)
          { description: 'Install', quantity: 3, rate: '33.35', taxable: false, classId: cls.id }, // 100.05
        ],
      });
      expect(est.subtotal).toBe('300.05');
      expect(est.taxAmount).toBe('20.00');
      expect(est.total).toBe('320.05');

      const inc0 = await bal(A, '4000');
      const tax0 = await bal(A, '2200');
      const cogs0 = await bal(A, '5000');
      const inv0 = await bal(A, '1300');
      const q0 = await qoh(gizmo);

      const r1 = await createProgressInvoice(A.ctx, est.id, { percent: 30, date: d('2025-03-02') });
      const r2 = await createProgressInvoice(A.ctx, est.id, { percent: 30, date: d('2025-03-03') });
      const r3 = await createProgressInvoice(A.ctx, est.id, { remaining: true, date: d('2025-03-04') });

      const invs = await Promise.all([r1, r2, r3].map((r) => getInvoice(A.ctx, r.invoice.id)));
      const gizmoQty = invs.map((i) => i.lines.find((l) => l.itemId === gizmo)!.quantity);
      expect(gizmoQty).toEqual(['3.0000', '3.0000', '4.0000']);
      const installQty = invs.map((i) => i.lines.find((l) => l.description === 'Install')!.quantity);
      expect(installQty).toEqual(['0.9000', '0.9000', '1.2000']);
      // Class is carried onto every billed Install line; rate is the estimate's rate.
      for (const i of invs) {
        const inst = i.lines.find((l) => l.description === 'Install')!;
        expect(inst.classId).toBe(cls.id);
        expect(inst.rate).toBe('33.3500');
        expect(inst.taxable).toBe(false);
      }
      // Tax is charged on the taxable Gizmo amount only, on each invoice.
      expect([r1, r2, r3].map((r) => r.invoice.taxAmount)).toEqual(['6.00', '6.00', '8.00']);

      const sumSub = [r1, r2, r3].reduce((s, r) => s.plus(r.invoice.subtotal), Money.zero());
      const sumTot = [r1, r2, r3].reduce((s, r) => s.plus(r.invoice.total), Money.zero());
      expect(sumSub.toFixed(2)).toBe('300.05');
      expect(sumTot.toFixed(2)).toBe('320.05');

      // GL: income = subtotal (never the tax), Sales Tax Payable = tax, COGS = 10 units × $6.
      expect((await bal(A, '4000')).minus(inc0).abs().toFixed(2)).toBe('300.05');
      expect((await bal(A, '2200')).minus(tax0).abs().toFixed(2)).toBe('20.00');
      expect((await bal(A, '5000')).minus(cogs0).abs().toFixed(2)).toBe('60.00');
      expect(inv0.minus(await bal(A, '1300')).toFixed(2)).toBe('60.00');
      expect(q0.minus(await qoh(gizmo)).toFixed(4)).toBe('10.0000');

      const done = await getEstimate(A.ctx, est.id);
      expect(done.status).toBe('closed');
      expect(done.amountInvoiced).toBe('320.05');
      expect(done.convertedInvoiceId).toBe(r3.invoice.id);
      for (const l of done.lines) expect(l.percentInvoiced).toBe('100.00');

      await assertCustomerTies(A, customerId, d('2030-01-01'));
      await assertBooks(A);
    });

    it('a refused over-bill changes nothing (no invoice, no stock movement, estimate untouched)', async () => {
      const gizmo = await newInventoryItem(A, 'Rollback Gizmo', 20, 5);
      const customerId = await newCustomer(A, 'Rollback Rob');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-10'),
        lines: [{ itemId: gizmo, description: 'RG', quantity: 4, rate: 10 }],
      });
      const full = await getEstimate(A.ctx, est.id);
      await createProgressInvoice(A.ctx, est.id, { percent: 75, date: d('2025-03-11') });

      const n0 = await invoiceCount(A);
      const q0 = await qoh(gizmo);
      const before = await getEstimate(A.ctx, est.id);

      await expect(
        createProgressInvoice(A.ctx, est.id, { lines: [{ lineId: full.lines[0].id, quantity: 2 }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION', details: { warning: 'PROGRESS_OVERBILL' } });

      expect(await invoiceCount(A)).toBe(n0);
      expect((await qoh(gizmo)).toFixed(4)).toBe(q0.toFixed(4));
      const after = await getEstimate(A.ctx, est.id);
      expect(after.status).toBe(before.status);
      expect(after.amountInvoiced).toBe(before.amountInvoiced);
      expect(after.lines[0].qtyInvoiced).toBe('3.0000');
      await assertBooks(A);
    });

    it('respects the closing date: a progress invoice dated in a closed period is refused and nothing changes', async () => {
      const customerId = await newCustomer(A, 'Closed Carl');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-01-05'),
        taxRateId: A.taxRateId,
        lines: [{ description: 'Work', quantity: 2, rate: 100 }],
      });
      const n0 = await invoiceCount(A);
      await setClosing(A, '2025-01-31');
      try {
        await expect(
          createProgressInvoice(A.ctx, est.id, { percent: 50, date: d('2025-01-20') }),
        ).rejects.toBeTruthy();
      } finally {
        await setClosing(A, null);
      }
      expect(await invoiceCount(A)).toBe(n0);
      const after = await getEstimate(A.ctx, est.id);
      expect(after.status).not.toBe('partial');
      expect(after.amountInvoiced).toBe('0.00');
      expect(after.lines[0].qtyInvoiced).toBe('0.0000');
    });

    it('voiding every progress invoice puts stock back and reopens the estimate, which can then be converted in full', async () => {
      const gizmo = await newInventoryItem(A, 'Void Gizmo', 30, 4);
      const customerId = await newCustomer(A, 'Void Vera');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-15'),
        taxRateId: A.taxRateId,
        lines: [{ itemId: gizmo, description: 'VG', quantity: 10, rate: 15, taxable: true }],
      });
      const q0 = await qoh(gizmo);
      const cogs0 = await bal(A, '5000');
      const a = await createProgressInvoice(A.ctx, est.id, { percent: 20, date: d('2025-03-16') });
      const b = await createProgressInvoice(A.ctx, est.id, { percent: 50, date: d('2025-03-17') });
      expect(q0.minus(await qoh(gizmo)).toFixed(4)).toBe('7.0000');

      // Converting while progress invoices exist is refused.
      await expect(convertToInvoice(A.ctx, est.id)).rejects.toMatchObject({ code: 'CONFLICT' });

      await voidInvoice(A.ctx, a.invoice.id);
      await voidInvoice(A.ctx, b.invoice.id);
      expect((await qoh(gizmo)).toFixed(4)).toBe(q0.toFixed(4));
      expect((await bal(A, '5000')).minus(cogs0).toFixed(2)).toBe('0.00');
      const reopened = await getEstimate(A.ctx, est.id);
      expect(reopened.status).toBe('accepted');
      expect(reopened.amountInvoiced).toBe('0.00');
      expect(reopened.lines[0].qtyInvoiced).toBe('0.0000');

      const inv = await convertToInvoice(A.ctx, est.id);
      expect(inv.total).toBe('165.00');
      expect(q0.minus(await qoh(gizmo)).toFixed(4)).toBe('10.0000');
      const closed = await getEstimate(A.ctx, est.id);
      expect(closed.status).toBe('closed');
      expect(closed.amountInvoiced).toBe('165.00');
      await assertCustomerTies(A, customerId, d('2030-01-01'));
      await assertBooks(A);
    });

    it('a fully billed estimate refuses another bill unless over-billing is allowed (then it warns)', async () => {
      const customerId = await newCustomer(A, 'Full Fran');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-20'),
        lines: [{ description: 'Job', quantity: 1, rate: 500 }],
      });
      await createProgressInvoice(A.ctx, est.id, { percent: 100 });
      await expect(createProgressInvoice(A.ctx, est.id, { percent: 10 })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(createProgressInvoice(A.ctx, est.id, { remaining: true })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const extra = await createProgressInvoice(A.ctx, est.id, { percent: 10, allowOverBilling: true });
      expect(extra.invoice.subtotal).toBe('50.00');
      expect(extra.overBilled).toHaveLength(1);
      expect(extra.overBilled[0].percentBilled).toBe('110.00');
      const e = await getEstimate(A.ctx, est.id);
      expect(e.status).toBe('closed');
      expect(e.lines[0].percentInvoiced).toBe('110.00');
      await assertBooks(A);
    });

    it('rejects bad requests without creating anything', async () => {
      const customerId = await newCustomer(A, 'Bad Input Ben');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-21'),
        lines: [
          { description: 'L1', quantity: 2, rate: 10 },
          { description: 'L2', quantity: 1, rate: 5 },
        ],
      });
      const other = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-21'),
        lines: [{ description: 'Other', quantity: 1, rate: 1 }],
      });
      const e = await getEstimate(A.ctx, est.id);
      const o = await getEstimate(A.ctx, other.id);
      const [l1, l2] = e.lines;
      const n0 = await invoiceCount(A);

      const bad: Array<Parameters<typeof createProgressInvoice>[2]> = [
        {},
        { percent: 0 },
        { percent: -5 },
        { percent: '100.01' },
        { percent: 50, remaining: true },
        { percent: 50, lines: [{ lineId: l1.id, percent: 50 }] },
        { lines: [{ lineId: o.lines[0].id, percent: 50 }] }, // line of another estimate
        { lines: [{ lineId: '00000000-0000-0000-0000-000000000000', percent: 50 }] },
        { lines: [{ lineId: l1.id, percent: 10 }, { lineId: l1.id, percent: 10 }] },
        { lines: [{ lineId: l1.id, quantity: 1, amount: 10 }] },
        { lines: [{ lineId: l1.id }] },
        { lines: [{ lineId: l1.id, quantity: -1 }] },
        { lines: [{ lineId: l1.id, amount: -1 }] },
        { lines: [{ lineId: l1.id, percent: 0 }, { lineId: l2.id, amount: 0 }] },
      ];
      for (const input of bad) {
        await expect(createProgressInvoice(A.ctx, est.id, input), JSON.stringify(input)).rejects.toBeTruthy();
      }
      expect(await invoiceCount(A)).toBe(n0);
      const after = await getEstimate(A.ctx, est.id);
      expect(after.amountInvoiced).toBe('0.00');
    });

    it('rejected estimates cannot be progress-invoiced', async () => {
      const customerId = await newCustomer(A, 'Rejected Rita');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-22'),
        lines: [{ description: 'Nope', quantity: 1, rate: 10 }],
      });
      await db.update((await import('@/lib/db/schema')).estimates).set({ status: 'rejected' }).where(
        eq((await import('@/lib/db/schema')).estimates.id, est.id),
      );
      await expect(createProgressInvoice(A.ctx, est.id, { percent: 50 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('multi-company: another company cannot progress-invoice or read billing progress of this estimate', async () => {
      const customerId = await newCustomer(A, 'Isolated Ida');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-23'),
        lines: [{ description: 'Mine', quantity: 1, rate: 100 }],
      });
      const nB = await invoiceCount(B);
      await expect(createProgressInvoice(B.ctx, est.id, { percent: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(getEstimate(B.ctx, est.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await invoiceCount(B)).toBe(nB);
    });

    it('penny rounding: tiny rates billed in thirds never create a negative or lost penny', async () => {
      const customerId = await newCustomer(A, 'Penny Pete');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-24'),
        taxRateId: A.taxRateId,
        lines: [
          { description: 'Dime', quantity: 1, rate: '0.10', taxable: true },
          { description: 'Odd', quantity: 7, rate: '1.43', taxable: true }, // 10.01
        ],
      });
      const rs = [
        await createProgressInvoice(A.ctx, est.id, { percent: '33.333' }),
        await createProgressInvoice(A.ctx, est.id, { percent: '33.333' }),
        await createProgressInvoice(A.ctx, est.id, { remaining: true }),
      ];
      for (const r of rs) {
        const inv = await getInvoice(A.ctx, r.invoice.id);
        for (const l of inv.lines) {
          expect(Money.of(l.amount).greaterThanOrEqualTo(0)).toBe(true);
          expect(Money.of(l.quantity).greaterThan(0)).toBe(true);
        }
      }
      const sub = rs.reduce((s, r) => s.plus(r.invoice.subtotal), Money.zero());
      expect(sub.toFixed(2)).toBe('10.11');
      const e = await getEstimate(A.ctx, est.id);
      expect(e.status).toBe('closed');
      for (const l of e.lines) {
        expect(l.amountInvoiced).toBe(l.amount);
        expect(Money.of(l.qtyInvoiced).toFixed(4)).toBe(Money.of(l.quantity).toFixed(4));
      }
      await assertBooks(A);
    });

    it('editing a progress invoice keeps each line billing ITS estimate line (deleting the first line must not shift links)', async () => {
      // Two description-only lines (no item). The progress invoice bills both; the user then
      // deletes the first line in the invoice form. The remaining "Permit" line must still count
      // against the Permit estimate line, and Labor must go back to 0% invoiced.
      const customerId = await newCustomer(A, 'Edit Eddie');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-25'),
        lines: [
          { description: 'Labor', quantity: 10, rate: 50, taxable: false }, // 500
          { description: 'Permit', quantity: 1, rate: 120, taxable: false }, // 120
        ],
      });
      const e = await getEstimate(A.ctx, est.id);
      const labor = e.lines.find((l) => l.description === 'Labor')!;
      const permit = e.lines.find((l) => l.description === 'Permit')!;
      const r = await createProgressInvoice(A.ctx, est.id, { percent: 50, date: d('2025-03-26') });
      const inv = await getInvoice(A.ctx, r.invoice.id);
      const permitLine = inv.lines.find((l) => l.description === 'Permit')!;

      await updateInvoice(A.ctx, r.invoice.id, {
        customerId,
        date: d('2025-03-26'),
        memo: inv.memo,
        lines: [{ description: 'Permit', quantity: permitLine.quantity, rate: permitLine.rate, taxable: false }],
      });
      const after = await getEstimate(A.ctx, est.id);
      expect(after.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      expect(after.lines.find((l) => l.id === permit.id)!.amountInvoiced).toBe('60.00');
    });

    it('the edit form round-trips estimateLineId: explicit links are kept, null unlinks, foreign links are refused', async () => {
      const customerId = await newCustomer(A, 'Explicit Ella');
      const otherCustomer = await newCustomer(A, 'Other Otto');
      const est = await createEstimate(A.ctx, {
        customerId,
        date: d('2025-03-25'),
        lines: [
          { description: 'Labor', quantity: 10, rate: 50, taxable: false },
          { description: 'Labor', quantity: 2, rate: 50, taxable: false }, // same content as line 1
        ],
      });
      const e = await getEstimate(A.ctx, est.id);
      const [l1, l2] = e.lines;
      const r = await createProgressInvoice(A.ctx, est.id, { percent: 50, date: d('2025-03-26') });
      const inv = await getInvoice(A.ctx, r.invoice.id);
      // getInvoice exposes the link so the form can send it back.
      expect(inv.lines.map((l) => l.estimateLineId).sort()).toEqual([l1.id, l2.id].sort());
      const second = inv.lines.find((l) => l.estimateLineId === l2.id)!;

      // Keep only the second line, stating its link explicitly.
      await updateInvoice(A.ctx, r.invoice.id, {
        customerId,
        date: d('2025-03-26'),
        lines: [{ description: 'Labor', quantity: second.quantity, rate: second.rate, taxable: false, estimateLineId: l2.id }],
      });
      let after = await getEstimate(A.ctx, est.id);
      expect(after.lines.find((l) => l.id === l1.id)!.amountInvoiced).toBe('0.00');
      expect(after.lines.find((l) => l.id === l2.id)!.amountInvoiced).toBe('50.00');

      // An explicit null unlinks it (the invoice no longer bills the estimate).
      await updateInvoice(A.ctx, r.invoice.id, {
        customerId,
        date: d('2025-03-26'),
        lines: [{ description: 'Labor', quantity: second.quantity, rate: second.rate, taxable: false, estimateLineId: null }],
      });
      after = await getEstimate(A.ctx, est.id);
      expect(after.lines.find((l) => l.id === l2.id)!.amountInvoiced).toBe('0.00');

      // A link to this estimate from an invoice for another customer is refused, as is a bogus id.
      await expect(
        createInvoice(A.ctx, {
          customerId: otherCustomer,
          date: d('2025-03-27'),
          lines: [{ description: 'Labor', quantity: 1, rate: 50, taxable: false, estimateLineId: l1.id }],
        }),
      ).rejects.toThrow(/different customer/);
      await expect(
        updateInvoice(A.ctx, r.invoice.id, {
          customerId,
          date: d('2025-03-26'),
          lines: [{ description: 'Labor', quantity: 1, rate: 50, taxable: false, estimateLineId: '00000000-0000-4000-8000-000000000000' }],
        }),
      ).rejects.toThrow();
      // Another company cannot link to this estimate line.
      const bCustomer = await newCustomer(B, 'Cross Carl');
      await expect(
        createInvoice(B.ctx, {
          customerId: bCustomer,
          date: d('2025-03-27'),
          lines: [{ description: 'Labor', quantity: 1, rate: 50, taxable: false, estimateLineId: l1.id }],
        }),
      ).rejects.toThrow();
    });
  });

  it('migration 0036 is idempotent: re-running it leaves estimate billing progress unchanged', async () => {
    const before = await db.execute(
      sql`SELECT id, prior_qty_invoiced, prior_amount_invoiced FROM estimate_lines ORDER BY id`,
    );
    const beforeEst = await db.execute(sql`SELECT id, prior_amount_invoiced, amount_invoiced FROM estimates ORDER BY id`);
    const beforeLinks = await db.execute(sql`SELECT id, estimate_line_id FROM invoice_lines ORDER BY id`);
    const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0036_fix_sales.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
    const rows = (r: unknown) => (r as { rows: unknown[] }).rows;
    expect(rows(await db.execute(sql`SELECT id, prior_qty_invoiced, prior_amount_invoiced FROM estimate_lines ORDER BY id`))).toEqual(rows(before));
    expect(rows(await db.execute(sql`SELECT id, prior_amount_invoiced, amount_invoiced FROM estimates ORDER BY id`))).toEqual(rows(beforeEst));
    expect(rows(await db.execute(sql`SELECT id, estimate_line_id FROM invoice_lines ORDER BY id`))).toEqual(rows(beforeLinks));
  });

  // ===========================================================================
  // P0-3: statements include refunds; statement == GL == aging
  // ===========================================================================
  describe('customer statements', () => {
    it('refund dated in range of a payment received before the range: opening + lines == GL at every cut', async () => {
      const customerId = await newCustomer(A, 'Range Randy');
      const inv = await createInvoice(A.ctx, {
        customerId,
        date: d('2025-05-01'),
        dueDate: d('2025-05-31'),
        lines: [{ description: 'Svc', quantity: 1, rate: 400 }],
      });
      const pay = await receivePayment(A.ctx, {
        customerId,
        date: d('2025-05-10'),
        method: 'check',
        reference: 'R-1',
        amount: 500,
        depositAccountId: A.acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: 400 }],
      });
      await refundPayment(A.ctx, { paymentId: pay.payment.id, bankAccountId: A.acct['1000'], amount: 60, date: d('2025-06-15') });
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-05-20'),
        lines: [{ description: 'Credit', quantity: 1, rate: 90, taxable: false }],
      });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: 30, date: d('2025-06-20') });

      // Cuts: before refunds, between them, on the refund dates (inclusive), and after.
      // (Statement vs GL here; the aging side of the same cuts is its own test below.)
      for (const cut of ['2025-06-14', '2025-06-15', '2025-06-19', '2025-06-20', '2025-07-01']) {
        const st = await customerStatement(A.ctx, customerId, { to: d(cut) });
        expect(st.closingBalance, cut).toBe(await customerArLedgerBalance(A.ctx, customerId, d(cut)));
      }
      await assertCustomerTies(A, customerId, d('2025-07-01'));
      const gl = await customerArLedgerBalance(A.ctx, customerId);
      expect(gl).toBe('-100.00'); // -100 unapplied payment +60 refund... = -40; -90 memo +30 = -60 → -100

      const ranged = await customerStatement(A.ctx, customerId, { from: d('2025-06-01'), to: d('2025-06-30') });
      expect(ranged.openingBalance).toBe('-190.00');
      expect(ranged.lines.map((l) => [l.type, l.amount])).toEqual([
        ['refund', '60.00'],
        ['refund', '30.00'],
      ]);
      expect(ranged.closingBalance).toBe(gl);

      // Range that starts after both refunds: they move into the opening balance.
      const later = await customerStatement(A.ctx, customerId, { from: d('2025-07-01'), to: d('2025-07-31') });
      expect(later.openingBalance).toBe(gl);
      expect(later.lines).toHaveLength(0);
    });

    it('A/R aging as of a date BEFORE a credit-memo refund still counts the full memo credit (aging == GL == statement)', async () => {
      // Out-of-team file but part of the required invariant: arAging (lib/services/reportsExtra.ts)
      // subtracts creditMemos.unapplied as it is TODAY, so a memo refunded after the cutoff is
      // under-counted as of the cutoff (payments get this right via customerCredits.ts laterRefunds).
      const customerId = await newCustomer(A, 'Aging Asof Ann');
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-06-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: 90, taxable: false }],
      });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: 30, date: d('2025-06-20') });
      expect(await assertCustomerTies(A, customerId, d('2025-06-10'))).toBe('-90.00');
      expect(await assertCustomerTies(A, customerId, d('2025-06-30'))).toBe('-60.00');
    });

    it('A/R aging detail as of a date before a FULL credit-memo refund still lists the memo credit', async () => {
      const customerId = await newCustomer(A, 'Detail Dora');
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-06-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: 75, taxable: false }],
      });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: 75, date: d('2025-06-20') });
      const before = await arAgingDetail(A.ctx, d('2025-06-10'));
      const row = before.rows.find((r) => r.docId === cm.id);
      expect(row?.openBalance).toBe('-75.00');
      expect(await assertCustomerTies(A, customerId, d('2025-06-10'))).toBe('-75.00');
      const after = await arAgingDetail(A.ctx, d('2025-06-30'));
      expect(after.rows.find((r) => r.docId === cm.id)).toBeUndefined();
      expect(await assertCustomerTies(A, customerId, d('2025-06-30'))).toBe('0.00');
    });

    it('partial credit-memo refund with the rest applied, then fully refunded overpayment: ties at the end', async () => {
      const customerId = await newCustomer(A, 'Mixed Mia');
      const inv = await createInvoice(A.ctx, {
        customerId,
        date: d('2025-07-01'),
        dueDate: d('2025-07-31'),
        taxRateId: A.taxRateId,
        lines: [{ description: 'Svc', quantity: 1, rate: 100 }],
      }); // 110
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-07-02'),
        lines: [{ description: 'Credit', quantity: 1, rate: 50, taxable: false }],
      });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: '20.01', date: d('2025-07-03') });
      await applyToInvoice(A.ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '29.99' });
      const over = await receivePayment(A.ctx, {
        customerId,
        date: d('2025-07-04'),
        method: 'check',
        reference: 'M-1',
        amount: '0.03',
        depositAccountId: A.acct['1000'],
        applications: [],
      });
      await refundPayment(A.ctx, { paymentId: over.payment.id, bankAccountId: A.acct['1000'], amount: '0.03', date: d('2025-07-05') });
      const gl = await assertCustomerTies(A, customerId, d('2030-01-01'));
      expect(gl).toBe('80.01');
      const st = await customerStatement(A.ctx, customerId);
      expect(st.lines.filter((l) => l.type === 'refund').map((l) => l.amount).sort()).toEqual(['0.03', '20.01']);
    });

    it('a voided refund leaves the statement and the GL together', async () => {
      const customerId = await newCustomer(A, 'Voided Vic');
      const pay = await receivePayment(A.ctx, {
        customerId,
        date: d('2025-08-01'),
        method: 'check',
        reference: 'V-1',
        amount: 75,
        depositAccountId: A.acct['1000'],
        applications: [],
      });
      await refundPayment(A.ctx, { paymentId: pay.payment.id, bankAccountId: A.acct['1000'], amount: 75, date: d('2025-08-02') });
      const [je] = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, A.ctx.companyId), eq(journalEntries.sourceRef, `refund:${pay.payment.id}`)));
      await voidJournalEntry(A.ctx, je.id);
      const st = await customerStatement(A.ctx, customerId);
      expect(st.lines.map((l) => l.type)).toEqual(['payment']);
      expect(st.closingBalance).toBe(await customerArLedgerBalance(A.ctx, customerId));
      expect(st.closingBalance).toBe('-75.00');
    });

    it('company-wide: the sum of every customer statement == the A/R control account; batch statements include refunds', async () => {
      const C = await newCompany('Adv Co C (statements)');
      const c1 = await newCustomer(C, 'C One');
      const c2 = await newCustomer(C, 'C Two');
      const i1 = await createInvoice(C.ctx, {
        customerId: c1,
        date: d('2025-02-01'),
        dueDate: d('2025-02-15'),
        taxRateId: C.taxRateId,
        lines: [{ description: 'X', quantity: 3, rate: '33.33' }],
      });
      await receivePayment(C.ctx, {
        customerId: c1,
        date: d('2025-02-10'),
        method: 'check',
        reference: 'C1',
        amount: 150,
        depositAccountId: C.acct['1000'],
        applications: [{ invoiceId: i1.id, amountApplied: i1.total }],
      }).then((p) =>
        refundPayment(C.ctx, { paymentId: p.payment.id, bankAccountId: C.acct['1000'], amount: 10, date: d('2025-02-11') }),
      );
      const cm = await createCreditMemo(C.ctx, {
        customerId: c2,
        date: d('2025-02-12'),
        lines: [{ description: 'Credit', quantity: 1, rate: 40, taxable: false }],
      });
      await refundCreditMemo(C.ctx, { creditMemoId: cm.id, bankAccountId: C.acct['1000'], amount: 40, date: d('2025-02-13') });
      await createManualEntry(C.ctx, {
        date: d('2025-02-14'),
        description: 'Named A/R adj',
        lines: [
          { accountId: C.acct['1200'], debit: '12.34', entityType: 'customer', entityId: c2 },
          { accountId: C.acct['4000'], credit: '12.34' },
        ],
      });
      await assessFinanceCharges(C.ctx, { asOf: d('2025-06-30'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      // Activity in company A must not leak into C (and vice versa).
      const sum = (await Promise.all([c1, c2].map((c) => customerStatement(C.ctx, c)))).reduce(
        (s, st) => s.plus(st.closingBalance),
        Money.zero(),
      );
      expect(sum.toFixed(2)).toBe((await bal(C, '1200')).toFixed(2));
      for (const c of [c1, c2]) await assertCustomerTies(C, c, d('2030-01-01'));

      const batch = await batchStatements(C.ctx, { format: 'balance_forward' });
      const types = batch.flatMap((b) => ('lines' in b.statement ? (b.statement.lines as Array<{ type?: string }>).map((l) => l.type) : []));
      expect(types.filter((t) => t === 'refund')).toHaveLength(2);
      await expect(customerStatement(A.ctx, c1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await assertBooks(C);
    });
  });

  // ===========================================================================
  // P0-4: finance-charge invoices use the normal invoice numbering
  // ===========================================================================
  describe('finance-charge numbering', () => {
    async function overdueCompany(name: string) {
      const co = await newCompany(name);
      await db
        .update(companies)
        .set({ settings: { financeCharges: { annualRate: '18.00', minCharge: '1.00', graceDays: 0 } } as never })
        .where(eq(companies.id, co.ctx.companyId));
      return co;
    }

    it('starting number with a prefix and leading zeros is used by the first finance-charge invoice; sequence continues', async () => {
      const co = await overdueCompany('FC Start Co');
      const cust = await newCustomer(co, 'Late Lou');
      const old = await createInvoice(co.ctx, {
        customerId: cust,
        date: d('2025-01-01'),
        dueDate: d('2025-01-15'),
        lines: [{ description: 'Old', quantity: 1, rate: 1000 }],
      });
      expect(old.refNumber).toBe('1');
      await setStartingDocNumber(co.ctx, 'invoice', 'Q-0099');
      const res = await assessFinanceCharges(co.ctx, { asOf: d('2025-04-30'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      expect(res.assessed).toHaveLength(1);
      expect(res.assessed[0].refNumber).toBe('Q-0099');
      const next = await createInvoice(co.ctx, {
        customerId: cust,
        date: d('2025-05-01'),
        lines: [{ description: 'New', quantity: 1, rate: 5 }],
      });
      expect(next.refNumber).toBe('Q-0100');
      await assertBooks(co);
    });

    it('several customers in one run get consecutive, unique numbers', async () => {
      const co = await overdueCompany('FC Multi Co');
      await setStartingDocNumber(co.ctx, 'invoice', 'INV-1001');
      const ids: string[] = [];
      for (const n of ['M1', 'M2', 'M3']) {
        const c = await newCustomer(co, n);
        ids.push(c);
        await createInvoice(co.ctx, {
          customerId: c,
          date: d('2025-01-01'),
          dueDate: d('2025-01-10'),
          lines: [{ description: 'Old', quantity: 1, rate: 800 }],
        });
      }
      const res = await assessFinanceCharges(co.ctx, { asOf: d('2025-05-01'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      expect(res.assessed).toHaveLength(3);
      expect(res.assessed.map((a) => a.refNumber).sort()).toEqual(['INV-1004', 'INV-1005', 'INV-1006']);
      const rows = await db.select({ ref: invoices.refNumber }).from(invoices).where(eq(invoices.companyId, co.ctx.companyId));
      expect(new Set(rows.map((r) => r.ref)).size).toBe(rows.length);
      for (const c of ids) await assertCustomerTies(co, c, d('2025-05-01'));
      await assertBooks(co);
    });

    it('a finance charge refused by the closing date does not burn a number', async () => {
      const co = await overdueCompany('FC Closed Co');
      await setStartingDocNumber(co.ctx, 'invoice', 'INV-1001');
      const c = await newCustomer(co, 'Closed Cora');
      await createInvoice(co.ctx, {
        customerId: c,
        date: d('2025-01-01'),
        dueDate: d('2025-01-10'),
        lines: [{ description: 'Old', quantity: 1, rate: 800 }],
      });
      await db
        .update(companies)
        .set({ settings: { closingDate: '2025-06-30' } as never })
        .where(eq(companies.id, co.ctx.companyId));
      const res = await assessFinanceCharges(co.ctx, { asOf: d('2025-05-01'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      expect(res.assessed).toHaveLength(0);
      await db.update(companies).set({ settings: {} as never }).where(eq(companies.id, co.ctx.companyId));
      const next = await createInvoice(co.ctx, {
        customerId: c,
        date: d('2025-07-01'),
        lines: [{ description: 'New', quantity: 1, rate: 5 }],
      });
      expect(next.refNumber).toBe('INV-1002');
    });

    it('finance-charge invoices in two companies do not share a sequence', async () => {
      const x = await overdueCompany('FC X');
      const y = await overdueCompany('FC Y');
      await setStartingDocNumber(x.ctx, 'invoice', 'X-500');
      await setStartingDocNumber(y.ctx, 'invoice', 'Y-10');
      for (const co of [x, y]) {
        const c = await newCustomer(co, 'Late');
        await createInvoice(co.ctx, {
          customerId: c,
          date: d('2025-01-01'),
          dueDate: d('2025-01-10'),
          lines: [{ description: 'Old', quantity: 1, rate: 800 }],
        });
      }
      const rx = await assessFinanceCharges(x.ctx, { asOf: d('2025-05-01'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      const ry = await assessFinanceCharges(y.ctx, { asOf: d('2025-05-01'), settings: { annualRate: '18', minCharge: '1', graceDays: 0 } });
      expect(rx.assessed[0].refNumber).toBe('X-501');
      expect(ry.assessed[0].refNumber).toBe('Y-11');
    });
  });

  // ===========================================================================
  // Re-test round 1: estimate links now accepted from the API; aging memo-refund add-back
  // ===========================================================================
  describe('re-test round 1', () => {
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

    it('original repro still fixed: deleting Labor from a 50% progress invoice leaves Permit 60.00, Labor 0.00, books balanced', async () => {
      const { customerId, estimateId, labor, permit } = await twoLineEstimate(A, 'Repro Rita');
      const r = await createProgressInvoice(A.ctx, estimateId, { percent: 50, date: d('2025-04-02') });
      const inv = await getInvoice(A.ctx, r.invoice.id);
      const p = inv.lines.find((l) => l.description === 'Permit')!;
      // Exactly what the invoice form sends now (link round-tripped).
      await updateInvoice(A.ctx, r.invoice.id, {
        customerId,
        date: d('2025-04-02'),
        lines: [{ description: 'Permit', quantity: p.quantity, rate: p.rate, taxable: false, estimateLineId: p.estimateLineId }],
      });
      const after = await getEstimate(A.ctx, estimateId);
      expect(after.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
      expect(after.lines.find((l) => l.id === permit.id)!.amountInvoiced).toBe('60.00');
      expect(after.status).toBe('partial');
      expect(after.amountInvoiced).toBe('60.00');
      // The rest can still be billed in full without an over-billing warning.
      await createProgressInvoice(A.ctx, estimateId, { remaining: true, date: d('2025-04-03') });
      const done = await getEstimate(A.ctx, estimateId);
      expect(done.lines.map((l) => l.amountInvoiced).sort()).toEqual(['120.00', '500.00']);
      expect(done.status).toBe('closed');
      await assertBooks(A);
    });

    it('a plain invoice that links an estimate line (API now accepts estimateLineId) cannot silently over-bill it', async () => {
      // invoiceLineSchema now accepts estimateLineId on POST /api/invoices, so createInvoice is
      // a second way to bill an estimate. Billing 200% of Labor this way must get the same
      // over-billing refusal (or warning) createProgressInvoice gives, not pass silently.
      const { customerId, estimateId, labor } = await twoLineEstimate(A, 'Overbill Olga');
      const before = await invoiceCount(A);
      await expect(
        createInvoice(A.ctx, {
          customerId,
          date: d('2025-04-05'),
          lines: [{ description: 'Labor', quantity: 20, rate: 50, taxable: false, estimateLineId: labor.id }],
        }),
      ).rejects.toThrow(/more than 100%/);
      expect(await invoiceCount(A)).toBe(before);
      const e = await getEstimate(A.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00');
    });

    it('a plain invoice that bills an estimate line in full updates the estimate header (amount invoiced / status)', async () => {
      const { customerId, estimateId, labor, permit } = await twoLineEstimate(A, 'Header Hank');
      await createInvoice(A.ctx, {
        customerId,
        date: d('2025-04-05'),
        lines: [
          { description: 'Labor', quantity: 10, rate: 50, taxable: false, estimateLineId: labor.id },
          { description: 'Permit', quantity: 1, rate: 120, taxable: false, estimateLineId: permit.id },
        ],
      });
      const e = await getEstimate(A.ctx, estimateId);
      // Line progress is computed live, so it is right...
      expect(e.lines.map((l) => l.amountInvoiced).sort()).toEqual(['120.00', '500.00']);
      // ...and the header must agree with it.
      expect(e.amountInvoiced).toBe('620.00');
      expect(e.status).toBe('closed');
    });

    it('posting a pending (draft) invoice that bills estimate lines updates the estimate header', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(A, 'Draft Dan');
      const draft = await createInvoice(A.ctx, {
        customerId,
        date: d('2025-04-06'),
        status: 'draft',
        lines: [{ description: 'Labor', quantity: 5, rate: 50, taxable: false, estimateLineId: labor.id }],
      });
      let e = await getEstimate(A.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('0.00'); // drafts bill nothing
      await postDraftInvoice(A.ctx, draft.id);
      e = await getEstimate(A.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('250.00');
      expect(e.amountInvoiced).toBe('250.00');
      expect(e.status).toBe('partial');
      await assertBooks(A);
    });

    it('editing a progress invoice cannot silently push a line past 100% of the estimate', async () => {
      const { customerId, estimateId, labor } = await twoLineEstimate(A, 'Edit Over Ed');
      const r = await createProgressInvoice(A.ctx, estimateId, { percent: 100, date: d('2025-04-07') });
      const inv = await getInvoice(A.ctx, r.invoice.id);
      const l = inv.lines.find((x) => x.estimateLineId === labor.id)!;
      await expect(
        updateInvoice(A.ctx, r.invoice.id, {
          customerId,
          date: d('2025-04-07'),
          lines: inv.lines.map((x) => ({
            description: x.description,
            quantity: x.id === l.id ? 30 : x.quantity, // 300% of Labor
            rate: x.rate,
            taxable: false,
            estimateLineId: x.estimateLineId,
          })),
        }),
      ).rejects.toThrow(/more than 100%/);
      const e = await getEstimate(A.ctx, estimateId);
      expect(e.lines.find((x) => x.id === labor.id)!.amountInvoiced).toBe('500.00');
      await assertBooks(A);
    });

    it('an old-API edit (no links sent) of a progress invoice with re-ordered lines keeps each link by content', async () => {
      const { customerId, estimateId, labor, permit } = await twoLineEstimate(A, 'Reorder Rex');
      const r = await createProgressInvoice(A.ctx, estimateId, { percent: 50, date: d('2025-04-08') });
      const inv = await getInvoice(A.ctx, r.invoice.id);
      const lab = inv.lines.find((l) => l.description === 'Labor')!;
      const per = inv.lines.find((l) => l.description === 'Permit')!;
      await updateInvoice(A.ctx, r.invoice.id, {
        customerId,
        date: d('2025-04-08'),
        lines: [
          { description: 'Permit', quantity: per.quantity, rate: per.rate, taxable: false },
          { description: 'Labor', quantity: lab.quantity, rate: lab.rate, taxable: false },
        ],
      });
      const e = await getEstimate(A.ctx, estimateId);
      expect(e.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('250.00');
      expect(e.lines.find((l) => l.id === permit.id)!.amountInvoiced).toBe('60.00');
    });

    it('A/R aging between a credit memo and its two refunds, part of the memo applied: aging == GL == statement', async () => {
      const customerId = await newCustomer(A, 'Between Bea');
      const inv = await createInvoice(A.ctx, {
        customerId,
        date: d('2025-09-01'),
        dueDate: d('2025-09-30'),
        lines: [{ description: 'Svc', quantity: 1, rate: 200 }],
      });
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-09-02'),
        lines: [{ description: 'Credit', quantity: 1, rate: '100.01', taxable: false }],
      });
      await applyToInvoice(A.ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '40.00' });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: '30.00', date: d('2025-09-10') });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: '30.01', date: d('2025-09-20') });
      expect(await assertCustomerTies(A, customerId, d('2025-09-05'))).toBe('99.99');
      expect(await assertCustomerTies(A, customerId, d('2025-09-15'))).toBe('129.99');
      expect(await assertCustomerTies(A, customerId, d('2025-09-25'))).toBe('160.00');
      const det = await arAgingDetail(A.ctx, d('2025-09-15'));
      const sum = det.rows
        .filter((r) => r.entityId === customerId)
        .reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero());
      expect(sum.toFixed(2)).toBe('129.99');
      await assertBooks(A);
    });

    it('a voided credit-memo refund: statement, GL and aging still agree', async () => {
      const customerId = await newCustomer(A, 'Void Memo Val');
      const cm = await createCreditMemo(A.ctx, {
        customerId,
        date: d('2025-10-01'),
        lines: [{ description: 'Credit', quantity: 1, rate: 90, taxable: false }],
      });
      await refundCreditMemo(A.ctx, { creditMemoId: cm.id, bankAccountId: A.acct['1000'], amount: 30, date: d('2025-10-05') });
      const [je] = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, A.ctx.companyId), eq(journalEntries.sourceRef, `refund:${cm.id}`)));
      await voidJournalEntry(A.ctx, je.id);
      expect(await assertCustomerTies(A, customerId, d('2025-10-31'))).toBe('-90.00');
    });

    it('a voided overpayment refund: statement, GL and aging still agree', async () => {
      const customerId = await newCustomer(A, 'Void Pay Pat');
      const pay = await receivePayment(A.ctx, {
        customerId,
        date: d('2025-10-01'),
        method: 'check',
        reference: 'VP-1',
        amount: 75,
        depositAccountId: A.acct['1000'],
        applications: [],
      });
      await refundPayment(A.ctx, { paymentId: pay.payment.id, bankAccountId: A.acct['1000'], amount: 25, date: d('2025-10-02') });
      const [je] = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, A.ctx.companyId), eq(journalEntries.sourceRef, `refund:${pay.payment.id}`)));
      await voidJournalEntry(A.ctx, je.id);
      expect(await assertCustomerTies(A, customerId, d('2025-10-31'))).toBe('-75.00');
    });

    it('company-wide aging total == every customer GL balance summed, at several cuts', async () => {
      const aging = async (cut: string) => {
        const a = await arAging(A.ctx, d(cut));
        return a.rows.reduce((s, r) => s.plus(Money.of(r.total)), Money.zero()).toFixed(2);
      };
      const custs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, A.ctx.companyId));
      for (const cut of ['2025-06-10', '2025-09-15', '2030-01-01']) {
        let gl = Money.zero();
        for (const c of custs) gl = gl.plus(Money.of(await customerArLedgerBalance(A.ctx, c.id, d(cut))));
        expect(await aging(cut), cut).toBe(gl.toFixed(2));
      }
    });
  });
});
