/**
 * AI categorizer service — trains the local naive-Bayes categorizer (lib/ai/categorizer.ts)
 * from the company's OWN posted history and uses it for:
 *
 *  - Bank Feeds review: per-line account suggestion with calibrated confidence, optional
 *    auto-apply at/above the company threshold (posting still goes through the normal
 *    bankCategorize.categorize → postJournalEntry path), and an optional LLM second opinion
 *    for low-confidence lines (the model may only choose among existing active accounts).
 *  - Bills / Expenses / Write Checks: QB "pre-fill accounts for vendor".
 *
 * Training sources (each LINE is one example):
 *  - non-void expense / check / CC-charge lines (payee = vendor or free-text payee)
 *  - non-void bill expense lines (item lines excluded — the item decides their account)
 *  - bank-feed lines the USER categorized (journal entries with sourceRef bank_transaction:*)
 *    — lines the AI auto-applied are excluded so the model never trains on its own output.
 *
 * Incremental learning: every suggestion request first syncs the model with source documents
 * created since the stored watermark (so a categorization the user just made is learned before
 * the next suggestion). A 10-minute overlap window plus a "seen" key set guards against rows
 * whose created_at predates the watermark because their transaction committed late.
 */
import { and, desc, eq, gt, inArray, isNull, like, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  accounts,
  aiAutoApplied,
  aiCategorizerModels,
  bankAccounts,
  bankTransactions,
  billLines,
  bills,
  expenseLines,
  expenses,
  journalEntries,
  journalEntryLines,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, writeAudit } from './_base';
import { categorize } from './bankCategorize';
import { buildRouter, loadSettings, type BuildRouterOptions } from './aiSettings';
import {
  NONE,
  emptyState,
  learn,
  loadState,
  predict,
  summary,
  type CategorizerState,
  type TrainingExample,
} from '@/lib/ai/categorizer';
import { AiError } from '@/lib/ai/types';

const OVERLAP_MS = 10 * 60 * 1000;

interface StoredModel {
  state: CategorizerState;
  /** Source keys ingested within the overlap window → createdAt epoch ms. */
  seen: Record<string, number>;
}

