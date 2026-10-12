/**
 * Wave-2 GL foundation — fix round 5 regression tests (I11: A/R / A/P aging == GL).
 *
 * QA7 found that the round-4 rule ("a document's own control line, one direction") let an
 * invoice discount line on A/R through: it debits A/R in the same direction as the invoice's own
 * A/R line, so the GL grew by the gross while aging showed the net.
 *
 * Fix:
 *  - posting.ts: a document's own A/R / A/P line is exempt only when the document service marks
 *    it `controlLine: true`. Every unmarked A/R / A/P line on a document is refused, whatever its
 *    direction. Several marked lines in one direction are still fine.
 *  - invoices / credit memos refuse A/R and A/P as a line or discount account; items refuse them
 *    as any of their accounts (create and edit).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { createItem, updateItem } from './items';
import { assertControlAccountNames, postJournalEntry } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-fix5');
const ID = '00000000-0000-4000-8000-000000000005';

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const DAY = new Date(2026, 6, 15);
let discountItemId: string;
let customerId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-fix5@test.local', name: 'Fix5', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation Fix5 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '2000', '4000', '6000']) {
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
    code[c] = row!.id;
  }
  discountItemId = (await createItem(ctx, { name: 'Fix5 Discount', type: 'discount' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'Fix5 Customer' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const rows = () => [
  { id: 'ar', type: 'asset', subtype: 'accounts_receivable', name: 'Accounts Receivable' },
  { id: 'ap', type: 'liability', subtype: 'accounts_payable', name: 'Accounts Payable' },
  { id: 'inc', type: 'revenue', subtype: null, name: 'Sales' },
  { id: 'bank', type: 'asset', subtype: 'bank', name: 'Checking' },
];

describe('fix5: only the marked own control line is exempt on a document', () => {
  it('a marked own A/R line passes; a second, unmarked same-direction A/R line is refused', () => {
    expect(() =>
      assertControlAccountNames(
        {
          sourceRef: `invoice:${ID}`,
          lines: [
            { accountId: 'ar', debit: '90.00', controlLine: true },
            { accountId: 'ar', debit: '10.00' },
            { accountId: 'inc', credit: '100.00' },
          ],
        },
        rows(),
      ),
    ).toThrow(/can't be used on this form/);
    expect(() =>
      assertControlAccountNames(
        {
          sourceRef: `invoice:${ID}`,
          lines: [
            { accountId: 'ar', debit: '100.00', controlLine: true },
            { accountId: 'inc', credit: '100.00' },
          ],
        },
        rows(),
      ),
    ).not.toThrow();
  });

  it('several marked lines in one direction are fine; marked lines both ways are refused', () => {
    expect(() =>
      assertControlAccountNames(
        {
          sourceRef: `customer:${ID}`,
          lines: [
            { accountId: 'bank', debit: '30.00' },
            { accountId: 'ar', credit: '10.00', controlLine: true },
            { accountId: 'ar', credit: '20.00', controlLine: true },
          ],
        },
        rows(),
      ),
    ).not.toThrow();
    expect(() =>
      assertControlAccountNames(
        {
          sourceRef: `customer:${ID}`,
          lines: [
            { accountId: 'ar', debit: '30.00', controlLine: true },
            { accountId: 'ar', credit: '30.00', controlLine: true },
          ],
        },
        rows(),
      ),
    ).toThrow(/Deposit to/);
  });

  it('a marked line on the other side (A/P on a customer form) is still refused', () => {
    expect(() =>
      assertControlAccountNames(
        {
          sourceRef: `invoice:${ID}`,
          lines: [
            { accountId: 'ap', debit: '10.00', controlLine: true },
            { accountId: 'inc', credit: '10.00' },
          ],
        },
        rows(),
      ),
    ).toThrow(/Accounts Payable account and can't be used on this form/);
  });

  it('an unmarked document A/R line is refused by postJournalEntry even when it is the only one', async () => {
    await expect(
      postJournalEntry(ctx, {
        date: DAY,
        description: 'unmarked invoice A/R',
        sourceRef: `invoice:${ID}`,
        lines: [
          { accountId: code['1200'], debit: '10.00' },
          { accountId: code['4000'], credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(/can't be used on this form/);
  });
});

describe('fix5: forms refuse A/R and A/P as line accounts up front', () => {
  it('an invoice discount line on A/R (main or a second A/R account) is refused in plain language', async () => {
    await expect(
      createInvoice(ctx, {
        customerId,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId: discountItemId, accountId: code['1200'], quantity: 1, rate: '10.00', taxable: false },
        ],
      }),
    ).rejects.toThrow(/Line 2: .*Accounts Receivable can't be used as an item or line account/);
    const ar2 = await createAccount(ctx, { code: '1290', name: 'Fix5 A/R 2', qbType: 'accounts_receivable' });
    await expect(
      createInvoice(ctx, {
        customerId,
        date: DAY,
        lines: [
          { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
          { itemId: discountItemId, accountId: ar2.id, quantity: 1, rate: '10.00', taxable: false },
        ],
      }),
    ).rejects.toThrow(/Line 2/);
  });

  it('a normal invoice with a discount line still posts', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: DAY,
      lines: [
        { accountId: code['4000'], quantity: 1, rate: '100.00', taxable: false },
        { itemId: discountItemId, accountId: code['4000'], quantity: 1, rate: '10.00', taxable: false },
      ],
    });
    expect(inv.id).toBeTruthy();
  });

  it('a credit memo line on A/R or A/P is refused', async () => {
    for (const acct of [code['1200'], code['2000']]) {
      await expect(
        createCreditMemo(ctx, {
          customerId,
          date: DAY,
          lines: [{ accountId: acct, quantity: 1, rate: '5.00', taxable: false }],
        }),
      ).rejects.toThrow(/Line 1: .*can't be used as an item or line account/);
    }
  });

  it("an item can't use A/R as its asset account (create or edit)", async () => {
    await expect(
      createItem(ctx, { name: 'Fix5 Bad Asset', type: 'inventory', assetAccountId: code['1200'] }),
    ).rejects.toThrow(/Accounts Receivable can't be used as an item or line account/);
    const ok = await createItem(ctx, { name: 'Fix5 Service', type: 'service', incomeAccountId: code['4000'] });
    await expect(updateItem(ctx, ok.id, { assetAccountId: code['1200'] })).rejects.toThrow(
      /Accounts Receivable can't be used/,
    );
  });
});
