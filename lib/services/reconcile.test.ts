/**
 * Integration tests for the bank reconciliation module.
 *
 * Boots a throwaway PGlite directory, seeds a user + company + accounts,
 * posts a few journal entries against the checking account, then walks
 * through the full reconciliation workflow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, bankAccounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  startReconciliation,
  listClearable,
  toggleCleared,
  getProgress,
  completeReconciliation,
} from './reconcile';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reconcile');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let bankAcctId: string;

describe('Bank reconciliation (end-to-end)', () => {
  beforeAll(async () => {
    // A run that was killed leaves its folder behind; start from an empty one.
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);

    // Seed a user and company.
    const [user] = await db
      .insert(users)
      .values({ email: 'recon-owner@test.local', name: 'Recon Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Recon Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Create the minimum accounts needed.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6400', 'Rent Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Create a bank account linked to the Checking GL account.
    const [ba] = await db
      .insert(bankAccounts)
      .values({
        companyId: company.id,
        accountId: acct['1000'],
        bankName: 'First National',
        accountNumber: '****1234',
      })
      .returning();
    bankAcctId = ba.id;

    // Post some journal entries against Checking.
    // Entry 1: owner invests $5,000 cash.  debit Checking, credit Equity.
    await postJournalEntry(ctx, {
      date: new Date('2025-01-01'),
      description: 'Owner investment',
      lines: [
        { accountId: acct['1000'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '5000.00' },
      ],
    });

    // Entry 2: sale of $1,200 cash.  debit Checking, credit Sales.
    await postJournalEntry(ctx, {
      date: new Date('2025-01-10'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '1200.00' },
        { accountId: acct['4000'], credit: '1200.00' },
      ],
    });

    // Entry 3: rent payment $800 cash.  debit Rent, credit Checking.
    await postJournalEntry(ctx, {
      date: new Date('2025-01-15'),
      description: 'January rent',
      lines: [
        { accountId: acct['6400'], debit: '800.00' },
        { accountId: acct['1000'], credit: '800.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // startReconciliation
  // -------------------------------------------------------------------------
  it('starts a reconciliation in_progress', async () => {
    // Statement balance after: 5000 + 1200 − 800 = 5400
    const recon = await startReconciliation(ctx, {
      bankAccountId: bankAcctId,
      statementDate: new Date('2025-01-31'),
      statementBalance: '5400.00',
    });

    expect(recon.status).toBe('in_progress');
    expect(recon.statementBalance).toBe('5400.00');
    expect(recon.bankAccountId).toBe(bankAcctId);
  });

  it('rejects a second in_progress reconciliation for the same bank account', async () => {
    await expect(
      startReconciliation(ctx, {
        bankAccountId: bankAcctId,
        statementDate: new Date('2025-01-31'),
        statementBalance: '5400.00',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // -------------------------------------------------------------------------
  // listClearable + toggleCleared + getProgress
  // -------------------------------------------------------------------------
  it('lists clearable lines for the checking account', async () => {
    // Find the active reconciliation id.
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const lines = await listClearable(ctx, bankAcctId, new Date('2025-01-31'), recon.id);

    // Three entries touch the Checking account → three lines.
    expect(lines.length).toBe(3);
    // None cleared yet.
    expect(lines.every((l) => !l.isCleared)).toBe(true);
  });

  it('progress shows full difference before any lines are cleared', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const progress = await getProgress(ctx, recon.id);
    expect(progress.statementBalance).toBe('5400.00');
    expect(progress.clearedBalance).toBe('0.00');
    expect(progress.difference).toBe('5400.00');
  });

  it('toggleCleared marks lines and progress converges', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const lines = await listClearable(ctx, bankAcctId, new Date('2025-01-31'), recon.id);

    // Clear all three lines.
    for (const line of lines) {
      await toggleCleared(ctx, recon.id, line.journalEntryLineId, true);
    }

    const progress = await getProgress(ctx, recon.id);
    // clearedBalance = +5000 + 1200 − 800 = 5400
    expect(progress.clearedBalance).toBe('5400.00');
    expect(progress.difference).toBe('0.00');
  });

  it('toggleCleared is idempotent (clearing twice is fine)', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const lines = await listClearable(ctx, bankAcctId, new Date('2025-01-31'), recon.id);
    // Toggle the first line again — should not throw.
    await expect(
      toggleCleared(ctx, recon.id, lines[0].journalEntryLineId, true),
    ).resolves.toBeUndefined();
  });

  it('un-clearing a line changes the progress', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const lines = await listClearable(ctx, bankAcctId, new Date('2025-01-31'), recon.id);
    // Un-clear the rent payment line (credit 800 on Checking → removing it reduces cleared by -800).
    const rentLine = lines.find((l) => l.credit === '800.00');
    expect(rentLine).toBeDefined();
    await toggleCleared(ctx, recon.id, rentLine!.journalEntryLineId, false);

    const progress = await getProgress(ctx, recon.id);
    // 5400 (statement) − (5000 + 1200) = -800  →  difference = -800 ... wait:
    // clearedBalance = +5000 +1200 = 6200
    // difference = 5400 - 6200 = -800
    expect(progress.clearedBalance).toBe('6200.00');
    expect(progress.difference).toBe('-800.00');

    // Re-clear the rent line so it balances for the complete test.
    await toggleCleared(ctx, recon.id, rentLine!.journalEntryLineId, true);
  });

  // -------------------------------------------------------------------------
  // completeReconciliation
  // -------------------------------------------------------------------------
  it('rejects completion when difference is non-zero', async () => {
    // Start a fresh reconciliation on a temp bank account that has a mismatch.
    const [tempAcct] = await db
      .insert(bankAccounts)
      .values({
        companyId: ctx.companyId,
        accountId: acct['1000'],
        bankName: 'Temp Bank',
        accountNumber: '****9999',
      })
      .returning();

    const reconMismatch = await startReconciliation(ctx, {
      bankAccountId: tempAcct.id,
      statementDate: new Date('2025-01-31'),
      statementBalance: '9999.00', // deliberately wrong
    });

    await expect(completeReconciliation(ctx, reconMismatch.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('completes reconciliation when difference is zero', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    const completed = await completeReconciliation(ctx, recon.id);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeTruthy();
    expect(completed.reconciledBalance).toBe('5400.00');

    // bankAccounts.lastReconciledBalance should be updated.
    const [ba] = await db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.id, bankAcctId));
    expect(ba.lastReconciledBalance).toBe('5400.00');
    expect(ba.lastReconciledDate).toBeTruthy();
  });

  it('rejects toggling lines after completion', async () => {
    const { reconciliations, reconciliationItems: riTable } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    // After completion, listClearable returns nothing (all lines are permanently cleared).
    // Grab a line id directly from reconciliation_items.
    const [item] = await db
      .select({ lineId: riTable.journalEntryLineId })
      .from(riTable)
      .where(eq(riTable.reconciliationId, recon.id))
      .limit(1);
    expect(item).toBeDefined();

    await expect(
      toggleCleared(ctx, recon.id, item.lineId, false),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects completing an already-completed reconciliation', async () => {
    const { reconciliations } = await import('@/lib/db/schema');
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.bankAccountId, bankAcctId));

    await expect(completeReconciliation(ctx, recon.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  // -------------------------------------------------------------------------
  // Trial balance stays balanced throughout
  // -------------------------------------------------------------------------
  it('trial balance remains balanced after all postings', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
