/**
 * Wave-2 GL foundation — independent QA, round 6 (re-test of fix round 3).
 *
 * Fix round 3 added a central guard in posting.ts (assertControlAccountNames) that refuses an
 * unnamed A/R / A/P line — but it EXEMPTS every posting whose sourceRef is a customer/vendor
 * document (invoice:, bill:, customer:, vendor:, salesreceipt:, refund:, …) and every posting
 * with no sourceRef at all. This round attacks I11 (A/R aging == A/R GL, A/P aging == A/P GL)
 * through exactly those exempt paths, where the user still picks an arbitrary GL account:
 *   - Receive Payments "Deposit to" account,
 *   - Sales Receipt "Deposit to" account and line accounts,
 *   - Bill expense-line accounts,
 *   - Pay Sales Tax with no agency (posts with no sourceRef),
 * plus the account-structure rules (type change with history, sub-account type on update) and
 * positive controls so the new rules do not over-block legitimate QB workflows.
 *
 * Each test measures the gap (GL - aging) before and after its own posting. A refusal is always
 * acceptable; posting an amount that aging can never see is not.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createAccount, updateAccount } from './accounts';
import { createExpense } from './expenses';
import { receivePayment } from './payments';
import { createSalesReceipt } from './salesReceipts';
import { createBill } from './bills';
import { paySalesTax } from './liabilityPayments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa6');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);
const DAY = new Date(2026, 6, 15);

async function idByCode(c: string) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row?.id;
}

async function controlOf(subtype: 'accounts_receivable' | 'accounts_payable', asOf: Date): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  const natural = subtype === 'accounts_receivable' ? total : -total;
  return Math.round(natural * 100) / 100;
}
async function arGap(asOf = D) {
  return Math.round(((await controlOf('accounts_receivable', asOf)) - Number((await arAging(ctx, asOf)).totals.total)) * 100) / 100;
}
async function apGap(asOf = D) {
  return Math.round(((await controlOf('accounts_payable', asOf)) - Number((await apAging(ctx, asOf)).totals.total)) * 100) / 100;
}
async function tbBalanced(asOf = D) {
  const tb = await trialBalance(ctx, asOf);
  let dr = 0;
  let cr = 0;
  for (const r of tb.rows) {
    dr += Number(r.debit);
    cr += Number(r.credit);
  }
  return Math.round((dr - cr) * 100) === 0;
}

/** Run `fn`; a refusal is fine. Returns whether it posted. */
async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

let acctSeq = 9300;
const nextCode = () => String(acctSeq++);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa6@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA6 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '2100', '3000', '4000', '6000']) code[c] = (await idByCode(c))!;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I11 through the "document" paths the posting guard exempts
// ---------------------------------------------------------------------------