interface SourceExample extends TrainingExample {
  key: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Collect training examples
// ---------------------------------------------------------------------------

async function collectExamples(ctx: ServiceContext, since: Date | null): Promise<SourceExample[]> {
  const out: SourceExample[] = [];

  // Expenses / checks / CC charges.
  const expConds = [eq(expenses.companyId, ctx.companyId), isNull(expenses.voidedAt)];
  if (since) expConds.push(gt(expenses.createdAt, since));
  const expRows = await ctx.db
    .select({
      lineId: expenseLines.id,
      createdAt: expenses.createdAt,
      payeeName: expenses.payeeName,
      vendorName: vendors.displayName,
      memo: expenses.memo,
      description: expenseLines.description,
      amount: expenseLines.amount,
      accountId: expenseLines.accountId,
      classId: expenseLines.classId,
      customerId: expenseLines.customerId,
      jobId: expenseLines.jobId,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .where(and(...expConds));
  for (const r of expRows) {
    out.push({
      key: `expense_line:${r.lineId}`,
      createdAt: r.createdAt,
      payee: r.vendorName ?? r.payeeName,
      memo: r.description || r.memo,
      amount: r.amount,
      direction: Money.isNegative(r.amount) ? 'in' : 'out',
      labels: {
        account: r.accountId,
        class: r.classId ?? NONE,
        customerJob: r.customerId ? `${r.customerId}|${r.jobId ?? ''}` : NONE,
      },
    });
  }

  // Bills (expense lines only).
  const billConds = [eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), isNull(billLines.itemId)];
  if (since) billConds.push(gt(bills.createdAt, since));
  const billRows = await ctx.db
    .select({
      lineId: billLines.id,
      createdAt: bills.createdAt,
      vendorName: vendors.displayName,
      memo: bills.memo,
      description: billLines.description,
      amount: billLines.amount,
      accountId: billLines.accountId,
      classId: billLines.classId,
      billClassId: bills.classId,
      customerId: billLines.customerId,
      jobId: billLines.jobId,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(and(...billConds));
  for (const r of billRows) {
    out.push({
      key: `bill_line:${r.lineId}`,
      createdAt: r.createdAt,
      payee: r.vendorName,
      memo: r.description || r.memo,
      amount: r.amount,
      direction: 'out',
      labels: {
        account: r.accountId,
        class: r.classId ?? r.billClassId ?? NONE,
        customerJob: r.customerId ? `${r.customerId}|${r.jobId ?? ''}` : NONE,
      },
    });
  }

  // Bank-feed lines the user categorized (excluding AI auto-applied ones).
  const autoRows = await ctx.db
    .select({ entryId: aiAutoApplied.journalEntryId })
    .from(aiAutoApplied)
    .where(eq(aiAutoApplied.companyId, ctx.companyId));
  const autoIds = autoRows.map((r) => r.entryId);
  const bankConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    like(journalEntries.sourceRef, 'bank_transaction:%'),
  ];
  if (since) bankConds.push(gt(journalEntries.createdAt, since));
  if (autoIds.length) bankConds.push(notInArray(journalEntries.id, autoIds));
  const bankRows = await ctx.db
    .select({
      entryId: journalEntries.id,
      createdAt: journalEntries.createdAt,
      payee: bankTransactions.payee,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      bankGl: bankAccounts.accountId,
    })
    .from(journalEntries)
    .innerJoin(bankTransactions, eq(bankTransactions.matchedEntryId, journalEntries.id))
    .innerJoin(bankAccounts, eq(bankTransactions.bankAccountId, bankAccounts.id))
    .where(and(...bankConds));
  if (bankRows.length) {
    const lines = await ctx.db
      .select({ entryId: journalEntryLines.journalEntryId, accountId: journalEntryLines.accountId, classId: journalEntryLines.classId })
      .from(journalEntryLines)
      .where(inArray(journalEntryLines.journalEntryId, bankRows.map((r) => r.entryId)));
    for (const r of bankRows) {
      const offset = lines.find((l) => l.entryId === r.entryId && l.accountId !== r.bankGl);
      if (!offset) continue;
      out.push({
        key: `bank_entry:${r.entryId}`,
        createdAt: r.createdAt,
        payee: r.payee,
        memo: r.description,
        amount: r.amount,
        direction: Money.isNegative(r.amount) ? 'out' : 'in',
        labels: { account: offset.accountId },
      });
    }
  }

  out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return out;
}

// ---------------------------------------------------------------------------
// Model persistence + sync
// ---------------------------------------------------------------------------

function parseStored(raw: unknown): StoredModel {
  const r = raw as Partial<StoredModel> | null;
  return { state: loadState(r?.state), seen: r?.seen && typeof r.seen === 'object' ? r.seen : {} };
}

/**
 * Bring the model up to date with source documents created since the last sync (or retrain
 * from scratch). Model rows are derived data — written with a plain DB transaction (no audit,
 * allowed for read-only roles because viewing suggestions must keep the cache current).
 */
export async function syncModel(
  ctx: ServiceContext,
  opts: { full?: boolean } = {},
): Promise<{ state: CategorizerState; learned: number }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(aiCategorizerModels)
      .where(eq(aiCategorizerModels.companyId, ctx.companyId))
      .for('update');
    const stored: StoredModel = row && !opts.full ? parseStored(row.model) : { state: emptyState(), seen: {} };
    const watermark = row && !opts.full ? row.watermark : null;
    const since = watermark ? new Date(watermark.getTime() - OVERLAP_MS) : null;

    const txCtx = { ...ctx, db: tx as unknown as ServiceContext['db'] };
    const examples = await collectExamples(txCtx, since);
    let learned = 0;
    let newMark = watermark?.getTime() ?? 0;
    for (const ex of examples) {
      const t = ex.createdAt.getTime();
      if (stored.seen[ex.key]) continue; // already learned (overlap window)
      learn(stored.state, ex, { track: !opts.full && !!row });
      stored.seen[ex.key] = t;
      learned += 1;
      if (t > newMark) newMark = t;
    }
    // Keep only keys inside the overlap window.
    for (const [k, t] of Object.entries(stored.seen)) if (t < newMark - OVERLAP_MS) delete stored.seen[k];

    if (!row || learned > 0 || opts.full) {
      const values = {
        model: stored as unknown as Record<string, unknown>,
        sampleCount: stored.state.docs,
        watermark: newMark ? new Date(newMark) : null,
        updatedAt: new Date(),
        ...(opts.full || !row ? { trainedAt: new Date() } : {}),
      };
      if (row) await tx.update(aiCategorizerModels).set(values).where(eq(aiCategorizerModels.id, row.id));
      else await tx.insert(aiCategorizerModels).values({ companyId: ctx.companyId, ...values });
    }
    return { state: stored.state, learned };
  });
}

/** Retrain from all history (Settings → "Retrain now"). */
export async function retrainModel(ctx: ServiceContext) {
  const { state } = await syncModel(ctx, { full: true });
  return summary(state);
}

