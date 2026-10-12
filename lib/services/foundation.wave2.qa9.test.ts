/**
 * Wave-2 GL foundation — QA round 9: re-test fix round 6 (Retainage Receivable is an Other
 * Current Asset, I11) through every path an invoice with retainage can take: edit, void, draft
 * then post, credit memo, payment, rounding, tax + discount, account rename / retype attempts,
 * cash basis, statements and the integrity check.
 *
 * Invariants checked after every step: trial balance balanced, A/R accounts on the balance sheet
 * == A/R aging total (I11), and 1250 moves by exactly the invoice's stored retainageAmount.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice, getInvoice, postDraftInvoice, updateInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { applyToInvoice, createCreditMemo } from './creditMemos';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';
import { verifyIntegrity } from './integrity';
import { updateAccount } from './accounts';
import { createManualEntry } from './journal';
import { customerStatement } from './statements';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa9');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);
const DAY = new Date(2026, 6, 15);

async function acct(c: string) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row;
}
async function arControl(asOf = D) {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, 'accounts_receivable')))
    ).map((r) => r.id),
  );
  let total = Money.zero();
  for (const r of tb.rows) if (ids.has(r.accountId)) total = total.plus(Money.of(r.debit)).minus(Money.of(r.credit));
  return total;
}
async function arGap(asOf = D) {
  return Number((await arControl(asOf)).minus(Money.of((await arAging(ctx, asOf)).totals.total)).toFixed(2));
}
async function arRow(customerId: string, asOf = D) {
  return Number((await arAging(ctx, asOf)).rows.find((r) => r.id === customerId)?.total ?? 0);
}
async function bal(c: string) {
  return Money.of((await acct(c)).balance);
}
async function tbBalanced() {
  const tb = await trialBalance(ctx, D);
  let dr = Money.zero();
  let cr = Money.zero();
  for (const r of tb.rows) {
    dr = dr.plus(Money.of(r.debit));
    cr = cr.plus(Money.of(r.credit));
  }
  return dr.toFixed(2) === cr.toFixed(2);
}
async function customer(name: string) {
  return (await createCustomer(ctx, { displayName: name })).id;
}
function line(rate: string, extra: Record<string, unknown> = {}) {
  return { accountId: code['4000'], quantity: 1, rate, taxable: false, ...extra };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa9@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA9 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '1250', '4000', '3000']) {
    const a = await acct(c);
    if (a) code[c] = a.id;
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('QA9: retainage through every invoice path keeps I11 and the ledger balanced', () => {
  it('editing the retainage percent (10% → 25% → none) moves 1250 and A/R exactly; aging follows', async () => {
    const c = await customer('QA9 Edit');
    const g0 = await arGap();
    const r0 = await bal('1250');
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('2000.00')], retainagePercent: 10 });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('200.00');
    expect(await arRow(c)).toBe(1800);
    expect(await arGap()).toBe(g0);

    await updateInvoice(ctx, inv.id, { customerId: c, date: DAY, lines: [line('2000.00')], retainagePercent: 25 });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('500.00');
    expect(await arRow(c)).toBe(1500);
    expect(await arGap()).toBe(g0);

    await updateInvoice(ctx, inv.id, { customerId: c, date: DAY, lines: [line('2000.00')], retainagePercent: null });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('0.00');
    expect(await arRow(c)).toBe(2000);
    expect(await arGap()).toBe(g0);
    expect(await tbBalanced()).toBe(true);
  });

  it('voiding a retainage invoice reverses 1250 and A/R; aging and GL agree', async () => {
    const c = await customer('QA9 Void');
    const g0 = await arGap();
    const r0 = await bal('1250');
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('750.00')], retainagePercent: 5 });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('37.50');
    await voidInvoice(ctx, inv.id);
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('0.00');
    expect(await arRow(c)).toBe(0);
    expect(await arGap()).toBe(g0);
    expect(await tbBalanced()).toBe(true);
  });

  it('a draft retainage invoice posts nothing until posted, then posts retainage to the Other Current Asset', async () => {
    const c = await customer('QA9 Draft');
    const g0 = await arGap();
    const r0 = await bal('1250');
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [line('400.00')],
      retainagePercent: 10,
      status: 'draft',
    });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('0.00');
    expect(await arGap()).toBe(g0);
    await postDraftInvoice(ctx, inv.id);
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('40.00');
    expect(await arRow(c)).toBe(360);
    expect(await arGap()).toBe(g0);
  });

  it('100% retainage: nothing is due now, nothing reaches A/R, the whole amount sits in 1250', async () => {
    const c = await customer('QA9 Full Hold');
    const g0 = await arGap();
    const a0 = await bal('1200');
    const r0 = await bal('1250');
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('321.00')], retainagePercent: 100 });
    expect(Money.of(inv.balanceDue).toFixed(2)).toBe('0.00');
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('321.00');
    expect((await bal('1200')).minus(a0).toFixed(2)).toBe('0.00');
    expect(await arRow(c)).toBe(0);
    expect(await arGap()).toBe(g0);
  });

  it('rounding: odd percentages and cents — 1250 gets exactly the stored retainage, A/R exactly the balance due', async () => {
    const cases: Array<[string, string]> = [
      ['333.33', '33.33'],
      ['0.03', '33.33'],
      ['1000.01', '12.5'],
      ['99.99', '0.01'],
      ['10.00', '66.67'],
    ];
    for (const [rate, pct] of cases) {
      const c = await customer(`QA9 Round ${rate}/${pct}`);
      const g0 = await arGap();
      const a0 = await bal('1200');
      const r0 = await bal('1250');
      const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line(rate)], retainagePercent: pct });
      const stored = await getInvoice(ctx, inv.id);
      expect((await bal('1250')).minus(r0).toFixed(2)).toBe(Money.of(stored.retainageAmount).toFixed(2));
      expect((await bal('1200')).minus(a0).toFixed(2)).toBe(Money.of(stored.balanceDue).toFixed(2));
      expect(
        Money.of(stored.retainageAmount).plus(Money.of(stored.balanceDue)).toFixed(2),
      ).toBe(Money.of(stored.total).toFixed(2));
      expect(await arGap()).toBe(g0);
    }
    expect(await tbBalanced()).toBe(true);
  });

  it('retainage with a header discount: 1250 + A/R == total and I11 holds', async () => {
    const c = await customer('QA9 Discount');
    const g0 = await arGap();
    const r0 = await bal('1250');
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [line('1000.00'), line('250.00')],
      discount: 10,
      discountType: 'percent',
      retainagePercent: 10,
    });
    // total = 1250 - 125 = 1125; retainage 112.50; due 1012.50
    expect(Money.of(inv.total).toFixed(2)).toBe('1125.00');
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('112.50');
    expect(await arRow(c)).toBe(1012.5);
    expect(await arGap()).toBe(g0);
    expect(await tbBalanced()).toBe(true);
  });

  it('a payment cannot be applied beyond the billed base (the retainage is not owed yet)', async () => {
    const c = await customer('QA9 Overpay');
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('1000.00')], retainagePercent: 10 });
    const g0 = await arGap();
    const a0 = await bal('1200');
    await expect(
      receivePayment(ctx, {
        customerId: c,
        date: DAY,
        amount: '1000.00',
        method: 'check',
        depositAccountId: code['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '1000.00' }],
      }),
    ).rejects.toThrow();
    expect((await bal('1200')).toFixed(2)).toBe(a0.toFixed(2));
    expect(await arGap()).toBe(g0);
    expect(await arRow(c)).toBe(900);
  });

  it('a credit memo applied to a retainage invoice: capped at the billed base, I11 holds', async () => {
    const c = await customer('QA9 Credit');
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('500.00')], retainagePercent: 20 });
    const cm = await createCreditMemo(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '600.00', taxable: false } as never],
    });
    const g0 = await arGap();
    await expect(applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '500.00' })).rejects.toThrow();
    expect(await arGap()).toBe(g0);
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '400.00' });
    expect(Money.of((await getInvoice(ctx, inv.id)).balanceDue).toFixed(2)).toBe('0.00');
    // Customer still has 200 unapplied credit; aging shows it as a negative item.
    expect(await arRow(c)).toBe(-200);
    expect(await arGap()).toBe(g0);
  });

  it('partial payment then a backdated aging: I11 holds both before and after the payment date', async () => {
    const c = await customer('QA9 Backdated');
    const early = new Date(2026, 6, 1);
    const later = new Date(2026, 7, 1);
    const g0e = await arGap(new Date(2026, 6, 20));
    const g0 = await arGap();
    const inv = await createInvoice(ctx, { customerId: c, date: early, lines: [line('800.00')], retainagePercent: 10 });
    await receivePayment(ctx, {
      customerId: c,
      date: later,
      amount: '300.00',
      method: 'check',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '300.00' }],
    });
    expect(await arRow(c, new Date(2026, 6, 20))).toBe(720);
    expect(await arRow(c)).toBe(420);
    expect(await arGap(new Date(2026, 6, 20))).toBe(g0e);
    expect(await arGap()).toBe(g0);
  });

  it('a customer statement shows the billed balance (A/R), not the retainage held back', async () => {
    const c = await customer('QA9 Statement');
    await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('1000.00')], retainagePercent: 10 });
    const st = await customerStatement(ctx, c, { to: D });
    expect(Money.of(st.closingBalance).toFixed(2)).toBe(Money.of(await arRow(c)).toFixed(2));
  });

  it('a journal entry on 1250 needs no customer name now (it is not an A/R account) and leaves aging alone', async () => {
    const g0 = await arGap();
    await createManualEntry(ctx, {
      date: DAY,
      description: 'QA9 retainage reclass',
      lines: [
        { accountId: code['1250'], debit: '15.00' },
        { accountId: code['4000'], credit: '15.00' },
      ],
    });
    expect(await arGap()).toBe(g0);
    expect(await tbBalanced()).toBe(true);
  });

  it('1250 with history cannot be turned back into an A/R account (that would reopen the I11 gap)', async () => {
    const id = code['1250'];
    await expect(updateAccount(ctx, id, { qbType: 'accounts_receivable' } as never)).rejects.toThrow(
      /already has transactions/,
    );
    await expect(updateAccount(ctx, id, { subtype: 'accounts_receivable' })).rejects.toThrow(/already has transactions/);
    expect((await acct('1250')).subtype).toBe('other_current_asset');
  });

  it('renaming 1250 keeps retainage working, the cash-basis balance sheet balanced and agreeing with cash P&L', async () => {
    await updateAccount(ctx, code['1250'], { name: 'Contract Holdbacks' });
    const c = await customer('QA9 Renamed');
    const g0 = await arGap();
    const r0 = await bal('1250');
    await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('600.00')], retainagePercent: 10 });
    expect((await bal('1250')).minus(r0).toFixed(2)).toBe('60.00');
    expect(await arGap()).toBe(g0);

    const bs = await balanceSheetCashBasis(ctx);
    expect(bs.balanced).toBe(true);
    const pl = await profitAndLossCashBasis(ctx);
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
    await updateAccount(ctx, code['1250'], { name: 'Retainage Receivable' });
  });

  it('cash-basis balance sheet stays balanced and agrees with cash P&L after all of the above', async () => {
    const bs = await balanceSheetCashBasis(ctx);
    expect(bs.balanced).toBe(true);
    const pl = await profitAndLossCashBasis(ctx);
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
  });

  it('the integrity check is clean and the trial balance balanced at the end', async () => {
    const integrity = await verifyIntegrity(ctx);
    expect(integrity.checks.filter((k) => !k.ok)).toEqual([]);
    expect(await tbBalanced()).toBe(true);
  });
});

/**
 * Isolation of the failures above in a fresh company (no retainage involved), so the doer can
 * see which part is retainage-specific and which is a general I11 hole.
 */
