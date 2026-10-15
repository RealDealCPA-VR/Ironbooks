/**
 * Bank feed suggestions with confidence + bulk accept + auto-apply rules (team bankrules).
 *
 * One suggestion per unreviewed feed line, merged from three signals (lib/bankRules/core.ts
 * combineSignals):
 *   1. rules    — the first enabled rule that matches (highest weight; carries class / payee /
 *                 memo / split actions);
 *   2. history  — how the user categorized the same normalized pattern before, weighted by
 *                 recency and count ("You chose Fuel 5 times");
 *   3. AI       — the local learned categorizer (on this computer, never leaves the machine) and,
 *                 only when the company configured a model and the caller asks for it, an LLM
 *                 second opinion through the AI router (lib/ai/router.ts via aiSettings.buildRouter:
 *                 local/tailnet vs cloud policy + redaction). With AI off everything still works
 *                 from rules + history.
 *
 * Posting always goes through bankCategorize.categorize (→ postJournalEntry: balanced entries,
 * closing date, ledger guards, audit) — one DB transaction per line, so one bad line never blocks
 * the rest of a bulk accept.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { accounts, bankAccounts, bankTransactions } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { categorize } from './bankCategorize';
import { activeBankRules, loadHistory, noteRuleApplied, ruleOffers, type BankRule, type RuleOffer } from './bankRules';
import {
  HIGH_CONFIDENCE,
  RULE_CONFIDENCE,
  combineSignals,
  historyConfidence,
  patternOf,
  pickRule,
  toPercent,
  type RuleSplit,
  type Signal,
  type SignalSource,
} from '@/lib/bankRules/core';
import { predict, type CategorizerState } from '@/lib/ai/categorizer';
import { llmSuggestBankCategory, syncModel } from './aiCategorizer';
import { buildRouter, loadSettings } from './aiSettings';

export interface SuggestionSignal {
  source: SignalSource;
  accountId: string;
  /** 0..100 */
  confidence: number;
  reason: string;
}

export interface LineSuggestion {
  bankTransactionId: string;
  pattern: string;
  accountId: string | null;
  accountName: string | null;
  classId: string | null;
  payee: string | null;
  memo: string | null;
  splits: RuleSplit[] | null;
  /** 0..100 */
  confidence: number;
  /** Plain-language "why", e.g. 'Matched rule "Shell" · You chose Fuel 5 times'. */
  reason: string;
  source: SignalSource | null;
  ruleId: string | null;
  ruleName: string | null;
  ruleMode: 'suggest' | 'auto' | null;
  signals: SuggestionSignal[];
}

export interface SuggestOptions {
  /** Also ask the configured AI model (router) about low-confidence lines. Default false. */
  ai?: boolean;
  /** Max lines sent to the AI model per request. */
  aiLimit?: number;
  /** Only these lines (default: every unreviewed line of the account). */
  bankTransactionIds?: string[];
  /** Use the local learned categorizer (default true; tests turn it off for determinism). */
  localModel?: boolean;
  now?: Date;
}

/** History events from automatic posts never count (the engine must not learn from itself). */
const HISTORY_SOURCES = new Set(['user', 'bulk', 'rule']);
/** The learned model needs this many examples before its opinion is shown. */
const MIN_MODEL_DOCS = 5;

async function loadBankAccount(ctx: ServiceContext, bankAccountId: string) {
  const [ba] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)));
  if (!ba) throw notFound('Bank account');
  return ba;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Suggestions for the unreviewed lines of one bank account. */
