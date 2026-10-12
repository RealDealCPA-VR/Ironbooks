import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { trialBalance, profitAndLoss, balanceSheet } from './reports';
import { ServiceError } from './_base';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accounting');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

describe('Accounting engine (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@test.local', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['5000', 'Rent Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects an unbalanced entry', async () => {
    await expect(
      postJournalEntry(ctx, {
        allowUnnamedControl: true, // fixture posts straight to A/R or A/P
        date: new Date('2025-01-01'),
        description: 'bad',
        lines: [
          { accountId: acct['1000'], debit: '100.00' },
          { accountId: acct['4000'], credit: '90.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
  });

  it('rejects a line with both debit and credit', async () => {
    await expect(
      postJournalEntry(ctx, {
        allowUnnamedControl: true, // fixture posts straight to A/R or A/P
        date: new Date('2025-01-01'),
        description: 'bad2',
        lines: [
          { accountId: acct['1000'], debit: '100.00', credit: '100.00' },
          { accountId: acct['4000'], credit: '100.00' },
        ],
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('posts owner investment, a sale, and rent — balances reconcile', async () => {
    // Owner invests $10,000 cash
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-01-01'),
      description: 'Owner investment',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
    // Sale of $2,500 on account (AR)
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-01-05'),
      description: 'Invoice #1',
      lines: [
        { accountId: acct['1200'], debit: '2500.00' },
        { accountId: acct['4000'], credit: '2500.00' },
      ],
    });
    // Pay rent $1,200 cash
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-01-10'),
      description: 'January rent',
      lines: [
        { accountId: acct['5000'], debit: '1200.00' },
        { accountId: acct['1000'], credit: '1200.00' },
      ],
    });

    // Cached balances
    const rows = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const bal = Object.fromEntries(rows.map((r) => [r.code, r.balance]));
    expect(bal['1000']).toBe('8800.00'); // 10000 - 1200
    expect(bal['1200']).toBe('2500.00');
    expect(bal['3000']).toBe('10000.00');
    expect(bal['4000']).toBe('2500.00');
    expect(bal['5000']).toBe('1200.00');

    // Trial balance must balance
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    // P&L: income 2500, expense 1200, net 1300
    const pl = await profitAndLoss(ctx);
    expect(pl.totalIncome).toBe('2500.00');
    expect(pl.totalExpenses).toBe('1200.00');
    expect(pl.netIncome).toBe('1300.00');

    // Balance sheet equation: Assets = Liabilities + Equity (incl. retained earnings)
    const bs = await balanceSheet(ctx);
    expect(bs.totalAssets).toBe('11300.00'); // 8800 cash + 2500 AR
    expect(bs.retainedEarnings).toBe('1300.00');
    expect(bs.totalEquity).toBe('11300.00'); // 10000 owner + 1300 RE
    expect(bs.balanced).toBe(true);
  });

  it('voiding an entry reverses balances', async () => {
    const entry = await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-02-01'),
      description: 'To be voided',
      lines: [
        { accountId: acct['5000'], debit: '500.00' },
        { accountId: acct['1000'], credit: '500.00' },
      ],
    });
    let [cash] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    expect(cash.balance).toBe('8300.00'); // 8800 - 500

    await voidJournalEntry(ctx, entry.id);
    [cash] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    expect(cash.balance).toBe('8800.00'); // reversed

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
