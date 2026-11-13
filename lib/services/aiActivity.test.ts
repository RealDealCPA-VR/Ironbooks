/**
 * The Home page AI card's read model (lib/services/aiActivity.ts): no AI connected says so; bank
 * lines to review (with and without a suggestion) and pending assistant proposals are counted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { aiActivity } from './aiActivity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-activity');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'act@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Activity Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const checking = all.find((a) => a.subtype === 'checking')!;
  const expense = all.find((a) => a.type === 'expense')!;
  const [bank] = await db.insert(bankAccounts).values({ companyId: company.id, accountId: checking.id, bankName: 'Bank', accountNumber: '1' }).returning();
  await db.insert(bankTransactions).values([
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-01T12:00:00Z'), description: 'SHELL OIL', amount: '-40.00', fitId: 'a', suggestedAccountId: expense.id },
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-02T12:00:00Z'), description: 'UNKNOWN', amount: '-12.00', fitId: 'b' },
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-03T12:00:00Z'), description: 'DUPLICATE', amount: '-12.00', fitId: 'c', excluded: true },
  ]);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Home AI card', () => {
  it('reports no AI connected and the bank lines waiting for review', async () => {
    const a = await aiActivity(ctx);
    expect(a.connected).toBe('none');
    expect(a.bankLinesToReview).toBe(2);
    expect(a.bankLinesWithSuggestion).toBe(1);
    expect(a.pendingProposals).toBe(0);
    expect(a.autoPostedLast7Days).toBe(0);
  });
});
