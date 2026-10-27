/**
 * AI Error Detection service — rules-based scan over journal entries to surface
 * data-quality issues. Findings are stored as `error_detections` rows so the LLM
 * corrector and the UI can reference them by id.
 *
 * Rules (each produces one or more detections):
 *   1. Unbalanced posted entries (total debit ≠ total credit within a cent) — CRITICAL
 *   2. Duplicate journal entries (same date + description + total debit amount) — HIGH
 *   3. Missing description or zero-amount lines — LOW
 *   4. Outlier amounts (> mean + 3 * stddev within an account) — MEDIUM
 *
 * Multi-tenant: every query is scoped by ctx.companyId.
 */
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  errorCorrections,
  errorDetections,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { writeAudit } from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionRow = typeof errorDetections.$inferSelect;

// ---------------------------------------------------------------------------
// detectErrors
// ---------------------------------------------------------------------------

/**
 * Run all rule checks for the company and persist any NEW detections (skips
 * entries that already have an unresolved detection of the same type).
 * Returns the full list of detections just inserted during this run.
 */
export async function detectErrors(ctx: ServiceContext): Promise<DetectionRow[]> {
  // The unresolved findings are read once (not one query per finding), and the new ones are
  // saved together at the end, in rule order.
  const run = new ScanRun(await openDetectionKeys(ctx));
  await detectUnbalanced(ctx, run);
  await detectDuplicates(ctx, run);
  await detectMissingFields(ctx, run);
  await detectOutliers(ctx, run);
  return run.save(ctx);
}

type NewDetection = typeof errorDetections.$inferInsert;
const detectionKey = (entryId: string | null | undefined, errorType: string) => `${errorType}:${entryId ?? ''}`;

/** "type:entryId" of every unresolved finding of the company. */
async function openDetectionKeys(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ entryId: errorDetections.journalEntryId, errorType: errorDetections.errorType })
    .from(errorDetections)
    .where(and(eq(errorDetections.companyId, ctx.companyId), isNull(errorDetections.resolvedAt)));
  return new Set(rows.map((r) => detectionKey(r.entryId, r.errorType)));
}

/** The findings of one scan: an entry with an unresolved finding of the same type is skipped. */
class ScanRun {
  private readonly pending: NewDetection[] = [];
  constructor(private readonly open: Set<string>) {}
  add(d: NewDetection): void {
    const k = detectionKey(d.journalEntryId, d.errorType);
    if (this.open.has(k)) return;
    this.open.add(k);
    this.pending.push(d);
  }
  async save(ctx: ServiceContext): Promise<DetectionRow[]> {
    const out: DetectionRow[] = [];
    for (let i = 0; i < this.pending.length; i += 500) {
      out.push(...(await ctx.db.insert(errorDetections).values(this.pending.slice(i, i + 500)).returning()));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// listErrors
// ---------------------------------------------------------------------------

/**
 * List error_detections for the company.
 * @param resolved  undefined = all, true = resolved only, false = open only.
 */
export async function listErrors(
  ctx: ServiceContext,
  opts?: { resolved?: boolean },
): Promise<DetectionRow[]> {
  const conds = [eq(errorDetections.companyId, ctx.companyId)];

  if (opts?.resolved === true) {
    conds.push(isNotNull(errorDetections.resolvedAt));
  } else if (opts?.resolved === false) {
    conds.push(isNull(errorDetections.resolvedAt));
  }

  return ctx.db
    .select()
    .from(errorDetections)
    .where(and(...conds))
    .orderBy(errorDetections.detectedAt);
}

// ---------------------------------------------------------------------------
// Internal rule helpers
// ---------------------------------------------------------------------------

/**
 * Rule 1 — Unbalanced posted entries.
 * A correctly-posted entry should have SUM(debit) == SUM(credit). We re-verify
 * from raw lines rather than trusting the posting engine (which guards this), so
 * that any data imported via direct SQL or a broken migration is caught.
 */
async function detectUnbalanced(
  ctx: ServiceContext,
  run: ScanRun,
): Promise<void> {
  // Sum lines per entry for posted (non-void) entries.
  const sums = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}::numeric), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}::numeric), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .groupBy(journalEntryLines.journalEntryId);

  for (const row of sums) {
    if (Money.equalWithinCent(row.totalDebit, row.totalCredit)) continue;

    // Skipped when an unresolved detection already exists for this entry + type.
    const diff = toAmountString(Money.abs(Money.sub(row.totalDebit, row.totalCredit)));
    run.add({
      companyId: ctx.companyId,
      journalEntryId: row.entryId,
      errorType: 'unbalanced',
      severity: 'critical',
      description:
        `Unbalanced journal entry: debits ${toAmountString(row.totalDebit)} ≠ ` +
        `credits ${toAmountString(row.totalCredit)} (diff ${diff}).`,
    });
  }
}

