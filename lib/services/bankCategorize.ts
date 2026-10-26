/**
 * Bank-categorize service — the "Add to register" / "Match" step in the bank feed workflow.
 *
 * Flow:
 *  1. Transactions are staged in bank_transactions (matched = false) by the import module.
 *  2. `categorize` posts a GL journal entry and marks the transaction matched.
 *  3. `bulkApplyRules` runs active categorization rules against all unmatched transactions,
 *     writing suggestedAccountId where a rule fires (no GL posting yet).
 *  4. `categorizeSuggested` calls `categorize` for every unmatched txn whose suggestion a live
 *     rule still gives — the "Add all suggested" one-click batch.
 *  5. `unmatch` voids the GL entry and clears the matched flag (undo).
 *
 * IMPORTANT: GL writes happen ONLY through `postJournalEntry` (posting.ts).
 * All money arithmetic uses '@/lib/money'.
 */
import { and, desc, eq, gte, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  accounts,
  auditLogs,
  bankAccounts,
  bankCategorizationHistory,
  bankTransactions,
  classes,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { patternOf, pickRule, splitError, type RuleSplit } from '@/lib/bankRules/core';
import { activeBankRules, noteRuleApplied } from './bankRules';
import { postJournalEntry, voidJournalEntry } from './posting';
import { applyRulesToAccount } from './rules';
import { accountSigned, foreignCurrencyOfAccount } from './fxLedger';
import { currencyRate, toHome } from './exchangeRates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategorizeInput {
  bankTransactionId: string;
  /** The offsetting GL account (income, expense, liability, etc.). */
  accountId: string;
  payee?: string | null;
  memo?: string | null;
  /**
   * p1 fx: for a foreign-currency bank / credit-card account the feed amount is in the account's
   * currency; it is posted at this rate (home units per 1 unit), default the currency list's rate.
   */
  exchangeRate?: string | number | null;
  /** bankrules: class for the offset line(s). */
  classId?: string | null;
  /**
   * bankrules: split the offset by percentage across accounts (sums to 100). When given, each
   * split line uses its own account/class and `accountId` is only the "main" account recorded
   * for learning.
   */
  splits?: RuleSplit[] | null;
  /**
   * bankrules: who decided this categorization — recorded in the learning history. 'user' (the
   * default) and 'bulk' (user accepted suggestions in bulk) teach the rules engine; 'rule_auto'
   * and 'ai' (automatic posts) are kept for reference but never count towards learning.
   */
  source?: 'user' | 'bulk' | 'rule' | 'rule_auto' | 'ai';
  /** bankrules: the rule that produced this categorization (usage statistics). */
  ruleId?: string | null;
}

export type ReviewFilter = 'all' | 'unreviewed' | 'matched' | 'excluded';

export type MatchConfidence = 'high' | 'medium' | 'low';

/** A candidate existing GL entry that a staged bank transaction can be matched to. */
export interface MatchCandidate {
  entryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  reference: string | null;
  sourceRef: string | null;
  /** Net signed effect of the entry on the bank GL account (debits − credits). */
  amount: string;
  /** Absolute distance in whole days between the entry date and the feed date. */
  dateDiffDays: number;
  /** Entry reference / check number found in the feed description or payee. */
  referenceMatch: boolean;
  confidence: MatchConfidence;
  /** 0–100 ranking score; 100 = exact reference match. */
  score: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * List staged bank-feed transactions for a bank account, newest first.
 *
 * Filters:
 *  - `filter: 'unreviewed'` — not matched AND not excluded (the review queue).
 *  - `filter: 'matched'`    — matched/categorized rows.
 *  - `filter: 'excluded'`   — rows the user excluded from review.
 *  - `filter: 'all'` (default) — everything.
 *  - `unmatchedOnly: true` is kept for back-compat and behaves like 'unreviewed'.
 */
export async function listStaged(
  ctx: ServiceContext,
  bankAccountId: string,
  opts: { unmatchedOnly?: boolean; filter?: ReviewFilter } = {},
) {
  const filter: ReviewFilter = opts.filter ?? (opts.unmatchedOnly ? 'unreviewed' : 'all');
  const conditions = [
    eq(bankTransactions.companyId, ctx.companyId),
    eq(bankTransactions.bankAccountId, bankAccountId),
  ];
  if (filter === 'unreviewed') {
    conditions.push(eq(bankTransactions.matched, false), eq(bankTransactions.excluded, false));
  } else if (filter === 'matched') {
    conditions.push(eq(bankTransactions.matched, true));
  } else if (filter === 'excluded') {
    conditions.push(eq(bankTransactions.excluded, true));
  }
  return ctx.db
    .select()
    .from(bankTransactions)
    .where(and(...conditions))
    .orderBy(desc(bankTransactions.date));
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

async function loadTransaction(ctx: ServiceContext, bankTransactionId: string) {
  const [txn] = await ctx.db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, bankTransactionId),
        eq(bankTransactions.companyId, ctx.companyId),
      ),
    );
  if (!txn) throw notFound('Bank transaction');
  return txn;
}

