/**
 * Wave-2 GL foundation — independent QA, round 8 (re-test of fix round 5).
 *
 * Fix round 5: only a document's own, explicitly marked control line (PostingLine.controlLine)
 * may sit unnamed on A/R / A/P; invoices / credit memos refuse A/R / A/P as line accounts and
 * items refuse them as any account.
 *
 * This round attacks:
 *   - the QA7 holes again through other entry points (updateInvoice, a legacy item whose account
 *     already points at A/R / A/P, credit memos, bills, sales receipts, payments),
 *   - rollback: a refused edit must leave the original document and GL untouched,
 *   - every line the services DO mark as controlLine: is it really in the subledger? The
 *     invoice's Retainage Receivable line is marked controlLine and sits on an A/R account, but
 *     aging leaves retainage out (billed base = total - retainage).
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
import { accounts, invoices, items, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createAccount } from './accounts';
import { receivePayment } from './payments';
import { createInvoice, updateInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { createSalesReceipt } from './salesReceipts';
import { createItem, updateItem } from './items';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa8');

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
async function arRow(customerId: string) {
  return Number((await arAging(ctx, D)).rows.find((r) => r.id === customerId)?.total ?? 0);
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

let acctSeq = 9500;
const nextCode = () => String(acctSeq++);
let discountItemId: string;
let ar2Id: string;
let ap2Id: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa8@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA8 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '3000', '4000', '6000']) code[c] = (await idByCode(c))!;
  discountItemId = (await createItem(ctx, { name: 'QA8 Discount', type: 'discount' })).id;
  ar2Id = (await createAccount(ctx, { code: nextCode(), name: 'QA8 A/R Retail', qbType: 'accounts_receivable' })).id;
  ap2Id = (await createAccount(ctx, { code: nextCode(), name: 'QA8 A/P Imports', qbType: 'accounts_payable' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** A service item created normally, then pointed at `accountId` directly in the database —
 *  the shape of an item saved before the round-5 item guard, or imported. */
async function legacyItem(name: string, patch: Partial<typeof items.$inferInsert>) {
  const it = await createItem(ctx, { name, type: 'service', incomeAccountId: code['4000'] });
  await db.update(items).set(patch).where(eq(items.id, it.id));
  return it.id;
}

// ---------------------------------------------------------------------------
// The QA7 hole through other entry points
// ---------------------------------------------------------------------------