export async function suggestForAccount(
  ctx: ServiceContext,
  bankAccountId: string,
  opts: SuggestOptions = {},
): Promise<LineSuggestion[]> {
  const ba = await loadBankAccount(ctx, bankAccountId);
  const now = opts.now ?? new Date();
  let txns = await ctx.db
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
  if (opts.bankTransactionIds) {
    const want = new Set(opts.bankTransactionIds);
    txns = txns.filter((t) => want.has(t.id));
  }
  if (txns.length === 0) return [];

  const acctRows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acctName = new Map(acctRows.map((a) => [a.id, a.name]));
  const usable = new Set(acctRows.filter((a) => a.isActive && a.id !== ba.accountId).map((a) => a.id));

  const rules = await activeBankRules(ctx);
  const patterns = new Map(txns.map((t) => [t.id, patternOf(t)]));
  const history = (await loadHistory(ctx, { patterns: [...new Set([...patterns.values()].filter(Boolean))] })).filter(
    (h) => HISTORY_SOURCES.has(h.source) && !h.split,
  );

  // Local learned categorizer (best effort, stays on this computer).
  let model: CategorizerState | null = null;
  if (opts.localModel !== false) {
    try {
      const { state } = await syncModel(ctx);
      if (state.docs >= MIN_MODEL_DOCS) model = state;
    } catch {
      model = null;
    }
  }

  const out: LineSuggestion[] = [];
  for (const t of txns) {
    const pattern = patterns.get(t.id) ?? '';
    const direction = Money.isNegative(t.amount) ? 'out' : 'in';
    const signals: Signal[] = [];
    let rule: BankRule | null = null;

    // 1. Rules.
    rule = pickRule(rules, { description: t.description, payee: t.payee, amount: t.amount, bankAccountId: t.bankAccountId });
    const ruleAccount = rule ? rule.setAccountId ?? rule.splits?.[0]?.accountId ?? null : null;
    if (rule && ruleAccount) {
      signals.push({ source: 'rule', accountId: ruleAccount, classId: rule.setClassId, confidence: RULE_CONFIDENCE, reason: `Matched rule "${rule.name}"` });
    }
    // NOTE: bank_transactions.suggested_account_id (stamped by a rule at import time) is
    // deliberately NOT used here. Every live rule was just evaluated above, so that stale value
    // only differs when its rule has since been switched off, deleted or edited — exactly when
    // it is wrong — and it must never feed "Accept all high-confidence".

    // 2. History of the same pattern + direction.
    const events = history
      .filter((h) => h.pattern === pattern && h.direction === direction && usable.has(h.accountId))
      .map((h) => ({ accountId: h.accountId, classId: h.classId, createdAt: h.createdAt }));
    const vote = historyConfidence(events, now);
    if (vote) {
      const name = acctName.get(vote.accountId) ?? 'that account';
      signals.push({
        source: 'history',
        accountId: vote.accountId,
        classId: vote.classId,
        confidence: vote.confidence,
        reason: `You chose ${name} ${plural(vote.count, 'time')}${vote.total > vote.count ? ` (out of ${vote.total})` : ''} for ${pattern}`,
      });
    }

    // 3. Local AI model.
    if (model && !Money.isZero(t.amount)) {
      const p = predict(
        model,
        { payee: t.payee, memo: t.description, amount: t.amount, direction },
        { allowed: { account: usable } },
      ).account;
      if (p && p.label && p.confidence >= 0.4) {
        signals.push({ source: 'ai', accountId: p.label, confidence: p.confidence, reason: `AI model on this computer is ${toPercent(p.confidence)}% sure` });
      }
    }

    const combined = combineSignals(signals);
    const histPayee = vote
      ? history.find((h) => h.pattern === pattern && h.accountId === vote.accountId && h.payee)?.payee ?? null
      : null;
    const useRule = combined?.source === 'rule' && rule;
    out.push({
      bankTransactionId: t.id,
      pattern,
      accountId: combined?.accountId ?? null,
      accountName: combined ? acctName.get(combined.accountId) ?? null : null,
      classId: useRule ? rule!.setClassId ?? null : combined?.classId ?? null,
      payee: useRule ? rule!.setPayee ?? null : histPayee,
      memo: useRule ? rule!.setMemo ?? null : null,
      splits: useRule && rule!.splits && rule!.splits.length > 0 ? rule!.splits : null,
      confidence: combined?.confidence ?? 0,
      reason: combined?.reason ?? 'No suggestion yet — choose an account.',
      source: combined?.source ?? null,
      ruleId: useRule ? rule!.id : null,
      ruleName: useRule ? rule!.name : null,
      ruleMode: useRule ? (rule!.mode === 'auto' ? 'auto' : 'suggest') : null,
      signals: signals.map((s) => ({ source: s.source, accountId: s.accountId, confidence: toPercent(Math.min(s.confidence, s.source === 'ai' ? 0.85 : 1)), reason: s.reason })),
    });
  }

  // 4. Optional LLM second opinion (router; only if configured + enabled; low-confidence lines).
  if (opts.ai) await addLlmOpinions(ctx, out, txns, acctName, opts.aiLimit ?? 10);
  return out;
}

