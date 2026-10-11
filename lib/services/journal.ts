/**
 * Manual Journal Entries + General Ledger service.
 *
 * `createManualEntry` is the public-facing wrapper around `postJournalEntry` for user-authored
 * double-entry transactions entered directly in the UI (as opposed to invoices, bills, etc. that
 * auto-post through their own service layers).
 *
 * `generalLedger` produces the per-account register view — the chronological list of every line
 * that touched an account together with a running balance. The running balance respects the
 * natural sign convention (debit-normal for asset/expense, credit-normal for liability/equity/revenue).
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { accounts, classes, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertPeriodOpen } from './fiscalPeriods';
import {
  type PostingLine,
  postJournalEntry,
  voidJournalEntry,
  balanceDelta,
} from './posting';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface ManualEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  lines: PostingLine[];
}

export interface JournalEntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  /** Class/department dimension on the line (null when untagged). */
  classId: string | null;
  /** Resolved class name via join (null when untagged). */
  className: string | null;
}

export interface JournalEntryDetail {
  id: string;
  entryNumber: number;
  date: Date;
  description: string;
  reference: string | null;
  status: string;
  /** Source-document link (e.g. "invoice:<id>", "manual") for drill-down to the origin. */
  sourceRef: string | null;
  createdAt: Date;
  /** Version for multi-user optimistic concurrency (lib/services/concurrency.ts). */
  updatedAt: Date;
  voidedAt: Date | null;
  lines: JournalEntryLine[];
}

export interface ListEntriesOptions {
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface GLRegisterRow {
  date: Date;
  entryNumber: number;
  description: string;
  reference: string | null;
  /** Source-document link of the entry (e.g. "invoice:<id>") for drill-down. */
  sourceRef: string | null;
  journalEntryId: string;
  lineId: string;
  debit: string | null;
  credit: string | null;
  /** Running natural balance of the account up through (and including) this line. */
  runningBalance: string;
}

export interface GeneralLedgerResult {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  /** False for deactivated accounts (still reported so the GL ties to the journal). */
  isActive: boolean;
  /**
   * Balance brought forward from activity before the `from` date ('0.00' when no
   * `from` filter). Running balances and closingBalance include this amount.
   */
  openingBalance: string;
  lines: GLRegisterRow[];
  /** Closing balance after all lines in the result set. */
  closingBalance: string;
}

export interface GLOptions {
  /** Restrict to a single account; if omitted, returns GL for all accounts. */
  accountId?: string;
  from?: Date;
  to?: Date;
}

// ---------------------------------------------------------------------------
// createManualEntry
// ---------------------------------------------------------------------------

/**
 * Create a user-authored manual journal entry.
 * Delegates all validation and balance-update logic to `postJournalEntry`.
 */
export async function createManualEntry(ctx: ServiceContext, input: ManualEntryInput) {
  if (!input.description?.trim()) {
    throw validation('Description is required.');
  }
  if (!input.date || isNaN(input.date.getTime())) {
    throw validation('A valid date is required.');
  }
  return postJournalEntry(ctx, {
    date: input.date,
    description: input.description.trim(),
    reference: input.reference ?? null,
    status: 'posted',
    lines: input.lines,
    sourceRef: 'manual',
  });
}

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

/** List posted + voided journal entries for this company with optional date range paging. */
export async function listEntries(ctx: ServiceContext, opts: ListEntriesOptions = {}) {
  const conds = [eq(journalEntries.companyId, ctx.companyId)];
  if (opts.from) conds.push(gte(journalEntries.date, opts.from));
  if (opts.to) conds.push(lte(journalEntries.date, opts.to));

  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  const rows = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(...conds))
    .orderBy(desc(journalEntries.date), desc(journalEntries.entryNumber))
    .limit(limit)
    .offset(offset);

  return rows;
}

// ---------------------------------------------------------------------------
// getEntry
// ---------------------------------------------------------------------------

