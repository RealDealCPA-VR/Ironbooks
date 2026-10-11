/**
 * Integration tests for the AI error-detection + LLM-corrector module.
 *
 * Uses a throwaway PGlite database under .bookkeeper-data/test-ai-errors so the
 * tests are fully isolated from the dev data and can run in CI without any
 * external services. ANTHROPIC_API_KEY is deliberately not set here; the corrector
 * falls back to its deterministic offline stub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { trialBalance } from './reports';
import { detectErrors, listErrors } from './errorDetection';
import { analyzeError, applyCorrection } from './llmCorrector';

// ---------------------------------------------------------------------------
// Test bootstrap
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-errors');
let ctx: ServiceContext;
let db: DB;
/** Maps account code → uuid */
const acct: Record<string, string> = {};

/** Ledger triggers (0017) switched off to fabricate a pre-0017 "legacy" unbalanced entry. */
const LEGACY_TRIGGERS: Array<[string, string]> = [
  ['journal_entries', 'bka_je_balanced'],
  ['journal_entry_lines', 'bka_jel_balanced'],
  ['journal_entry_lines', 'bka_jel_guard'],
  ['journal_entry_lines', 'bka_jel_sync_ins'],
  ['accounts', 'bka_accounts_guard'],
];

describe('AI Error Detection + LLM Corrector', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // Seed user + company.
    const [user] = await db
      .insert(users)
      .values({ email: 'ai-test@bookkeeper.local', name: 'AI Test User', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'AI Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Seed a minimal Chart of Accounts.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
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

  // -------------------------------------------------------------------------
  // 1. Unbalanced entry (bypasses the posting engine by direct SQL insert)
  // -------------------------------------------------------------------------

  it('detectErrors finds an unbalanced posted entry', async () => {
    // Since migration 0017 the DATABASE refuses an unbalanced posted entry at COMMIT, so
    // this can only exist in a LEGACY file written before the guard. Simulate that by
    // disabling the ledger triggers for one transaction (test-only DDL, restored to ENABLE
    // ALWAYS before commit) and applying the cached-balance deltas the way the pre-0017
    // posting code did.
    const userId = ctx.userId ?? '00000000-0000-0000-0000-000000000000';
    const entry = await db.transaction(async (tx) => {
      for (const [table, trig] of LEGACY_TRIGGERS) {
        await tx.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trig}`));
      }
      const [e] = await tx
        .insert(journalEntries)
        .values({
          companyId: ctx.companyId,
          entryNumber: 9001,
          date: new Date('2025-03-01'),
          description: 'Unbalanced test entry',
          status: 'posted',
          createdBy: userId,
        })
        .returning();
      // debit 500, credit 300 → out of balance by 200.
      await tx.insert(journalEntryLines).values([
        { journalEntryId: e.id, accountId: acct['1000'], debit: '500.00', credit: null },
        { journalEntryId: e.id, accountId: acct['4000'], debit: null, credit: '300.00' },
      ]);
      await tx.execute(sql`UPDATE accounts SET balance = balance + 500 WHERE id = ${acct['1000']}`);
      await tx.execute(sql`UPDATE accounts SET balance = balance + 300 WHERE id = ${acct['4000']}`);
      for (const [table, trig] of LEGACY_TRIGGERS) {
        await tx.execute(sql.raw(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trig}`));
      }
      return e;
    });

    const detections = await detectErrors(ctx);

    const unbalanced = detections.filter((d) => d.errorType === 'unbalanced');
    expect(unbalanced.length).toBeGreaterThanOrEqual(1);
    expect(unbalanced[0].severity).toBe('critical');
    expect(unbalanced[0].journalEntryId).toBe(entry.id);
    expect(unbalanced[0].description).toMatch(/debits.*credits/i);
  });

  // -------------------------------------------------------------------------
  // 2. Duplicate entries
  // -------------------------------------------------------------------------

  it('detectErrors finds duplicate posted entries', async () => {
    // Post the same logical transaction twice using postJournalEntry.
    const duplicateInput = {
      date: new Date('2025-03-10'),
      description: 'Duplicate sale',
      lines: [
        { accountId: acct['1200'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    };
    await postJournalEntry(ctx, duplicateInput);
    await postJournalEntry(ctx, duplicateInput);

    const detections = await detectErrors(ctx);
    const dupes = detections.filter((d) => d.errorType === 'duplicate');
    // Both entries in the duplicate pair should be flagged.
    expect(dupes.length).toBeGreaterThanOrEqual(2);
    expect(dupes[0].severity).toBe('high');
    expect(dupes[0].description).toMatch(/duplicate/i);
  });

  // -------------------------------------------------------------------------
  // 3. Missing description
  // -------------------------------------------------------------------------

  it('detectErrors finds entries with blank descriptions', async () => {
    const userId = ctx.userId ?? '00000000-0000-0000-0000-000000000000';
    // Header + lines in ONE transaction: the DB checks posted entries at COMMIT.
    const entry = await db.transaction(async (tx) => {
      const [e] = await tx
        .insert(journalEntries)
        .values({
          companyId: ctx.companyId,
          entryNumber: 9002,
          date: new Date('2025-03-05'),
          description: '   ', // blank / whitespace only
          status: 'posted',
          createdBy: userId,
        })
        .returning();

      // Add balanced lines so this entry won't also trigger unbalanced.
      await tx.insert(journalEntryLines).values([
        { journalEntryId: e.id, accountId: acct['1000'], debit: '100.00', credit: null },
        { journalEntryId: e.id, accountId: acct['3000'], debit: null, credit: '100.00' },
      ]);
      return e;
    });

    const detections = await detectErrors(ctx);
    const missingField = detections.filter(
      (d) => d.errorType === 'missing_field' && d.journalEntryId === entry.id,
    );
    expect(missingField.length).toBeGreaterThanOrEqual(1);
    expect(missingField[0].severity).toBe('low');
  });

  // -------------------------------------------------------------------------
  // 4. listErrors filtering
  // -------------------------------------------------------------------------

  it('listErrors returns open detections when resolved=false', async () => {
    const open = await listErrors(ctx, { resolved: false });
    expect(open.length).toBeGreaterThan(0);
    for (const d of open) {
      expect(d.resolvedAt).toBeNull();
    }
  });

  it('listErrors returns all detections when no filter is passed', async () => {
    const all = await listErrors(ctx);
    expect(all.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. analyzeError (offline stub — no API key needed)
  // -------------------------------------------------------------------------

  it('analyzeError returns an offline stub correction when API key is absent', async () => {
    // Make sure there is at least one detection to work with.
    const open = await listErrors(ctx, { resolved: false });
    expect(open.length).toBeGreaterThan(0);

    const detection = open[0];
    // Ensure ANTHROPIC_API_KEY is absent for this test.
    delete process.env.ANTHROPIC_API_KEY;

    const correction = await analyzeError(ctx, detection.id);

    expect(correction.errorDetectionId).toBe(detection.id);
    expect(correction.suggestedBy).toBe('llm');
    expect(correction.status).toBe('pending');
    expect(correction.correctionType).toBeTruthy();
    expect(correction.llmReasoning).toMatch(/offline stub/i);
    // correctionData should have action + changes.
    expect(correction.correctionData?.action).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 6. applyCorrection marks applied + resolves detection
  // -------------------------------------------------------------------------

  it('applyCorrection marks the correction applied and resolves the detection', async () => {
    // Find a pending correction to apply.
    const open = await listErrors(ctx, { resolved: false });
    // Run analyzeError on the second open detection (to avoid reusing the one
    // we may have already analysed above).
    const target = open.find((d) => d.id !== open[0].id) ?? open[0];

    delete process.env.ANTHROPIC_API_KEY;
    const correction = await analyzeError(ctx, target.id);
    expect(correction.status).toBe('pending');

    const applied = await applyCorrection(ctx, correction.id);
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeTruthy();

    // The parent detection should now be resolved.
    const [det] = await db
      .select()
      .from(
        // Re-import is fine — the schema is already in scope from top-level imports.
        // We use the schema table directly from the module-level import.
        (await import('@/lib/db/schema')).errorDetections,
      )
      .where(eq((await import('@/lib/db/schema')).errorDetections.id, target.id));
    expect(det.resolvedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. Trial balance stays balanced after all the above
  // -------------------------------------------------------------------------

  it('trial balance refuses loudly to present the legacy out-of-balance ledger', async () => {
    // The legacy unbalanced entry injected above makes the books unbalanced; reports must
    // never silently show such a trial balance — they throw an INTEGRITY error instead.
    await expect(trialBalance(ctx)).rejects.toThrow(/INTEGRITY/);

    // Voiding the bad entry (the supported repair) restores a balanced trial balance.
    const [bad] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.entryNumber, 9001));
    await voidJournalEntry(ctx, bad.id);
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
