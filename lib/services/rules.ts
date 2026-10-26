/**
 * Categorization rules service.
 *
 * Each rule watches one field on a bank transaction (description, payee, or amount),
 * applies an operator (contains / equals / starts_with), and — when it matches —
 * sets a suggested account on that transaction. Rules are evaluated in descending
 * priority order; the first match wins.
 *
 * This is a STAGING layer: no GL posting happens here. Rules only write
 * `bank_transactions.suggestedAccountId`; the reconcile/match step does the posting.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { accounts, bankTransactions, transactionRules } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { pickRule } from '@/lib/bankRules/core';
import { subledgerAccountReason } from '@/lib/registerEntryPlan';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchField = 'description' | 'payee' | 'amount';
export type MatchOperator = 'contains' | 'equals' | 'starts_with';

export interface CreateRuleInput {
  name: string;
  matchField: MatchField;
  matchOperator: MatchOperator;
  matchValue: string;
  /** The account to suggest when the rule fires. */
  setAccountId: string;
  /** Optional: override the payee display name. */
  setPayee?: string | null;
  /** Higher number = evaluated first. Default 0. */
  priority?: number;
}

/** Minimal bank transaction shape needed by applyRules. */
export interface BankTxnForRules {
  description?: string | null;
  payee?: string | null;
  amount: string; // decimal string
  /** bankrules: the feed's bank account (rules limited to one account need it). */
  bankAccountId?: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * List all active, enabled rules for the company, ordered by priority desc then name asc.
 * (bankrules: disabled rules are kept but never fire — see lib/services/bankRules.ts.)
 */
export async function listRules(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(transactionRules)
    .where(
      and(
        eq(transactionRules.companyId, ctx.companyId),
        eq(transactionRules.isActive, true),
        eq(transactionRules.enabled, true),
      ),
    )
    .orderBy(desc(transactionRules.priority), asc(transactionRules.name));
}

/** Fetch a single rule, scoped to the company. */
export async function getRule(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(transactionRules)
    .where(and(eq(transactionRules.id, id), eq(transactionRules.companyId, ctx.companyId)));
  if (!row) throw notFound('Categorization rule');
  return row;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Create a new categorization rule. */
export async function createRule(ctx: ServiceContext, input: CreateRuleInput) {
  if (typeof input.name !== 'string' || !input.name.trim()) throw validation('Rule name is required.');
  if (typeof input.matchValue !== 'string' || !input.matchValue.trim()) throw validation('Match value is required.');
  if (!input.setAccountId) throw validation('setAccountId is required.');
  // The columns are varchar(255) / integer: refuse what they can't hold with a plain message
  // (an over-long name or payee used to fail in the database → HTTP 500).
  if (input.name.trim().length > 255) throw validation('The rule name is too long (max 255 characters).');
  if (input.matchValue.trim().length > 255) throw validation('The text to match is too long (max 255 characters).');
  if (input.setPayee != null && (typeof input.setPayee !== 'string' || input.setPayee.length > 255)) {
    throw validation('The payee is too long (max 255 characters).');
  }
  if (input.priority != null && (!Number.isInteger(input.priority) || Math.abs(input.priority) > 1_000_000)) {
    throw validation('Priority must be a whole number between -1,000,000 and 1,000,000.');
  }

  // Verify the target account belongs to this company.
  const [acct] = await ctx.db
    .select({ id: accounts.id, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.id, input.setAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!acct) throw notFound(`Account ${input.setAccountId}`);
  // Bank-feed lines can't be added to Undeposited Funds / an inventory asset account.
  const reason = subledgerAccountReason(acct);
  if (reason) throw validation(`${reason} A bank rule can't put transactions there.`);

  const [row] = await ctx.db
    .insert(transactionRules)
    .values({
      companyId: ctx.companyId,
      name: input.name.trim(),
      matchField: input.matchField,
      matchOperator: input.matchOperator,
      matchValue: input.matchValue.trim(),
      setAccountId: input.setAccountId,
      setPayee: input.setPayee ?? null,
      priority: input.priority ?? 0,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'transaction_rule',
    entityId: row.id,
    newValues: row,
  });

  return row;
}

/** Soft-delete a rule (sets isActive = false). */
export async function deactivateRule(ctx: ServiceContext, id: string) {
  const before = await getRule(ctx, id);
  const [row] = await ctx.db
    .update(transactionRules)
    .set({ isActive: false })
    .where(eq(transactionRules.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'transaction_rule',
    entityId: id,
    oldValues: before,
    newValues: { isActive: false },
  });

  return row;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/** The actionable fields of the highest-priority rule that matched a transaction. */
export interface MatchedRule {
  setAccountId: string | null;
  setPayee: string | null;
}

/**
 * Run all active rules against a single bank transaction and return the actionable
 * fields (setAccountId AND setPayee) of the highest-priority matching rule, or null
 * if none match.
 *
 * Rules are fetched fresh from the DB on each call so that changes take effect immediately.
 * For bulk imports, prefer loading rules once and passing them in (see importTransactions).
 */
export async function matchRule(
  ctx: ServiceContext,
  txn: BankTxnForRules,
  /** Pre-fetched rules (optional — avoids repeated DB queries during bulk import). */
  rules?: Awaited<ReturnType<typeof listRules>>,
): Promise<MatchedRule | null> {
  const ruleList = rules ?? (await listRules(ctx));
  // bankrules: shared matcher (conditions incl. direction / amount range / bank account, raw +
  // normalized text, safe wildcard patterns) and precedence (priority, then oldest first).
  const rule = pickRule(ruleList, txn);
  if (!rule) return null;
  return { setAccountId: rule.setAccountId ?? rule.splits?.[0]?.accountId ?? null, setPayee: rule.setPayee ?? null };
}

/**
 * Back-compat convenience over `matchRule`: returns only the setAccountId from the
 * highest-priority matching rule, or null if none match.
 */
export async function applyRules(
  ctx: ServiceContext,
  txn: BankTxnForRules,
  rules?: Awaited<ReturnType<typeof listRules>>,
): Promise<string | null> {
  const match = await matchRule(ctx, txn, rules);
  return match?.setAccountId ?? null;
}

/**
 * Apply all active rules to every unmatched bank transaction for a bank account,
 * writing suggestedAccountId where a rule fires. Returns the count of rows updated.
 */
export async function applyRulesToAccount(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<number> {
  // Load active rules once.
  const rules = await listRules(ctx);
  if (rules.length === 0) return 0;

  // Fetch unmatched staging transactions for the account.
  const txns = await ctx.db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.matched, false),
      ),
    );

  let updated = 0;
  for (const txn of txns) {
    const match = await matchRule(
      ctx,
      { description: txn.description, payee: txn.payee, amount: txn.amount, bankAccountId: txn.bankAccountId },
      rules,
    );
    if (!match) continue;
    const set: { suggestedAccountId?: string; payee?: string } = {};
    if (match.setAccountId && match.setAccountId !== txn.suggestedAccountId) {
      set.suggestedAccountId = match.setAccountId;
    }
    if (match.setPayee && match.setPayee !== txn.payee) {
      set.payee = match.setPayee;
    }
    if (Object.keys(set).length > 0) {
      await ctx.db
        .update(bankTransactions)
        .set(set)
        .where(eq(bankTransactions.id, txn.id));
      updated += 1;
    }
  }
  return updated;
}
