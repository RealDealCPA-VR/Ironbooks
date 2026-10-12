/**
 * Wave-2 GL foundation — fix round 4 regression tests (I11: A/R / A/P aging == GL).
 *
 * posting.ts assertControlAccountNames now checks every A/R / A/P line of every posting:
 *  - a customer/vendor document may carry only its OWN control line unnamed, in one direction;
 *    a "Deposit to" / "Pay from" / line account on the same control account, or a control line
 *    of the other side, is refused (a Sales Receipt may not touch A/R or A/P at all);
 *  - every other posting (including one with no source) must name the customer / vendor;
 *  - `allowUnnamedControl` is the explicit opt-out for fixtures.
 * Named A/R / A/P lines from non-document postings (checks, deposits, bank-feed lines, ...) are
 * General Journal open items in aging, so they tie.
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
import { createInvoice } from './invoices';
import { postJournalEntry, assertNotControlAccount } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-fix4');
const ID = '00000000-0000-4000-8000-000000000001';

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);
const DAY = new Date(2026, 6, 15);

async function controlOf(subtype: 'accounts_receivable' | 'accounts_payable'): Promise<number> {
  const tb = await trialBalance(ctx, D);
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
  return Math.round((subtype === 'accounts_receivable' ? total : -total) * 100) / 100;
}
const arGap = async () =>
  Math.round(((await controlOf('accounts_receivable')) - Number((await arAging(ctx, D)).totals.total)) * 100) / 100;
const apGap = async () =>
  Math.round(((await controlOf('accounts_payable')) - Number((await apAging(ctx, D)).totals.total)) * 100) / 100;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-fix4@test.local', name: 'Fix4', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation Fix4 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '4000', '6000']) {
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
    code[c] = row!.id;
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('fix4: line-level A/R / A/P guard', () => {
  it('a posting with no source must name A/R / A/P lines; allowUnnamedControl opts out explicitly', async () => {
    const lines = [
      { accountId: code['1200'], debit: '10.00' },
      { accountId: code['4000'], credit: '10.00' },
    ];
    await expect(postJournalEntry(ctx, { date: DAY, description: 'no source', lines })).rejects.toThrow(
      /customer name/,
    );
    const e = await postJournalEntry(ctx, { date: DAY, description: 'fixture', lines, allowUnnamedControl: true });
    expect(e.id).toBeTruthy();
  });

  it("a customer document's own A/R line may be unnamed; a second A/R line the other way is refused", async () => {
    // Receive Payments shape with "Deposit to" = A/R: Dr A/R / Cr A/R.
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'payment deposited to A/R',
        sourceRef: `customer:${ID}`,
        lines: [
          { accountId: code['1200'], debit: '20.00' },
          { accountId: code['1200'], credit: '20.00' },
        ],
      }),
    ).rejects.toThrow(/Deposit to/);
    // A/P on a customer form is refused outright.
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'payment deposited to A/P',
        sourceRef: `customer:${ID}`,
        lines: [
          { accountId: code['2000'], debit: '20.00' },
          { accountId: code['1200'], credit: '20.00' },
        ],
      }),
    ).rejects.toThrow(/Accounts Payable account and can't be used on this form/);
  });

  it('a bill may not carry an expense line on A/P or A/R', async () => {
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'bill line on A/P',
        sourceRef: `bill:${ID}`,
        lines: [
          { accountId: code['2000'], debit: '30.00' },
          { accountId: code['2000'], credit: '30.00' },
        ],
      }),
    ).rejects.toThrow(/line account/);
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'bill line on A/R',
        sourceRef: `bill:${ID}`,
        lines: [
          { accountId: code['1200'], debit: '30.00' },
          { accountId: code['2000'], credit: '30.00' },
        ],
      }),
    ).rejects.toThrow(/Accounts Receivable account and can't be used on this form/);
  });

  it('a Sales Receipt never touches A/R or A/P', async () => {
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'sales receipt to A/R',
        sourceRef: `salesreceipt:${ID}`,
        lines: [
          { accountId: code['1200'], debit: '40.00' },
          { accountId: code['4000'], credit: '40.00' },
        ],
      }),
    ).rejects.toThrow(/can't be used on this form/);
  });

  it('a refund carries only one control line (the refunded document side)', async () => {
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'refund from A/P',
        sourceRef: `refund:${ID}`,
        lines: [
          { accountId: code['1200'], debit: '15.00' },
          { accountId: code['2000'], credit: '15.00' },
        ],
      }),
    ).rejects.toThrow(/can't be used on this form/);
  });

  it('an invoice line posted to A/R itself is refused', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Fix4 Inv' })).id;
    const g0 = await arGap();
    await expect(
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        dueDate: DAY,
        lines: [{ accountId: code['1200'], quantity: 1, rate: '25.00' }],
      }),
    ).rejects.toThrow();
    expect(await arGap()).toBeCloseTo(g0, 2);
  });

  it('a named A/R line from a bank-feed / deposit posting shows in A/R aging (tie holds)', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Fix4 Bank Line' })).id;
    const v = (await createVendor(ctx, { displayName: 'Fix4 Vendor Line' })).id;
    const ar0 = await arGap();
    const ap0 = await apGap();
    await postJournalEntry(ctx, {
      date: DAY,
      description: 'customer paid a GL charge',
      sourceRef: `bank_transaction:${ID}`,
      lines: [
        { accountId: code['1000'], debit: '12.00' },
        { accountId: code['1200'], credit: '12.00', entityType: 'customer', entityId: c },
      ],
    });
    await postJournalEntry(ctx, {
      date: DAY,
      description: 'vendor deposit line',
      sourceRef: `deposit:${ID}`,
      lines: [
        { accountId: code['1000'], debit: '9.00' },
        { accountId: code['2000'], credit: '9.00', entityType: 'vendor', entityId: v },
      ],
    });
    expect(await arGap()).toBeCloseTo(ar0, 2);
    expect(await apGap()).toBeCloseTo(ap0, 2);
  });

  it('assertNotControlAccount refuses A/R and A/P as "Deposit to" / "Pay from" in plain language', () => {
    expect(() =>
      assertNotControlAccount({ type: 'asset', subtype: 'accounts_receivable', name: 'A/R' }, 'Deposit to'),
    ).toThrow(/can't be used as the "Deposit to" account/);
    expect(() =>
      assertNotControlAccount({ type: 'liability', subtype: 'accounts_payable', name: 'A/P' }, 'Pay from'),
    ).toThrow(/Accounts Payable/);
    expect(() => assertNotControlAccount({ type: 'asset', subtype: 'checking', name: 'Bank' }, 'Deposit to')).not.toThrow();
  });
});