export async function modelStatus(ctx: ServiceContext) {
  const [row] = await ctx.db
    .select({ trainedAt: aiCategorizerModels.trainedAt, updatedAt: aiCategorizerModels.updatedAt, model: aiCategorizerModels.model })
    .from(aiCategorizerModels)
    .where(eq(aiCategorizerModels.companyId, ctx.companyId));
  if (!row) return { trained: false as const, docs: 0, vocabulary: 0, accounts: 0, onlineAccuracy: null, onlinePredictions: 0, trainedAt: null, updatedAt: null };
  return { trained: true as const, ...summary(parseStored(row.model).state), trainedAt: row.trainedAt, updatedAt: row.updatedAt };
}

async function activeAccountIds(ctx: ServiceContext, exclude: string[] = []): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)));
  const ex = new Set(exclude);
  return new Set(rows.map((r) => r.id).filter((id) => !ex.has(id)));
}

// ---------------------------------------------------------------------------
// Bank feeds
// ---------------------------------------------------------------------------

export type SuggestionSource = 'rule' | 'model' | 'llm';

export interface BankSuggestion {
  bankTransactionId: string;
  accountId: string | null;
  confidence: number;
  source: SuggestionSource | null;
  alternatives: { accountId: string; confidence: number }[];
  /** True when auto-apply is on and this line clears the threshold. */
  autoApplyEligible: boolean;
}

async function loadBankAccount(ctx: ServiceContext, bankAccountId: string) {
  const [ba] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)));
  if (!ba) throw notFound('Bank account');
  return ba;
}

/** Suggestions for every unreviewed line in a bank account's feed. */
export async function suggestBankCategories(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<{ suggestions: BankSuggestion[]; threshold: number; autoApplyEnabled: boolean; trainedOn: number }> {
  const ba = await loadBankAccount(ctx, bankAccountId);
  const settings = await loadSettings(ctx);
  const threshold = Number(settings.autoApplyThreshold);
  const { state } = await syncModel(ctx);
  const allowed = await activeAccountIds(ctx, [ba.accountId]);

  const txns = await ctx.db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.matched, false),
        eq(bankTransactions.excluded, false),
      ),
    )
    .orderBy(desc(bankTransactions.date));

  const suggestions = txns.map((t): BankSuggestion => {
    // User-defined rules win (QB applies bank rules before learned suggestions).
    if (t.suggestedAccountId && allowed.has(t.suggestedAccountId)) {
      return { bankTransactionId: t.id, accountId: t.suggestedAccountId, confidence: 1, source: 'rule', alternatives: [], autoApplyEligible: false };
    }
    if (Money.isZero(t.amount)) {
      return { bankTransactionId: t.id, accountId: null, confidence: 0, source: null, alternatives: [], autoApplyEligible: false };
    }
    const p = predict(
      state,
      { payee: t.payee, memo: t.description, amount: t.amount, direction: Money.isNegative(t.amount) ? 'out' : 'in' },
      { allowed: { account: allowed } },
    ).account;
    if (!p) return { bankTransactionId: t.id, accountId: null, confidence: 0, source: null, alternatives: [], autoApplyEligible: false };
    return {
      bankTransactionId: t.id,
      accountId: p.label,
      confidence: round4(p.confidence),
      source: 'model',
      alternatives: p.alternatives.map((a) => ({ accountId: a.label, confidence: round4(a.confidence) })),
      autoApplyEligible: settings.autoApplyEnabled && p.confidence >= threshold,
    };
  });
  return { suggestions, threshold, autoApplyEnabled: settings.autoApplyEnabled, trainedOn: state.docs };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface AutoApplyResult {
  applied: { bankTransactionId: string; accountId: string; confidence: number; entryId: string }[];
  skipped: { bankTransactionId: string; reason: string }[];
}

/**
 * Auto-apply learned suggestions at/above the company threshold. Each line posts through
 * bankCategorize.categorize (→ postJournalEntry) inside one transaction together with its
 * ai_auto_applied log row and an audit entry explaining the AI decision.
 */
