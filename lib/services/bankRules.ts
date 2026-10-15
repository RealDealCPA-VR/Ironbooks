/**
 * Bank feed rules (team bankrules) — management, learning offers and testing.
 *
 * A rule = conditions (description / payee text with contains / starts with / is exactly /
 * wildcard pattern, money in / out, amount equals or range, bank account) + actions (account or a
 * percentage split, class, payee name, memo) + a mode ('suggest' pre-fills the review screen,
 * 'auto' posts on its own) + priority order + an on/off switch. Rules live in transaction_rules
 * (extended by migration 0048); evaluation is the pure code in lib/bankRules/core.ts, shared with
 * the legacy rules service (lib/services/rules.ts) used at import time.
 *
 * Learning: every categorization through bankCategorize.categorize is recorded in
 * bank_categorization_history under the line's normalized description. Once the user sends the
 * same pattern to the same account (and class) LEARN_THRESHOLD times without a rule covering it,
 * `ruleOffers` proposes "Always categorize SHELL OIL as Fuel?"; accepting creates a learned rule,
 * "No thanks" stores a dismissal so the offer does not come back.
 *
 * Every query is scoped by ctx.companyId; every referenced id is checked with assertRefInCompany.
 */
import { and, desc, eq, gte, inArray, max, sql } from 'drizzle-orm';
import {
  accounts,
  bankAccounts,
  bankCategorizationHistory,
  bankRuleDismissals,
  bankTransactions,
  classes,
  journalEntries,
  transactionRules,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import {
  LEARN_THRESHOLD,
  RULE_DIRECTIONS,
  RULE_FIELDS,
  RULE_MODES,
  RULE_OPERATORS,
  patternOf,
  pickRule,
  ruleMatches,
  sortRules,
  splitError,
  type RuleDirection,
  type RuleField,
  type RuleLike,
  type RuleMode,
  type RuleOperator,
  type RuleSplit,
} from '@/lib/bankRules/core';

export type BankRule = typeof transactionRules.$inferSelect;

export interface BankRuleInput {
  name: string;
  matchField?: RuleField;
  matchOperator?: RuleOperator;
  matchValue?: string | null;
  bankAccountId?: string | null;
  direction?: RuleDirection;
  /** Absolute amount bounds (strings). Set both equal for "amount equals". */
  amountMin?: string | null;
  amountMax?: string | null;
  setAccountId?: string | null;
  setClassId?: string | null;
  setPayee?: string | null;
  setMemo?: string | null;
  splits?: RuleSplit[] | null;
  mode?: RuleMode;
  enabled?: boolean;
  /** Higher = checked first. Default: above every existing rule. */
  priority?: number;
  learned?: boolean;
}

const MAX_TEXT = 255;
/** Rule priorities are small integers; anything outside this range is a client bug. */
export const MAX_PRIORITY = 1_000_000;

function checkPriority(priority: number | undefined | null): void {
  if (priority === undefined || priority === null) return;
  if (!Number.isInteger(priority) || Math.abs(priority) > MAX_PRIORITY) {
    throw validation(`Priority must be a whole number between -${MAX_PRIORITY.toLocaleString('en-US')} and ${MAX_PRIORITY.toLocaleString('en-US')}.`);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** All rules (enabled and disabled; deleted ones excluded) in the order they are checked. */
export async function listBankRules(ctx: ServiceContext): Promise<BankRule[]> {
  const rows = await ctx.db
    .select()
    .from(transactionRules)
    .where(and(eq(transactionRules.companyId, ctx.companyId), eq(transactionRules.isActive, true)));
  return sortRules(rows);
}

/** Rules that can fire (enabled + not deleted), in precedence order. */
export async function activeBankRules(ctx: ServiceContext): Promise<BankRule[]> {
  return (await listBankRules(ctx)).filter((r) => r.enabled);
}

export async function getBankRule(ctx: ServiceContext, id: string): Promise<BankRule> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Rule');
  const [row] = await ctx.db
    .select()
    .from(transactionRules)
    .where(and(eq(transactionRules.id, id), eq(transactionRules.companyId, ctx.companyId), eq(transactionRules.isActive, true)));
  if (!row) throw notFound('Rule');
  return row;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function amountOrNull(v: string | number | null | undefined, label: string): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  let d;
  try {
    d = Money.of(String(v).trim());
  } catch {
    throw validation(`${label} must be a number.`);
  }
  if (d.isNegative()) throw validation(`${label} cannot be negative — use "Money in / out" for the direction.`);
  if (d.decimalPlaces() > 2) throw validation(`${label} can have at most 2 decimal places.`);
  return toAmountString(d);
}

function trimOrNull(v: string | null | undefined, label: string): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (t.length > MAX_TEXT) throw validation(`${label} is too long (max ${MAX_TEXT} characters).`);
  return t;
}

type RuleValues = Omit<typeof transactionRules.$inferInsert, 'id' | 'companyId' | 'createdAt'>;

async function validateInput(
  ctx: ServiceContext,
  input: BankRuleInput,
  opts: { conditionsOnly?: boolean } = {},
): Promise<RuleValues> {
  const name = (input.name ?? '').trim() || (opts.conditionsOnly ? 'Draft rule' : '');
  if (!name) throw validation('Give the rule a name.');
  if (name.length > MAX_TEXT) throw validation(`Rule name is too long (max ${MAX_TEXT} characters).`);

  const matchField = input.matchField ?? 'description';
  if (!RULE_FIELDS.includes(matchField)) throw validation(`Unknown field "${matchField}".`);
  const matchOperator = input.matchOperator ?? 'contains';
  if (!RULE_OPERATORS.includes(matchOperator)) throw validation(`Unknown condition "${matchOperator}".`);
  const matchValue = trimOrNull(input.matchValue, 'Text to match') ?? '';
  if (matchOperator === 'pattern' && matchValue && !/[^*?\s]/.test(matchValue)) {
    throw validation('A pattern needs at least one letter or number besides * and ?.');
  }
  const direction = input.direction ?? 'any';
  if (!RULE_DIRECTIONS.includes(direction)) throw validation(`Unknown direction "${direction}".`);
  const amountMin = amountOrNull(input.amountMin, 'Smallest amount');
  const amountMax = amountOrNull(input.amountMax, 'Largest amount');
  if (amountMin && amountMax && Money.gt(amountMin, amountMax)) {
    throw validation('The smallest amount is bigger than the largest amount.');
  }
  const bankAccountId = input.bankAccountId || null;
  if (bankAccountId) await assertRefInCompany(ctx, bankAccounts, bankAccountId, 'Bank account');

  if (!matchValue && !amountMin && !amountMax && !bankAccountId && direction === 'any') {
    throw validation('Add at least one condition (text, amount, money in/out or bank account).');
  }

  const mode = input.mode ?? 'suggest';
  if (!RULE_MODES.includes(mode)) throw validation(`Unknown mode "${mode}".`);

  const splits = input.splits && input.splits.length > 0 ? input.splits.map((s) => ({
    accountId: s.accountId,
    classId: s.classId || null,
    percent: String(s.percent ?? '').trim(),
  })) : null;
  if (splits) {
    const err = splitError(splits);
    if (err) throw validation(err);
    for (const s of splits) {
      await assertRefInCompany(ctx, accounts, s.accountId, 'Split account');
      if (s.classId) await assertRefInCompany(ctx, classes, s.classId, 'Split class');
    }
  }
  const setAccountId = splits ? null : input.setAccountId || null;
  if (!splits && !setAccountId && !opts.conditionsOnly) {
    throw validation('Choose the account this rule puts transactions in.');
  }
  if (setAccountId) await assertRefInCompany(ctx, accounts, setAccountId, 'Account');
  const setClassId = input.setClassId || null;
  if (setClassId) await assertRefInCompany(ctx, classes, setClassId, 'Class');

  return {
    name,
    matchField,
    matchOperator,
    matchValue,
    bankAccountId,
    direction,
    amountMin,
    amountMax,
    setAccountId,
    setClassId,
    setPayee: trimOrNull(input.setPayee, 'Payee'),
    setMemo: trimOrNull(input.setMemo, 'Memo'),
    splits,
    mode,
    enabled: input.enabled ?? true,
    learned: input.learned ?? false,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function topPriority(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ p: max(transactionRules.priority) })
    .from(transactionRules)
    .where(and(eq(transactionRules.companyId, ctx.companyId), eq(transactionRules.isActive, true)));
  return row?.p ?? 0;
}

export async function createBankRule(ctx: ServiceContext, input: BankRuleInput): Promise<BankRule> {
  checkPriority(input.priority);
  const values = await validateInput(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const priority = Number.isInteger(input.priority) ? input.priority! : (await topPriority(tx)) + 1;
    const [row] = await tx.db
      .insert(transactionRules)
      .values({ ...values, priority, companyId: tx.companyId })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'transaction_rule', entityId: row.id, newValues: row });
    return row;
  });
}