async function addLlmOpinions(
  ctx: ServiceContext,
  out: LineSuggestion[],
  txns: { id: string; amount: string }[],
  acctName: Map<string, string>,
  limit: number,
) {
  const settings = await loadSettings(ctx);
  if (!settings.llmSuggestEnabled) return;
  const router = await buildRouter(ctx);
  if (!router.isAvailable('categorize')) return;
  const weak = out.filter((s) => s.confidence < HIGH_CONFIDENCE && s.source !== 'rule').slice(0, Math.max(0, limit));
  for (const s of weak) {
    const t = txns.find((x) => x.id === s.bankTransactionId);
    if (!t || Money.isZero(t.amount)) continue;
    try {
      const r = await llmSuggestBankCategory(ctx, s.bankTransactionId);
      const prior: Signal[] = s.signals.map((g) => ({ source: g.source, accountId: g.accountId, confidence: g.confidence / 100, reason: g.reason }));
      const llm: Signal = { source: 'ai', accountId: r.accountId, confidence: r.confidence, reason: `AI: ${r.reason || 'picked this account'}` };
      // The LLM replaces the local model's vote (one AI voice).
      const merged = combineSignals([...prior.filter((p) => p.source !== 'ai'), llm]);
      if (!merged) continue;
      s.signals = [...s.signals.filter((g) => g.source !== 'ai'), { source: 'ai', accountId: r.accountId, confidence: toPercent(Math.min(r.confidence, 0.85)), reason: llm.reason }];
      s.accountId = merged.accountId;
      s.accountName = acctName.get(merged.accountId) ?? null;
      s.confidence = merged.confidence;
      s.reason = merged.reason;
      s.source = merged.source;
      if (merged.classId) s.classId = merged.classId;
    } catch {
      // AI unavailable / timed out / refused — the suggestion stays as it was.
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk accept
// ---------------------------------------------------------------------------

export interface BulkItem {
  bankTransactionId: string;
  /** Omit to accept the current suggestion for the line. */
  accountId?: string | null;
  classId?: string | null;
  payee?: string | null;
  memo?: string | null;
  splits?: RuleSplit[] | null;
  exchangeRate?: string | null;
}

export type BulkAcceptInput =
  | { bankAccountId: string; allHighConfidence: true; minConfidence?: number; exchangeRate?: string | null }
  | { items: BulkItem[]; exchangeRate?: string | null };

export interface BulkAcceptResult {
  accepted: { bankTransactionId: string; entryId: string; accountId: string; confidence: number | null }[];
  failed: { bankTransactionId: string; reason: string; code: string }[];
  /** Learning offers that became available after this batch. */
  offers: RuleOffer[];
}

const MAX_BULK = 1000;

/**
 * Accept many lines at once. Either every unreviewed line of a bank account whose combined
 * confidence is ≥ minConfidence (default 90, recomputed on the server — the client's numbers are
 * never trusted), or an explicit list (each with the user's choice, or none = take the
 * suggestion). Each line posts in its OWN transaction through categorize(); failures (closed
 * period, already added, inactive account, …) are reported and skipped.
 */
export async function bulkAccept(
  ctx: ServiceContext,
  input: BulkAcceptInput,
  suggestOpts: Pick<SuggestOptions, 'localModel' | 'now'> = {},
): Promise<BulkAcceptResult> {
  const result: BulkAcceptResult = { accepted: [], failed: [], offers: [] };
  type Plan = { item: BulkItem; suggestion: LineSuggestion | null; known: boolean };
  const plans: Plan[] = [];

  if ('allHighConfidence' in input) {
    const min = Math.min(Math.max(input.minConfidence ?? HIGH_CONFIDENCE, 50), 100);
    const suggestions = await suggestForAccount(ctx, input.bankAccountId, suggestOpts);
    for (const s of suggestions) {
      if (!s.accountId || s.confidence < min) continue;
      plans.push({ item: { bankTransactionId: s.bankTransactionId, exchangeRate: input.exchangeRate ?? null }, suggestion: s, known: true });
    }
  } else {
    if (!Array.isArray(input.items) || input.items.length === 0) throw validation('Select at least one transaction.');
    if (input.items.length > MAX_BULK) throw validation(`Accept at most ${MAX_BULK} transactions at a time.`);
    const ids = input.items.map((i) => i.bankTransactionId);
    if (new Set(ids).size !== ids.length) throw validation('A transaction is listed twice.');
    // Suggestions for lines that need one, grouped by bank account (company-scoped lookup).
    const uuidLike = ids.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
    const rows = uuidLike.length
      ? await ctx.db
          .select({ id: bankTransactions.id, bankAccountId: bankTransactions.bankAccountId })
          .from(bankTransactions)
          .where(and(eq(bankTransactions.companyId, ctx.companyId), inArray(bankTransactions.id, uuidLike)))
      : [];
    const accountOf = new Map(rows.map((r) => [r.id, r.bankAccountId]));
    const needs = new Map<string, string[]>();
    for (const it of input.items) {
      const ba = accountOf.get(it.bankTransactionId);
      if (!ba) continue;
      needs.set(ba, [...(needs.get(ba) ?? []), it.bankTransactionId]);
    }
    const byId = new Map<string, LineSuggestion>();
    for (const [ba, lineIds] of needs) {
      for (const s of await suggestForAccount(ctx, ba, { ...suggestOpts, bankTransactionIds: lineIds })) {
        byId.set(s.bankTransactionId, s);
      }
    }
    for (const it of input.items) {
      plans.push({
        item: { ...it, exchangeRate: it.exchangeRate ?? input.exchangeRate ?? null },
        suggestion: byId.get(it.bankTransactionId) ?? null,
        known: accountOf.has(it.bankTransactionId),
      });
    }
  }

  for (const { item, suggestion: s, known } of plans) {
    try {
      if (!known) throw new ServiceError('NOT_FOUND', 'Bank transaction not found.');
      const explicit = !!(item.accountId || (item.splits && item.splits.length));
      const accountId = explicit ? item.accountId ?? item.splits![0].accountId : s!.accountId;
      if (!accountId) {
        throw validation(s ? 'No suggestion for this line — choose an account first.' : 'This line was already reviewed.');
      }
      const splits = explicit ? item.splits ?? null : s?.splits ?? null;
      // A line counts as "accepted from the rule" only if the user took the rule's choice as-is.
      const sameSplits = !item.splits || (!!s?.splits && JSON.stringify(item.splits) === JSON.stringify(s.splits));
      const fromRule = !!s?.ruleId && (!explicit || (accountId === s.accountId && sameSplits));
      const r = await inTransaction(ctx, async (tx) => {
        const res = await categorize(tx, {
          bankTransactionId: item.bankTransactionId,
          accountId,
          classId: explicit ? item.classId ?? null : s?.classId ?? null,
          payee: (explicit ? item.payee : item.payee ?? s?.payee) || null,
          memo: (explicit ? item.memo : item.memo ?? s?.memo) || null,
          splits,
          exchangeRate: item.exchangeRate ?? null,
          source: fromRule ? 'rule' : 'bulk',
          ruleId: fromRule ? s!.ruleId : null,
        });
        if (fromRule) await noteRuleApplied(tx, s!.ruleId!);
        return res;
      });
      result.accepted.push({
        bankTransactionId: item.bankTransactionId,
        entryId: r.entry.id,
        accountId,
        confidence: s && s.accountId === accountId ? s.confidence : null,
      });
    } catch (err) {
      result.failed.push({
        bankTransactionId: item.bankTransactionId,
        reason: err instanceof Error ? err.message : String(err),
        code: err instanceof ServiceError ? err.code : 'ERROR',
      });
    }
  }

  if (result.accepted.length > 0) {
    try {
      result.offers = await ruleOffers(ctx);
    } catch {
      result.offers = [];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Auto-apply rules
// ---------------------------------------------------------------------------

export interface AutoRulesResult {
  applied: { bankTransactionId: string; ruleId: string; ruleName: string; entryId: string }[];
  skipped: { bankTransactionId: string; ruleName: string; reason: string }[];
}

/**
 * Post every unreviewed line of a bank account whose first matching rule is in 'auto' mode.
 * Each line: own transaction, categorize() + rule usage + an audit note naming the rule.
 */
export async function runAutoRules(ctx: ServiceContext, bankAccountId: string): Promise<AutoRulesResult> {
  await loadBankAccount(ctx, bankAccountId);
  const rules = await activeBankRules(ctx);
  const result: AutoRulesResult = { applied: [], skipped: [] };
  if (!rules.some((r) => r.mode === 'auto')) return result;
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
    .orderBy(bankTransactions.date);
  for (const t of txns) {
    const rule = pickRule(rules, { description: t.description, payee: t.payee, amount: t.amount, bankAccountId: t.bankAccountId });
    if (!rule || rule.mode !== 'auto') continue;
    const accountId = rule.setAccountId ?? rule.splits?.[0]?.accountId ?? null;
    if (!accountId) continue;
    try {
      const r = await inTransaction(ctx, async (tx) => {
        const res = await categorize(tx, {
          bankTransactionId: t.id,
          accountId,
          classId: rule.setClassId,
          payee: rule.setPayee,
          memo: rule.setMemo,
          splits: rule.splits && rule.splits.length ? rule.splits : null,
          source: 'rule_auto',
          ruleId: rule.id,
        });
        await noteRuleApplied(tx, rule.id);
        await writeAudit(tx, {
          action: 'update',
          entityType: 'bank_transaction',
          entityId: t.id,
          newValues: { autoRule: true, ruleId: rule.id, ruleName: rule.name, entryId: res.entry.id },
        });
        return res;
      });
      result.applied.push({ bankTransactionId: t.id, ruleId: rule.id, ruleName: rule.name, entryId: r.entry.id });
    } catch (err) {
      result.skipped.push({ bankTransactionId: t.id, ruleName: rule.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