export async function autoApplyBankSuggestions(ctx: ServiceContext, bankAccountId: string): Promise<AutoApplyResult> {
  const settings = await loadSettings(ctx);
  if (!settings.autoApplyEnabled) {
    throw new ServiceError('VALIDATION', 'Auto-apply is turned off. Enable it in Settings → AI & Automation.');
  }
  const threshold = Number(settings.autoApplyThreshold);
  const { suggestions } = await suggestBankCategories(ctx, bankAccountId);
  const result: AutoApplyResult = { applied: [], skipped: [] };
  for (const s of suggestions) {
    if (s.source !== 'model' || !s.accountId || s.confidence < threshold) continue;
    try {
      const { entry } = await inTransaction(ctx, async (tx) => {
        const r = await categorize(tx, { bankTransactionId: s.bankTransactionId, accountId: s.accountId! });
        await tx.db.insert(aiAutoApplied).values({
          companyId: tx.companyId,
          bankTransactionId: s.bankTransactionId,
          journalEntryId: r.entry.id,
          accountId: s.accountId!,
          confidence: s.confidence.toFixed(4),
        });
        await writeAudit(tx, {
          action: 'update',
          entityType: 'bank_transaction',
          entityId: s.bankTransactionId,
          newValues: { aiAutoApplied: true, accountId: s.accountId, confidence: s.confidence, threshold },
          llmReasoning: `Auto-categorized by the local learned categorizer (confidence ${(s.confidence * 100).toFixed(1)}% ≥ threshold ${(threshold * 100).toFixed(1)}%).`,
        });
        return r;
      });
      result.applied.push({ bankTransactionId: s.bankTransactionId, accountId: s.accountId, confidence: s.confidence, entryId: entry.id });
    } catch (err) {
      result.skipped.push({ bankTransactionId: s.bankTransactionId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLM second opinion (low-confidence lines)
// ---------------------------------------------------------------------------

export interface LlmCategorySuggestion {
  bankTransactionId: string;
  accountId: string;
  confidence: number;
  reason: string;
  source: 'llm';
  providerId: string;
  redacted: boolean;
}

/**
 * Ask the AI router (task 'categorize') to pick an account for one bank line. The response
 * schema is an enum of the company's existing active account codes — the model can only
 * choose among them. Throws AiError('UNAVAILABLE') when no model is configured/eligible.
 */
export async function llmSuggestBankCategory(
  ctx: ServiceContext,
  bankTransactionId: string,
  routerOpts: BuildRouterOptions = {},
): Promise<LlmCategorySuggestion> {
  const settings = await loadSettings(ctx);
  if (!settings.llmSuggestEnabled) throw new AiError('UNAVAILABLE', 'AI suggestions are turned off for this company.');
  const [txn] = await ctx.db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.companyId, ctx.companyId)));
  if (!txn) throw notFound('Bank transaction');
  const ba = await loadBankAccount(ctx, txn.bankAccountId);

  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true), ne(accounts.id, ba.accountId)))
    .orderBy(accounts.code);
  if (acctRows.length === 0) throw new ServiceError('VALIDATION', 'No accounts to choose from.');
  const codes = acctRows.map((a) => a.code) as [string, ...string[]];

  const schema = z.object({
    accountCode: z.enum(codes),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(500).default(''),
  });
  const jsonSchema = {
    type: 'object',
    properties: {
      accountCode: { type: 'string', enum: codes },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
    required: ['accountCode', 'confidence', 'reason'],
  };

  const outflow = Money.isNegative(txn.amount);
  const prompt = [
    'Categorize this bank transaction for double-entry bookkeeping.',
    `Date: ${txn.date.toISOString().slice(0, 10)}`,
    `Payee: ${txn.payee ?? '(none)'}`,
    `Bank description: ${txn.description ?? '(none)'}`,
    `Amount: ${toAmountString(Money.abs(txn.amount))} ${outflow ? 'paid OUT of' : 'received INTO'} the bank account`,
    '',
    'Choose exactly ONE account code from this chart of accounts (code — name [type]):',
    ...acctRows.map((a) => `${a.code} — ${a.name} [${a.type}]`),
    '',
    'Reply with JSON: {"accountCode": "<code from the list>", "confidence": <0..1>, "reason": "<one sentence>"}',
  ].join('\n');

  const router = await buildRouter(ctx, routerOpts);
  const res = await router.chatJson('categorize', [
    { role: 'system', content: 'You are a careful bookkeeper. You only ever answer with JSON and only choose accounts from the provided list.' },
    { role: 'user', content: prompt },
  ], schema, { jsonSchema, temperature: 0, maxTokens: 300 });

  const acct = acctRows.find((a) => a.code === res.data.accountCode)!;
  return {
    bankTransactionId,
    accountId: acct.id,
    // LLM self-reported confidence is not calibrated — cap it so it never looks auto-apply-grade.
    confidence: Math.min(res.data.confidence, 0.8),
    reason: res.data.reason,
    source: 'llm',
    providerId: res.providerId,
    redacted: res.redacted,
  };
}

// ---------------------------------------------------------------------------
// Vendor pre-fill (bills / expenses / write checks)
// ---------------------------------------------------------------------------

export interface PrefillLine {
  accountId: string;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
  confidence: number;
}

