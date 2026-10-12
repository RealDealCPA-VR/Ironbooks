/**
 * Independent QA — re-test of accountant fix round 2 (a48dbbc). Adversarial checks of:
 *   D7 cumulative cash-basis allocation: many small settlements, settlements entered out of date
 *      order, a combined (multi-agency) rate with awkward cents, a voided payment in the middle,
 *      an unapplied payment, and repeat runs giving identical output. Invariant: once an invoice is
 *      fully settled, cash-basis tax == accrual tax for every agency, and no month is off by more
 *      than one cent from its pro-rata share.
 *   I2/I6 Batch Void cleans up only the corrections orphaned by this batch, reports that count,
 *      and works for a role with Banking delete rights but no Sales Tax rights.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createInvoice } from '../invoices';
import { createExpense, voidExpense } from '../expenses';
import { receivePayment, unapplyFromInvoice, voidPayment } from '../payments';
import { trialBalance } from '../reports';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { setComponents } from '../combinedTax';
import { emptyPermissionSet, type Area, type EffectiveAccess } from '@/lib/permissions/model';
import { salesTaxLiabilityReport } from './salesTaxLedger';
import { findMisrecordedSalesTax, reclassifySalesTaxPayment } from './salesTaxTools';
import { batchVoidTransactions } from './batchVoid';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-retest2');
let db: DB;
let userId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const cents = (v: string | number) => Math.round(Number(v) * 100);

function only(areas: Partial<Record<Area, Array<'view' | 'create' | 'modify' | 'delete' | 'print'>>>): EffectiveAccess {
  const permissions = emptyPermissionSet();
  for (const [k, v] of Object.entries(areas)) (permissions as Record<string, string[]>)[k] = v as string[];
  return {
    roleKeys: ['retest2'],
    permissions,
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

async function newCompany(name: string): Promise<{ ctx: ServiceContext; acct: Record<string, string> }> {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

type Report = Awaited<ReturnType<typeof salesTaxLiabilityReport>>;
function net(r: Report, agencyId: string): number {
  const a = r.agencies.find((x) => x.agencyId === agencyId);
  return a ? cents(a.collected) + cents(a.credited) : 0;
}
function collected(r: Report, agencyId: string): number {
  return cents(r.agencies.find((x) => x.agencyId === agencyId)?.collected ?? 0);
}

const lastDay = (mm: string) => (['04', '06', '09', '11'].includes(mm) ? '30' : mm === '02' ? '28' : '31');
const month = (yyyy: string, mm: string) => ({ from: d(`${yyyy}-${mm}-01`), to: eod(`${yyyy}-${mm}-${lastDay(mm)}`), basis: 'cash' as const });

describe('wave2 accountant — re-test of fix round 2', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-retest2@test.local', name: 'Retester 2', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('D7 cumulative cash-basis allocation', () => {
    let ctx: ServiceContext;
    let acct: Record<string, string>;
    let agency: string;
    let rate: string;

    beforeAll(async () => {
      ({ ctx, acct } = await newCompany('Retest2 Cash Co'));
      agency = (await createTaxAgency(ctx, { name: 'R2 County' })).id;
      rate = (await createTaxRate(ctx, { name: 'R2 5%', rate: '0.05', agencyId: agency })).id;
    });

    const pay = async (cust: string, invoiceId: string, date: string, amt: string) =>
      receivePayment(ctx, {
        customerId: cust,
        date: d(date),
        method: 'check',
        amount: amt,
        depositAccountId: acct['1000'],
        applications: [{ invoiceId, amountApplied: amt }],
      });

    it('seven 15.00 payments on a 105.00 invoice recognize exactly 5.00, each month within a cent', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Sevenths Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2025-01-02'),
        taxRateId: rate,
        lines: [{ description: 'Goods', quantity: 1, rate: '100' }],
      });
      const mms = ['01', '02', '03', '04', '05', '06', '07'];
      for (const mm of mms) await pay(cust, inv.id, `2025-${mm}-10`, '15.00');
      const per = await Promise.all(mms.map(async (mm) => collected(await salesTaxLiabilityReport(ctx, month('2025', mm)), agency)));
      for (const c of per) expect(Math.abs(c - 500 / 7)).toBeLessThanOrEqual(1);
      expect(per.reduce((s, c) => s + c, 0)).toBe(500);
      const full = { from: d('2025-01-01'), to: eod('2025-07-31') };
      expect(net(await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' }), agency)).toBe(
        net(await salesTaxLiabilityReport(ctx, full), agency),
      );
    });

    it('settlements entered out of date order are allocated in date order (stable per-month result)', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Out Of Order Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2025-08-01'),
        taxRateId: rate,
        lines: [{ description: 'Goods', quantity: 1, rate: '100' }],
      }); // 105.00 / 5.00
      // Entered: Sept, then Aug, then Oct — dated Aug < Sept < Oct.
      await pay(cust, inv.id, '2025-09-15', '35.00');
      await pay(cust, inv.id, '2025-08-15', '35.00');
      const before = await Promise.all(['08', '09'].map(async (mm) => collected(await salesTaxLiabilityReport(ctx, month('2025', mm)), agency)));
      await pay(cust, inv.id, '2025-10-15', '35.00');
      const after = await Promise.all(['08', '09', '10'].map(async (mm) => collected(await salesTaxLiabilityReport(ctx, month('2025', mm)), agency)));
      // August is the first settlement: round(5 * 35/105) = 1.67; Sept = round(5*70/105) - 1.67 = 1.66.
      expect(after[0]).toBe(167);
      expect(after[1]).toBe(166);
      expect(after[2]).toBe(167);
      // Adding a later settlement never restates earlier months.
      expect(after.slice(0, 2)).toEqual(before);
      expect(after.reduce((s, c) => s + c, 0)).toBe(500);
    });

    it('combined two-agency rate with awkward cents: each agency cash total == accrual total', async () => {
      const state = (await createTaxAgency(ctx, { name: 'R2 State' })).id;
      const city = (await createTaxAgency(ctx, { name: 'R2 City' })).id;
      const combo = (await createTaxRate(ctx, { name: 'R2 Combo', rate: '0.0725', agencyId: state })).id;
      await setComponents(ctx, combo, [
        { name: 'State 6%', rate: '0.06', agencyId: state },
        { name: 'City 1.25%', rate: '0.0125', agencyId: city },
      ]);
      const cust = (await createCustomer(ctx, { displayName: 'Combo Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2025-11-03'),
        taxRateId: combo,
        lines: [{ description: 'Odd', quantity: 3, rate: '33.33' }],
      });
      const [head] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      const total = cents(head.total);
      const a = Math.floor(total / 3);
      const amts = [a, a, total - 2 * a].map((c) => (c / 100).toFixed(2));
      await pay(cust, inv.id, '2025-11-20', amts[0]);
      await pay(cust, inv.id, '2025-12-05', amts[1]);
      await pay(cust, inv.id, '2026-01-07', amts[2]);
      const full = { from: d('2025-11-01'), to: eod('2026-01-31') };
      const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
      const accrual = await salesTaxLiabilityReport(ctx, full);
      for (const ag of [state, city]) {
        expect(net(accrual, ag)).not.toBe(0);
        expect(net(cash, ag)).toBe(net(accrual, ag));
      }
      // The months add up to the full range for each agency.
      const parts = await Promise.all([month('2025', '11'), month('2025', '12'), month('2026', '01')].map((r) => salesTaxLiabilityReport(ctx, r)));
      for (const ag of [state, city]) expect(parts.reduce((s, p) => s + net(p, ag), 0)).toBe(net(accrual, ag));
      expect(accrual.tiesToGl).toBe(true);
    });

    it('a voided middle payment drops out; the replacement payment completes exactly the invoice tax', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Void Middle Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-02-02'),
        taxRateId: rate,
        lines: [{ description: 'Goods', quantity: 1, rate: '100' }],
      });
      await pay(cust, inv.id, '2026-02-10', '35.00');
      const mid = await pay(cust, inv.id, '2026-03-10', '35.00');
      const midId = mid.payment.id;
      await voidPayment(ctx, midId);
      const march = await salesTaxLiabilityReport(ctx, month('2026', '03'));
      expect(collected(march, agency)).toBe(0);
      await pay(cust, inv.id, '2026-04-10', '70.00');
      const feb = collected(await salesTaxLiabilityReport(ctx, month('2026', '02')), agency);
      const apr = collected(await salesTaxLiabilityReport(ctx, month('2026', '04')), agency);
      expect(feb).toBe(167);
      expect(feb + apr).toBe(500);
    });

    it('an unapplied payment no longer settles the invoice; a partial invoice never over-recognizes', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Unapply Cust' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-05-02'),
        taxRateId: rate,
        lines: [{ description: 'Goods', quantity: 1, rate: '100' }],
      });
      const p = await pay(cust, inv.id, '2026-05-12', '52.50');
      const pid = p.payment.id;
      expect(collected(await salesTaxLiabilityReport(ctx, month('2026', '05')), agency)).toBe(250);
      await unapplyFromInvoice(ctx, { paymentId: pid, invoiceId: inv.id });
      expect(collected(await salesTaxLiabilityReport(ctx, month('2026', '05')), agency)).toBe(0);
    });

    it('running the cash report twice gives identical output (no hidden state)', async () => {
      const r = { from: d('2025-01-01'), to: eod('2026-12-31'), basis: 'cash' as const };
      const a = await salesTaxLiabilityReport(ctx, r);
      const b = await salesTaxLiabilityReport(ctx, r);
      expect(JSON.stringify(b.agencies)).toBe(JSON.stringify(a.agencies));
      expect(b.totals).toEqual(a.totals);
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });
  });

  describe('I2/I6 Batch Void scopes orphan cleanup to the batch', () => {
    it('voids only the new orphan, leaves the pre-existing one listed, and needs no Sales Tax rights', async () => {
      const { ctx, acct } = await newCompany('Retest2 Orphan Co');
      const agency = (await createTaxAgency(ctx, { name: 'R2 Orphan Agency' })).id;
      const mk = async (date: string) => {
        const e = await createExpense(ctx, {
          payeeName: 'R2 Orphan Agency',
          date: d(date),
          method: 'check',
          paymentAccountId: acct['1000'],
          lines: [{ accountId: acct['6700'], amount: '5', description: 'R2 Orphan Agency sales tax' }],
        });
        return (e as { id?: string; expense?: { id: string } }).expense?.id ?? (e as { id: string }).id;
      };
      const e1 = await mk('2026-06-02');
      const e2 = await mk('2026-06-03');
      const issues = (await findMisrecordedSalesTax(ctx)).filter((i) => i.issue === 'expense_payment');
      expect(issues.length).toBe(2);
      for (const i of issues) await reclassifySalesTaxPayment(ctx, { lineId: i.lineId, agencyId: agency });

      // e1 voided from its own screen → pre-existing orphan.
      await voidExpense(ctx, e1);
      const pre = (await findMisrecordedSalesTax(ctx)).filter((i) => i.issue === 'orphaned_fix');
      expect(pre.length).toBe(1);

      // A Banking-only clerk batch-voids e2 → only e2's correction goes.
      const clerk = { ...ctx, access: only({ banking: ['view', 'create', 'modify', 'delete'], accounting: ['view', 'delete'] }) } as ServiceContext;
      const r = await batchVoidTransactions(clerk, [`check:${e2}`]);
      expect(r.succeeded).toBe(1);
      expect(r.salesTaxFixesVoided).toBe(1);
      const after = (await findMisrecordedSalesTax(ctx)).filter((i) => i.issue === 'orphaned_fix');
      expect(after.map((o) => o.entryId)).toEqual(pre.map((o) => o.entryId));
      const [preRow] = await db.select().from(journalEntries).where(eq(journalEntries.id, pre[0].entryId!));
      expect(preRow.status).toBe('posted');

      // Re-running the same batch is idempotent: nothing new voided, nothing double-reversed.
      const again = await batchVoidTransactions(clerk, [`check:${e2}`]).catch(() => null);
      if (again) expect(again.salesTaxFixesVoided).toBe(0);
      expect((await salesTaxLiabilityReport(ctx)).tiesToGl).toBe(true);
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });
  });
});