/**
 * Update a rule. `expectedUpdatedAt` (the version the editor loaded) turns on record locking:
 * when someone else saved the rule in the meantime the save is refused with CONFLICT.
 */
export async function updateBankRule(
  ctx: ServiceContext,
  id: string,
  input: Partial<BankRuleInput>,
  expectedUpdatedAt?: string | Date | null,
): Promise<BankRule> {
  checkPriority(input.priority);
  const before = await getBankRule(ctx, id);
  const merged: BankRuleInput = {
    name: input.name ?? before.name,
    matchField: input.matchField ?? (before.matchField as RuleField),
    matchOperator: input.matchOperator ?? (before.matchOperator as RuleOperator),
    matchValue: input.matchValue !== undefined ? input.matchValue : before.matchValue,
    bankAccountId: input.bankAccountId !== undefined ? input.bankAccountId : before.bankAccountId,
    direction: input.direction ?? (before.direction as RuleDirection),
    amountMin: input.amountMin !== undefined ? input.amountMin : before.amountMin,
    amountMax: input.amountMax !== undefined ? input.amountMax : before.amountMax,
    setAccountId: input.setAccountId !== undefined ? input.setAccountId : before.setAccountId,
    setClassId: input.setClassId !== undefined ? input.setClassId : before.setClassId,
    setPayee: input.setPayee !== undefined ? input.setPayee : before.setPayee,
    setMemo: input.setMemo !== undefined ? input.setMemo : before.setMemo,
    splits: input.splits !== undefined ? input.splits : before.splits,
    mode: input.mode ?? (before.mode as RuleMode),
    enabled: input.enabled ?? before.enabled,
    learned: before.learned,
  };
  const values = await validateInput(ctx, merged);
  return inTransaction(ctx, async (tx) => {
    const conds = [eq(transactionRules.id, id), eq(transactionRules.companyId, tx.companyId), eq(transactionRules.isActive, true)];
    // Lock the row, then compare versions at millisecond precision (what JSON round-trips).
    const [locked] = await tx.db.select().from(transactionRules).where(and(...conds)).for('update');
    if (!locked) throw notFound('Rule');
    if (expectedUpdatedAt) {
      const want = new Date(expectedUpdatedAt);
      if (Number.isNaN(want.getTime())) throw validation('Invalid record version.');
      if (locked.updatedAt.getTime() !== want.getTime()) throw staleRule(locked);
    }
    const now = new Date(Math.max(Date.now(), locked.updatedAt.getTime() + 1));
    const [row] = await tx.db
      .update(transactionRules)
      .set({ ...values, ...(Number.isInteger(input.priority) ? { priority: input.priority } : {}), updatedAt: now })
      .where(and(...conds))
      .returning();
    if (!row) throw notFound('Rule');
    await writeAudit(tx, { action: 'update', entityType: 'transaction_rule', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

function staleRule(r: BankRule) {
  return new ServiceError('CONFLICT', 'This rule was changed by someone else. Reload to see the latest.', {
    staleVersion: true,
    entity: 'transaction_rule',
    id: r.id,
    currentUpdatedAt: r.updatedAt.toISOString(),
  });
}

export async function setBankRuleEnabled(ctx: ServiceContext, id: string, enabled: boolean): Promise<BankRule> {
  return updateBankRule(ctx, id, { enabled });
}

/** Delete a rule (soft: is_active = false, kept for the audit trail). */
export async function deleteBankRule(ctx: ServiceContext, id: string): Promise<void> {
  const before = await getBankRule(ctx, id);
  await inTransaction(ctx, async (tx) => {
    await tx.db
      .update(transactionRules)
      .set({ isActive: false, enabled: false, updatedAt: new Date() })
      .where(and(eq(transactionRules.id, id), eq(transactionRules.companyId, tx.companyId)));
    await writeAudit(tx, { action: 'delete', entityType: 'transaction_rule', entityId: id, oldValues: before, newValues: { isActive: false } });
  });
}

/**
 * Reorder: `orderedIds` is the complete list of the company's rules, first = checked first.
 * Priorities are rewritten n..1 so the order is explicit and stable.
 */
export async function reorderBankRules(ctx: ServiceContext, orderedIds: string[]): Promise<BankRule[]> {
  const current = await listBankRules(ctx);
  const known = new Set(current.map((r) => r.id));
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length) throw validation('A rule is listed twice.');
  for (const id of orderedIds) if (!known.has(id)) throw validation('A rule in the new order does not exist in this company.');
  if (orderedIds.length !== current.length) throw validation('The new order must include every rule.');
  await inTransaction(ctx, async (tx) => {
    const n = orderedIds.length;
    for (let i = 0; i < n; i++) {
      await tx.db
        .update(transactionRules)
        .set({ priority: n - i, updatedAt: new Date() })
        .where(and(eq(transactionRules.id, orderedIds[i]), eq(transactionRules.companyId, tx.companyId)));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'transaction_rule',
      entityId: orderedIds[0] ?? ctx.companyId,
      oldValues: { order: current.map((r) => r.id) },
      newValues: { order: orderedIds },
    });
  });
  return listBankRules(ctx);
}

/** Record that a rule categorized `count` more lines (usage statistics on the Rules page). */
export async function noteRuleApplied(ctx: ServiceContext, ruleId: string, count = 1): Promise<void> {
  await ctx.db
    .update(transactionRules)
    .set({ appliedCount: sql`${transactionRules.appliedCount} + ${count}`, lastAppliedAt: new Date() })
    .where(and(eq(transactionRules.id, ruleId), eq(transactionRules.companyId, ctx.companyId)));
}

// ---------------------------------------------------------------------------
// Test a rule against recent transactions
// ---------------------------------------------------------------------------

export interface RuleTestHit {
  bankTransactionId: string;
  date: Date;
  description: string | null;
  payee: string | null;
  amount: string;
  bankAccountId: string;
  status: 'to_review' | 'added' | 'excluded';
  /** A higher-priority rule would categorize this line first. */
  shadowedBy: { id: string; name: string } | null;
}

/**
 * Run a rule (saved or a draft from the editor) against the company's most recent bank lines
 * (default: last 365 days, newest 500) and list what it would catch. Nothing is changed.
 */
export async function testBankRule(
  ctx: ServiceContext,
  draft: BankRuleInput & { id?: string | null },
  opts: { days?: number; limit?: number } = {},
): Promise<{ checked: number; hits: RuleTestHit[] }> {
  checkPriority(draft.priority);
  const values = await validateInput(ctx, draft, { conditionsOnly: true });
  const days = Math.min(Math.max(opts.days ?? 365, 1), 3650);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await ctx.db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, ctx.companyId), gte(bankTransactions.date, since)))
    .orderBy(desc(bankTransactions.date))
    .limit(limit);

  const others = (await activeBankRules(ctx)).filter((r) => r.id !== draft.id);
  const priority = Number.isInteger(draft.priority)
    ? draft.priority!
    : draft.id
      ? (await getBankRule(ctx, draft.id)).priority
      : (await topPriority(ctx)) + 1;
  const probe: RuleLike = {
    id: draft.id ?? '__draft__',
    name: values.name,
    matchField: values.matchField ?? 'description',
    matchOperator: values.matchOperator ?? 'contains',
    matchValue: values.matchValue ?? '',
    bankAccountId: values.bankAccountId ?? null,
    direction: values.direction ?? 'any',
    amountMin: values.amountMin ?? null,
    amountMax: values.amountMax ?? null,
    priority,
    createdAt: new Date(),
  };

  const hits: RuleTestHit[] = [];
  for (const t of rows) {
    const txn = { description: t.description, payee: t.payee, amount: t.amount, bankAccountId: t.bankAccountId };
    if (!ruleMatches(probe, txn)) continue;
    const winner = pickRule([...others, probe], txn);
    hits.push({
      bankTransactionId: t.id,
      date: t.date,
      description: t.description,
      payee: t.payee,
      amount: t.amount,
      bankAccountId: t.bankAccountId,
      status: t.matched ? 'added' : t.excluded ? 'excluded' : 'to_review',
      shadowedBy: winner && winner.id !== probe.id ? { id: winner.id, name: winner.name } : null,
    });
  }
  return { checked: rows.length, hits };
}

