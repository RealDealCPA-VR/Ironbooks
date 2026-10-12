/**
 * Wave-2 GL foundation — independent QA, round 7 (re-test of fix round 4).
 *
 * Fix round 4 replaced the whole-posting exemptions in posting.ts assertControlAccountNames
 * with a line-level rule: a customer/vendor document may carry its OWN control line unnamed,
 * in ONE direction; any other A/R / A/P line on it is refused. Every other posting (including
 * one with no sourceRef) must name the customer / vendor on each A/R / A/P line.
 *
 * This round attacks the remaining weak spot of that rule — a second A/R line on an invoice
 * that runs in the SAME direction as the invoice's own A/R line (an invoice discount line whose
 * account the user picks), plus the round-6 regressions from different angles:
 *   - no-source postings, Pay Sales Tax with an agency, refunds "from" A/P,
 *   - checks naming a customer/vendor on A/R/A/P (positive controls, voids, credits),
 *   - malformed / foreign names on check lines.
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
import { createAccount } from './accounts';
import { createExpense, voidExpense } from './expenses';
import { receivePayment, refundPayment } from './payments';
import { createInvoice } from './invoices';
import { createItem } from './items';
import { paySalesTax } from './liabilityPayments';
import { postJournalEntry } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa7');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);
const DAY = new Date(2026, 6, 15);

async function idByCode(c: string, companyId = ctx.companyId) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, c)));
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
async function arRow(customerId: string) {
  return Number((await arAging(ctx, D)).rows.find((r) => r.id === customerId)?.total ?? 0);
}
async function apRow(vendorId: string) {
  return Number((await apAging(ctx, D)).rows.find((r) => r.id === vendorId)?.total ?? 0);
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

let acctSeq = 9400;
const nextCode = () => String(acctSeq++);
let discountItemId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa7@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA7 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const other = await createCompany(db, { name: 'Foundation QA7 Other Co', ownerId: user.id });
  otherCtx = { db, companyId: other.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '3000', '4000', '6000']) code[c] = (await idByCode(c))!;
  discountItemId = (await createItem(ctx, { name: 'QA7 Discount', type: 'discount' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A second, same-direction A/R line on an invoice
// ---------------------------------------------------------------------------

describe('QA7: an invoice cannot put a second, unnamed debit on A/R', () => {
  it('an invoice discount line posted to Accounts Receivable keeps A/R aging == GL', async () => {
    // Discount lines DEBIT their account. With accountId = A/R the invoice posts
    // Dr A/R 90 (its own line) + Dr A/R 10 (discount) / Cr Income 100: both A/R lines are
    // debits, so the one-direction rule lets it through. Aging shows the invoice at 90; the GL
    // grows by 100.
    const c = (await createCustomer(ctx, { displayName: 'QA7 Discount on AR' })).id;
    const g0 = await arGap();
    await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId: discountItemId, accountId: code['1200'], quantity: 1, rate: '10.00', taxable: false },
        ],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('an invoice discount line posted to a SECOND Accounts Receivable account keeps A/R aging == GL', async () => {
    const ar2 = await createAccount(ctx, { code: nextCode(), name: 'QA7 A/R Retail', qbType: 'accounts_receivable' });
    const c = (await createCustomer(ctx, { displayName: 'QA7 Discount on AR2' })).id;
    const g0 = await arGap();
    await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '200.00', taxable: false },
          { itemId: discountItemId, accountId: ar2.id, quantity: 1, rate: '20.00', taxable: false },
        ],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('an invoice income line posted to Accounts Receivable is refused (opposite direction)', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Income on AR' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [{ accountId: code['1200'], quantity: 1, rate: '40.00', taxable: false }],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('an invoice discount line on Accounts Payable is refused (other control account)', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Discount on AP' })).id;
    const g0 = await apGap();
    const ok = await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '50.00', taxable: false },
          { itemId: discountItemId, accountId: code['2000'], quantity: 1, rate: '5.00', taxable: false },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a normal invoice with a discount line to an income account still posts and ties', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Normal Discount' })).id;
    const g0 = await arGap();
    await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [
        { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
        { itemId: discountItemId, accountId: code['4000'], quantity: 1, rate: '10.00', taxable: false },
      ],
    });
    expect(await arRow(c)).toBe(90);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-6 root cause from other angles
// ---------------------------------------------------------------------------

describe('QA7: postings with no source / other windows', () => {
  it('a posting with NO sourceRef and an unnamed A/R line is refused at the engine', async () => {
    const g0 = await arGap();
    const ok = await attempt(() =>
      postJournalEntry(ctx, {
        date: DAY,
        description: 'QA7 no source',
        lines: [
          { accountId: code['1200'], debit: '12.00' },
          { accountId: code['4000'], credit: '12.00' },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a posting with NO sourceRef and an unnamed A/P line is refused at the engine', async () => {
    const g0 = await apGap();
    const ok = await attempt(() =>
      postJournalEntry(ctx, {
        date: DAY,
        description: 'QA7 no source AP',
        lines: [
          { accountId: code['6000'], debit: '13.00' },
          { accountId: code['2000'], credit: '13.00' },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a no-source posting that names the customer on A/R posts and shows in aging', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Named Engine' })).id;
    const g0 = await arGap();
    await postJournalEntry(ctx, {
      date: DAY,
      description: 'QA7 named no source',
      lines: [
        { accountId: code['1200'], debit: '14.00', entityType: 'customer', entityId: c },
        { accountId: code['4000'], credit: '14.00' },
      ],
    });
    expect(await arRow(c)).toBe(14);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('Pay Sales Tax paid "from" Accounts Receivable is refused (no agency)', async () => {
    const g0 = await arGap();
    const ok = await attempt(() =>
      paySalesTax(ctx, { amount: '7.00', date: DAY, paymentAccountId: code['1200'] }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('refunding an unapplied customer payment "from" Accounts Payable is refused', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Refund From AP' })).id;
    const p = await receivePayment(ctx, {
      customerId: c,
      date: DAY,
      method: 'check',
      amount: '40.00',
      depositAccountId: code['1000'],
      applications: [],
    });
    const paymentId = (p as { id?: string; payment?: { id: string } }).id ?? (p as { payment: { id: string } }).payment.id;
    const ga = await arGap();
    const gp = await apGap();
    const ok = await attempt(() =>
      refundPayment(ctx, { paymentId, bankAccountId: code['2000'], amount: '40.00', date: DAY }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(ga, 2);
    expect(await apGap()).toBeCloseTo(gp, 2);
  });
});

// ---------------------------------------------------------------------------
// Checks that name a customer / vendor on A/R / A/P
// ---------------------------------------------------------------------------

describe('QA7: checks on A/R / A/P carry the name and stay in aging', () => {
  it('a customer refund check reduces that customer\'s aging row; voiding it restores it', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Check Refund' })).id;
    const g0 = await arGap();
    const exp = await createExpense(ctx, {
      payeeName: 'QA7 Check Refund',
      date: DAY,
      method: 'check',
      paymentAccountId: code['1000'],
      lines: [{ accountId: code['1200'], amount: '30.00', customerId: c }],
    });
    // Dr A/R 30 for the customer: the customer now owes 30 more (QB shows the check in aging).
    expect(await arRow(c)).toBe(30);
    expect(await arGap()).toBeCloseTo(g0, 2);
    const id = (exp as { id?: string; expense?: { id: string } }).id ?? (exp as { expense: { id: string } }).expense.id;
    await voidExpense(ctx, id);
    expect(await arRow(c)).toBe(0);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a check line on A/P with the payee vendor posts and shows under that vendor', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA7 Check AP Vendor' })).id;
    const g0 = await apGap();
    const ok = await attempt(() =>
      createExpense(ctx, {
        vendorId: v,
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['2000'], amount: '22.00' }],
      }),
    );
    expect(ok).toBe(true);
    // Dr A/P 22 for the vendor (a prepayment): aging shows -22 for the vendor.
    expect(await apRow(v)).toBe(-22);
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a check line on A/P with only a free-text payee (no vendor) is refused', async () => {
    const g0 = await apGap();
    const ok = await attempt(() =>
      createExpense(ctx, {
        payeeName: 'Somebody',
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['2000'], amount: '23.00' }],
      }),
    );
    expect(ok).toBe(false);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a check line on A/R naming a customer of ANOTHER company is refused', async () => {
    const foreign = (await createCustomer(otherCtx, { displayName: 'QA7 Foreign Customer' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createExpense(ctx, {
        payeeName: 'QA7 Foreign Customer',
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['1200'], amount: '24.00', customerId: foreign }],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a check paid FROM Accounts Receivable is refused even when lines name a customer', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA7 Pay From AR' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createExpense(ctx, {
        payeeName: 'QA7 Pay From AR',
        date: DAY,
        method: 'check',
        paymentAccountId: code['1200'],
        lines: [{ accountId: code['6000'], amount: '26.00', customerId: c }],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });
});
