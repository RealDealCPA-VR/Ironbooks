/**
 * Wave-2 GL foundation — independent QA, round 5 (re-test of the resumed run).
 *
 * Rounds 1-4 covered manual journal entries, AI proposals, merges, recurring templates and
 * typed document numbers. This round attacks the I11 invariant (A/R aging == A/R control,
 * A/P aging == A/P control) from every OTHER path that lets a user pick an arbitrary GL
 * account: account opening balances, check/expense lines, deposit lines, transfers, account
 * merges between two A/R accounts and sub-accounts. QuickBooks requires a customer/vendor on
 * every A/R / A/P line in all of these windows; an unnamed amount on A/R or A/P can never be
 * seen in aging, so the subledger stops tying to the GL.
 *
 * Each test measures the gap (GL - aging) before and after its own posting, so failures do not
 * cascade. A refusal is always acceptable; posting an unnamed amount onto A/R / A/P is not.
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
import { createManualEntry, reverseEntry } from './journal';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { mergeAccounts } from './merge';
import { createAccount } from './accounts';
import { createExpense } from './expenses';
import { createDeposit } from './deposits';
import { createTransfer } from './transfers';
import { createInvoice } from './invoices';
import { incrementAlnum, nextDocNumber, normalizeDocNumber } from './docNumbers';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa5');

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

let acctSeq = 9100;
const nextCode = () => String(acctSeq++);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa5@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA5 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '2100', '3000', '4000', '6000']) code[c] = (await idByCode(c))!;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I11 — A/R and A/P stay tied to aging from every path that picks a GL account
// ---------------------------------------------------------------------------

describe('QA5: unnamed amounts can never land on A/R or A/P', () => {
  it('a new Accounts Receivable account with an opening balance (no customer) keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() =>
      createAccount(ctx, {
        code: nextCode(),
        name: 'QA5 Second A/R',
        qbType: 'accounts_receivable',
        openingBalance: '500.00',
        openingBalanceDate: DAY,
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a new Accounts Payable account with an opening balance (no vendor) keeps A/P aging == GL', async () => {
    const g0 = await apGap();
    await attempt(() =>
      createAccount(ctx, {
        code: nextCode(),
        name: 'QA5 Second A/P',
        qbType: 'accounts_payable',
        openingBalance: '700.00',
        openingBalanceDate: DAY,
      }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a check whose expense line hits A/R keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() =>
      createExpense(ctx, {
        payeeName: 'QA5 Payee',
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['1200'], amount: '40.00' }],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a check to a vendor whose expense line hits A/P keeps A/P aging == GL', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA5 Check Vendor' })).id;
    const g0 = await apGap();
    await attempt(() =>
      createExpense(ctx, {
        vendorId: v,
        date: DAY,
        method: 'check',
        paymentAccountId: code['1000'],
        lines: [{ accountId: code['2000'], amount: '60.00' }],
      }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a deposit line received from A/R (no customer) keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() =>
      createDeposit(ctx, {
        depositAccountId: code['1000'],
        date: DAY,
        extraLines: [{ accountId: code['1200'], amount: '80.00', description: 'QA5 deposit from A/R' }],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a transfer into the A/R account keeps A/R aging == GL', async () => {
    const g0 = await arGap();
    await attempt(() =>
      createTransfer(ctx, { date: DAY, fromAccountId: code['1000'], toAccountId: code['1200'], amount: '90.00' }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a transfer out of A/P (A/P -> credit card) keeps A/P aging == GL', async () => {
    const g0 = await apGap();
    await attempt(() =>
      createTransfer(ctx, { date: DAY, fromAccountId: code['2000'], toAccountId: code['2100'], amount: '35.00' }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
  });
});

// ---------------------------------------------------------------------------
// I11 + B1 — account structure around A/R
// ---------------------------------------------------------------------------

describe('QA5: account structure around Accounts Receivable', () => {
  it('merging two A/R accounts keeps every customer name; aging still ties and the customer total is unchanged', async () => {
    const extra = await createAccount(ctx, { code: nextCode(), name: 'QA5 A/R Two', qbType: 'accounts_receivable' });
    const c = (await createCustomer(ctx, { displayName: 'QA5 Two-A/R Customer' })).id;
    await createManualEntry(ctx, {
      date: DAY,
      description: 'QA5 charge on second A/R',
      lines: [
        { accountId: extra.id, debit: '123.45', entityType: 'customer', entityId: c },
        { accountId: code['4000'], credit: '123.45' },
      ],
    });
    const custTotal = async () =>
      Number(
        ((await arAging(ctx, D)).rows as Array<{ id: string; total: string | number }>).find(
          (r) => r.id === c,
        )?.total ?? 0,
      );
    expect(await custTotal()).toBeCloseTo(123.45, 2);
    const g0 = await arGap();
    await mergeAccounts(ctx, { fromId: extra.id, toId: code['1200'] });
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await custTotal()).toBeCloseTo(123.45, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a sub-account must be the same QuickBooks type as its parent (no expense account under A/R)', async () => {
    const ok = await attempt(() =>
      createAccount(ctx, { code: nextCode(), name: 'QA5 Expense under A/R', qbType: 'expense', parentId: code['1200'] }),
    );
    expect(ok).toBe(false);
  });

  it('rounding: thirds split across three customers tie to the cent, and a reversal nets every customer to zero', async () => {
    const cs = [
      (await createCustomer(ctx, { displayName: 'QA5 Third A' })).id,
      (await createCustomer(ctx, { displayName: 'QA5 Third B' })).id,
      (await createCustomer(ctx, { displayName: 'QA5 Third C' })).id,
    ];
    const g0 = await arGap();
    const je = await createManualEntry(ctx, {
      date: DAY,
      description: 'QA5 split fee',
      lines: [
        { accountId: code['1200'], debit: '33.33', entityType: 'customer', entityId: cs[0] },
        { accountId: code['1200'], debit: '33.33', entityType: 'customer', entityId: cs[1] },
        { accountId: code['1200'], debit: '33.34', entityType: 'customer', entityId: cs[2] },
        { accountId: code['4000'], credit: '100.00' },
      ],
    });
    expect(await arGap()).toBeCloseTo(g0, 2);
    await reverseEntry(ctx, (je as { id: string }).id, new Date(2026, 6, 20));
    const rows = (await arAging(ctx, D)).rows as Array<{ id: string; total: string | number }>;
    for (const c of cs) expect(Number(rows.find((r) => r.id === c)?.total ?? 0)).toBeCloseTo(0, 2);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('an A/R line with an amount over two decimals never leaves fractional cents behind', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA5 Fraction' })).id;
    const g0 = await arGap();
    await attempt(() =>
      createManualEntry(ctx, {
        date: DAY,
        description: 'QA5 fractional',
        lines: [
          { accountId: code['1200'], debit: '10.005', entityType: 'customer', entityId: c },
          { accountId: code['4000'], credit: '10.005' },
        ],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A3 — typed numbers: whitespace and suggestion edge cases
// ---------------------------------------------------------------------------

describe('QA5: typed document numbers, edge cases', () => {
  it('blank / whitespace-only typed numbers fall back to the next number; padding is trimmed before the duplicate check', async () => {
    expect(normalizeDocNumber('   ')).toBeNull();
    expect(incrementAlnum('INV-0099')).toBe('INV-0100');
    const cust = (await createCustomer(ctx, { displayName: 'QA5 Numbers' })).id;
    const LINE = [{ quantity: 1, rate: '10.00' }];
    const a = await createInvoice(ctx, { customerId: cust, date: DAY, dueDate: DAY, refNumber: 'QA5-0099', lines: LINE });
    expect(a.refNumber).toBe('QA5-0099');
    expect(await nextDocNumber(ctx, 'invoice')).toBe('QA5-0100');
    const b = await createInvoice(ctx, { customerId: cust, date: DAY, dueDate: DAY, refNumber: '   ', lines: LINE });
    expect(b.refNumber).toBe('QA5-0100');
    const dup = await attempt(() =>
      createInvoice(ctx, { customerId: cust, date: DAY, dueDate: DAY, refNumber: '  qa5-0099  ', lines: LINE }),
    );
    expect(dup).toBe(false);
  });
});
