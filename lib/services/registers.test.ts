/**
 * Integration tests for the QB-style account-register helpers in journal.ts
 * (listRegisterAccounts + accountRegister).
 *
 * Boots a throwaway PGlite instance, seeds a user + company + a chart with
 * bank / CC / AR / AP accounts, posts entries via the posting engine (with
 * sourceRefs + line memos), then asserts register ordering, running balances,
 * opening/closing balances, search filtering, and paging.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { listRegisterAccounts, accountRegister, createManualEntry } from './journal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-registers');
let ctx: ServiceContext;
let db: DB;
/** Account id map keyed by chart code. */
const acct: Record<string, string> = {};

describe('Account registers (listRegisterAccounts + accountRegister)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'regtest@test.local', name: 'RegTest', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Register Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Chart: register accounts (bank/CC/AR/AP) + non-register accounts.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1100', 'Savings', 'asset', 'savings'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2100', 'Visa Card', 'liability', 'credit_card'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Office Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed transactions (chronological):
    // 1. 2025-01-05 Owner investment $10,000 → Checking (sourceRef manual)
    await createManualEntry(ctx, {
      date: new Date('2025-01-05'),
      description: 'Owner investment',
      reference: 'OWN-1',
      lines: [
        { accountId: acct['1000'], debit: '10000.00', memo: 'initial funding' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });

    // 2. 2025-02-01 Invoice $1,200 → AR (sourceRef invoice:abc)
    await postJournalEntry(ctx, {
      date: new Date('2025-02-01'),
      description: 'Invoice INV-100 — Acme Corp',
      reference: 'INV-100',
      lines: [
        { accountId: acct['1200'], debit: '1200.00', memo: 'Acme Corp', controlLine: true },
        { accountId: acct['4000'], credit: '1200.00' },
      ],
      sourceRef: 'invoice:abc-123',
    });

    // 3. 2025-02-10 Office supplies $250 on the Visa card
    await postJournalEntry(ctx, {
      date: new Date('2025-02-10'),
      description: 'Staples run',
      lines: [
        { accountId: acct['6000'], debit: '250.00' },
        { accountId: acct['2100'], credit: '250.00', memo: 'staples charge' },
      ],
      sourceRef: 'expense:exp-1',
    });

    // 4. 2025-03-01 Pay Visa card $100 from Checking
    await postJournalEntry(ctx, {
      date: new Date('2025-03-01'),
      description: 'Visa payment',
      reference: 'CHK-101',
      lines: [
        { accountId: acct['2100'], debit: '100.00' },
        { accountId: acct['1000'], credit: '100.00', memo: 'card payment' },
      ],
    });

    // 5. 2025-03-15 Customer pays invoice $1,200 into Checking
    await postJournalEntry(ctx, {
      date: new Date('2025-03-15'),
      description: 'Payment from Acme Corp',
      lines: [
        { accountId: acct['1000'], debit: '1200.00' },
        { accountId: acct['1200'], credit: '1200.00', memo: 'pays INV-100', controlLine: true },
      ],
      sourceRef: 'customer:cust-1',
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listRegisterAccounts
  // -------------------------------------------------------------------------

  it('lists every posting account, sorted by code, with cached balances', async () => {
    const rows = await listRegisterAccounts(ctx);
    const codes = rows.map((r) => r.code);

    // Any account can be opened as a register (equity, income and expense included).
    expect(codes).toEqual(['1000', '1100', '1200', '2000', '2100', '3000', '4000', '6000']);

    const checking = rows.find((r) => r.code === '1000')!;
    // 10000 - 100 + 1200 = 11100
    expect(checking.balance).toBe('11100.00');
    expect(checking.subtype).toBe('checking');

    const visa = rows.find((r) => r.code === '2100')!;
    // 250 charge - 100 payment = 150 owed (credit-normal natural balance)
    expect(visa.balance).toBe('150.00');

    const ar = rows.find((r) => r.code === '1200')!;
    expect(ar.balance).toBe('0.00'); // invoiced 1200, paid 1200
  });

  // -------------------------------------------------------------------------
  // accountRegister — basic register (ascending, running balance, sourceRef)
  // -------------------------------------------------------------------------

  it('returns the checking register ascending with correct running balances', async () => {
    const reg = await accountRegister(ctx, acct['1000']);

    expect(reg.account.code).toBe('1000');
    expect(reg.openingBalance).toBe('0.00');
    expect(reg.totalRows).toBe(3);
    expect(reg.rows).toHaveLength(3);

    // Oldest first (newest at bottom).
    expect(reg.rows[0].description).toBe('Owner investment');
    expect(reg.rows[0].debit).toBe('10000.00');
    expect(reg.rows[0].runningBalance).toBe('10000.00');
    expect(reg.rows[0].memo).toBe('initial funding');
    expect(reg.rows[0].sourceRef).toBe('manual');

    expect(reg.rows[1].description).toBe('Visa payment');
    expect(reg.rows[1].credit).toBe('100.00');
    expect(reg.rows[1].reference).toBe('CHK-101');
    expect(reg.rows[1].runningBalance).toBe('9900.00');

    expect(reg.rows[2].description).toBe('Payment from Acme Corp');
    expect(reg.rows[2].debit).toBe('1200.00');
    expect(reg.rows[2].runningBalance).toBe('11100.00');
    expect(reg.rows[2].sourceRef).toBe('customer:cust-1');

    expect(reg.closingBalance).toBe('11100.00');
  });

  it('credit-card register is credit-normal: charges increase, payments decrease', async () => {
    const reg = await accountRegister(ctx, acct['2100']);

    expect(reg.account.subtype).toBe('credit_card');
    expect(reg.rows).toHaveLength(2);

    // Charge (credit) +250
    expect(reg.rows[0].credit).toBe('250.00');
    expect(reg.rows[0].runningBalance).toBe('250.00');
    expect(reg.rows[0].sourceRef).toBe('expense:exp-1');

    // Payment (debit) -100
    expect(reg.rows[1].debit).toBe('100.00');
    expect(reg.rows[1].runningBalance).toBe('150.00');

    expect(reg.closingBalance).toBe('150.00');
  });

  // -------------------------------------------------------------------------
  // Date-range filter + opening balance
  // -------------------------------------------------------------------------

  it('computes the opening balance brought forward before the from date', async () => {
    const reg = await accountRegister(ctx, acct['1000'], {
      from: new Date('2025-03-01'),
      to: new Date('2025-03-31'),
    });

    // Only the investment (01-05) precedes the window.
    expect(reg.openingBalance).toBe('10000.00');
    expect(reg.rows).toHaveLength(2);
    expect(reg.rows[0].runningBalance).toBe('9900.00'); // 10000 - 100
    expect(reg.rows[1].runningBalance).toBe('11100.00');
    expect(reg.closingBalance).toBe('11100.00');
  });

  it('to-date filter excludes later activity from rows and closing balance', async () => {
    const reg = await accountRegister(ctx, acct['1000'], { to: new Date('2025-02-28') });
    expect(reg.rows).toHaveLength(1);
    expect(reg.closingBalance).toBe('10000.00');
  });

  // -------------------------------------------------------------------------
  // Search filter — keeps true running balances
  // -------------------------------------------------------------------------

  it('search filters on description/reference/memo while keeping true running balances', async () => {
    const reg = await accountRegister(ctx, acct['1000'], { search: 'acme' });
    expect(reg.totalRows).toBe(1);
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0].description).toBe('Payment from Acme Corp');
    // True register balance at that row, not a filtered-only sum.
    expect(reg.rows[0].runningBalance).toBe('11100.00');
    // Closing balance stays the account's real end-of-range balance.
    expect(reg.closingBalance).toBe('11100.00');

    // Memo match.
    const memoHit = await accountRegister(ctx, acct['1000'], { search: 'card payment' });
    expect(memoHit.rows).toHaveLength(1);
    expect(memoHit.rows[0].description).toBe('Visa payment');

    // Reference match.
    const refHit = await accountRegister(ctx, acct['1000'], { search: 'chk-101' });
    expect(refHit.rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Paging
  // -------------------------------------------------------------------------

  it('limit/offset page the ascending row set without breaking balances', async () => {
    const page1 = await accountRegister(ctx, acct['1000'], { limit: 2, offset: 0 });
    expect(page1.totalRows).toBe(3);
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0].runningBalance).toBe('10000.00');
    expect(page1.rows[1].runningBalance).toBe('9900.00');

    const page2 = await accountRegister(ctx, acct['1000'], { limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0].runningBalance).toBe('11100.00');
    expect(page2.offset).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Voided entries + tenant safety
  // -------------------------------------------------------------------------

  it('excludes voided entries from the register', async () => {
    // Post + void a throwaway entry against Savings.
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-04-01'),
      description: 'Mistake transfer',
      lines: [
        { accountId: acct['1100'], debit: '500.00' },
        { accountId: acct['1000'], credit: '500.00' },
      ],
    });
    const { voidJournalEntry } = await import('./posting');
    await voidJournalEntry(ctx, entry.id);

    const savings = await accountRegister(ctx, acct['1100']);
    expect(savings.rows).toHaveLength(0);
    expect(savings.closingBalance).toBe('0.00');

    // Checking unchanged too.
    const checking = await accountRegister(ctx, acct['1000']);
    expect(checking.closingBalance).toBe('11100.00');
  });

  it('throws NOT_FOUND for an unknown account id', async () => {
    await expect(
      accountRegister(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND for another company’s account', async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: 'other@test.local', name: 'Other', passwordHash: 'x' })
      .returning();
    const [otherCompany] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: otherUser.id })
      .returning();
    const otherCtx: ServiceContext = { db, companyId: otherCompany.id, userId: otherUser.id };

    await expect(accountRegister(otherCtx, acct['1000'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // And the other company sees no register accounts.
    expect(await listRegisterAccounts(otherCtx)).toHaveLength(0);
  });
});