export interface PrefillResult {
  source: 'vendor-default' | 'last-used' | 'learned' | 'none';
  lines: PrefillLine[];
}

/**
 * QB "pre-fill accounts for vendor": the vendor's explicit default expense account first,
 * then the accounts on the vendor's most recent transaction (QB autorecall, up to 3), then
 * the learned model's prediction for the payee (when confident enough to be useful).
 */
export async function vendorPrefill(
  ctx: ServiceContext,
  input: { vendorId?: string | null; payee?: string | null; amount?: string | null },
): Promise<PrefillResult> {
  const allowed = await activeAccountIds(ctx);
  let payee = input.payee ?? null;

  if (input.vendorId) {
    const [v] = await ctx.db
      .select({ name: vendors.displayName, defaultAccount: vendors.defaultExpenseAccountId })
      .from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
    if (!v) throw notFound('Vendor');
    payee = v.name;
    if (v.defaultAccount && allowed.has(v.defaultAccount)) {
      return { source: 'vendor-default', lines: [{ accountId: v.defaultAccount, classId: null, customerId: null, jobId: null, confidence: 1 }] };
    }

    // Most recent non-void bill or expense for this vendor.
    const [lastBill] = await ctx.db
      .select({ id: bills.id, date: bills.date, createdAt: bills.createdAt })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, input.vendorId), ne(bills.status, 'void')))
      .orderBy(desc(bills.date), desc(bills.createdAt))
      .limit(1);
    const [lastExp] = await ctx.db
      .select({ id: expenses.id, date: expenses.date, createdAt: expenses.createdAt })
      .from(expenses)
      .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.vendorId, input.vendorId), isNull(expenses.voidedAt)))
      .orderBy(desc(expenses.date), desc(expenses.createdAt))
      .limit(1);
    const useBill = lastBill && (!lastExp || lastBill.date.getTime() >= lastExp.date.getTime());
    const lines = useBill
      ? await ctx.db
          .select({ accountId: billLines.accountId, classId: billLines.classId, customerId: billLines.customerId, jobId: billLines.jobId })
          .from(billLines)
          .where(and(eq(billLines.billId, lastBill.id), isNull(billLines.itemId)))
          .orderBy(billLines.lineOrder)
      : lastExp
        ? await ctx.db
            .select({ accountId: expenseLines.accountId, classId: expenseLines.classId, customerId: expenseLines.customerId, jobId: expenseLines.jobId })
            .from(expenseLines)
            .where(eq(expenseLines.expenseId, lastExp.id))
            .orderBy(expenseLines.lineOrder)
        : [];
    const distinct: PrefillLine[] = [];
    for (const l of lines) {
      if (!allowed.has(l.accountId) || distinct.some((d) => d.accountId === l.accountId)) continue;
      distinct.push({ accountId: l.accountId, classId: l.classId, customerId: l.customerId, jobId: l.jobId, confidence: 0.9 });
      if (distinct.length === 3) break;
    }
    if (distinct.length) return { source: 'last-used', lines: distinct };
  }

  if (!payee) return { source: 'none', lines: [] };
  const { state } = await syncModel(ctx);
  const p = predict(state, { payee, amount: input.amount ?? '0', direction: 'out' }, { allowed: { account: allowed } });
  if (!p.account || p.account.confidence < 0.4) return { source: 'none', lines: [] };
  const cj = p.customerJob && p.customerJob.confidence >= 0.5 ? p.customerJob.label : NONE;
  const [customerId, jobId] = cj ? cj.split('|') : [null, null];
  return {
    source: 'learned',
    lines: [{
      accountId: p.account.label,
      classId: p.class && p.class.confidence >= 0.5 && p.class.label ? p.class.label : null,
      customerId: customerId || null,
      jobId: jobId || null,
      confidence: round4(p.account.confidence),
    }],
  };
}

/** Recent AI auto-applied lines (for review / undo in the UI). */
export async function listAutoApplied(ctx: ServiceContext, limit = 50) {
  return ctx.db
    .select({
      id: aiAutoApplied.id,
      bankTransactionId: aiAutoApplied.bankTransactionId,
      journalEntryId: aiAutoApplied.journalEntryId,
      accountId: aiAutoApplied.accountId,
      confidence: aiAutoApplied.confidence,
      createdAt: aiAutoApplied.createdAt,
      entryStatus: journalEntries.status,
    })
    .from(aiAutoApplied)
    .innerJoin(journalEntries, eq(aiAutoApplied.journalEntryId, journalEntries.id))
    .where(eq(aiAutoApplied.companyId, ctx.companyId))
    .orderBy(desc(aiAutoApplied.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
