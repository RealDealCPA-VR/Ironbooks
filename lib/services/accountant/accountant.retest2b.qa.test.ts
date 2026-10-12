/**
 * Independent QA — second pass on accountant fix round 2 (a48dbbc), resumed run.
 * Extra adversarial checks of the D7 cumulative cash-basis allocation that the first re-test
 * did not cover:
 *   - foreign-currency invoice settled by foreign-currency payments at different rates
 *   - per-line rates (two rates, same agency) settled by a payment and a credit memo on the
 *     same day
 *   - a penny-tax invoice split into payments whose individual shares round to zero
 *   - cash-basis opening balance continuity (opening(next) == opening(prev) + net(prev) - paid)
 * Invariants: fully settled invoice => cash tax == accrual tax for each agency, ledger TB balanced,
 * accrual liability ties to the GL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, creditMemos, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createInvoice } from '../invoices';
import { applyToInvoice, createCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { trialBalance } from '../reports';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { salesTaxLiabilityReport } from './salesTaxLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-retest2b');
let db: DB;
let userId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const cents = (v: string | number) => Math.round(Number(v) * 100);

type Report = Awaited<ReturnType<typeof salesTaxLiabilityReport>>;
const ag = (r: Report, id: string) => r.agencies.find((x) => x.agencyId === id);
const net = (r: Report, id: string) => cents(ag(r, id)?.collected ?? 0) + cents(ag(r, id)?.credited ?? 0);
const collected = (r: Report, id: string) => cents(ag(r, id)?.collected ?? 0);

describe('wave2 accountant — re-test 2b of fix round 2 (cash basis)', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;

  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-retest2b@test.local', name: 'Retester 2b', passwordHash: 'x' })
      .returning();
    userId = user.id;
    const company = await createCompany(db, { name: 'Retest2b Co', ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('foreign-currency invoice paid in three FX payments at different rates: cash == accrual (home currency)', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'FX County' })).id;
    const rate = (await createTaxRate(ctx, { name: 'FX 5%', rate: '0.05', agencyId: agency })).id;
    const cust = (await createCustomer(ctx, { displayName: 'FX Cust' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2025-01-03'),
      taxRateId: rate,
      currency: 'EUR',
      exchangeRate: '1.37',
      lines: [{ description: 'EUR goods', quantity: 1, rate: '100' }],
    }); // EUR 105.00, tax EUR 5.00 = USD 6.85
    const [head] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(head.total).toBe('105.00');
    const fx: Array<[string, string, string]> = [
      ['2025-01-20', '35.00', '1.31'],
      ['2025-02-20', '35.00', '1.44'],
      ['2025-03-20', '35.00', '1.29'],
    ];
    for (const [date, amt, xr] of fx) {
      await receivePayment(ctx, {
        customerId: cust,
        date: d(date),
        method: 'bank_transfer',
        amount: amt,
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: amt }],
        currency: 'EUR',
        exchangeRate: xr,
      });
    }
    const full = { from: d('2025-01-01'), to: eod('2025-03-31') };
    const accrual = await salesTaxLiabilityReport(ctx, full);
    const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
    // Sales tax is recognised at the booked (invoice) rate: 5.00 EUR x 1.37 = 6.85.
    expect(net(accrual, agency)).toBe(685);
    expect(net(cash, agency)).toBe(685);
    const months = await Promise.all(
      [
        ['2025-01-01', '2025-01-31'],
        ['2025-02-01', '2025-02-28'],
        ['2025-03-01', '2025-03-31'],
      ].map(([f, t]) => salesTaxLiabilityReport(ctx, { from: d(f), to: eod(t), basis: 'cash' })),
    );
    const per = months.map((m) => collected(m, agency));
    for (const c of per) expect(Math.abs(c - 685 / 3)).toBeLessThanOrEqual(1);
    expect(per.reduce((s, c) => s + c, 0)).toBe(685);
    expect(accrual.tiesToGl).toBe(true);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('per-line rates on one agency, settled by a payment and a credit memo on the same day: cash == accrual', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'Lines County' })).id;
    const r5 = (await createTaxRate(ctx, { name: 'L 5%', rate: '0.05', agencyId: agency })).id;
    const r7 = (await createTaxRate(ctx, { name: 'L 7.25%', rate: '0.0725', agencyId: agency })).id;
    const cust = (await createCustomer(ctx, { displayName: 'Lines Cust' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2025-04-02'),
      taxRateId: r5,
      lines: [
        { description: 'Five', quantity: 3, rate: '11.11', taxRateId: r5 },
        { description: 'Seven', quantity: 7, rate: '13.13', taxRateId: r7 },
      ],
    });
    const [head] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2025-05-09'),
      taxRateId: r5,
      lines: [{ description: 'Return', quantity: 1, rate: '9.99' }],
    });
    const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id));
    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: m.total });
    const rest = (cents(head.total) - cents(m.total)) / 100;
    await receivePayment(ctx, {
      customerId: cust,
      date: d('2025-05-09'),
      method: 'check',
      amount: rest.toFixed(2),
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: rest.toFixed(2) }],
    });
    const [after] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(after.balanceDue).toBe('0.00');

    const full = { from: d('2025-04-01'), to: eod('2025-05-31') };
    const accrual = await salesTaxLiabilityReport(ctx, full);
    const cash = await salesTaxLiabilityReport(ctx, { ...full, basis: 'cash' });
    expect(net(accrual, agency)).toBeGreaterThan(0);
    expect(net(cash, agency)).toBe(net(accrual, agency));
    // Nothing recognised in April on cash basis (unpaid), everything in May.
    const apr = await salesTaxLiabilityReport(ctx, { from: d('2025-04-01'), to: eod('2025-04-30'), basis: 'cash' });
    expect(collected(apr, agency)).toBe(0);
    // Component rows add up to the agency's collected figure.
    const a = ag(cash, agency)!;
    const compSum = a.components.reduce((s, c) => s + cents(c.collected), 0);
    expect(compSum).toBe(cents(a.collected));
    expect(accrual.tiesToGl).toBe(true);
  });

  it('a penny of tax split over payments whose individual shares round to zero is still recognized once', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'Penny County' })).id;
    const rate = (await createTaxRate(ctx, { name: 'P 5%', rate: '0.05', agencyId: agency })).id;
    const cust = (await createCustomer(ctx, { displayName: 'Penny Cust' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2025-06-02'),
      taxRateId: rate,
      lines: [{ description: 'Gum', quantity: 1, rate: '0.20' }],
    }); // 0.20 + 0.01 tax = 0.21
    const [head] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(head.total).toBe('0.21');
    const days = ['2025-06-10', '2025-07-10', '2025-08-10'];
    for (const day of days) {
      await receivePayment(ctx, {
        customerId: cust,
        date: d(day),
        method: 'cash',
        amount: '0.07',
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '0.07' }],
      });
    }
    const per = await Promise.all(
      [
        ['2025-06-01', '2025-06-30'],
        ['2025-07-01', '2025-07-31'],
        ['2025-08-01', '2025-08-31'],
      ].map(async ([f, t]) => collected(await salesTaxLiabilityReport(ctx, { from: d(f), to: eod(t), basis: 'cash' }), agency)),
    );
    expect(per.every((c) => c >= 0 && c <= 1)).toBe(true);
    expect(per.reduce((s, c) => s + c, 0)).toBe(1);
  });

  it('cash-basis opening balance carries forward exactly from the prior period', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'Carry County' })).id;
    const rate = (await createTaxRate(ctx, { name: 'C 6%', rate: '0.06', agencyId: agency })).id;
    const cust = (await createCustomer(ctx, { displayName: 'Carry Cust' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2025-09-02'),
      taxRateId: rate,
      lines: [{ description: 'Svc', quantity: 1, rate: '333.33' }],
    }); // tax 20.00 → total 353.33
    const [head] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    const third = Math.floor(cents(head.total) / 3);
    const amts = [third, third, cents(head.total) - 2 * third].map((c) => (c / 100).toFixed(2));
    const dates = ['2025-09-15', '2025-10-15', '2025-11-15'];
    for (let i = 0; i < 3; i++) {
      await receivePayment(ctx, {
        customerId: cust,
        date: d(dates[i]),
        method: 'check',
        amount: amts[i],
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: amts[i] }],
      });
    }
    const ranges = [
      ['2025-09-01', '2025-09-30'],
      ['2025-10-01', '2025-10-31'],
      ['2025-11-01', '2025-11-30'],
      ['2025-12-01', '2025-12-31'],
    ];
    const reps = await Promise.all(ranges.map(([f, t]) => salesTaxLiabilityReport(ctx, { from: d(f), to: eod(t), basis: 'cash' })));
    for (let i = 1; i < reps.length; i++) {
      const prev = ag(reps[i - 1], agency)!;
      const cur = ag(reps[i], agency)!;
      expect(cents(cur.openingBalance)).toBe(cents(prev.balance));
    }
    expect(cents(ag(reps[3], agency)!.openingBalance)).toBe(2000);
    expect(reps.slice(0, 3).reduce((s, r) => s + collected(r, agency), 0)).toBe(2000);
  });
});