async function loadBankAccount(ctx: ServiceContext, bankAccountId: string) {
  const [ba] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!ba) throw notFound('Bank account');
  return ba;
}

// ---------------------------------------------------------------------------
// Categorize (Add to register)
// ---------------------------------------------------------------------------

/**
 * Categorize a single staged bank transaction:
 *  - Loads the txn and its bank account's GL account.
 *  - amount > 0 (money IN):  Dr bankGL / Cr accountId
 *  - amount < 0 (money OUT): Dr accountId / Cr bankGL  (uses abs amount)
 *  - Posts via postJournalEntry, sets matched = true + matchedEntryId.
 */
export async function categorize(ctx: ServiceContext, input: CategorizeInput) {
  // Load the bank transaction (company-scoped).
  const [txn] = await ctx.db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, input.bankTransactionId),
        eq(bankTransactions.companyId, ctx.companyId),
      ),
    );
  if (!txn) throw notFound('Bank transaction');
  if (txn.matched) {
    throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
  }
  if (txn.excluded) {
    throw new ServiceError('CONFLICT', 'Bank transaction is excluded. Restore it before categorizing.');
  }

  // Load the bank account to find its linked GL account.
  const [ba] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, txn.bankAccountId),
        eq(bankAccounts.companyId, ctx.companyId),
      ),
    );
  if (!ba) throw notFound('Bank account');

  const bankGlAccountId = ba.accountId;
  const amt = Money.of(txn.amount);
  const absAmt = toAmountString(Money.abs(txn.amount));

  if (amt.isZero()) {
    throw validation('Cannot categorize a zero-amount transaction.');
  }
  // The feed line keeps the payee (varchar 255); refuse a longer one plainly instead of failing
  // in the database.
  if (input.payee != null && typeof input.payee !== 'string') throw validation('Payee must be text.');
  if (input.memo != null && typeof input.memo !== 'string') throw validation('Memo must be text.');
  if (input.payee && input.payee.length > 255) throw validation('The payee is too long (max 255 characters).');

  // p1 fx: a foreign-currency bank / card account's feed is in the account's currency. Post the
  // home value at the stated rate (else the currency list's rate) and keep the feed amount on the
  // bank line, so the register and reconciliation stay in the account's currency.
  const feedCurrency = await foreignCurrencyOfAccount(ctx, bankGlAccountId);
  const fx = feedCurrency ? await currencyRate(ctx, feedCurrency, input.exchangeRate) : null;
  const homeAmt = fx ? toAmountString(toHome(Money.abs(txn.amount), fx.rate)) : absAmt;
  if (fx && !Money.gt(homeAmt, 0)) {
    throw validation('This amount is too small to convert to your home currency.');
  }
  const bankFx = fx ? { foreignAmount: absAmt } : {};

  // bankrules: class + percentage splits for the offset side.
  const splits = input.splits && input.splits.length > 0 ? input.splits : null;
  if (splits) {
    const err = splitError(splits);
    if (err) throw validation(err);
    for (const sp of splits) {
      await assertRefInCompany(ctx, accounts, sp.accountId, 'Split account');
      if (sp.classId) await assertRefInCompany(ctx, classes, sp.classId, 'Split class');
    }
  } else if (!input.accountId) {
    throw validation('Choose an account.');
  }
  if (input.classId) await assertRefInCompany(ctx, classes, input.classId, 'Class');
  // The offset is the OTHER side of the bank line: categorizing to the feed's own account posts
  // Dr Checking / Cr Checking — the line shows as added but the books never get the money.
  if ((splits ? splits.map((sp) => sp.accountId) : [input.accountId]).includes(bankGlAccountId)) {
    throw validation('Choose a different account: this line came from this bank account, so it cannot also be the account it goes to.');
  }
  const offsets: { accountId: string; classId: string | null; amount: string }[] = splits
    ? allocate(homeAmt, splits.map((sp) => sp.percent))
        .map((a, i) => ({
          accountId: splits[i].accountId,
          classId: splits[i].classId ?? input.classId ?? null,
          amount: toAmountString(a),
        }))
        .filter((o) => Money.gt(o.amount, 0))
    : [{ accountId: input.accountId, classId: input.classId ?? null, amount: homeAmt }];
  const mainAccountId = splits
    ? [...offsets].sort((a, b) => (Money.gt(b.amount, a.amount) ? 1 : Money.gt(a.amount, b.amount) ? -1 : 0))[0].accountId
    : input.accountId;

  // Build posting lines:
  //   amount > 0 (deposit / credit): money came IN — debit the bank GL, credit the offset.
  //   amount < 0 (withdrawal / debit): money went OUT — debit the offset, credit the bank GL.
  const memo = input.memo ?? null;
  const lines =
    amt.greaterThan(0)
      ? [
          { accountId: bankGlAccountId, debit: homeAmt, memo, ...bankFx },
          ...offsets.map((o) => ({ accountId: o.accountId, credit: o.amount, memo, classId: o.classId })),
        ]
      : [
          ...offsets.map((o) => ({ accountId: o.accountId, debit: o.amount, memo, classId: o.classId })),
          { accountId: bankGlAccountId, credit: homeAmt, memo, ...bankFx },
        ];

  const description =
    input.payee
      ? `${input.payee}${txn.description ? ` — ${txn.description}` : ''}`
      : txn.description ?? 'Bank transaction';

  // Post + flag + audit in ONE transaction (postJournalEntry's internal
  // inTransaction nests as a savepoint) so a failure after posting cannot leave
  // a live GL entry with the staging row still unmatched — re-categorizing such
  // a row would post the same money twice.
  return inTransaction(ctx, async (tx) => {
    // Post on the feed line's calendar day (UTC midnight): older staged rows may carry a time of
    // day, which would push the entry outside "as of <that day>" reports.
    const feedDay = new Date(txn.date);
    const entry = await postJournalEntry(tx, {
      date: new Date(Date.UTC(feedDay.getUTCFullYear(), feedDay.getUTCMonth(), feedDay.getUTCDate())),
      description,
      // journal_entries.reference is varchar(100); the full memo is on every line. A rule's memo
      // (up to 255) or a long typed memo used to fail the post with a database error.
      reference: input.memo ? input.memo.slice(0, 100) : undefined,
      sourceRef: `bank_transaction:${txn.id}`,
      lines,
      ...(fx ? { currency: fx.currency, exchangeRate: fx.rate.toFixed(8) } : {}),
    });

    // Mark the staging row as matched. The matched=false guard in the WHERE makes
    // this race-safe: if another caller matched it since our read, zero rows come
    // back and the whole transaction (including the GL entry) rolls back.
    const [updated] = await tx.db
      .update(bankTransactions)
      .set({
        matched: true,
        matchedEntryId: entry.id,
        ...(input.payee ? { payee: input.payee } : {}),
      })
      .where(and(eq(bankTransactions.id, txn.id), eq(bankTransactions.matched, false)))
      .returning();
    if (!updated) {
      throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'bank_transaction',
      entityId: txn.id,
      oldValues: { matched: false },
      newValues: {
        matched: true,
        matchedEntryId: entry.id,
        ...(fx ? { currency: fx.currency, exchangeRate: fx.rate.toFixed(8), homeAmount: homeAmt } : {}),
        ...(splits ? { splits } : {}),
        ...(input.classId ? { classId: input.classId } : {}),
      },
    });

    // bankrules: remember the choice under the line's normalized description (learning + history).
    const pattern = patternOf(txn);
    if (pattern) {
      await tx.db.insert(bankCategorizationHistory).values({
        companyId: tx.companyId,
        bankTransactionId: txn.id,
        bankAccountId: txn.bankAccountId,
        journalEntryId: entry.id,
        pattern,
        direction: amt.greaterThan(0) ? 'in' : 'out',
        accountId: mainAccountId,
        classId: splits ? null : input.classId ?? null,
        payee: input.payee ?? null,
        split: !!splits,
        source: input.source ?? 'user',
        ruleId: input.ruleId ?? null,
      });
    }

    return { transaction: updated, entry };
  });
}

