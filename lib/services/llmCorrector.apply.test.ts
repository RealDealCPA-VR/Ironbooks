/**
 * P2 AI — an approved correction POSTS its correcting journal entry through the posting engine
 * (closing date + password, ledger guards, audit) and links it; nothing posts without approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, errorCorrections, errorDetections, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createManualEntry } from './journal';
import { analyzeError, applyCorrection } from './llmCorrector';
import { trialBalance } from './reports';
import { closingDateExceptionReport } from './accountant/auditReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-llm-corrector-apply');
let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function duplicateDetection(date: string, amount: string) {
  const make = () =>
    createManualEntry(ctx, {
      date: D(date),
      description: `Office supplies ${amount}`,
      lines: [
        { accountId: code['6000'], debit: amount },
        { accountId: code['1000'], credit: amount },
      ],
    });
  await make();
  const dup = await make();
  const [det] = await db
    .insert(errorDetections)
    .values({ companyId: ctx.companyId, journalEntryId: dup.id, errorType: 'duplicate', severity: 'medium', description: 'Possible duplicate' })
    .returning();
  return { dup, det };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'llm-apply@test.local', name: 'Reviewer', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'LLM Apply Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('applyCorrection posts the approved correcting entry', () => {
  it('a duplicate gets a reversal proposal that posts only when approved, and is linked', async () => {
    const { dup, det } = await duplicateDetection('2026-03-10', '75.00');
    const correction = await analyzeError(ctx, det.id); // no AI configured → offline stub
    const entry = (correction.correctionData as { entry?: { date: string; lines: Array<{ accountId: string; debit?: string | null; credit?: string | null }> } }).entry;
    expect(entry?.date).toBe('2026-03-10');
    expect(entry?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: code['6000'], credit: '75.00', debit: null }),
        expect.objectContaining({ accountId: code['1000'], debit: '75.00', credit: null }),
      ]),
    );

    // Not approved: refused, nothing posted, still pending.
    const before = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    await expect(applyCorrection(ctx, correction.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length).toBe(before);

    const applied = await applyCorrection(ctx, correction.id, { approved: true });
    expect(applied.status).toBe('applied');
    const postedId = (applied.correctionData as { postedEntryId?: string }).postedEntryId!;
    expect(postedId).toBeTruthy();
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, postedId));
    expect(je.status).toBe('posted');
    expect(je.sourceRef).toBe('manual');
    expect(je.description).toMatch(new RegExp(`Reverse duplicate entry #${dup.entryNumber}`));
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, postedId));
    expect(lines).toHaveLength(2);

    const [d] = await db.select().from(errorDetections).where(eq(errorDetections.id, det.id));
    expect(d.resolvedAt).not.toBeNull();
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'error_correction'), eq(auditLogs.entityId, correction.id)));
    expect((audit.newValues as { postedEntryId: string }).postedEntryId).toBe(postedId);
    expect((await trialBalance(ctx)).balanced).toBe(true);

    await expect(applyCorrection(ctx, correction.id, { approved: true })).rejects.toThrow(/already been applied/);
  });

  it('respects the closing date: refused without the password (nothing changes), recorded with it', async () => {
    const { det } = await duplicateDetection('2026-01-15', '20.00');
    const correction = await analyzeError(ctx, det.id);
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    try {
      await expect(applyCorrection(ctx, correction.id, { approved: true })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const [c] = await db.select().from(errorCorrections).where(eq(errorCorrections.id, correction.id));
      expect(c.status).toBe('pending');
      const [d] = await db.select().from(errorDetections).where(eq(errorDetections.id, det.id));
      expect(d.resolvedAt).toBeNull();

      const applied = await applyCorrection({ ...ctx, closingDateOverride: true }, correction.id, { approved: true });
      const postedId = (applied.correctionData as { postedEntryId?: string }).postedEntryId!;
      const report = await closingDateExceptionReport(ctx);
      expect(report.rows.some((r) => r.entryId === postedId && r.operation === 'post')).toBe(true);
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null } as never);
    }
  });

  it('a user-entered correcting entry must balance and use this company’s accounts', async () => {
    const [det] = await db
      .insert(errorDetections)
      .values({ companyId: ctx.companyId, errorType: 'unusual_pattern', severity: 'low', description: 'Big amount' })
      .returning();
    const correction = await analyzeError(ctx, det.id);
    const base = { date: '2026-04-01', description: 'Fix misposting' };
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: { ...base, lines: [{ accountId: code['6000'], debit: '10.00' }, { accountId: code['1000'], credit: '9.00' }] },
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
    await expect(
      applyCorrection(ctx, correction.id, {
        approved: true,
        entry: { ...base, lines: [{ accountId: code['6000'], debit: '10.00' }, { accountId: '00000000-0000-4000-8000-000000000000', credit: '10.00' }] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const [c] = await db.select().from(errorCorrections).where(eq(errorCorrections.id, correction.id));
    expect(c.status).toBe('pending');

    const ok = await applyCorrection(ctx, correction.id, {
      approved: true,
      entry: { ...base, lines: [{ accountId: code['6000'], debit: '10.00' }, { accountId: code['1000'], credit: '10.00' }] },
    });
    expect((ok.correctionData as { postedEntryId?: string }).postedEntryId).toBeTruthy();
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a correction with no entry (e.g. add a description) is just marked applied', async () => {
    const [det] = await db
      .insert(errorDetections)
      .values({ companyId: ctx.companyId, errorType: 'missing_field', severity: 'low', description: 'Blank description' })
      .returning();
    const correction = await analyzeError(ctx, det.id);
    const applied = await applyCorrection(ctx, correction.id);
    expect(applied.status).toBe('applied');
    expect((applied.correctionData as { postedEntryId?: string }).postedEntryId).toBeUndefined();
  });
});
