/**
 * Independent QA, re-test round 3 of the cash-basis line split (Balinski-Young quota step).
 *
 * Properties checked over random documents and settlement sequences:
 *  - quota: on any monotone (payments only) sequence, every line is strictly less than one cent
 *    from its exact share of its sign group's target, and less than two cents from frac x line;
 *  - house-monotone: a payment never moves a line against its sign;
 *  - exact: each settlement recognizes exactly round2(frac x net); frac = 1 lands every line;
 *  - integration: per-account cash P&L for partial payments matches the pro-rata share to the
 *    cent, ties out to accrual when fully paid, and the cash BS / TB stay balanced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type Decimal from 'decimal.js';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { cashBasisLedger, splitCumulative } from './cashBasisLedger';
import { trialBalanceReport } from './reportsStandard';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Check one split result against all invariants; returns nothing, throws on failure. */
function checkStep(tag: string, nets: Decimal[], frac: Decimal, prev: Decimal[], cur: Decimal[], up: boolean, quota: boolean) {
  const net = nets.reduce((a, x) => a.plus(x), Money.zero());
  const f = frac.greaterThanOrEqualTo(1) ? Money.of(1) : frac;
  const total = cur.reduce((a, x) => a.plus(x), Money.zero());
  expect(total.toFixed(2), `${tag}: total`).toBe(Money.round2(Money.mul(net, f)).toFixed(2));
  // sign groups and their recognized totals
  const grp = (s: number) => nets.map((x, i) => i).filter((i) => nets[i].s === s && !nets[i].isZero());
  for (const s of [1, -1]) {
    const idx = grp(s);
    if (idx.length === 0) continue;
    const gTotal = idx.reduce((a, i) => a.plus(nets[i]), Money.zero());
    const gRec = idx.reduce((a, i) => a.plus(cur[i]), Money.zero());
    for (const i of idx) {
      const inc = cur[i].minus(prev[i]);
      const dir = up ? nets[i].s : -nets[i].s;
      expect(inc.isZero() || inc.s === dir, `${tag} line ${i}: moved ${inc.toFixed(2)} against direction`).toBe(true);
      expect(cur[i].abs().lessThanOrEqualTo(nets[i].abs()), `${tag} line ${i}: beyond its amount`).toBe(true);
      expect(cur[i].isZero() || cur[i].s === nets[i].s, `${tag} line ${i}: sign flipped`).toBe(true);
      if (quota) {
        const groupShare = Money.mul(gRec, Money.div(nets[i], gTotal));
        expect(
          cur[i].minus(groupShare).abs().lessThan('0.01'),
          `${tag} line ${i}: ${cur[i].toFixed(2)} vs group share ${groupShare.toFixed(4)}`,
        ).toBe(true);
        const exact = Money.mul(nets[i], f);
        expect(
          cur[i].minus(exact).abs().lessThan('0.02'),
          `${tag} line ${i}: ${cur[i].toFixed(2)} vs exact ${exact.toFixed(4)}`,
        ).toBe(true);
      }
    }
  }
}

function runSequence(tag: string, nets: Decimal[], cumsCents: number[], quota: boolean) {
  const net = nets.reduce((a, x) => a.plus(x), Money.zero());
  const base = net.abs();
  let prev = nets.map(() => Money.zero());
  let prevCum = 0;
  for (const c of cumsCents) {
    const frac = Money.div(c / 100, base);
    const cur = splitCumulative(nets, frac, prev);
    checkStep(`${tag} cum ${prevCum}->${c}`, nets, frac, prev, cur, c >= prevCum, quota);
    prev = cur;
    prevCum = c;
  }
  return prev;
}