describe('QA9: isolated I11 holes found while re-testing retainage', () => {
  let saved: ServiceContext;
  beforeAll(async () => {
    saved = ctx;
    const [user] = await db
      .insert(users)
      .values({ email: 'wave2-foundation-qa9b@test.local', name: 'QA b', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Foundation QA9 Isolated Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const c of ['1000', '1200', '1250', '4000']) code[c] = (await acct(c))!.id;
  });
  afterAll(() => {
    ctx = saved;
  });

  it('a draft (pending) invoice without retainage is not in A/R aging (it posts nothing to A/R)', async () => {
    const c = await customer('QA9b Draft');
    const g0 = await arGap();
    await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('250.00')], status: 'draft' });
    expect(await arRow(c)).toBe(0);
    expect(await arGap()).toBe(g0);
  });

  it('a draft (pending) invoice is not on the customer statement', async () => {
    const c = await customer('QA9b Draft Statement');
    await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('250.00')], status: 'draft' });
    const st = await customerStatement(ctx, c, { to: D });
    expect(Money.of(st.closingBalance).toFixed(2)).toBe('0.00');
  });

  it('a customer statement for a retainage invoice ends at the billed balance, with and without a from date', async () => {
    const c = await customer('QA9b Retainage Statement');
    await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('1000.00')], retainagePercent: 10 });
    const st = await customerStatement(ctx, c, { to: D });
    expect(Money.of(st.closingBalance).toFixed(2)).toBe('900.00');
    const later = await customerStatement(ctx, c, { from: new Date(2026, 8, 1), to: D });
    expect(Money.of(later.openingBalance).toFixed(2)).toBe('900.00');
  });

  it('integrity: an unapplied credit memo (no retainage) does not make the A/R check fail', async () => {
    const c = await customer('QA9b Credit');
    const g0 = await arGap();
    const inv = await createInvoice(ctx, { customerId: c, date: DAY, lines: [line('400.00')] });
    const cm = await createCreditMemo(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '600.00', taxable: false } as never],
    });
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '400.00' });
    expect(await arRow(c)).toBe(-200);
    expect(await arGap()).toBe(g0);
    const integrity = await verifyIntegrity(ctx);
    expect(integrity.checks.filter((k) => !k.ok && /A\/R control/.test(k.name))).toEqual([]);
  });
});
