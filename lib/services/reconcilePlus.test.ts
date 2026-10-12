/**
 * Integration tests for the reconciliation completion features:
 *   - getReconcileInfo (beginning balance + discrepancy detection)
 *   - addStatementAdjustments (service charge / interest earned, auto-cleared)
 *   - undoLastReconciliation (revert latest completed session)
 *   - getReconciliationReport / reconciliationDiscrepancies (reports)
 *   - payCreditCardBalance / payCreditCard (CC pay after reconcile)
 *
 * Boots a throwaway PGlite directory following the reconcile.test.ts pattern.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  bankAccounts,
  journalEntries,
  journalEntryLines,
  reconciliations,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  startReconciliation,
  listClearable,
  toggleCleared,
  getProgress,
  completeReconciliation,
  cancelReconciliation,
  getReconcileInfo,
  addStatementAdjustments,
  undoLastReconciliation,
  getReconciliationReport,
  reconciliationDiscrepancies,
  payCreditCardBalance,
} from './reconcile';
import { payCreditCard } from './liabilityPayments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reconcile-plus');

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let checkingBA: string; // bank account (asset)
let ccBA: string; // credit card bank account (liability)
let recon1Id: string; // first completed checking session
let recon2Id: string; // second checking session (later undone)
let ccReconId: string; // completed CC session

async function clearAll(reconId: string, bankAccountId: string, asOf: Date) {
  const lines = await listClearable(ctx, bankAccountId, asOf, reconId);
  for (const line of lines) {
    await toggleCleared(ctx, reconId, line.journalEntryLineId, true);
  }
  return lines;
}

describe('Reconciliation completion features (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'recon-plus@test.local', name: 'Recon Plus', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Recon Plus Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2100', 'Visa Card', 'liability', 'credit_card'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4900', 'Interest Income', 'revenue', 'other_income'],
      ['6400', 'Rent Expense', 'expense', 'operating_expenses'],
      ['6500', 'Bank Service Charges', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, {
        code,
        name,
        type: type as never,
        subtype: subtype as never,
      });
      acct[code] = row.id;
    }

    const [chk] = await db
      .insert(bankAccounts)
      .values({
        companyId: company.id,
        accountId: acct['1000'],
        bankName: 'First National',
        accountNumber: '****1234',
      })
      .returning();
    checkingBA = chk.id;

    const [cc] = await db
      .insert(bankAccounts)
      .values({
        companyId: company.id,
        accountId: acct['2100'],
        bankName: 'Visa',
        accountNumber: '****8888',
      })
      .returning();
    ccBA = cc.id;

    // Checking activity for the first statement period:
    //   +5000 owner investment, −800 rent  →  cleared movement 4200
    await postJournalEntry(ctx, {
      date: new Date('2025-01-01'),
      description: 'Owner investment',
      lines: [
        { accountId: acct['1000'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '5000.00' },
      ],
    });
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
  // getReconcileInfo before any reconciliation
  // -------------------------------------------------------------------------
  it('reports a zero beginning balance for a never-reconciled account', async () => {
    const info = await getReconcileInfo(ctx, checkingBA);
    expect(info.beginningBalance).toBe('0.00');
    expect(info.recomputedBalance).toBe('0.00');
    expect(info.discrepancy).toBe('0.00');
    expect(info.lastReconciledDate).toBeNull();
    expect(info.isCreditCard).toBe(false);
    expect(info.glAccountId).toBe(acct['1000']);
  });

  // -------------------------------------------------------------------------
  // Service charge + interest earned during a session
  // -------------------------------------------------------------------------
  it('service charge and interest earned post, auto-clear, and balance the session', async () => {
    // Statement: 5000 − 800 − 25 (service charge) + 12.50 (interest) = 4187.50
    const recon = await startReconciliation(ctx, {
      bankAccountId: checkingBA,
      statementDate: new Date('2025-01-31'),
      statementBalance: '4187.50',
    });
    recon1Id = recon.id;

    await clearAll(recon1Id, checkingBA, new Date('2025-01-31'));
    let progress = await getProgress(ctx, recon1Id);
    expect(progress.clearedBalance).toBe('4200.00');
    expect(progress.difference).toBe('-12.50');

    progress = await addStatementAdjustments(ctx, recon1Id, {
      serviceCharge: { amount: '25.00', accountId: acct['6500'] },
      interestEarned: { amount: '12.50', accountId: acct['4900'] },
    });
    expect(progress.clearedBalance).toBe('4187.50');
    expect(progress.difference).toBe('0.00');

    // Both adjustment entries carry sourceRef "reconciliation:<id>".
    const adjEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.sourceRef, `reconciliation:${recon1Id}`));
    expect(adjEntries.length).toBe(2);
    expect(adjEntries.every((e) => e.status === 'posted')).toBe(true);
    expect(
      adjEntries.map((e) => e.date.toISOString().slice(0, 10)).every((d) => d === '2025-01-31'),
    ).toBe(true);

    const completed = await completeReconciliation(ctx, recon1Id);
    expect(completed.status).toBe('completed');
    expect(completed.reconciledBalance).toBe('4187.50');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('rejects adjustments on a completed reconciliation', async () => {
    await expect(
      addStatementAdjustments(ctx, recon1Id, {
        serviceCharge: { amount: '5.00', accountId: acct['6500'] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects non-positive and account-less adjustments', async () => {
    const recon = await startReconciliation(ctx, {
      bankAccountId: ccBA, // unused CC account so we don't conflict with checking
      statementDate: new Date('2025-01-31'),
      statementBalance: '0.00',
    });
    await expect(
      addStatementAdjustments(ctx, recon.id, {
        serviceCharge: { amount: '0.00', accountId: acct['6500'] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      addStatementAdjustments(ctx, recon.id, {
        interestEarned: { amount: '5.00', accountId: '' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(addStatementAdjustments(ctx, recon.id, {})).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await cancelReconciliation(ctx, recon.id);
  });

  // -------------------------------------------------------------------------
  // Reconciliation report (summary + detail)
  // -------------------------------------------------------------------------
  it('builds the previous-reconciliation report for the first session', async () => {
    const report = await getReconciliationReport(ctx, recon1Id);

    expect(report.status).toBe('completed');
    expect(report.beginningBalance).toBe('0.00');
    expect(report.statementBalance).toBe('4187.50');
    expect(report.clearedTotal).toBe('4187.50');
    expect(report.clearedBalance).toBe('4187.50');
    expect(report.difference).toBe('0.00');

    // 4 cleared lines: +5000, −800, −25 service charge, +12.50 interest.
    expect(report.lines.length).toBe(4);
    expect(report.depositsCount).toBe(2);
    expect(report.depositsTotal).toBe('5012.50');
    expect(report.paymentsCount).toBe(2);
    expect(report.paymentsTotal).toBe('825.00');
    expect(report.discrepancies.length).toBe(0);
    expect(report.bankName).toBe('First National');
  });

  // -------------------------------------------------------------------------
  // Second session + Undo Last Reconciliation
  // -------------------------------------------------------------------------
  it('completes a second session whose beginning balance carries forward', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2025-02-10'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    });

    const info = await getReconcileInfo(ctx, checkingBA);
    expect(info.beginningBalance).toBe('4187.50');
    expect(info.discrepancy).toBe('0.00');
    expect(info.lastReconciledDate).not.toBeNull();

    const recon = await startReconciliation(ctx, {
      bankAccountId: checkingBA,
      statementDate: new Date('2025-02-28'),
      statementBalance: '5187.50',
    });
    recon2Id = recon.id;

    const lines = await clearAll(recon2Id, checkingBA, new Date('2025-02-28'));
    expect(lines.length).toBe(1); // only the new sale; prior lines are permanently cleared

    const completed = await completeReconciliation(ctx, recon2Id);
    expect(completed.status).toBe('completed');

    const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, checkingBA));
    expect(ba.lastReconciledBalance).toBe('5187.50');

    const report = await getReconciliationReport(ctx, recon2Id);
    expect(report.beginningBalance).toBe('4187.50');
    expect(report.clearedTotal).toBe('1000.00');
    expect(report.difference).toBe('0.00');
  });

  it('refuses to undo while a session is in progress', async () => {
    const blocker = await startReconciliation(ctx, {
      bankAccountId: checkingBA,
      statementDate: new Date('2025-03-31'),
      statementBalance: '5187.50',
    });
    await expect(undoLastReconciliation(ctx, checkingBA)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await cancelReconciliation(ctx, blocker.id);
  });

  it('undoLastReconciliation reverts the latest session and restores prior stamps', async () => {
    const undone = await undoLastReconciliation(ctx, checkingBA);
    expect(undone.id).toBe(recon2Id);
    expect(undone.status).toBe('undone');

    // Bank account stamps roll back to session 1's statement values.
    const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, checkingBA));
    expect(ba.lastReconciledBalance).toBe('4187.50');
    expect(ba.lastReconciledDate?.toISOString().slice(0, 10)).toBe('2025-01-31');

    // The line cleared in session 2 is clearable again.
    const recon = await startReconciliation(ctx, {
      bankAccountId: checkingBA,
      statementDate: new Date('2025-02-28'),
      statementBalance: '5187.50',
    });
    const lines = await listClearable(ctx, checkingBA, new Date('2025-02-28'), recon.id);
    expect(lines.length).toBe(1);
    expect(lines[0].debit).toBe('1000.00');
    await cancelReconciliation(ctx, recon.id);

    // Beginning-balance info reflects the rollback with no discrepancy.
    const info = await getReconcileInfo(ctx, checkingBA);
    expect(info.beginningBalance).toBe('4187.50');
    expect(info.discrepancy).toBe('0.00');
  });

  it('undo with no completed reconciliation is NOT_FOUND', async () => {
    await expect(undoLastReconciliation(ctx, ccBA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // -------------------------------------------------------------------------
  // Discrepancy detection (historical void of a reconciled line)
  // -------------------------------------------------------------------------
  it('detects a reconciled-then-voided entry in info, report, and discrepancy report', async () => {
    // Simulate legacy data: void the rent entry directly (bypassing the posting
    // guard that now blocks voiding reconciled lines).
    const [rentJe] = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.description, 'January rent'),
        ),
      );
    // The whole scenario runs in a transaction that is rolled back at the end, so the
    // direct void (voiding is final at the DB level) never leaks into later tests.
    const ROLLBACK = new Error('rollback-simulated-legacy-void');
    await expect(
      db.transaction(async (tx) => {
        const tctx = { ...ctx, db: tx as unknown as DB };
        await tx
          .update(journalEntries)
          .set({ status: 'void', voidedAt: new Date() })
          .where(eq(journalEntries.id, rentJe.id));

        // Beginning-balance discrepancy: stamped 4187.50 vs recomputed 4987.50 → −800.
        const info = await getReconcileInfo(tctx, checkingBA);
        expect(info.recomputedBalance).toBe('4987.50');
        expect(info.discrepancy).toBe('-800.00');

        // Session report flags the voided line.
        const report = await getReconciliationReport(tctx, recon1Id);
        expect(report.discrepancies.length).toBe(1);
        expect(report.discrepancies[0].description).toBe('January rent');
        expect(report.discrepancies[0].amount).toBe('-800.00');

        // Company-wide discrepancy report shows the same row.
        const all = await reconciliationDiscrepancies(tctx);
        expect(all.length).toBe(1);
        expect(all[0].description).toBe('January rent');
        expect(all[0].amount).toBe('-800.00');
        expect(all[0].bankName).toBe('First National');
        expect(all[0].voidedAt).not.toBeNull();

        // Filtered to an unrelated bank account → empty.
        const ccOnly = await reconciliationDiscrepancies(tctx, ccBA);
        expect(ccOnly.length).toBe(0);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  // -------------------------------------------------------------------------
  // Credit card reconciliation → pay credit card
  // -------------------------------------------------------------------------
  it('reconciles a credit card (sign-aware) and pays the balance', async () => {
    // CC charge: Dr expense / Cr CC liability — increases the amount owed.
    await postJournalEntry(ctx, {
      date: new Date('2025-02-05'),
      description: 'Office supplies on Visa',
      lines: [
        { accountId: acct['6400'], debit: '200.00' },
        { accountId: acct['2100'], credit: '200.00' },
      ],
    });

    const info = await getReconcileInfo(ctx, ccBA);
    expect(info.isCreditCard).toBe(true);
    expect(info.beginningBalance).toBe('0.00');

    const recon = await startReconciliation(ctx, {
      bankAccountId: ccBA,
      statementDate: new Date('2025-02-28'),
      statementBalance: '200.00',
    });
    ccReconId = recon.id;

    await clearAll(ccReconId, ccBA, new Date('2025-02-28'));
    const progress = await getProgress(ctx, ccReconId);
    expect(progress.clearedBalance).toBe('200.00'); // liability natural side: Cr − Dr
    expect(progress.difference).toBe('0.00');

    // Cannot pay before completion.
    await expect(
      payCreditCardBalance(ctx, ccReconId, { paymentAccountId: acct['1000'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await completeReconciliation(ctx, ccReconId);

    const entry = await payCreditCardBalance(ctx, ccReconId, {
      paymentAccountId: acct['1000'],
      date: new Date('2025-03-01'),
    });
    expect(entry.sourceRef).toBe(`cc-payment:${ccReconId}`);
    expect(entry.status).toBe('posted');

    // Dr CC 200 / Cr Checking 200.
    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entry.id));
    const ccLine = lines.find((l) => l.accountId === acct['2100']);
    const bankLine = lines.find((l) => l.accountId === acct['1000']);
    expect(ccLine?.debit).toBe('200.00');
    expect(bankLine?.credit).toBe('200.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('rejects a duplicate credit card payment for the same reconciliation', async () => {
    await expect(
      payCreditCardBalance(ctx, ccReconId, { paymentAccountId: acct['1000'] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects pay-credit-card on a non-liability reconciliation', async () => {
    await expect(
      payCreditCardBalance(ctx, recon1Id, { paymentAccountId: acct['1000'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('payCreditCard validates accounts and amounts', async () => {
    await expect(
      payCreditCard(ctx, {
        creditCardAccountId: acct['2100'],
        paymentAccountId: acct['1000'],
        amount: '0.00',
        date: new Date('2025-03-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Non-liability account on the CC side.
    await expect(
      payCreditCard(ctx, {
        creditCardAccountId: acct['1000'],
        paymentAccountId: acct['2100'],
        amount: '50.00',
        date: new Date('2025-03-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Same account on both sides.
    await expect(
      payCreditCard(ctx, {
        creditCardAccountId: acct['2100'],
        paymentAccountId: acct['2100'],
        amount: '50.00',
        date: new Date('2025-03-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('undo restores null stamps when there is no earlier completed session', async () => {
    const undone = await undoLastReconciliation(ctx, ccBA);
    expect(undone.id).toBe(ccReconId);

    const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, ccBA));
    expect(ba.lastReconciledBalance).toBeNull();
    expect(ba.lastReconciledDate).toBeNull();

    const info = await getReconcileInfo(ctx, ccBA);
    expect(info.beginningBalance).toBe('0.00');
    expect(info.discrepancy).toBe('0.00');
  });

  it('keeps an audit trail row for the undo', async () => {
    const { auditLogs } = await import('@/lib/db/schema');
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'reconciliation'),
          eq(auditLogs.entityId, recon2Id),
        ),
      );
    const undoRow = rows.find(
      (r) => (r.newValues as { status?: string } | null)?.status === 'undone',
    );
    expect(undoRow).toBeDefined();
  });
});
