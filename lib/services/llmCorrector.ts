/**
 * LLM Corrector — asks the company's AI router (task 'error-correction') to analyse a
 * detected accounting error, generate a structured correction suggestion, and let a user
 * apply it.
 *
 * Key design decisions:
 *   - Local-first: the call goes through lib/ai/router.ts, so it uses the company's tailnet
 *     model by default and only reaches a cloud model when the company opted in — with
 *     names / account numbers redacted before the request leaves the machine.
 *   - Structured output: the reply is validated with zod (one repair attempt in the router).
 *   - Offline-safe: when no model is configured/eligible (or every model fails) the service
 *     returns a deterministic stub suggestion, so tests and offline installs keep working.
 *   - Correcting entries are proposed, never posted silently: a suggestion may carry a
 *     proposed correcting journal entry (the reversal of a duplicate General Journal entry, or
 *     balanced lines the model proposed on existing accounts). applyCorrection posts it ONLY
 *     with the user's explicit approval, as a General Journal entry through journal.ts /
 *     posting.ts (closing date + password, ledger guards, audit), links the posted entry to
 *     the correction and resolves the detection — all in one transaction.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  errorCorrections,
  errorDetections,
  journalEntries,
  journalEntryLines,
  accounts,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { inTransaction, notFound, validation, writeAudit, ServiceError } from './_base';
import { createManualEntry } from './journal';
import type { JournalEntityType, PostingLine } from './posting';
import { Money, toAmountString } from '@/lib/money';
import { buildRouter, type BuildRouterOptions } from './aiSettings';
import { AiError } from '@/lib/ai/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CorrectionRow = typeof errorCorrections.$inferSelect;

export interface LlmSuggestion {
  analysis: string;
  action: string;
  steps: string[];
  impact: string;
}

/** A correcting journal entry proposed with a suggestion (posted only on approval). */
export interface ProposedEntry {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  lines: Array<{
    accountId: string;
    accountCode?: string;
    accountName?: string;
    debit?: string | null;
    credit?: string | null;
    memo?: string | null;
    entityType?: JournalEntityType | null;
    entityId?: string | null;
  }>;
}

/** What the user approved when applying a correction. */
export interface ApplyCorrectionOptions {
  /** Explicit approval to post the correcting entry (required whenever one will be posted). */
  approved?: boolean;
  /** The correcting entry as the user reviewed / edited it (defaults to the proposed one). */
  entry?: ProposedEntry | null;
}

// ---------------------------------------------------------------------------
// analyzeError
// ---------------------------------------------------------------------------

/**
 * Fetch the detection + related entry, build an accounting-context prompt,
 * ask the AI router for a JSON suggestion, and persist an `error_corrections` row.
 *
 * When no AI model is available, returns a deterministic offline stub.
 */