describe('QA6: customer/vendor documents cannot put unnamed amounts on A/R or A/P', () => {
  it('Receive Payments with "Deposit to" = Accounts Payable keeps A/P aging == GL', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA6 Payer AP' })).id;
    const g0 = await apGap();
    await attempt(() =>
      receivePayment(ctx, {
        customerId: c,
        date: DAY,
        method: 'check',
        amount: '55.00',
        depositAccountId: code['2000'],
        applications: [],
      }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('Receive Payments with "Deposit to" = Accounts Receivable keeps A/R aging == GL', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA6 Payer AR' })).id;
    const g0 = await arGap();
    await attempt(() =>
      receivePayment(ctx, {
        customerId: c,
        date: DAY,
        method: 'check',
        amount: '45.00',
        depositAccountId: code['1200'],
        applications: [],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a Sales Receipt deposited to Accounts Receivable keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() =>
      createSalesReceipt(ctx, {
        date: DAY,
        depositAccountId: code['1200'],
        lines: [{ accountId: code['4000'], description: 'QA6 counter sale', quantity: 1, rate: '75.00' }],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a Sales Receipt line posted to Accounts Payable keeps A/P aging == GL', async () => {
    const g0 = await apGap();
    await attempt(() =>
      createSalesReceipt(ctx, {
        date: DAY,
        depositAccountId: code['1000'],
        lines: [{ accountId: code['2000'], description: 'QA6 line on A/P', quantity: 1, rate: '65.00' }],
      }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a bill whose expense line hits Accounts Receivable keeps A/R aging == GL', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA6 Bill Vendor AR' })).id;
    const g0 = await arGap();
    await attempt(() =>
      createBill(ctx, { vendorId: v, date: DAY, dueDate: DAY, lines: [{ accountId: code['1200'], amount: '85.00' }] }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a bill whose expense line hits Accounts Payable keeps A/P aging == GL', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA6 Bill Vendor AP' })).id;
    const g0 = await apGap();
    await attempt(() =>
      createBill(ctx, { vendorId: v, date: DAY, dueDate: DAY, lines: [{ accountId: code['2000'], amount: '95.00' }] }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('Pay Sales Tax (no agency, so no sourceRef) paid "from" A/R keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() => paySalesTax(ctx, { amount: '25.00', date: DAY, paymentAccountId: code['1200'] }));
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('Pay Sales Tax (no agency) paid "from" A/P keeps A/P aging == GL', async () => {
    const g0 = await apGap();
    await attempt(() => paySalesTax(ctx, { amount: '15.00', date: DAY, paymentAccountId: code['2000'] }));
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Positive control — QB allows a check line on A/R when it names the customer
// ---------------------------------------------------------------------------

describe('QA6: legitimate QB workflows still work', () => {
  it('a check refunding a customer (A/R line WITH the customer name) posts and keeps A/R aging == GL', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA6 Refund Customer' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createExpense(ctx, {
        payeeName: 'QA6 Refund Customer',
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['1200'], amount: '30.00', customerId: c }],
      }),
    );
    expect(ok).toBe(true);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a same-type sub-account is allowed (expense under expense, bank under bank)', async () => {
    const e = await createAccount(ctx, { code: nextCode(), name: 'QA6 Sub Expense', qbType: 'expense', parentId: code['6000'] });
    expect(e.parentId).toBe(code['6000']);
    const b = await createAccount(ctx, { code: nextCode(), name: 'QA6 Sub Bank', qbType: 'bank', parentId: code['1000'] });
    expect(b.parentId).toBe(code['1000']);
  });

  it('an A/R account with a zero opening balance can still be created', async () => {
    const ar = await attempt(() =>
      createAccount(ctx, { code: nextCode(), name: 'QA6 Zero A/R', qbType: 'accounts_receivable', openingBalance: '0' }),
    );
    expect(ar).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Account structure on UPDATE
// ---------------------------------------------------------------------------

describe('QA6: account type / parent rules on edit', () => {
  it('moving an existing expense account under A/R is refused', async () => {
    const e = await createAccount(ctx, { code: nextCode(), name: 'QA6 Loose Expense', qbType: 'expense' });
    const ok = await attempt(() => updateAccount(ctx, e.id, { parentId: code['1200'] }));
    expect(ok).toBe(false);
  });

  it('changing a sub-account to a type different from its parent is refused', async () => {
    const e = await createAccount(ctx, { code: nextCode(), name: 'QA6 Child Expense', qbType: 'expense', parentId: code['6000'] });
    const ok = await attempt(() => updateAccount(ctx, e.id, { qbType: 'other_expense' }));
    expect(ok).toBe(false);
  });

  it('changing a parent to a type different from its sub-accounts is refused', async () => {
    const p = await createAccount(ctx, { code: nextCode(), name: 'QA6 Parent Exp', qbType: 'expense' });
    await createAccount(ctx, { code: nextCode(), name: 'QA6 Kid Exp', qbType: 'expense', parentId: p.id });
    const ok = await attempt(() => updateAccount(ctx, p.id, { qbType: 'cost_of_goods_sold' }));
    expect(ok).toBe(false);
  });

  it('a bank account with history cannot be turned into A/R (aging would not see its balance)', async () => {
    const b = await createAccount(ctx, {
      code: nextCode(),
      name: 'QA6 Bank With History',
      qbType: 'bank',
      openingBalance: '120.00',
      openingBalanceDate: DAY,
    });
    const g0 = await arGap();
    await attempt(() => updateAccount(ctx, b.id, { qbType: 'accounts_receivable' }));
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a malformed QB type is refused rather than silently stored', async () => {
    const ok = await attempt(() =>
      createAccount(ctx, { code: nextCode(), name: 'QA6 Bogus', qbType: 'not_a_type' as never }),
    );
    expect(ok).toBe(false);
  });
});