// ---------------------------------------------------------------------------
// History + learning
// ---------------------------------------------------------------------------

/** Sources that represent a person's decision (and therefore teach the engine). */
export const LEARNING_SOURCES = ['user', 'bulk'] as const;

export interface HistoryRow {
  pattern: string;
  direction: string;
  accountId: string;
  classId: string | null;
  payee: string | null;
  split: boolean;
  source: string;
  createdAt: Date;
}

/**
 * Past categorizations whose journal entry is still posted (an Unmatch voids the entry, which
 * removes it from history automatically), optionally limited to some patterns.
 */
export async function loadHistory(
  ctx: ServiceContext,
  opts: { patterns?: string[]; learningOnly?: boolean } = {},
): Promise<HistoryRow[]> {
  const conds = [eq(bankCategorizationHistory.companyId, ctx.companyId), eq(journalEntries.status, 'posted')];
  if (opts.patterns) {
    if (opts.patterns.length === 0) return [];
    conds.push(inArray(bankCategorizationHistory.pattern, opts.patterns));
  }
  if (opts.learningOnly) conds.push(inArray(bankCategorizationHistory.source, [...LEARNING_SOURCES]));
  return ctx.db
    .select({
      pattern: bankCategorizationHistory.pattern,
      direction: bankCategorizationHistory.direction,
      accountId: bankCategorizationHistory.accountId,
      classId: bankCategorizationHistory.classId,
      payee: bankCategorizationHistory.payee,
      split: bankCategorizationHistory.split,
      source: bankCategorizationHistory.source,
      createdAt: bankCategorizationHistory.createdAt,
    })
    .from(bankCategorizationHistory)
    .innerJoin(
      journalEntries,
      and(eq(journalEntries.id, bankCategorizationHistory.journalEntryId), eq(journalEntries.companyId, ctx.companyId)),
    )
    .where(and(...conds))
    .orderBy(desc(bankCategorizationHistory.createdAt));
}