export async function analyzeError(
  ctx: ServiceContext,
  errorId: string,
  routerOpts: BuildRouterOptions = {},
): Promise<CorrectionRow> {
  // --- Load the detection (company-scoped) ---
  const [detection] = await ctx.db
    .select()
    .from(errorDetections)
    .where(
      and(
        eq(errorDetections.id, errorId),
        eq(errorDetections.companyId, ctx.companyId),
      ),
    );
  if (!detection) throw notFound('Error detection');

  if (detection.resolvedAt) {
    throw validation('This error detection has already been resolved.');
  }

  // --- Load related journal entry + lines (if available) ---
  let entryContext = '';
  let reversal: ProposedEntry | null = null;
  if (detection.journalEntryId) {
    const [entry] = await ctx.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, detection.journalEntryId));

    if (entry) {
      const lines = await ctx.db
        .select({
          lineId: journalEntryLines.id,
          accountId: journalEntryLines.accountId,
          accountCode: accounts.code,
          accountName: accounts.name,
          accountType: accounts.type,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          memo: journalEntryLines.memo,
        })
        .from(journalEntryLines)
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(eq(journalEntryLines.journalEntryId, entry.id));
      if (detection.errorType === 'duplicate') reversal = await reversalProposal(ctx, entry.id);

      entryContext = `
Journal Entry #${entry.entryNumber}:
  Date: ${entry.date?.toISOString?.()?.slice(0, 10) ?? entry.date}
  Description: ${entry.description}
  Status: ${entry.status}
  Lines:
${lines
  .map(
    (l) =>
      `    - [${l.accountCode}] ${l.accountName} (${l.accountType})` +
      `  debit: ${l.debit ?? '—'}  credit: ${l.credit ?? '—'}` +
      (l.memo ? `  memo: ${l.memo}` : ''),
  )
  .join('\n')}`;
    }
  }

  // --- Build the suggestion (live or stub) ---
  let suggestion: LlmSuggestion;
  let llmReasoningText: string;

  const router = await buildRouter(ctx, routerOpts);
  const unavailable = router.unavailableReason('error-correction');
  if (unavailable) {
    // Offline stub — deterministic so tests are reproducible.
    suggestion = buildStubSuggestion(detection.errorType, detection.description);
    llmReasoningText = `Offline stub: ${unavailable}`;
  } else {
    try {
      const result = await router.chatJson(
        'error-correction',
        [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: buildUserMessage(detection, entryContext) },
        ],
        suggestionSchema,
        { jsonSchema: SUGGESTION_JSON_SCHEMA, temperature: 0.1, maxTokens: 1024 },
      );
      suggestion = result.data;
      llmReasoningText = `${result.raw}

[model: ${result.model} via ${result.providerId}${result.redacted ? ', redacted' : ''}]`;
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      suggestion = buildStubSuggestion(detection.errorType, detection.description);
      llmReasoningText = `Offline stub: AI model unavailable (${err.message}).`;
    }
  }

  // --- Proposed correcting entry (reviewed and approved by the user before posting) ---
  // A duplicate's fix is always the exact reversal of the duplicate (never model-made numbers);
  // otherwise a model-proposed entry is kept only if it balances on this company's accounts.
  const proposed: ProposedEntry | null =
    detection.errorType === 'duplicate' || suggestion.action === 'void_duplicate'
      ? reversal
      : await modelProposal(ctx, suggestion, detection.description);

  // --- Persist the correction suggestion ---
  const [correction] = await ctx.db
    .insert(errorCorrections)
    .values({
      errorDetectionId: detection.id,
      suggestedBy: 'llm',
      correctionType: suggestion.action,
      correctionData: {
        action: suggestion.action,
        changes: { steps: suggestion.steps },
        reasoning: suggestion.analysis,
        ...(proposed ? { entry: proposed } : {}),
      },
      llmReasoning: llmReasoningText,
      status: 'pending',
    })
    .returning();

  return correction;
}

// ---------------------------------------------------------------------------
// applyCorrection
// ---------------------------------------------------------------------------

/**
 * Apply a correction. When it carries a correcting journal entry (proposed, or edited by the
 * user in `opts.entry`), the entry is posted ONLY with explicit approval (`opts.approved`), as a
 * General Journal entry through journal.ts / posting.ts — so the closing date (and its password),
 * the ledger guards and the A/R / A/P name rules all apply — and linked to the correction
 * (correctionData.postedEntryId). Posting, marking the correction applied, resolving the
 * detection and the audit row happen in ONE transaction: if posting is refused nothing changes.
 * A correction without an entry (e.g. "add a description") is simply marked applied.
 */