describe('splitCumulative quota + monotone (re-test 3)', () => {
  it('payments only: random documents, every step within quota, lands exactly', () => {
    const r = rng(31337);
    for (let t = 0; t < 400; t++) {
      const k = 1 + Math.floor(r() * 20);
      const nets = Array.from({ length: k }, () => {
        const sz = r();
        const c = 1 + Math.floor(r() * (sz < 0.4 ? 100 : sz < 0.8 ? 100_000 : 5_000_000));
        return Money.of(-c / 100);
      });
      const base = nets.reduce((a, x) => a.plus(x), Money.zero()).abs();
      const bc = Math.round(base.toNumber() * 100);
      const cums: number[] = [];
      let cum = 0;
      while (cum < bc) {
        cum = Math.min(bc, cum + 1 + Math.floor(r() * Math.max(1, bc / (2 + Math.floor(r() * 10)))));
        cums.push(cum);
      }
      const last = runSequence(`trial ${t}`, nets, cums, true);
      last.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });

  it('payments only, mixed signs (income + COGS): within two cents of exact, monotone, exact totals', () => {
    const r = rng(4242);
    for (let t = 0; t < 300; t++) {
      const k = 2 + Math.floor(r() * 10);
      const nets = Array.from({ length: k }, (_, i) => {
        const c = 1 + Math.floor(r() * (r() < 0.5 ? 500 : 1_000_000));
        return Money.of((i === 0 || r() < 0.6 ? -c : c) / 100);
      });
      const net = nets.reduce((a, x) => a.plus(x), Money.zero());
      if (net.isZero()) continue;
      const bc = Math.round(net.abs().toNumber() * 100);
      const cums: number[] = [];
      let cum = 0;
      while (cum < bc) {
        cum = Math.min(bc, cum + 1 + Math.floor(r() * Math.max(1, bc / 4)));
        cums.push(cum);
      }
      const last = runSequence(`mixed ${t}`, nets, cums, true);
      last.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });

  it('exhaustive one-cent payments on small documents: every house within quota', () => {
    const docs = [
      ['-0.07', '-0.05', '-0.03'],
      ['-1.00', '-0.01', '-0.01', '-0.01'],
      ['-0.10', '-0.09', '-0.08', '-0.07', '-0.06'],
      ['-3.33', '-3.33', '-3.34'],
      ['-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-0.50', '-10.00'],
      ['-2.00', '-0.03', '-0.03', '-0.03', '-0.03', '-0.03', '-0.03', '-0.03'],
    ];
    for (const raw of docs) {
      const nets = raw.map((x) => Money.of(x));
      const bc = Math.round(nets.reduce((a, x) => a.plus(x), Money.zero()).abs().toNumber() * 100);
      const cums = Array.from({ length: bc }, (_, i) => i + 1);
      const last = runSequence(`doc [${raw.join(',')}]`, nets, cums, true);
      last.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });

  it('auditor repro, any number of small lines, any fraction n/7: main line exact to the cent', () => {
    for (const k of [1, 10, 40, 99]) {
      const nets = [Money.of('-10000.00'), ...Array.from({ length: k }, () => Money.of('-0.50'))];
      const base = nets.reduce((a, x) => a.plus(x), Money.zero()).abs();
      let prev = nets.map(() => Money.zero());
      for (let n = 1; n <= 7; n++) {
        const frac = Money.div(n, 7);
        const cur = splitCumulative(nets, frac, prev);
        checkStep(`k=${k} ${n}/7`, nets, frac, prev, cur, true, true);
        // the big line is the one a reader checks: |x - exact| <= half a cent + group rounding
        const exact = Money.mul(nets[0], frac);
        expect(cur[0].minus(exact).abs().lessThanOrEqualTo('0.01'), `k=${k} ${n}/7 main ${cur[0].toFixed(2)} vs ${exact.toFixed(4)}`).toBe(true);
        prev = cur;
      }
      void base;
    }
  });

  it('a bounced check followed by repayment stays monotone and lands exactly (quota may lapse)', () => {
    const r = rng(777);
    for (let t = 0; t < 200; t++) {
      const k = 1 + Math.floor(r() * 12);
      const nets = Array.from({ length: k }, () => Money.of(-(1 + Math.floor(r() * (r() < 0.5 ? 300 : 200_000))) / 100));
      const bc = Math.round(nets.reduce((a, x) => a.plus(x), Money.zero()).abs().toNumber() * 100);
      const cums: number[] = [];
      let cum = 0;
      while (cum < bc) {
        const up = cum === 0 || r() < 0.7;
        const dlt = 1 + Math.floor(r() * Math.max(1, bc / 3));
        cum = up ? Math.min(bc, cum + dlt) : Math.max(0, cum - dlt);
        cums.push(cum);
      }
      const last = runSequence(`bounce ${t}`, nets, cums, false);
      last.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });

  it('without prev (fresh split) every line is within quota and the call is idempotent', () => {
    const r = rng(9001);
    for (let t = 0; t < 200; t++) {
      const k = 1 + Math.floor(r() * 30);
      const nets = Array.from({ length: k }, () => Money.of(-(1 + Math.floor(r() * (r() < 0.5 ? 200 : 900_000))) / 100));
      const frac = Money.of(r().toFixed(6));
      const a = splitCumulative(nets, frac);
      checkStep(`fresh ${t}`, nets, frac, nets.map(() => Money.zero()), a, true, true);
      // same frac again from its own result: nothing moves
      const b = splitCumulative(nets, frac, a);
      b.forEach((x, i) => expect(x.toFixed(2), `fresh ${t} line ${i} re-split moved`).toBe(a[i].toFixed(2)));
    }
  });

  it('large documents stay fast (quota step is not quadratic in cents)', () => {
    const nets = Array.from({ length: 200 }, (_, i) => Money.of(-(1_000_000 + i * 7919) / 100));
    const t0 = Date.now();
    let prev = nets.map(() => Money.zero());
    for (let n = 1; n <= 50; n++) prev = splitCumulative(nets, Money.div(n, 50), prev);
    expect(Date.now() - t0).toBeLessThan(10_000);
    prev.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
  });
});

// ---------------------------------------------------------------------------------------------
// Integration through the real ledger and reports.

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-retest3');
let db: DB;
let userId: string;
let n = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);

async function newCompany() {
  const company = await createCompany(db, { name: `Cash Retest3 Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  const customer = (await createCustomer(ctx, { displayName: 'Acme' })).id;
  const vendor = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  return { ctx, code, customer, vendor };
}
type Co = Awaited<ReturnType<typeof newCompany>>;

async function invariants(co: Co, asOf: string) {
  const at = eod(asOf);
  const bs = await balanceSheetCashBasis(co.ctx, at);
  expect(bs.balanced, `cash BS balanced @${asOf}`).toBe(true);
  const pl = await profitAndLossCashBasis(co.ctx, { from: d('2000-01-01'), to: at });
  expect(bs.retainedEarnings, `cash BS earnings == cash P&L @${asOf}`).toBe(pl.netIncome);
  const tb = await trialBalanceReport(co.ctx, { asOf, basis: 'cash' });
  expect(tb.balanced, `cash TB balanced @${asOf}`).toBe(true);
  const { adjustments } = await cashBasisLedger(co.ctx, { to: at });
  expect(adjustments.reduce((s, a) => s.plus(a.net), Money.zero()).toFixed(2)).toBe('0.00');
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'cash-retest3@test.local', name: 'Retest3', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cash P&L per account is pro-rata to the cent (re-test 3, integration)', () => {
  it('three payments of thirds on an invoice with many small fee lines: each month per account within quota, total ties to accrual', async () => {
    const co = await newCompany();
    const fees: string[] = [];
    for (let i = 0; i < 12; i++) {
      const a = await createAccount(co.ctx, { code: `48${String(i).padStart(2, '0')}`, name: `Fee R3 ${i}`, type: 'revenue', subtype: 'other_income' });
      fees.push(a.id);
    }
    // 10,000.00 + 12 x 0.25 = 10,003.00, paid 3,334.33 + 3,334.33 + 3,334.34
    const inv = await createInvoice(co.ctx, {
      customerId: co.customer,
      date: d('2026-01-05'),
      lines: [
        { accountId: co.code['4000'], quantity: 1, rate: '10000.00', taxable: false },
        ...fees.map((id) => ({ accountId: id, quantity: 1, rate: '0.25', taxable: false })),
      ],
    });
    const pays: [string, string][] = [
      ['2026-02-10', '3334.33'],
      ['2026-03-10', '3334.33'],
      ['2026-04-10', '3334.34'],
    ];
    let paid = Money.zero();
    for (const [date, amt] of pays) {
      await receivePayment(co.ctx, {
        customerId: co.customer,
        date: d(date),
        amount: amt,
        method: 'check',
        depositAccountId: co.code['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: amt }],
      });
      paid = paid.plus(amt);
      // cumulative through this payment
      const pl = await profitAndLossCashBasis(co.ctx, { from: d('2026-01-01'), to: eod(date) });
      expect(pl.netIncome).toBe(paid.toFixed(2));
      const frac = Money.div(paid, '10003.00');
      const main = pl.income.find((l) => l.accountId === co.code['4000']);
      const exact = Money.mul('10000.00', frac);
      expect(Money.of(main!.amount).minus(exact).abs().lessThan('0.01'), `main ${main!.amount} vs ${exact.toFixed(4)} @${date}`).toBe(true);
      for (const id of fees) {
        const l = pl.income.find((x) => x.accountId === id);
        const amt2 = Money.of(l?.amount ?? '0');
        expect(amt2.minus(Money.mul('0.25', frac)).abs().lessThan('0.01'), `fee ${amt2.toFixed(2)} @${date}`).toBe(true);
      }
      await invariants(co, date);
    }
    const all = await profitAndLossCashBasis(co.ctx, { from: d('2026-01-01'), to: eod('2026-12-31') });
    expect(all.income.find((l) => l.accountId === co.code['4000'])?.amount).toBe('10000.00');
    for (const id of fees) expect(all.income.find((l) => l.accountId === id)?.amount).toBe('0.25');
  });

  it('bill with expense lines on many accounts paid in two halves: per-account quota and balanced books', async () => {
    const co = await newCompany();
    const exp: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = await createAccount(co.ctx, { code: `68${String(i).padStart(2, '0')}`, name: `Exp R3 ${i}`, type: 'expense', subtype: 'operating_expenses' });
      exp.push(a.id);
    }
    const bill = await createBill(co.ctx, {
      vendorId: co.vendor,
      date: d('2026-01-10'),
      lines: [{ accountId: co.code['6000'], amount: '999.99' }, ...exp.map((id) => ({ accountId: id, amount: '0.03' }))],
    });
    // total 1000.23; pay 500.11 then 500.12
    await payBills(co.ctx, { vendorId: co.vendor, date: d('2026-02-01'), method: 'check', paymentAccountId: co.code['1000'], applications: [{ billId: bill.id, amountApplied: '500.11' }] });
    const pl = await profitAndLossCashBasis(co.ctx, { from: d('2026-01-01'), to: eod('2026-02-28') });
    expect(pl.netIncome).toBe('-500.11');
    const frac = Money.div('500.11', '1000.23');
    const main = pl.expenses.find((l) => l.accountId === co.code['6000']);
    expect(Money.of(main!.amount).minus(Money.mul('999.99', frac)).abs().lessThan('0.01'), `main ${main!.amount}`).toBe(true);
    for (const id of exp) {
      const v = Money.of(pl.expenses.find((l) => l.accountId === id)?.amount ?? '0');
      expect(v.minus(Money.mul('0.03', frac)).abs().lessThan('0.01'), `small ${v.toFixed(2)}`).toBe(true);
    }
    await invariants(co, '2026-02-28');
    await payBills(co.ctx, { vendorId: co.vendor, date: d('2026-03-01'), method: 'check', paymentAccountId: co.code['1000'], applications: [{ billId: bill.id, amountApplied: '500.12' }] });
    const all = await profitAndLossCashBasis(co.ctx, { from: d('2026-01-01'), to: eod('2026-03-31') });
    expect(all.netIncome).toBe('-1000.23');
    expect(all.expenses.find((l) => l.accountId === co.code['6000'])?.amount).toBe('999.99');
    await invariants(co, '2026-03-31');
  });
});
