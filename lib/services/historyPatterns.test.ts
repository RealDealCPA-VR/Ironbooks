/**
 * Payee → account patterns from imported QuickBooks history (lib/services/historyPatterns.ts):
 * imported GL transactions ("qbgl:" entries) become rule offers ("Your QuickBooks history put
 * SHELL OIL under Fuel 3 times…") and training examples for the learned categorizer. Only plain
 * two-line bank/category transactions count; A/R, A/P and multi-line entries are left alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, companies, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { postJournalEntry } from './posting';
import { glHistoryPatterns } from './historyPatterns';
import { ruleOffers } from './bankRules';
import { retrainModel } from './aiCategorizer';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-history-patterns');
let db: DB;
let ctx: ServiceContext;
let checking: string;
let fuel: string;
let ar: string;
let shellId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'hist@test.local', name: 'Hist', passwordHash: 'x' }).returning();
  const [co] = await db.insert(companies).values({ name: 'History Co', ownerId: user.id }).returning();
  ctx = { db, companyId: co.id, userId: user.id };
  const acct = async (code: string, name: string, type: string, subtype: string) =>
    (await db.insert(accounts).values({ companyId: co.id, code, name, type: type as never, subtype: subtype as never }).returning())[0].id;
  checking = await acct('1000', 'Checking', 'asset', 'checking');
  ar = await acct('1200', 'Accounts Receivable', 'asset', 'accounts_receivable');
  fuel = await acct('6100', 'Fuel', 'expense', 'operating_expenses');
  await acct('3000', 'Owner Equity', 'equity', 'owners_equity');
  await db.insert(bankAccounts).values({ companyId: co.id, accountId: checking, bankName: 'Test Bank', accountNumber: '1111' });
  shellId = (await db.insert(vendors).values({ companyId: co.id, displayName: 'Shell Oil' }).returning())[0].id;

  // Three imported checks to Shell Oil for fuel (the vendor is the line's name).
  for (let i = 0; i < 3; i++) {
    await postJournalEntry(ctx, {
      date: new Date(`2025-0${i + 1}-10T12:00:00Z`),
      description: `Check 10${i}`,
      sourceRef: `qbgl:check-${i}`,
      lines: [
        { accountId: fuel, debit: '45.00', credit: null, memo: 'gas', entityType: 'vendor', entityId: shellId },
        { accountId: checking, debit: null, credit: '45.00', memo: null, entityType: 'vendor', entityId: shellId },
      ],
    });
  }
  // An imported invoice payment (A/R) and a hand-made check are not history patterns.
  await postJournalEntry(ctx, {
    date: new Date('2025-02-01T12:00:00Z'),
    description: 'Payment',
    sourceRef: 'qbgl:pmt-1',
    lines: [
      { accountId: checking, debit: '100.00', credit: null, memo: null },
      { accountId: ar, debit: null, credit: '100.00', memo: null },
    ],
  });
  await postJournalEntry(ctx, {
    date: new Date('2025-02-02T12:00:00Z'),
    description: 'Check 999',
    lines: [
      { accountId: fuel, debit: '20.00', credit: null, memo: 'Shell Oil' },
      { accountId: checking, debit: null, credit: '20.00', memo: null },
    ],
  });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('patterns mined from imported QuickBooks history', () => {
  it('finds the vendor → account pattern on plain bank transactions only', async () => {
    const p = await glHistoryPatterns(ctx);
    expect(p).toHaveLength(3);
    for (const h of p) {
      expect(h.payee).toBe('Shell Oil');
      expect(h.pattern).toBe('SHELL OIL');
      expect(h.direction).toBe('out');
      expect(h.amount).toBe('-45.00');
      expect(h.accountId).toBe(fuel);
      expect(h.bankAccountId).not.toBe('');
    }
  });

  it('offers a bank rule from that history, worded as such', async () => {
    const offers = await ruleOffers(ctx);
    const shell = offers.find((o) => o.pattern === 'SHELL OIL');
    expect(shell).toBeDefined();
    expect(shell!.accountId).toBe(fuel);
    expect(shell!.count).toBe(3);
    expect(shell!.question).toMatch(/Your QuickBooks history put SHELL OIL under Fuel 3 times/);
    expect(shell!.rule.setAccountId).toBe(fuel);
  });

  it('trains the learned categorizer on it', async () => {
    const summary = await retrainModel(ctx);
    expect(summary.docs).toBeGreaterThanOrEqual(3);
  });
});
