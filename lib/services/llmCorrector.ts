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
 *   - No destructive GL change: applyCorrection only marks status + writes an
 *     audit row — any actual journal correction must be made by the user via the
 *     normal posting workflow, with the LLM reasoning surfaced as guidance.
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
import { notFound, validation, writeAudit } from './_base';
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
 * Mark a pending correction as applied, resolve the parent detection, and
 * write an audit row. No actual GL entries are created here — the user must
 * execute the recommended steps via the normal posting workflow. The LLM
 * reasoning is surfaced in the audit trail so reviewers can see why the
 * correction was applied.
 */
export async function applyCorrection(
  ctx: ServiceContext,
  correctionId: string,
): Promise<CorrectionRow> {
  // Load the correction (and verify it belongs to this company via the detection join).
  const [row] = await ctx.db
    .select({
      correction: errorCorrections,
      detection: errorDetections,
    })
    .from(errorCorrections)
    .innerJoin(errorDetections, eq(errorCorrections.errorDetectionId, errorDetections.id))
    .where(
      and(
        eq(errorCorrections.id, correctionId),
        eq(errorDetections.companyId, ctx.companyId),
      ),
    );

  if (!row) throw notFound('Error correction');
  if (row.correction.status === 'applied') {
    throw validation('Correction has already been applied.');
  }
  if (row.correction.status === 'rejected') {
    throw validation('Cannot apply a rejected correction.');
  }

  const now = new Date();

  // Mark correction applied.
  const [updated] = await ctx.db
    .update(errorCorrections)
    .set({ status: 'applied', appliedAt: now, reviewedBy: ctx.userId ?? undefined })
    .where(eq(errorCorrections.id, correctionId))
    .returning();

  // Resolve the parent detection.
  await ctx.db
    .update(errorDetections)
    .set({ resolvedAt: now })
    .where(eq(errorDetections.id, row.correction.errorDetectionId));

  // Audit trail.
  await writeAudit(ctx, {
    action: 'llm_correction',
    entityType: 'error_correction',
    entityId: correctionId,
    oldValues: { status: row.correction.status },
    newValues: { status: 'applied', appliedAt: now.toISOString() },
    llmReasoning: row.correction.llmReasoning ?? undefined,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const suggestionSchema = z.object({
  analysis: z.string().min(1),
  action: z.string().min(1).max(100),
  steps: z.array(z.string()).min(1).max(20),
  impact: z.string(),
});

const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    action: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    impact: { type: 'string' },
  },
  required: ['analysis', 'action', 'steps', 'impact'],
};

/** Stable accounting-system preamble. */
const SYSTEM_PREAMBLE = `You are an expert accounting AI assistant embedded in BookKeeper AI, a double-entry accounting system. Your role is to identify and explain accounting errors, then suggest clear, actionable corrections that maintain the fundamental accounting equation: Assets = Liabilities + Equity.

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
  "impact":   "<effect on financial statements if not corrected>"
}
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