export interface RuleOffer {
  /** Normalized pattern, e.g. "SHELL OIL". */
  pattern: string;
  direction: 'in' | 'out';
  accountId: string;
  accountName: string;
  classId: string | null;
  className: string | null;
  /** Payee name the user gave every time (null when they differed or none was given). */
  payee: string | null;
  /** How many times the user made this exact choice. */
  count: number;
  /** "Always categorize SHELL OIL as Fuel?" */
  question: string;
  /** Ready-to-save rule for one-click "Yes". */
  rule: BankRuleInput;
}

/**
 * Learning offers: patterns the user categorized to the same account + class at least
 * LEARN_THRESHOLD times (manual or bulk-accepted choices only), which no enabled rule already
 * covers and which the user has not dismissed. Pass `pattern` to check a single pattern (used
 * right after a categorization).
 */
export async function ruleOffers(ctx: ServiceContext, opts: { pattern?: string } = {}): Promise<RuleOffer[]> {
  const history = await loadHistory(ctx, {
    learningOnly: true,
    ...(opts.pattern ? { patterns: [opts.pattern] } : {}),
  });
  if (history.length === 0) return [];

  type Group = { pattern: string; direction: 'in' | 'out'; accountId: string; classId: string | null; payees: Set<string | null>; count: number };
  const groups = new Map<string, Group>();
  for (const h of history) {
    if (h.split || !h.pattern) continue;
    const key = `${h.pattern}|${h.direction}|${h.accountId}|${h.classId ?? ''}`;
    const g = groups.get(key) ?? {
      pattern: h.pattern,
      direction: h.direction === 'in' ? 'in' : 'out',
      accountId: h.accountId,
      classId: h.classId,
      payees: new Set<string | null>(),
      count: 0,
    };
    g.count += 1;
    g.payees.add(h.payee?.trim() || null);
    groups.set(key, g);
  }
  const eligible = [...groups.values()].filter((g) => g.count >= LEARN_THRESHOLD);
  if (eligible.length === 0) return [];

  const dismissed = await ctx.db
    .select({ pattern: bankRuleDismissals.pattern, accountId: bankRuleDismissals.accountId })
    .from(bankRuleDismissals)
    .where(eq(bankRuleDismissals.companyId, ctx.companyId));
  const dismissedKeys = new Set(dismissed.map((d) => `${d.pattern}|${d.accountId}`));
  const rules = await activeBankRules(ctx);

  const acctIds = [...new Set(eligible.map((g) => g.accountId))];
  const acctRows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, acctIds)));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const classIds = [...new Set(eligible.map((g) => g.classId).filter((c): c is string => !!c))];
  const classRows = classIds.length
    ? await ctx.db
        .select({ id: classes.id, name: classes.name })
        .from(classes)
        .where(and(eq(classes.companyId, ctx.companyId), inArray(classes.id, classIds)))
    : [];
  const classById = new Map(classRows.map((c) => [c.id, c.name]));

  const offers: RuleOffer[] = [];
  const seenPattern = new Set<string>();
  for (const g of eligible.sort((a, b) => b.count - a.count)) {
    const acct = acctById.get(g.accountId);
    if (!acct || !acct.isActive) continue;
    if (dismissedKeys.has(`${g.pattern}|${g.accountId}`)) continue;
    // One offer per pattern + direction (the most frequent choice).
    const pkey = `${g.pattern}|${g.direction}`;
    if (seenPattern.has(pkey)) continue;
    seenPattern.add(pkey);
    // Already covered by a rule? (probe with the pattern itself as the description)
    const probeAmount = g.direction === 'in' ? '1.00' : '-1.00';
    const covering = pickRule(
      rules.map((r) => ({ ...r, amountMin: null, amountMax: null })),
      { description: g.pattern, payee: null, amount: probeAmount, bankAccountId: null },
    );
    if (covering) continue;
    const payee = g.payees.size === 1 ? [...g.payees][0] : null;
    const className = g.classId ? classById.get(g.classId) ?? null : null;
    offers.push({
      pattern: g.pattern,
      direction: g.direction,
      accountId: g.accountId,
      accountName: acct.name,
      classId: g.classId,
      className,
      payee,
      count: g.count,
      question: `Always categorize ${g.pattern} as ${acct.name}${className ? ` (${className})` : ''}?`,
      rule: {
        name: `${g.pattern} → ${acct.name}`.slice(0, MAX_TEXT),
        matchField: 'any',
        matchOperator: 'contains',
        matchValue: g.pattern,
        direction: g.direction,
        setAccountId: g.accountId,
        setClassId: g.classId,
        setPayee: payee,
        mode: 'suggest',
        enabled: true,
        learned: true,
      },
    });
  }
  return offers;
}