/** Fetch a single journal entry with its lines and account names. */
export async function getEntry(ctx: ServiceContext, id: string): Promise<JournalEntryDetail> {
  // Load the entry header — scope by companyId for multi-tenant safety.
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, ctx.companyId)));

  if (!entry) throw notFound('Journal entry');

  // Load lines joined with account code/name + class name (left join — classId is optional).
  const lineRows = await ctx.db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
      classId: journalEntryLines.classId,
      className: classes.name,
    })
    .from(journalEntryLines)
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .leftJoin(classes, eq(journalEntryLines.classId, classes.id))
    .where(eq(journalEntryLines.journalEntryId, id))
    .orderBy(asc(journalEntryLines.createdAt));

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: entry.date,
    description: entry.description,
    reference: entry.reference ?? null,
    status: entry.status,
    sourceRef: entry.sourceRef ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    voidedAt: entry.voidedAt ?? null,
    lines: lineRows.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: l.accountName,
      debit: l.debit ?? null,
      credit: l.credit ?? null,
      memo: l.memo ?? null,
      classId: l.classId ?? null,
      className: l.className ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// updateEntry — QB "edit a saved journal entry"
// ---------------------------------------------------------------------------

export interface UpdateEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  lines: PostingLine[];
}

/**
 * Edit a posted journal entry: void-and-repost atomically.
 *
 * QuickBooks parity: opening a saved JE and editing lines/amounts/date. We
 * implement it as void(old) + post(new) inside ONE transaction so the GL never
 * shows a half-applied edit. The fiscal-period lock is checked on BOTH the old
 * date (we are reversing balances there) and the new date (we are posting there).
 *
 * Only user-authored entries (sourceRef null/'manual') may be edited — entries
 * posted by invoices/bills/etc. must be corrected through their source document,
 * otherwise the sub-ledger and GL would silently disagree.
 *
 * Returns the replacement entry (new id + entry number); the original remains
 * as a voided entry, and the audit log links old → new.
 */
export async function updateEntry(ctx: ServiceContext, id: string, input: UpdateEntryInput) {
  if (!input.description?.trim()) {
    throw validation('Description is required.');
  }
  if (!input.date || isNaN(input.date.getTime())) {
    throw validation('A valid date is required.');
  }

  // Load + tenant-check the existing entry (with lines, for the audit snapshot).
  const before = await getEntry(ctx, id);
  if (before.status !== 'posted') {
    throw new ServiceError('CONFLICT', 'Only posted journal entries can be edited.');
  }
  if (before.sourceRef && before.sourceRef !== 'manual') {
    throw new ServiceError(
      'CONFLICT',
      'This entry was posted by a source document. Edit the source document instead.',
    );
  }

  // Period lock on BOTH dates — the old date is where balances get reversed,
  // the new date is where they get re-posted. (postJournalEntry/voidJournalEntry
  // re-check these inside the transaction; checking up front gives a clean error
  // before any work begins.)
  await assertPeriodOpen(ctx, before.date);
  await assertPeriodOpen(ctx, input.date);

  return inTransaction(ctx, async (tx) => {
    // 1. Void the original (reverses cached balances; guards reconciled lines).
    await voidJournalEntry(tx, id);

    // 2. Re-post the edited version as a fresh manual entry.
    const replacement = await postJournalEntry(tx, {
      date: input.date,
      description: input.description.trim(),
      reference: input.reference === undefined ? before.reference : input.reference,
      status: 'posted',
      lines: input.lines,
      sourceRef: 'manual',
    });

    // 3. Audit the edit with the full old/new snapshots, linking old → new.
    await writeAudit(tx, {
      action: 'update',
      entityType: 'journal_entry',
      entityId: id,
      oldValues: {
        entryNumber: before.entryNumber,
        date: before.date,
        description: before.description,
        reference: before.reference,
        lines: before.lines,
      },
      newValues: {
        replacedBy: replacement.id,
        entryNumber: replacement.entryNumber,
        date: input.date,
        description: input.description.trim(),
        reference: replacement.reference,
        lines: input.lines,
      },
    });

    return replacement;
  });
}