// ---------------------------------------------------------------------------
// Bulk: apply rules
// ---------------------------------------------------------------------------

/**
 * Run all active categorization rules against every unmatched bank transaction
 * for the given bank account, setting suggestedAccountId where a rule fires.
 * Returns the number of transactions updated.
 */
export async function bulkApplyRules(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<number> {
  // Validate the bank account belongs to this company.
  const [ba] = await ctx.db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!ba) throw notFound('Bank account');

  return applyRulesToAccount(ctx, bankAccountId);
}

// ---------------------------------------------------------------------------
// Bulk: categorize all suggested
// ---------------------------------------------------------------------------

/**
 * For every unmatched transaction whose suggestedAccountId a currently enabled rule still gives, call
 * `categorize` so it gets posted to the GL. Returns the count of categorized rows.
 */
export async function categorizeSuggested(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<number> {
  // Validate ownership.
  const [ba] = await ctx.db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!ba) throw notFound('Bank account');

  const candidates = await ctx.db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.matched, false),
        eq(bankTransactions.excluded, false),
        isNotNull(bankTransactions.suggestedAccountId),
      ),
    );

  // bankrules: suggestedAccountId was written by the rule pass at import time. Only post a line
  // when a rule that is live NOW still puts it in that account — a rule switched off, deleted or
  // edited since must not keep posting. These posts are the rule's doing, not a person's choice,
  // so they are recorded as source 'rule' (never counted towards learning offers).
  const rules = await activeBankRules(ctx);
  let count = 0;
  for (const txn of candidates) {
    if (!txn.suggestedAccountId) continue;
    const rule = pickRule(rules, txn);
    if (!rule || rule.setAccountId !== txn.suggestedAccountId || (rule.splits && rule.splits.length > 0)) {
      // Stale import-time suggestion: bring it in line with the live rules and skip the line.
      const live = rule?.setAccountId ?? null;
      await ctx.db
        .update(bankTransactions)
        .set({ suggestedAccountId: live })
        .where(and(eq(bankTransactions.id, txn.id), eq(bankTransactions.companyId, ctx.companyId)));
      continue;
    }
    try {
      await inTransaction(ctx, async (tx) => {
        await categorize(tx, {
          bankTransactionId: txn.id,
          accountId: rule.setAccountId!,
          classId: rule.setClassId ?? null,
          payee: rule.setPayee ?? null,
          memo: rule.setMemo ?? null,
          source: 'rule',
          ruleId: rule.id,
        });
        await noteRuleApplied(tx, rule.id);
      });
      count += 1;
    } catch (err) {
      // Skip individual failures (already matched, zero amount, etc.) — don't abort
      // batch. Each categorize call is atomic, so a failure leaves no partial state;
      // log it so partial batches are not silently invisible.
      console.warn(
        `[bankCategorize] categorizeSuggested: skipped txn ${txn.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Match to existing transaction (QB Bank Feeds "Match")
// ---------------------------------------------------------------------------

/** Days on either side of the feed date to search for match candidates. */
const MATCH_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

/** Digit runs (2+ digits, leading zeros stripped) found in a string — check #s, refs. */
function digitTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(/\d{2,}/g)) {
    out.add(m[0].replace(/^0+/, '') || '0');
  }
  return out;
}

/** Does the entry's reference (check number) appear in the feed line's text? */
function referenceMatches(
  entryReference: string | null,
  txn: { description: string | null; payee: string | null },
): boolean {
  const ref = entryReference?.trim();
  if (!ref) return false;
  const haystack = `${txn.description ?? ''} ${txn.payee ?? ''}`;
  const refDigits = ref.replace(/\D/g, '').replace(/^0+/, '');
  if (refDigits && digitTokens(haystack).has(refDigits)) return true;
  return haystack.toLowerCase().includes(ref.toLowerCase());
}

/**
 * Suggest existing GL entries a staged bank transaction can be matched to.
 *
 * Candidates are POSTED journal entries whose net effect on the bank account's GL
 * account (debits − credits across all of the entry's lines on that account) equals
 * the feed line's signed amount — i.e. amount-equal AND sign-compatible — dated
 * within ±14 days, and not already matched by any other feed line.
 *
 * Ranking: exact check-number/reference matches first, then by date proximity.
 */
export async function suggestMatches(
  ctx: ServiceContext,
  bankTransactionId: string,
): Promise<MatchCandidate[]> {
  const txn = await loadTransaction(ctx, bankTransactionId);
  if (txn.matched) {
    throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
  }
  if (txn.excluded) {
    throw new ServiceError('CONFLICT', 'Bank transaction is excluded. Restore it first.');
  }

  const ba = await loadBankAccount(ctx, txn.bankAccountId);
  const amt = Money.of(txn.amount);
  if (amt.isZero()) return [];
  // p1 fx: a foreign-currency account's feed is compared in the account's currency.
  const foreign = !!(await foreignCurrencyOfAccount(ctx, ba.accountId));

  const txnDate = new Date(txn.date);
  const from = new Date(txnDate.getTime() - MATCH_WINDOW_DAYS * DAY_MS);
  const to = new Date(txnDate.getTime() + MATCH_WINDOW_DAYS * DAY_MS);

  // Entries already linked by a feed line OF THIS BANK ACCOUNT (whether matched or created via
  // categorize) are taken — a register transaction clears each bank only once. A transfer between
  // two feed-connected accounts is one entry that appears on both feeds, so the other account's
  // link does not take it.
  const takenRows = await ctx.db
    .select({ entryId: bankTransactions.matchedEntryId })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, txn.bankAccountId),
        isNotNull(bankTransactions.matchedEntryId),
      ),
    );
  const taken = new Set(takenRows.map((r) => r.entryId).filter((id): id is string => !!id));

  // All lines on the bank GL account from posted entries inside the date window.
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      foreignAmount: journalEntryLines.foreignAmount,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, ba.accountId),
        gte(journalEntries.date, from),
        lte(journalEntries.date, to),
      ),
    );

  // Net bank-GL effect per entry (an entry may hit the bank account on >1 line).
  const byEntry = new Map<
    string,
    {
      entryNumber: number;
      date: Date;
      description: string;
      reference: string | null;
      sourceRef: string | null;
      net: ReturnType<typeof Money.of>;
    }
  >();
  for (const r of rows) {
    const existing = byEntry.get(r.entryId);
    const delta = accountSigned(r, foreign);
    if (existing) {
      existing.net = existing.net.plus(delta);
    } else {
      byEntry.set(r.entryId, {
        entryNumber: r.entryNumber,
        date: new Date(r.date),
        description: r.description,
        reference: r.reference,
        sourceRef: r.sourceRef,
        net: delta,
      });
    }
  }

  const candidates: MatchCandidate[] = [];
  for (const [entryId, e] of byEntry) {
    if (taken.has(entryId)) continue;
    if (!Money.eq(e.net, amt)) continue; // amount-equal AND sign-compatible

    const dateDiffDays = Math.round(Math.abs(e.date.getTime() - txnDate.getTime()) / DAY_MS);
    const refMatch = referenceMatches(e.reference, txn);
    const score = refMatch ? 100 : Math.max(10, 90 - dateDiffDays * 5);
    const confidence: MatchConfidence =
      refMatch || dateDiffDays <= 3 ? 'high' : dateDiffDays <= 7 ? 'medium' : 'low';

    candidates.push({
      entryId,
      entryNumber: e.entryNumber,
      date: e.date,
      description: e.description,
      reference: e.reference,
      sourceRef: e.sourceRef,
      amount: toAmountString(e.net),
      dateDiffDays,
      referenceMatch: refMatch,
      confidence,
      score,
    });
  }

  candidates.sort((a, b) => {
    if (a.referenceMatch !== b.referenceMatch) return a.referenceMatch ? -1 : 1;
    if (a.dateDiffDays !== b.dateDiffDays) return a.dateDiffDays - b.dateDiffDays;
    return b.entryNumber - a.entryNumber;
  });
  return candidates;
}

/**
 * Match a staged bank transaction to an EXISTING posted journal entry —
 * the books already have the transaction, so NO new GL entry is posted.
 * Validates that the entry hits the bank account's GL account for exactly
 * the feed line's signed amount and is not already matched elsewhere.
 */
export async function matchTransaction(
  ctx: ServiceContext,
  bankTransactionId: string,
  journalEntryId: string,
) {
  // "Entry already matched on this feed" is checked in the same transaction as the match, so two
  // feed lines matched at once cannot both clear the same register transaction.
  return inTransaction(ctx, (tx) => matchTransactionInTx(tx, bankTransactionId, journalEntryId));
}

async function matchTransactionInTx(
  ctx: ServiceContext,
  bankTransactionId: string,
  journalEntryId: string,
) {
  const txn = await loadTransaction(ctx, bankTransactionId);
  if (txn.matched) {
    throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
  }
  if (txn.excluded) {
    throw new ServiceError('CONFLICT', 'Bank transaction is excluded. Restore it first.');
  }

  const ba = await loadBankAccount(ctx, txn.bankAccountId);

  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, journalEntryId),
        eq(journalEntries.companyId, ctx.companyId),
      ),
    );
  if (!entry) throw notFound('Journal entry');
  if (entry.status !== 'posted') {
    throw validation('Only posted journal entries can be matched.');
  }

  // The entry must net to exactly the feed amount on the bank GL account (in the account's own
  // currency for a foreign-currency account — p1 fx).
  const foreign = !!(await foreignCurrencyOfAccount(ctx, ba.accountId));
  const lines = await ctx.db
    .select({
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      foreignAmount: journalEntryLines.foreignAmount,
    })
    .from(journalEntryLines)
    .where(
      and(
        eq(journalEntryLines.journalEntryId, entry.id),
        eq(journalEntryLines.accountId, ba.accountId),
      ),
    );
  if (lines.length === 0) {
    throw validation('Journal entry does not touch this bank account’s GL account.');
  }
  let net = Money.zero();
  for (const l of lines) net = net.plus(accountSigned(l, foreign));
  if (!Money.eq(net, txn.amount)) {
    throw validation(
      `Journal entry's effect on the bank account (${toAmountString(net)}) does not equal the bank transaction amount (${toAmountString(txn.amount)}).`,
    );
  }

  // One register transaction can clear each bank account's feed only once (a transfer's entry
  // may be matched once on each of its two accounts' feeds).
  const [alreadyTaken] = await ctx.db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, txn.bankAccountId),
        eq(bankTransactions.matchedEntryId, entry.id),
      ),
    )
    .limit(1);
  if (alreadyTaken) {
    throw new ServiceError(
      'CONFLICT',
      'That journal entry is already matched to another bank-feed transaction.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // matched=false guard makes this race-safe (see categorize).
    const [updated] = await tx.db
      .update(bankTransactions)
      .set({ matched: true, matchedEntryId: entry.id })
      .where(and(eq(bankTransactions.id, txn.id), eq(bankTransactions.matched, false)))
      .returning();
    if (!updated) {
      throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'bank_transaction',
      entityId: txn.id,
      oldValues: { matched: false, matchedEntryId: null },
      newValues: { matched: true, matchedEntryId: entry.id, matchType: 'matched_existing' },
    });

    return { transaction: updated, entry };
  });
}