/** The learning offer (if any) right after a line was categorized. */
export async function offerForTransaction(ctx: ServiceContext, bankTransactionId: string): Promise<RuleOffer | null> {
  const [t] = await ctx.db
    .select({ description: bankTransactions.description, payee: bankTransactions.payee, amount: bankTransactions.amount })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.companyId, ctx.companyId)));
  if (!t) return null;
  const [h] = await ctx.db
    .select({ pattern: bankCategorizationHistory.pattern })
    .from(bankCategorizationHistory)
    .where(and(eq(bankCategorizationHistory.companyId, ctx.companyId), eq(bankCategorizationHistory.bankTransactionId, bankTransactionId)))
    .orderBy(desc(bankCategorizationHistory.createdAt))
    .limit(1);
  const pattern = h?.pattern ?? patternOf(t);
  if (!pattern) return null;
  const direction = Money.isNegative(t.amount) ? 'out' : 'in';
  const offers = await ruleOffers(ctx, { pattern });
  return offers.find((o) => o.direction === direction) ?? null;
}

/** Accept a learning offer: creates the learned rule. */
export async function acceptOffer(
  ctx: ServiceContext,
  input: { pattern: string; accountId: string; direction: 'in' | 'out'; mode?: RuleMode },
): Promise<BankRule> {
  const pattern = (input.pattern ?? '').trim();
  const offer = (await ruleOffers(ctx, { pattern })).find(
    (o) => o.accountId === input.accountId && o.direction === input.direction,
  );
  if (!offer) throw validation('That suggestion is no longer available (a rule may already cover it).');
  return createBankRule(ctx, { ...offer.rule, mode: input.mode ?? 'suggest' });
}