export async function applyCorrection(
  ctx: ServiceContext,
  correctionId: string,
  opts: ApplyCorrectionOptions = {},
): Promise<CorrectionRow> {
  return inTransaction(ctx, async (tx) => {
    // Load the correction (and verify it belongs to this company via the detection join).
    const [row] = await tx.db
      .select({
        correction: errorCorrections,
        detection: errorDetections,
      })
      .from(errorCorrections)
      .innerJoin(errorDetections, eq(errorCorrections.errorDetectionId, errorDetections.id))
      .where(
        and(
          eq(errorCorrections.id, correctionId),
          eq(errorDetections.companyId, tx.companyId),
        ),
      );

    if (!row) throw notFound('Error correction');
    if (row.correction.status === 'applied') {
      throw validation('Correction has already been applied.');
    }
    if (row.correction.status === 'rejected') {
      throw validation('Cannot apply a rejected correction.');
    }

    const data = (row.correction.correctionData ?? {}) as NonNullable<CorrectionRow['correctionData']> & {
      entry?: ProposedEntry;
      postedEntryId?: string;
    };
    const entry = opts.entry ?? data.entry ?? null;
    let posted: { id: string; entryNumber: number } | null = null;
    if (entry) {
      if (opts.approved !== true) {
        throw validation('Review the correcting journal entry and approve it to post it.');
      }
      if (!tx.userId) throw new ServiceError('FORBIDDEN', 'Posting a correction needs a signed-in user.');
      // The correction was computed from the flagged entry as it was then. If that entry has
      // since been voided (or deleted), the problem is already fixed — posting the stored
      // reversal now would correct it a second time.
      if (row.detection.journalEntryId) {
        const [source] = await tx.db
          .select({ status: journalEntries.status })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.id, row.detection.journalEntryId),
              eq(journalEntries.companyId, tx.companyId),
            ),
          );
        if (!source || source.status !== 'posted') {
          throw validation(
            'The entry this correction was made for has been voided or changed since. Ask for a new suggestion instead.',
          );
        }
      }
      const date = new Date(`${entry.date}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || isNaN(date.getTime())) {
        throw validation('The correcting entry needs a valid date.');
      }
      const lines: PostingLine[] = entry.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit ?? null,
        credit: l.credit ?? null,
        memo: l.memo ?? null,
        entityType: l.entityType ?? null,
        entityId: l.entityId ?? null,
      }));
      await assertCompanyAccounts(tx, lines);
      const je = await createManualEntry(tx, {
        date,
        description: entry.description?.trim() || 'Correcting entry',
        reference: 'AI correction',
        lines,
      });
      posted = { id: je.id, entryNumber: je.entryNumber };
    }

    const now = new Date();
    const [updated] = await tx.db
      .update(errorCorrections)
      .set({
        status: 'applied',
        appliedAt: now,
        reviewedBy: tx.userId ?? undefined,
        ...(posted || opts.entry
          ? {
              correctionData: {
                ...data,
                ...(opts.entry ? { entry: opts.entry } : {}),
                ...(posted ? { postedEntryId: posted.id } : {}),
              },
            }
          : {}),
      })
      .where(eq(errorCorrections.id, correctionId))
      .returning();

    // Resolve the parent detection.
    await tx.db
      .update(errorDetections)
      .set({ resolvedAt: now })
      .where(eq(errorDetections.id, row.correction.errorDetectionId));

    // Audit trail (the posted entry has its own audit rows from the posting engine).
    await writeAudit(tx, {
      action: 'llm_correction',
      entityType: 'error_correction',
      entityId: correctionId,
      oldValues: { status: row.correction.status },
      newValues: {
        status: 'applied',
        appliedAt: now.toISOString(),
        approvedBy: tx.userId,
        postedEntryId: posted?.id ?? null,
        postedEntryNumber: posted?.entryNumber ?? null,
      },
      llmReasoning: row.correction.llmReasoning ?? undefined,
    });

    return updated;
  });
}

/** Every line must be on an account of this company (never trust ids from the client / model). */
async function assertCompanyAccounts(ctx: ServiceContext, lines: PostingLine[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId)));
  const own = new Set(rows.map((r) => r.id));
  if (ids.some((id) => !own.has(id))) throw validation('The correcting entry uses an account that is not in this company.');
}

/** Reversal of a posted General Journal entry (the fix for a duplicate), dated like the original. */
async function reversalProposal(ctx: ServiceContext, entryId: string): Promise<ProposedEntry | null> {
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)));
  if (!entry || entry.status !== 'posted') return null;
  // Documents (invoices, bills, payments, ...) are fixed by voiding the document, not by a journal entry.
  if (entry.sourceRef && entry.sourceRef !== 'manual') return null;
  const lines = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      subtype: accounts.subtype,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      entityType: journalEntryLines.entityType,
      entityId: journalEntryLines.entityId,
    })
    .from(journalEntryLines)
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(eq(journalEntryLines.journalEntryId, entry.id));
  if (lines.length < 2) return null;
  // An A/R / A/P line without a customer / vendor name can't be reversed by a General Journal
  // entry (QB requires the name); leave that one to the user.
  const control = (t: string) => t === 'accounts_receivable' || t === 'accounts_payable';
  if (lines.some((l) => control(String(l.subtype)) && !l.entityId)) return null;
  return {
    date: entry.date.toISOString().slice(0, 10),
    description: `Reverse duplicate entry #${entry.entryNumber}: ${entry.description}`.slice(0, 500),
    lines: lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      // Swap sides.
      debit: Money.of(l.credit ?? 0).greaterThan(0) ? toAmountString(Money.of(l.credit)) : null,
      credit: Money.of(l.debit ?? 0).greaterThan(0) ? toAmountString(Money.of(l.debit)) : null,
      memo: 'Reverses a duplicate entry',
      entityType: (l.entityType as JournalEntityType | null) ?? null,
      entityId: l.entityId ?? null,
    })),
  };
}