/**
 * Rule 2 — Duplicate journal entries.
 * Entries with the same (date, description, total debit) within the same company
 * are flagged as likely duplicates. We group and find counts > 1.
 */
async function detectDuplicates(
  ctx: ServiceContext,
  run: ScanRun,
): Promise<void> {
  // Compute per-entry totals + entry header info.
  const entryTotals = await ctx.db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      description: journalEntries.description,
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}::numeric), 0)`,
    })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .groupBy(journalEntries.id, journalEntries.date, journalEntries.description);

  // A copy whose duplicate fix (a posted reversing entry) is in place no longer counts: it must
  // not be flagged again, and its twin is no longer a duplicate of anything.
  const corrected = await correctedDuplicateEntryIds(ctx);

  // Group in-memory to find duplicates (avoids a complex SQL self-join in PGlite).
  const groups = new Map<string, typeof entryTotals>();
  for (const row of entryTotals) {
    if (corrected.has(row.entryId)) continue;
    const key = duplicateKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Flag each entry in the duplicate group that doesn't yet have a detection.
    for (const row of group) {
      run.add({
        companyId: ctx.companyId,
        journalEntryId: row.entryId,
        errorType: 'duplicate',
        severity: 'high',
        description:
          `Possible duplicate journal entry: "${row.description}" on ` +
          `${fmtDate(row.date)} for ${toAmountString(row.totalDebit)} — ` +
          `found ${group.length} matching entries.`,
      });
    }
  }
}

/**
 * Rule 3 — Missing description or zero-amount lines.
 * Covers two sub-cases:
 *   a) Journal entry has an empty/whitespace description.
 *   b) A journal entry line has both debit and credit null/0 (shouldn't happen
 *      after posting, but direct imports can introduce it).
 */
async function detectMissingFields(
  ctx: ServiceContext,
  run: ScanRun,
): Promise<void> {
  // 3a: entries with blank descriptions.
  const blankDesc = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        // Only entries in the books: a voided or draft entry is not a finding (and voiding one
        // could never make it go away).
        eq(journalEntries.status, 'posted'),
        sql`TRIM(${journalEntries.description}) = ''`,
      ),
    );

  for (const row of blankDesc) {
    run.add({
      companyId: ctx.companyId,
      journalEntryId: row.id,
      errorType: 'missing_field',
      severity: 'low',
      description: 'Journal entry has no description (blank memo).',
    });
  }

  // 3b: lines where both debit and credit are NULL (zero-amount lines).
  const zeroLines = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      lineId: journalEntryLines.id,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        isNull(journalEntryLines.debit),
        isNull(journalEntryLines.credit),
      ),
    );

  // Group by entry — one detection per entry (not per line).
  const zeroEntries = [...new Set(zeroLines.map((r) => r.entryId))];
  for (const entryId of zeroEntries) {
    const lineCount = zeroLines.filter((r) => r.entryId === entryId).length;
    run.add({
      companyId: ctx.companyId,
      journalEntryId: entryId,
      errorType: 'missing_field',
      severity: 'low',
      description: `${lineCount} zero-amount line(s) found (both debit and credit are null).`,
    });
  }
}

/**
 * Rule 4 — Outlier amounts per account (> mean + 3 * stddev).
 * We look at all debit amounts per account across posted entries and flag lines
 * whose absolute value is more than 3 standard deviations above the mean.
 * Only accounts with ≥ 3 lines are analysed (too few points → no stable stddev).
 */
async function detectOutliers(
  ctx: ServiceContext,
  run: ScanRun,
): Promise<void> {
  // Fetch all line amounts with their account id + entry id.
  const lines = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
      ),
    );

  // Group by account; compute the absolute amount (max of debit/credit). Decimal arithmetic, so
  // the mean / threshold shown in the finding are the exact figures (no float noise).
  type LineInfo = { entryId: string; amount: Decimal };
  const byAccount = new Map<string, LineInfo[]>();
  for (const l of lines) {
    const abs = Decimal.max(Money.of(l.debit ?? '0').abs(), Money.of(l.credit ?? '0').abs());
    const bucket = byAccount.get(l.accountId) ?? [];
    bucket.push({ entryId: l.entryId, amount: abs });
    byAccount.set(l.accountId, bucket);
  }

  // The finding names the account the way the user knows it ("6110 · Fuel"), not by its id.
  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acctLabel = new Map(acctRows.map((a) => [a.id, a.code ? `${a.code} · ${a.name}` : a.name]));

  for (const [accountId, bucket] of byAccount) {
    if (bucket.length < 3) continue; // insufficient data

    const n = bucket.length;
    const mean = bucket.reduce((s, x) => s.plus(x.amount), new Decimal(0)).dividedBy(n);
    const variance = bucket.reduce((s, x) => s.plus(x.amount.minus(mean).pow(2)), new Decimal(0)).dividedBy(n);
    const stddev = variance.sqrt();
    if (stddev.isZero()) continue; // all identical amounts → no outliers

    const threshold = mean.plus(stddev.times(3));

    for (const { entryId, amount } of bucket) {
      if (amount.lessThanOrEqualTo(threshold)) continue;
      run.add({
        companyId: ctx.companyId,
        journalEntryId: entryId,
        errorType: 'unusual_pattern',
        severity: 'medium',
        description:
          `Outlier amount ${toAmountString(amount)} on account ${acctLabel.get(accountId) ?? '(unknown account)'} ` +
          `(mean ${toAmountString(mean)}, stddev ${toAmountString(stddev)}, ` +
          `threshold ${toAmountString(threshold)}).`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The duplicate-group key: same date + description + total debit. */
function duplicateKey(row: { date: Date | null; description: string | null; totalDebit: string }): string {
  return `${row.date?.toISOString?.() ?? row.date}|${row.description}|${toAmountString(row.totalDebit)}`;
}

/**
 * Entries already fixed as duplicates: an APPLIED correction of a 'duplicate' detection on the
 * entry whose correcting (reversing) entry is still posted. If that reversal was voided since,
 * the copy is live again and counts as a duplicate once more.
 */
export async function correctedDuplicateEntryIds(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ entryId: errorDetections.journalEntryId, data: errorCorrections.correctionData })
    .from(errorCorrections)
    .innerJoin(errorDetections, eq(errorCorrections.errorDetectionId, errorDetections.id))
    .where(
      and(
        eq(errorDetections.companyId, ctx.companyId),
        eq(errorDetections.errorType, 'duplicate'),
        eq(errorCorrections.status, 'applied'),
        isNotNull(errorDetections.journalEntryId),
      ),
    );
  const postedBy = new Map<string, string>();
  for (const r of rows) {
    const posted = (r.data as { postedEntryId?: string } | null)?.postedEntryId;
    if (r.entryId && posted) postedBy.set(posted, r.entryId);
  }
  const out = new Set<string>();
  if (postedBy.size === 0) return out;
  const live = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        inArray(journalEntries.id, [...postedBy.keys()]),
      ),
    );
  for (const l of live) out.add(postedBy.get(l.id)!);
  return out;
}

/**
 * The other live copies of a duplicate entry: posted entries with the same date, description
 * and total debit that have not themselves been fixed as duplicates. Empty means the entry is
 * no longer a duplicate (its twin was voided or already reversed) — reversing it now would
 * wipe out the real transaction.
 */
export async function liveDuplicateSiblings(ctx: ServiceContext, journalEntryId: string): Promise<string[]> {
  const totalsOf = (cond: ReturnType<typeof and>) =>
    ctx.db
      .select({
        entryId: journalEntries.id,
        date: journalEntries.date,
        description: journalEntries.description,
        totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}::numeric), 0)`,
      })
      .from(journalEntries)
      .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(cond)
      .groupBy(journalEntries.id, journalEntries.date, journalEntries.description);
  const [self] = await totalsOf(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, journalEntryId)));
  if (!self) return [];
  const candidates = await totalsOf(
    and(
      eq(journalEntries.companyId, ctx.companyId),
      eq(journalEntries.status, 'posted'),
      eq(journalEntries.date, self.date),
      eq(journalEntries.description, self.description),
    ),
  );
  const corrected = await correctedDuplicateEntryIds(ctx);
  if (corrected.has(journalEntryId)) return []; // this copy was already reversed
  const key = duplicateKey(self);
  return candidates
    .filter((c) => c.entryId !== journalEntryId && !corrected.has(c.entryId) && duplicateKey(c) === key)
    .map((c) => c.entryId);
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '(unknown date)';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}