/** "No thanks" on a learning offer: never offer this pattern → account again. */
export async function dismissOffer(ctx: ServiceContext, input: { pattern: string; accountId: string }): Promise<void> {
  const pattern = (input.pattern ?? '').trim().slice(0, MAX_TEXT);
  if (!pattern) throw validation('Pattern is required.');
  await assertRefInCompany(ctx, accounts, input.accountId, 'Account');
  await inTransaction(ctx, async (tx) => {
    await tx.db
      .insert(bankRuleDismissals)
      .values({ companyId: tx.companyId, pattern, accountId: input.accountId })
      .onConflictDoNothing();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'bank_rule_dismissal',
      entityId: input.accountId,
      newValues: { pattern, accountId: input.accountId },
    });
  });
}

/**
 * Account merge support (lib/services/merge.ts): move rule splits, learning history and
 * dismissals from `fromId` to `toId` so learned choices survive a chart-of-accounts merge.
 * (transaction_rules.set_account_id is repointed by merge.ts itself.) Returns rows touched.
 */
export async function repointBankRuleAccount(ctx: ServiceContext, fromId: string, toId: string): Promise<number> {
  let touched = 0;
  const withSplits = await ctx.db
    .select({ id: transactionRules.id, splits: transactionRules.splits })
    .from(transactionRules)
    .where(eq(transactionRules.companyId, ctx.companyId));
  for (const r of withSplits) {
    if (!r.splits?.some((s) => s.accountId === fromId)) continue;
    const splits = r.splits.map((s) => (s.accountId === fromId ? { ...s, accountId: toId } : s));
    await ctx.db.update(transactionRules).set({ splits, updatedAt: new Date() }).where(eq(transactionRules.id, r.id));
    touched += 1;
  }
  touched += (
    await ctx.db
      .update(bankCategorizationHistory)
      .set({ accountId: toId })
      .where(and(eq(bankCategorizationHistory.companyId, ctx.companyId), eq(bankCategorizationHistory.accountId, fromId)))
      .returning({ id: bankCategorizationHistory.id })
  ).length;
  // A pattern dismissed for BOTH accounts would collide on bank_rule_dismissals_uq once
  // repointed: drop the old account's duplicate first (the surviving dismissal still applies).
  touched += (
    await ctx.db
      .delete(bankRuleDismissals)
      .where(
        and(
          eq(bankRuleDismissals.companyId, ctx.companyId),
          eq(bankRuleDismissals.accountId, fromId),
          sql`exists (select 1 from bank_rule_dismissals e where e.company_id = ${ctx.companyId} and e.pattern = ${bankRuleDismissals.pattern} and e.account_id = ${toId})`,
        ),
      )
      .returning({ id: bankRuleDismissals.id })
  ).length;
  touched += (
    await ctx.db
      .update(bankRuleDismissals)
      .set({ accountId: toId })
      .where(and(eq(bankRuleDismissals.companyId, ctx.companyId), eq(bankRuleDismissals.accountId, fromId)))
      .returning({ id: bankRuleDismissals.id })
  ).length;
  return touched;
}