// ---------------------------------------------------------------------------
// Exclude / restore (QB Bank Feeds "Exclude")
// ---------------------------------------------------------------------------

/**
 * Exclude a staged bank transaction from review (duplicate / personal charge).
 * Excluded rows leave the review queue but stay in the table for restore.
 */
export async function excludeTransaction(ctx: ServiceContext, bankTransactionId: string) {
  const txn = await loadTransaction(ctx, bankTransactionId);
  if (txn.matched) {
    throw new ServiceError(
      'CONFLICT',
      'Bank transaction is already matched/categorized. Unmatch it before excluding.',
    );
  }
  if (txn.excluded) {
    throw new ServiceError('CONFLICT', 'Bank transaction is already excluded.');
  }

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(bankTransactions)
      .set({ excluded: true })
      .where(and(eq(bankTransactions.id, txn.id), eq(bankTransactions.matched, false)))
      .returning();
    if (!updated) {
      throw new ServiceError('CONFLICT', 'Bank transaction is already matched/categorized.');
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'bank_transaction',
      entityId: txn.id,
      oldValues: { excluded: false },
      newValues: { excluded: true },
    });

    return updated;
  });
}

/** Restore an excluded bank transaction back into the review queue. */
export async function restoreExcluded(ctx: ServiceContext, bankTransactionId: string) {
  const txn = await loadTransaction(ctx, bankTransactionId);
  if (!txn.excluded) {
    throw new ServiceError('CONFLICT', 'Bank transaction is not excluded.');
  }

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(bankTransactions)
      .set({ excluded: false })
      .where(eq(bankTransactions.id, txn.id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'bank_transaction',
      entityId: txn.id,
      oldValues: { excluded: true },
      newValues: { excluded: false },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Matched lines follow their transaction (void / edit)
// ---------------------------------------------------------------------------

/**
 * The posted entry that replaced `entryId` when its document was edited (void + re-post): the
 * document's audit row names the old and new postedEntryId, a journal entry edit names
 * `replacedBy`. Follows a few edits in a row; null when the entry was simply voided.
 */
async function replacementEntry(ctx: ServiceContext, entryId: string): Promise<string | null> {
  let cur = entryId;
  for (let hop = 0; hop < 10; hop++) {
    const [row] = await ctx.db
      .select({ next: sql<string | null>`COALESCE(${auditLogs.newValues}->>'replacedBy', ${auditLogs.newValues}->>'postedEntryId')` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.action, 'update'),
          or(
            and(eq(auditLogs.entityType, 'journal_entry'), eq(auditLogs.entityId, cur), sql`${auditLogs.newValues}->>'replacedBy' IS NOT NULL`),
            and(
              sql`${auditLogs.oldValues}->>'postedEntryId' = ${cur}`,
              sql`${auditLogs.newValues}->>'postedEntryId' IS NOT NULL`,
              sql`${auditLogs.newValues}->>'postedEntryId' <> ${cur}`,
            ),
          ),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    const next = row?.next;
    if (!next || !/^[0-9a-f-]{36}$/i.test(next)) return null;
    const [entry] = await ctx.db
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(and(eq(journalEntries.id, next), eq(journalEntries.companyId, ctx.companyId)));
    if (!entry) return null;
    if (entry.status === 'posted') return next;
    cur = next;
  }
  return null;
}

/**
 * QB: deleting or voiding a transaction a downloaded bank line was matched to puts the line back
 * in "For Review"; editing it keeps the match. Bank-feed lines matched to an entry that has since
 * been voided used to stay "added" for good — the bank showed money the books no longer had and
 * the line never came back to review. For every such line of the account: when the transaction
 * was edited (re-posted) and its new entry still moves the feed amount on this bank account, the
 * match follows it; otherwise the line returns to review. Runs when the bank feed is opened
 * (runAutoRules). Returns how many lines were re-pointed / returned.
 */
export async function resyncFeedMatches(
  ctx: ServiceContext,
  bankAccountId?: string,
): Promise<{ repointed: number; returned: number }> {
  const out = { repointed: 0, returned: 0 };
  const stale = await ctx.db
    .select({
      id: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      amount: bankTransactions.amount,
      matchedEntryId: bankTransactions.matchedEntryId,
    })
    .from(bankTransactions)
    .innerJoin(journalEntries, eq(journalEntries.id, bankTransactions.matchedEntryId))
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.matched, true),
        ne(journalEntries.status, 'posted'),
        ...(bankAccountId ? [eq(bankTransactions.bankAccountId, bankAccountId)] : []),
      ),
    );
  for (const s of stale) {
    if (!s.matchedEntryId) continue;
    await inTransaction(ctx, async (tx) => {
      const ba = await loadBankAccount(tx, s.bankAccountId);
      const foreign = !!(await foreignCurrencyOfAccount(tx, ba.accountId));
      let next = await replacementEntry(tx, s.matchedEntryId!);
      if (next) {
        const lines = await tx.db
          .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit, foreignAmount: journalEntryLines.foreignAmount })
          .from(journalEntryLines)
          .where(and(eq(journalEntryLines.journalEntryId, next), eq(journalEntryLines.accountId, ba.accountId)));
        let net = Money.zero();
        for (const l of lines) net = net.plus(accountSigned(l, foreign));
        const [taken] = await tx.db
          .select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(
            and(
              eq(bankTransactions.companyId, tx.companyId),
              eq(bankTransactions.bankAccountId, s.bankAccountId),
              eq(bankTransactions.matchedEntryId, next),
              ne(bankTransactions.id, s.id),
            ),
          )
          .limit(1);
        if (lines.length === 0 || !Money.eq(net, s.amount) || taken) next = null;
      }
      const [updated] = await tx.db
        .update(bankTransactions)
        .set(next ? { matchedEntryId: next } : { matched: false, matchedEntryId: null })
        .where(and(eq(bankTransactions.id, s.id), eq(bankTransactions.matchedEntryId, s.matchedEntryId!)))
        .returning({ id: bankTransactions.id });
      if (!updated) return;
      await writeAudit(tx, {
        action: 'update',
        entityType: 'bank_transaction',
        entityId: s.id,
        oldValues: { matched: true, matchedEntryId: s.matchedEntryId },
        newValues: next
          ? { matched: true, matchedEntryId: next, matchType: 'followed_edit' }
          : { matched: false, matchedEntryId: null, matchType: 'returned_to_review', reason: 'matched transaction was voided' },
      });
      if (next) out.repointed += 1;
      else out.returned += 1;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unmatch (undo)
// ---------------------------------------------------------------------------

/**
 * Reverse a categorization or a match:
 *  - If the linked entry was CREATED by `categorize` (sourceRef
 *    "bank_transaction:<id>"), void it — it exists only because of the feed line.
 *  - If the feed line was MATCHED to a pre-existing entry, the entry stays
 *    posted (the books had it before the feed) — only the link is cleared.
 *  - Either way, clears matched + matchedEntryId on the bank transaction row.
 */
export async function unmatch(ctx: ServiceContext, bankTransactionId: string) {
  const txn = await loadTransaction(ctx, bankTransactionId);
  if (!txn.matched || !txn.matchedEntryId) {
    throw new ServiceError('CONFLICT', 'Bank transaction is not currently matched.');
  }

  // Was the linked entry created by categorize for THIS feed line?
  const [entry] = await ctx.db
    .select({ id: journalEntries.id, sourceRef: journalEntries.sourceRef, status: journalEntries.status })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, txn.matchedEntryId),
        eq(journalEntries.companyId, ctx.companyId),
      ),
    );
  const ownEntry = !!entry && entry.sourceRef === `bank_transaction:${txn.id}`;

  // A categorized transfer can also be matched on the other account's feed. Voiding it here would
  // leave that feed line linked to a void entry — unmatch the other line first.
  if (ownEntry) {
    const [otherLink] = await ctx.db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          eq(bankTransactions.matchedEntryId, txn.matchedEntryId),
          ne(bankTransactions.id, txn.id),
        ),
      )
      .limit(1);
    if (otherLink) {
      throw new ServiceError(
        'CONFLICT',
        'This transaction is also matched on another bank account’s feed. Undo that match first.',
      );
    }
  }

  // Void + flag-clear + audit in ONE transaction so the GL entry and the staging
  // row can never diverge. Note: voidJournalEntry throws CONFLICT if any of the
  // entry's lines were cleared in a completed bank reconciliation — undo the
  // reconciliation first.
  return inTransaction(ctx, async (tx) => {
    if (ownEntry) {
      // Categorized: void the GL entry we created (reverses balance deltas).
      await voidJournalEntry(tx, txn.matchedEntryId!);
    }
    // Matched-to-existing: leave the entry posted; just unlink below.

    // Clear the match flags.
    const [updated] = await tx.db
      .update(bankTransactions)
      .set({ matched: false, matchedEntryId: null })
      .where(eq(bankTransactions.id, txn.id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'bank_transaction',
      entityId: txn.id,
      oldValues: { matched: true, matchedEntryId: txn.matchedEntryId },
      newValues: { matched: false, matchedEntryId: null, voidedEntry: ownEntry },
    });

    return updated;
  });
}