// ---------------------------------------------------------------------------
// reverseEntry — QB "Reverse" button on Make General Journal Entries
// ---------------------------------------------------------------------------

/** QB default for a reversing entry: the 1st of the month after the entry date. */
export function defaultReversalDate(entryDate: Date): Date {
  return new Date(entryDate.getFullYear(), entryDate.getMonth() + 1, 1);
}

/**
 * Create a reversing journal entry: same lines with debits and credits swapped,
 * dated `asOfDate` (default: 1st of the next month after the original entry),
 * referenced 'REV of #<n>'. The original entry is untouched — this is the
 * accrual workflow (post accrual at month-end, auto-reverse next period).
 */
export async function reverseEntry(ctx: ServiceContext, id: string, asOfDate?: Date) {
  const original = await getEntry(ctx, id);
  if (original.status !== 'posted') {
    throw new ServiceError('CONFLICT', 'Only posted journal entries can be reversed.');
  }
  const date = asOfDate ?? defaultReversalDate(original.date);
  if (isNaN(date.getTime())) {
    throw validation('A valid reversal date is required.');
  }

  // Swap debits and credits, preserving memo + class on each line.
  const lines: PostingLine[] = original.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.credit ?? undefined,
    credit: l.debit ?? undefined,
    memo: l.memo,
    classId: l.classId,
  }));

  return postJournalEntry(ctx, {
    date,
    description: `Reversal of #${original.entryNumber}: ${original.description}`,
    reference: `REV of #${original.entryNumber}`,
    status: 'posted',
    lines,
    sourceRef: `reversal:${id}`,
  });
}

// ---------------------------------------------------------------------------
// voidEntry
// ---------------------------------------------------------------------------

/** Void a posted journal entry and reverse its balance impact. */
export async function voidEntry(ctx: ServiceContext, id: string) {
  // Confirm the entry belongs to this company before delegating to the engine.
  const [entry] = await ctx.db
    .select({ id: journalEntries.id, companyId: journalEntries.companyId })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, ctx.companyId)));

  if (!entry) throw notFound('Journal entry');

  return voidJournalEntry(ctx, id);
}

// ---------------------------------------------------------------------------
// generalLedger
// ---------------------------------------------------------------------------

/**
 * General Ledger register: chronological lines per account with a running balance.
 *
 * Running balance convention (matches accounting):
 *  - Asset / Expense accounts are debit-normal → balance increases on debit.
 *  - Liability / Equity / Revenue accounts are credit-normal → balance increases on credit.
 *
 * Only 'posted' entries are included (voided entries are excluded from the GL view).
 */