/** A model-proposed entry, kept only when it balances on existing posting accounts. */
async function modelProposal(
  ctx: ServiceContext,
  suggestion: LlmSuggestion & { entry?: z.infer<typeof suggestionSchema>['entry'] },
  fallbackDescription: string,
): Promise<ProposedEntry | null> {
  const e = suggestion.entry;
  if (!e) return null;
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byCode = new Map(rows.map((r) => [r.code, r]));
  let dr = Money.zero();
  let cr = Money.zero();
  const lines: ProposedEntry['lines'] = [];
  for (const l of e.lines) {
    const acct = byCode.get(String(l.accountCode).trim());
    if (!acct || acct.subtype === 'non_posting') return null;
    // Model-made A/R / A/P lines would need a customer / vendor name: leave those to the user.
    if (acct.subtype === 'accounts_receivable' || acct.subtype === 'accounts_payable') return null;
    const d = Money.of(l.debit ?? 0);
    const c = Money.of(l.credit ?? 0);
    if (d.isNegative() || c.isNegative() || (d.isZero() === c.isZero())) return null;
    dr = dr.plus(d);
    cr = cr.plus(c);
    lines.push({
      accountId: acct.id,
      accountCode: acct.code,
      accountName: acct.name,
      debit: d.isZero() ? null : toAmountString(d),
      credit: c.isZero() ? null : toAmountString(c),
      memo: l.memo ?? null,
    });
  }
  if (lines.length < 2 || !dr.equals(cr) || dr.isZero()) return null;
  return {
    date: new Date().toISOString().slice(0, 10),
    description: (e.description || `Correcting entry: ${fallbackDescription}`).slice(0, 500),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const suggestionSchema = z.object({
  analysis: z.string().min(1),
  action: z.string().min(1).max(100),
  steps: z.array(z.string()).min(1).max(20),
  impact: z.string(),
  /** Optional correcting entry on existing account codes (validated before it is offered). */
  entry: z
    .object({
      description: z.string().min(1).max(500),
      lines: z
        .array(
          z.object({
            accountCode: z.string().min(1),
            debit: z.union([z.string(), z.number()]).nullish(),
            credit: z.union([z.string(), z.number()]).nullish(),
            memo: z.string().nullish(),
          }),
        )
        .min(2)
        .max(20),
    })
    .nullish(),
});

const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    action: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    impact: { type: 'string' },
    entry: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              accountCode: { type: 'string' },
              debit: { type: 'string' },
              credit: { type: 'string' },
              memo: { type: 'string' },
            },
            required: ['accountCode'],
          },
        },
      },
    },
  },
  required: ['analysis', 'action', 'steps', 'impact'],
};