describe('QA8: A/R / A/P as a line account through every sales / purchase entry point', () => {
  it('updateInvoice adding a discount line on A/R is refused and the original invoice + GL stay intact', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA8 Edit Discount AR' })).id;
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false }],
    });
    const g0 = await arGap();
    const ok = await attempt(() =>
      updateInvoice(ctx, inv.id, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId: discountItemId, accountId: code['1200'], quantity: 1, rate: '10.00', taxable: false },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await arRow(c)).toBe(100);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.total).toBe('100.00');
    expect(row.status).not.toBe('void');
    expect(await tbBalanced()).toBe(true);
  });

  it('updateInvoice moving an income line onto a second A/R account is refused', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA8 Edit Income AR2' })).id;
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '60.00', taxable: false }],
    });
    const g0 = await arGap();
    const ok = await attempt(() =>
      updateInvoice(ctx, inv.id, {
        customerId: c,
        date: DAY,
        lines: [{ accountId: ar2Id, quantity: 1, rate: '60.00', taxable: false }],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await arRow(c)).toBe(60);
  });

  it('an invoice using a legacy item whose income account is a second A/R account (no line account) is refused', async () => {
    const itemId = await legacyItem('QA8 Legacy AR Item', { incomeAccountId: ar2Id });
    const c = (await createCustomer(ctx, { displayName: 'QA8 Legacy AR' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId, quantity: 1, rate: '30.00', taxable: false },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a legacy discount item whose account is A/R (no line account) cannot add an unseen A/R debit', async () => {
    const itemId = await legacyItem('QA8 Legacy AR Discount', { type: 'discount', incomeAccountId: code['1200'] } as never);
    const c = (await createCustomer(ctx, { displayName: 'QA8 Legacy AR Discount' })).id;
    const g0 = await arGap();
    await attempt(() =>
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId, quantity: 1, rate: '15.00', taxable: false },
        ],
      }),
    );
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a credit memo using a legacy item whose income account is A/R is refused', async () => {
    const itemId = await legacyItem('QA8 Legacy AR CM Item', { incomeAccountId: code['1200'] });
    const c = (await createCustomer(ctx, { displayName: 'QA8 CM Legacy AR' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createCreditMemo(ctx, { customerId: c, date: DAY, lines: [{ itemId, quantity: 1, rate: '25.00', taxable: false }] }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a credit memo line on a second A/R account is refused', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA8 CM AR2' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createCreditMemo(ctx, { customerId: c, date: DAY, lines: [{ accountId: ar2Id, quantity: 1, rate: '25.00', taxable: false }] }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a bill expense line on a second A/P account is refused', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA8 Bill AP2' })).id;
    const g0 = await apGap();
    const ok = await attempt(() =>
      createBill(ctx, { vendorId: v, date: DAY, lines: [{ accountId: ap2Id, amount: '45.00' }] }),
    );
    expect(ok).toBe(false);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a bill expense line on the main A/P account (same account as its own line) is refused', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA8 Bill AP self' })).id;
    const g0 = await apGap();
    const ok = await attempt(() =>
      createBill(ctx, {
        vendorId: v,
        date: DAY,
        lines: [
          { accountId: code['6000'], amount: '100.00' },
          { accountId: code['2000'], amount: '20.00' },
        ],
      }),
    );
    expect(ok).toBe(false);
    expect(await apGap()).toBeCloseTo(g0, 2);
  });

  it('a bill line on A/R is refused', async () => {
    const v = (await createVendor(ctx, { displayName: 'QA8 Bill AR' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      createBill(ctx, { vendorId: v, date: DAY, lines: [{ accountId: code['1200'], amount: '45.00' }] }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a bill using a legacy item whose expense account is a second A/P account is refused', async () => {
    const itemId = await legacyItem('QA8 Legacy AP Item', { expenseAccountId: ap2Id });
    const v = (await createVendor(ctx, { displayName: 'QA8 Bill Legacy AP' })).id;
    const g0 = await apGap();
    await attempt(() =>
      createBill(ctx, { vendorId: v, date: DAY, lines: [{ itemId, quantity: 1, unitCost: '33.00' }] }),
    );
    expect(await apGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });

  it('a sales receipt line on A/R (main or second) is refused', async () => {
    const g0 = await arGap();
    for (const accountId of [code['1200'], ar2Id]) {
      const ok = await attempt(() =>
        createSalesReceipt(ctx, {
          date: DAY,
          depositAccountId: code['1000'],
          lines: [{ accountId, quantity: 1, rate: '18.00', taxable: false }],
        }),
      );
      expect(ok).toBe(false);
    }
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a customer payment deposited to a second A/R account is refused', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA8 Pay to AR2' })).id;
    const g0 = await arGap();
    const ok = await attempt(() =>
      receivePayment(ctx, { customerId: c, date: DAY, method: 'check', amount: '22.00', depositAccountId: ar2Id, applications: [] }),
    );
    expect(ok).toBe(false);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it("updateItem can't point an item's income / expense account at A/R or A/P", async () => {
    const it0 = await createItem(ctx, { name: 'QA8 Edit Item', type: 'service', incomeAccountId: code['4000'] });
    expect(await attempt(() => updateItem(ctx, it0.id, { incomeAccountId: ar2Id }))).toBe(false);
    expect(await attempt(() => updateItem(ctx, it0.id, { expenseAccountId: ap2Id }))).toBe(false);
    expect(await attempt(() => createItem(ctx, { name: 'QA8 New AP', type: 'service', expenseAccountId: code['2000'] }))).toBe(false);
    const [row] = await db.select().from(items).where(eq(items.id, it0.id));
    expect(row.incomeAccountId).toBe(code['4000']);
  });
});

// ---------------------------------------------------------------------------
// Lines the services DO mark as the document's own control line
// ---------------------------------------------------------------------------

describe('QA8: every marked control line is in the subledger', () => {
  it('a retainage invoice keeps A/R aging == the A/R accounts on the balance sheet', async () => {
    // invoices.ts postInvoiceGL posts the held-back amount to 1250 Retainage Receivable — an
    // accounts_receivable account — and marks it controlLine: true. arAging uses
    // billed base = total - retainage, so the 100 held back is in the A/R GL but nowhere in aging.
    const c = (await createCustomer(ctx, { displayName: 'QA8 Retainage' })).id;
    const g0 = await arGap();
    await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '1000.00', taxable: false }],
      retainagePercent: 10,
    });
    expect(await tbBalanced()).toBe(true);
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a normal invoice + full payment ties (positive control)', async () => {
    const c = (await createCustomer(ctx, { displayName: 'QA8 Normal' })).id;
    const g0 = await arGap();
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [
        { accountId: code['4000'], quantity: 2, rate: '33.335', taxable: false },
        { itemId: discountItemId, accountId: code['4000'], quantity: 1, rate: '0.01', taxable: false },
      ],
    });
    expect(await arGap()).toBeCloseTo(g0, 2);
    await receivePayment(ctx, {
      customerId: c,
      date: DAY,
      method: 'check',
      amount: inv.total,
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: inv.total }],
    });
    expect(await arRow(c)).toBe(0);
    expect(await arGap()).toBeCloseTo(g0, 2);
    expect(await tbBalanced()).toBe(true);
  });
});