export async function generalLedger(
  ctx: ServiceContext,
  opts: GLOptions = {},
): Promise<GeneralLedgerResult[]> {
  // Build account filter conditions. Deactivated accounts are intentionally
  // included — their historical posted lines must keep the GL reconciling to the
  // journal and trial balance (inactive accounts with no activity are dropped below).
  const acctConds = [eq(accounts.companyId, ctx.companyId)];
  if (opts.accountId) acctConds.push(eq(accounts.id, opts.accountId));

  // Load the requested account(s).
  const acctRows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(and(...acctConds))
    .orderBy(asc(accounts.code));

  if (acctRows.length === 0 && opts.accountId) {
    throw notFound('Account');
  }

  // Build journal entry conditions — only posted entries, scoped to company + optional date range.
  const entryConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  if (opts.from) entryConds.push(gte(journalEntries.date, opts.from));
  if (opts.to) entryConds.push(lte(journalEntries.date, opts.to));

  // Pull all relevant lines in one query, joining entry header for date/entryNumber/description.
  const accountIds = acctRows.map((a) => a.id);
  if (accountIds.length === 0) return [];

  // We use a parameterised IN list. Drizzle's `inArray` needs at least 1 element.
  const { inArray } = await import('drizzle-orm');

  // When a 'from' date is set, compute each account's balance brought forward from
  // all posted activity strictly before that date so running balances start from
  // the true opening balance instead of zero.
  const openingSums = new Map<string, { debit: string; credit: string }>();
  if (opts.from) {
    const priorRows = await ctx.db
      .select({
        accountId: journalEntryLines.accountId,
        debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          inArray(journalEntryLines.accountId, accountIds),
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          lt(journalEntries.date, opts.from),
        ),
      )
      .groupBy(journalEntryLines.accountId);
    for (const r of priorRows) {
      openingSums.set(r.accountId, { debit: r.debit, credit: r.credit });
    }
  }

  const lineRows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      date: journalEntries.date,
      entryNumber: journalEntries.entryNumber,
      description: journalEntries.description,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(inArray(journalEntryLines.accountId, accountIds), ...entryConds))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber), asc(journalEntryLines.createdAt));

  // Group lines by accountId, accumulate running balance per account.
  const linesByAccount = new Map<string, typeof lineRows>();
  for (const row of lineRows) {
    const bucket = linesByAccount.get(row.accountId) ?? [];
    bucket.push(row);
    linesByAccount.set(row.accountId, bucket);
  }

  const results: GeneralLedgerResult[] = [];

  for (const acct of acctRows) {
    const acctLines = linesByAccount.get(acct.id) ?? [];

    // Opening balance from pre-`from` activity (natural sign per account type).
    const priorSums = openingSums.get(acct.id);
    const openingBalance = priorSums
      ? balanceDelta(acct.type, priorSums.debit, priorSums.credit)
      : Money.zero();

    // Keep the all-accounts report uncluttered: skip deactivated accounts that have
    // no activity in the window and nothing brought forward.
    if (!acct.isActive && acctLines.length === 0 && openingBalance.isZero()) continue;

    let runningBalance = openingBalance;
    const registerRows: GLRegisterRow[] = [];

    for (const line of acctLines) {
      // balanceDelta follows debit-normal for asset/expense, credit-normal for everything else.
      const delta = balanceDelta(acct.type, line.debit, line.credit);
      runningBalance = runningBalance.plus(delta);

      registerRows.push({
        date: line.date,
        entryNumber: line.entryNumber,
        description: line.description,
        reference: line.reference ?? null,
        sourceRef: line.sourceRef ?? null,
        journalEntryId: line.journalEntryId,
        lineId: line.lineId,
        debit: line.debit ?? null,
        credit: line.credit ?? null,
        runningBalance: toAmountString(runningBalance),
      });
    }

    results.push({
      accountId: acct.id,
      accountCode: acct.code,
      accountName: acct.name,
      accountType: acct.type,
      isActive: acct.isActive,
      openingBalance: toAmountString(openingBalance),
      lines: registerRows,
      closingBalance: toAmountString(runningBalance),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Account registers (QB-style "Use Register" view) — additive query helpers
// ---------------------------------------------------------------------------

/** Account subtypes that get a register in the registers index (bank / CC / AR / AP). */
export const REGISTER_SUBTYPES = [
  'checking',
  'savings',
  'credit_card',
  'accounts_receivable',
  'accounts_payable',
] as const;

export interface RegisterAccountSummary {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  /** Cached natural balance maintained by the posting engine. */
  balance: string;
  isActive: boolean;
}

/**
 * List the accounts that should appear on the registers index page:
 * bank (checking/savings), credit card, A/R and A/P accounts with their
 * current cached balances. Inactive accounts are excluded — a register for
 * a deactivated account is still reachable directly by id via accountRegister.
 */
export async function listRegisterAccounts(
  ctx: ServiceContext,
): Promise<RegisterAccountSummary[]> {
  const rows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      balance: accounts.balance,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        inArray(accounts.subtype, [...REGISTER_SUBTYPES]),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(asc(accounts.code));

  return rows.map((r) => ({ ...r, balance: toAmountString(r.balance) }));
}

export interface RegisterRow {
  lineId: string;
  journalEntryId: string;
  date: Date;
  entryNumber: number;
  /** Header reference (check #, invoice #, etc.) — the register "Number" column. */
  reference: string | null;
  /** Entry description — the register "Payee / Description" column. */
  description: string;
  /** Line memo. */
  memo: string | null;
  /** Source-document link (e.g. "invoice:<id>") for drill-down; null/'manual' opens the JE detail. */
  sourceRef: string | null;
  debit: string | null;
  credit: string | null;
  /** True running natural balance of the account up through this line (unaffected by search). */
  runningBalance: string;
}

export interface AccountRegisterOptions {
  from?: Date;
  to?: Date;
  /** Case-insensitive substring match on description / reference / memo. */
  search?: string;
  /** Page size; omit for all rows. */
  limit?: number;
  /** Offset into the (filtered, ascending) row set. */
  offset?: number;
}

export interface AccountRegisterResult {
  account: RegisterAccountSummary;
  /** Natural balance brought forward from posted activity before `from` ('0.00' when unfiltered). */
  openingBalance: string;
  /**
   * Natural balance after ALL posted activity in the date range (ignores search/paging),
   * i.e. the account's true balance as of `to`.
   */
  closingBalance: string;
  /** Total rows matching the date range + search, before limit/offset paging. */
  totalRows: number;
  offset: number;
  /** Ascending (oldest first → newest at bottom), QB register order. */
  rows: RegisterRow[];
}

/**
 * QB-style per-account register: chronological lines with a true running balance.
 *
 * Running balances are computed over the full date-range row set BEFORE the search
 * filter is applied, so a filtered register still shows each transaction's real
 * balance (matching QuickBooks register search behavior). Paging slices the
 * filtered, ascending row set.
 */
export async function accountRegister(
  ctx: ServiceContext,
  accountId: string,
  opts: AccountRegisterOptions = {},
): Promise<AccountRegisterResult> {
  // Load + tenant-check the account.
  const [acct] = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      balance: accounts.balance,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)));

  if (!acct) throw notFound('Account');

  // Balance brought forward from posted activity strictly before `from`.
  let opening = Money.zero();
  if (opts.from) {
    const [prior] = await ctx.db
      .select({
        debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntryLines.accountId, accountId),
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          lt(journalEntries.date, opts.from),
        ),
      );
    if (prior) opening = balanceDelta(acct.type, prior.debit, prior.credit);
  }

  // All posted lines for this account in the date range, ascending.
  const entryConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
  ];
  if (opts.from) entryConds.push(gte(journalEntries.date, opts.from));
  if (opts.to) entryConds.push(lte(journalEntries.date, opts.to));

  const lineRows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
      date: journalEntries.date,
      entryNumber: journalEntries.entryNumber,
      description: journalEntries.description,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, accountId), ...entryConds))
    .orderBy(
      asc(journalEntries.date),
      asc(journalEntries.entryNumber),
      asc(journalEntryLines.createdAt),
    );

  // Running balance over the FULL range so filtered rows keep their true balance.
  let running = opening;
  const allRows: RegisterRow[] = lineRows.map((r) => {
    running = running.plus(balanceDelta(acct.type, r.debit, r.credit));
    return {
      lineId: r.lineId,
      journalEntryId: r.journalEntryId,
      date: r.date,
      entryNumber: r.entryNumber,
      reference: r.reference ?? null,
      description: r.description,
      memo: r.memo ?? null,
      sourceRef: r.sourceRef ?? null,
      debit: r.debit ?? null,
      credit: r.credit ?? null,
      runningBalance: toAmountString(running),
    };
  });

  // Search filter (description / reference / memo, case-insensitive).
  const q = opts.search?.trim().toLowerCase();
  const filtered = q
    ? allRows.filter((r) =>
        [r.description, r.reference, r.memo].some((v) => v?.toLowerCase().includes(q)),
      )
    : allRows;

  // Paging over the filtered ascending set.
  const offset = Math.max(0, opts.offset ?? 0);
  const rows =
    opts.limit != null ? filtered.slice(offset, offset + opts.limit) : filtered.slice(offset);

  return {
    account: { ...acct, balance: toAmountString(acct.balance) },
    openingBalance: toAmountString(opening),
    closingBalance: toAmountString(running),
    totalRows: filtered.length,
    offset,
    rows,
  };
}