/** Stable accounting-system preamble. */
const SYSTEM_PREAMBLE = `You are an expert accounting AI assistant embedded in Ironbooks, a double-entry accounting system. Your role is to identify and explain accounting errors, then suggest clear, actionable corrections that maintain the fundamental accounting equation: Assets = Liabilities + Equity.

Core principles you apply:
- Every journal entry must have equal total debits and credits (the double-entry rule).
- Assets and Expenses have debit-normal balances; Liabilities, Equity, and Revenue are credit-normal.
- Duplicated entries overstate both sides of the books and must be voided (not deleted).
- Missing descriptions reduce auditability; they should be filled in retroactively.
- Outlier amounts may indicate data-entry errors, currency mismatches, or fraudulent entries.
- All corrections must preserve the audit trail — never silently delete records.

When analysing an error you MUST return a JSON object with exactly these fields:
{
  "analysis": "<what is wrong and why it matters>",
  "action":   "<short imperative: void_duplicate | add_correcting_entry | update_description | review_amount>",
  "steps":    ["<step 1>", "<step 2>", ...],
  "impact":   "<effect on financial statements if not corrected>",
  "entry":    { "description": "<memo>", "lines": [{ "accountCode": "<existing code>", "debit": "0.00", "credit": "0.00" }] }
}
"entry" is optional: include it only for add_correcting_entry, using account codes from the entry shown, with debits equal to credits. The user reviews and approves it before anything is posted.
Return ONLY the JSON object — no markdown fences, no prose outside the JSON.`;

function buildUserMessage(detection: typeof errorDetections.$inferSelect, entryContext: string): string {
  return `Please analyse the following accounting error and return the JSON correction suggestion.

Error Type: ${detection.errorType}
Severity: ${detection.severity}
Description: ${detection.description}
${entryContext}

Remember: return ONLY a JSON object with fields: analysis, action, steps, impact.`;
}

/** Return a rule-specific offline stub suggestion without hitting the API. */
function buildStubSuggestion(
  errorType: string,
  description: string,
): LlmSuggestion {
  const stubs: Record<string, LlmSuggestion> = {
    unbalanced: {
      analysis:
        'This journal entry has unequal debits and credits, violating the fundamental ' +
        'double-entry accounting rule. The imbalance means the accounting equation ' +
        '(Assets = Liabilities + Equity) is broken for this entry.',
      action: 'add_correcting_entry',
      steps: [
        'Identify which side (debit or credit) is short.',
        'Determine the correct account for the balancing amount.',
        'Post a correcting entry that brings debits and credits into balance.',
        'Mark the original detection as resolved after verification.',
      ],
      impact:
        'If uncorrected, the trial balance will not balance and financial statements will be misstated.',
    },
    duplicate: {
      analysis:
        'Two or more journal entries share the same date, description, and total amount. ' +
        'Posting the same transaction twice overstates both accounts involved.',
      action: 'void_duplicate',
      steps: [
        'Compare the duplicate entries side-by-side to confirm they are identical.',
        'Identify which entry is the original (usually the earlier entry number).',
        'Void the duplicate(s) using the Void function (never delete).',
        'Verify the trial balance is still balanced after voiding.',
      ],
      impact:
        'Overstated revenue, expenses, or asset balances leading to incorrect P&L and Balance Sheet.',
    },
    missing_field: {
      analysis:
        'One or more journal entry fields are missing (blank description or zero-amount line). ' +
        'This reduces auditability and may indicate an incomplete import.',
      action: 'update_description',
      steps: [
        'Open the journal entry and add a meaningful description explaining the transaction.',
        'Remove or correct any zero-amount lines.',
        'Save and re-run the error detection scan to confirm the issue is resolved.',
      ],
      impact: 'Reduced audit trail quality; auditors may flag incomplete entries.',
    },
    unusual_pattern: {
      analysis:
        'The transaction amount is statistically anomalous (more than 3 standard deviations ' +
        'above the mean for this account). This may indicate a data-entry error or an ' +
        'exceptional one-time transaction that should be clearly documented.',
      action: 'review_amount',
      steps: [
        'Compare the amount to source documents (invoice, receipt, bank statement).',
        'If the amount is wrong, post a correcting/reversing entry for the difference.',
        'If the amount is correct and exceptional, add a memo explaining the nature of the transaction.',
        'Consider adding a note in the journal entry description for future auditors.',
      ],
      impact:
        'Potential misstatement of account balances; may indicate data-entry error or fraud.',
    },
  };

  return (
    stubs[errorType] ?? {
      analysis: `Detected error of type "${errorType}": ${description}`,
      action: 'manual_review',
      steps: ['Review the entry manually and apply the appropriate correction.'],
      impact: 'Varies — review required.',
    }
  );
}
