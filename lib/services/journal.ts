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
import {
  accounts,
  classes,
  customers,
  employees,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  otherNames,
  vendors,
  invoices,
  bills,
  depreciationEntries,
  fixedAssets,
} from '@/lib/db/schema';
import { REGISTER_SUBTYPES as REGISTER_SUBTYPE_LIST } from '@/lib/accountTypes';
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
import { assertAccountantMayVoidEntry } from './accountantCopy/guard';
import { balanceFixes, balanceSummary } from '@/lib/errorFixes';
import { getPreferences } from './company';
import { nextJournalNumber } from '@/lib/prefBehaviors';
import { isJournalScreenEntry } from '@/lib/journalScreen';
import {
  type JournalEntityType,
  type PostingLine,
  postJournalEntry,
  voidJournalEntry,
  balanceDelta,
  generalJournalSourceSql,
} from './posting';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface ManualEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  lines: PostingLine[];
  /** QB "Adjusting Entry" checkbox. */
  isAdjusting?: boolean;
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
  /** QB "Name" column: customer / vendor / employee / other (null when blank). */
  entityType: JournalEntityType | null;
  entityId: string | null;
  /** Display name of the customer / vendor / employee (null when blank or not found). */
  entityName: string | null;
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
  /** QB "Adjusting Entry" flag. */
  isAdjusting: boolean;
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
/**
 * Preferences > Accounting "Automatically assign general journal entry numbers": a manual entry
 * saved without an Entry No. gets the next number after the highest one used (any caller: the
 * journal page, the API, memorized entries). Off: the entry is saved without a number.
 */
async function autoJournalNumber(ctx: ServiceContext): Promise<string | null> {
  if (!(await getPreferences(ctx)).autoAssignJeNumbers) return null;
  const rows = await ctx.db
    .select({ reference: journalEntries.reference })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, 'manual')));
  return nextJournalNumber(rows.map((r) => r.reference));
}

/**
 * Fix errors where they happen: an out-of-balance entry gets a plain message ("Debits are $40.00
 * more than credits.") and fixes that add the difference to a line (lib/errorFixes.ts). Manual
 * entry lines map 1:1 onto the request body's `lines`, so the patch paths match what the form sent.
 */
async function withBalanceFixes<T>(lines: ManualEntryInput['lines'], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'UNBALANCED' && !err.fixes) {
      const summary = balanceSummary(lines ?? []);
      if (summary.message) {
        err.message = `${summary.message} An entry must have equal debits and credits.`;
        err.details = { ...(err.details as object | undefined), difference: summary.difference };
      }
      err.withFixes(balanceFixes(lines ?? []));
    }
    throw err;
  }
}

export async function createManualEntry(
  ctx: ServiceContext,
  input: ManualEntryInput,
) {
  return withBalanceFixes(input.lines, () => createManualEntryInner(ctx, input));
}

async function createManualEntryInner(
  ctx: ServiceContext,
  input: ManualEntryInput,
) {
  if (!input.description?.trim()) {
    throw validation('Description is required.');
  }
  if (!input.date || isNaN(input.date.getTime())) {
    throw validation('A valid date is required.');
  }
  await assertJournalNames(ctx, input.lines);
  return postJournalEntry(ctx, {
    date: input.date,
    description: input.description.trim(),
    reference: input.reference?.trim() || (await autoJournalNumber(ctx)),
    status: 'posted',
    lines: input.lines,
    sourceRef: 'manual',
    isAdjusting: input.isAdjusting ?? false,
  });
}

// ---------------------------------------------------------------------------
// Names on journal lines (QB "Name" column) + the A/R / A/P name rule
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve display names for (entityType, entityId) pairs. Missing ids are simply absent. */
export async function resolveEntityNames(
  ctx: ServiceContext,
  refs: Array<{ entityType: string | null; entityId: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (t: string) => [
    ...new Set(
      refs
        .filter((r) => r.entityType === t && r.entityId && UUID_RE.test(r.entityId))
        .map((r) => r.entityId!),
    ),
  ];
  const cust = ids('customer');
  const vend = ids('vendor');
  const emp = ids('employee');
  const other = ids('other');
  if (cust.length) {
    const rows = await ctx.db
      .select({ id: customers.id, name: customers.displayName })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, cust)));
    for (const r of rows) out.set(`customer:${r.id}`, r.name);
  }
  if (vend.length) {
    const rows = await ctx.db
      .select({ id: vendors.id, name: vendors.displayName })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), inArray(vendors.id, vend)));
    for (const r of rows) out.set(`vendor:${r.id}`, r.name);
  }
  if (emp.length) {
    const rows = await ctx.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, ctx.companyId), inArray(employees.id, emp)));
    for (const r of rows) out.set(`employee:${r.id}`, `${r.first} ${r.last}`.trim());
  }
  if (other.length) {
    // B3: the QB "Other Names" list (lib/services/lists/simpleLists.ts).
    const rows = await ctx.db
      .select({ id: otherNames.id, name: otherNames.name })
      .from(otherNames)
      .where(and(eq(otherNames.companyId, ctx.companyId), inArray(otherNames.id, other)));
    for (const r of rows) out.set(`other:${r.id}`, r.name);
  }
  return out;
}

/**
 * QuickBooks rule for manual journal entries: every line that hits an Accounts Receivable
 * account must name a customer, and every line that hits an Accounts Payable account must name
 * a vendor — otherwise the amount could never appear in that customer's / vendor's balance or
 * aging. Names on other lines are optional but must exist in this company.
 */
/**
 * Ids (as `type:id` keys) of named customers / vendors / employees that are inactive. Merged-away
 * names are inactive too (merge.ts deactivates the record it folds away).
 */
async function inactiveNames(
  ctx: ServiceContext,
  refs: Array<{ entityType: string | null; entityId: string | null }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = (t: string) => [
    ...new Set(
      refs.filter((r) => r.entityType === t && r.entityId && UUID_RE.test(r.entityId)).map((r) => r.entityId!),
    ),
  ];
  const cust = ids('customer');
  const vend = ids('vendor');
  const emp = ids('employee');
  const other = ids('other');
  if (other.length) {
    const rows = await ctx.db
      .select({ id: otherNames.id })
      .from(otherNames)
      .where(and(eq(otherNames.companyId, ctx.companyId), inArray(otherNames.id, other), eq(otherNames.isActive, false)));
    for (const r of rows) out.add(`other:${r.id}`);
  }
  if (cust.length) {
    const rows = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, cust), eq(customers.isActive, false)));
    for (const r of rows) out.add(`customer:${r.id}`);
  }
  if (vend.length) {
    const rows = await ctx.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), inArray(vendors.id, vend), eq(vendors.isActive, false)));
    for (const r of rows) out.add(`vendor:${r.id}`);
  }
  if (emp.length) {
    const rows = await ctx.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, ctx.companyId), inArray(employees.id, emp), eq(employees.isActive, false)));
    for (const r of rows) out.add(`employee:${r.id}`);
  }
  return out;
}

/**
 * Follow customer / vendor merges: a name that was merged away (merge.ts records
 * `mergedInto` in the audit log when it deactivates the duplicate) is replaced by the record
 * that was kept, following chains of merges. Names that were not merged are returned as is.
 * Used where a stored draft (e.g. an AI proposal) is posted later, after the list may have
 * changed.
 */
export async function followMergedNames<L extends { entityType?: string | null; entityId?: string | null }>(
  ctx: ServiceContext,
  lines: L[],
): Promise<L[]> {
  const inactive = await inactiveNames(
    ctx,
    lines.map((l) => ({ entityType: l.entityType ?? null, entityId: l.entityId ?? null })),
  );
  if (inactive.size === 0) return lines;
  const target = new Map<string, string>();
  for (const key of inactive) {
    const [type, startId] = key.split(':');
    if (type !== 'customer' && type !== 'vendor' && type !== 'other') continue;
    // Other Names merges are audited as 'other_name' (lib/services/lists/mergeLists.ts).
    const auditType = type === 'other' ? 'other_name' : type;
    let cur = startId;
    const seen = new Set<string>([cur]);
    for (let hop = 0; hop < 10; hop++) {
      const res = await ctx.db.execute(
        sql`SELECT new_values->>'mergedInto' AS to_id FROM audit_logs
            WHERE company_id = ${ctx.companyId} AND entity_type = ${auditType} AND entity_id = ${cur}
              AND new_values->>'mergedInto' IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
      );
      const toId = (res.rows[0] as { to_id?: string } | undefined)?.to_id;
      if (!toId || !UUID_RE.test(toId) || seen.has(toId)) break;
      seen.add(toId);
      cur = toId;
      if (!(await inactiveNames(ctx, [{ entityType: type, entityId: cur }])).size) {
        target.set(key, cur);
        break;
      }
    }
  }
  return lines.map((l) => {
    const to = l.entityType && l.entityId ? target.get(`${l.entityType}:${l.entityId}`) : undefined;
    return to ? { ...l, entityId: to } : l;
  });
}

export async function assertJournalNames(
  ctx: ServiceContext,
  lines: PostingLine[],
  opts: { allowInactive?: Set<string> } = {},
): Promise<void> {
  const accountIds = [...new Set(lines.map((l) => l.accountId).filter(Boolean))];
  if (accountIds.length === 0) return;
  const acctRows = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, accountIds)));
  const byId = new Map(acctRows.map((a) => [a.id, a]));
  const names = await resolveEntityNames(
    ctx,
    lines.map((l) => ({ entityType: l.entityType ?? null, entityId: l.entityId ?? null })),
  );
  const inactive = await inactiveNames(
    ctx,
    lines.map((l) => ({ entityType: l.entityType ?? null, entityId: l.entityId ?? null })),
  );
  for (const [i, l] of lines.entries()) {
    const acct = byId.get(l.accountId);
    if (!acct) continue; // postJournalEntry reports unknown accounts
    if (Boolean(l.entityType) !== Boolean(l.entityId)) {
      throw validation(`Line ${i + 1}: pick a name from the list (or leave it blank).`);
    }
    if (l.entityType && l.entityId && !names.has(`${l.entityType}:${l.entityId}`)) {
      if (l.entityType === 'other') {
        throw validation(
          `Line ${i + 1}: that name was not found in the Other Names list. Pick a customer, vendor or employee, or add the name first.`,
        );
      }
      throw validation(`Line ${i + 1}: that ${l.entityType} was not found.`);
    }
    if (l.entityType && l.entityId) {
      const key = `${l.entityType}:${l.entityId}`;
      if (inactive.has(key) && !opts.allowInactive?.has(key)) {
        throw validation(
          `Line ${i + 1}: "${names.get(key)}" is inactive (or was merged into another ${l.entityType === 'other' ? 'name' : l.entityType}). Pick an active name, or make this one active again first.`,
        );
      }
    }
    if (acct.type === 'asset' && acct.subtype === 'accounts_receivable' && l.entityType !== 'customer') {
      throw validation(
        `Line ${i + 1}: "${acct.name}" is an Accounts Receivable account, so the line needs a customer in the Name column.`,
      );
    }
    if (acct.type === 'liability' && acct.subtype === 'accounts_payable' && l.entityType !== 'vendor') {
      throw validation(
        `Line ${i + 1}: "${acct.name}" is an Accounts Payable account, so the line needs a vendor in the Name column.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// listEntries
// ---------------------------------------------------------------------------

/** List posted + voided journal entries for this company with optional date range paging. */
/**
 * Inclusive "to" date filter for ledger dates: the WHOLE UTC calendar day of `to`. Ledger dates are
 * calendar days at UTC midnight, but some entries carry a time of day (the year-end closing entry
 * at 23:59:59Z, opening balances dated "now"), and a date-only `to` ('2024-12-31' = midnight)
 * would leave those out of their own day.
 */
export function onOrBeforeDay(to: Date) {
  const nextDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
  return lt(journalEntries.date, nextDay);
}

export async function listEntries(ctx: ServiceContext, opts: ListEntriesOptions = {}) {
  const conds = [eq(journalEntries.companyId, ctx.companyId)];
  if (opts.from) conds.push(gte(journalEntries.date, opts.from));
  if (opts.to) conds.push(onOrBeforeDay(opts.to));

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
      entityType: journalEntryLines.entityType,
      entityId: journalEntryLines.entityId,
    })
    .from(journalEntryLines)
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .leftJoin(classes, eq(journalEntryLines.classId, classes.id))
    .where(eq(journalEntryLines.journalEntryId, id))
    .orderBy(asc(journalEntryLines.createdAt));
  const entityNames = await resolveEntityNames(ctx, lineRows);

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    date: entry.date,
    description: entry.description,
    reference: entry.reference ?? null,
    status: entry.status,
    sourceRef: entry.sourceRef ?? null,
    isAdjusting: entry.isAdjusting ?? false,
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
      entityType: (l.entityType as JournalEntityType | null) ?? null,
      entityId: l.entityId ?? null,
      entityName: l.entityType && l.entityId ? (entityNames.get(`${l.entityType}:${l.entityId}`) ?? null) : null,
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
  /** Omitted = keep the original entry's flag. */
  isAdjusting?: boolean;
}

/**
 * Refuse to void / edit a journal entry whose A/R or A/P lines were paid or applied (QB asks you
 * to remove the payments / credits first). The DB trigger (0037) enforces the same rule for every
 * other path that voids an entry.
 */
export async function assertNoJournalApplications(
  ctx: ServiceContext,
  journalEntryId: string,
  verb: 'voided' | 'edited',
): Promise<void> {
  const [row] = await ctx.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(journalItemApplications)
    .where(
      and(
        eq(journalItemApplications.companyId, ctx.companyId),
        eq(journalItemApplications.journalEntryId, journalEntryId),
      ),
    );
  if (Number(row?.n ?? 0) > 0) {
    throw new ServiceError(
      'CONFLICT',
      `This journal entry can't be ${verb} because payments or credits were applied to its customer or vendor lines. ` +
        'Remove those in Receive Payments or Pay Bills first.',
    );
  }
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
  return withBalanceFixes(input.lines, () => updateEntryInner(ctx, id, input));
}

async function updateEntryInner(ctx: ServiceContext, id: string, input: UpdateEntryInput) {
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
  await assertNoJournalApplications(ctx, id, 'edited');

  // Period lock on BOTH dates — the old date is where balances get reversed,
  // the new date is where they get re-posted. (postJournalEntry/voidJournalEntry
  // re-check these inside the transaction; checking up front gives a clean error
  // before any work begins.)
  await assertPeriodOpen(ctx, before.date, { movable: false });
  await assertPeriodOpen(ctx, input.date);
  // Names already on the entry may stay even if they were made inactive since (QB lets you
  // edit an old entry without re-picking its names); new names must be active.
  await assertJournalNames(ctx, input.lines, {
    allowInactive: new Set(
      before.lines.filter((l) => l.entityType && l.entityId).map((l) => `${l.entityType}:${l.entityId}`),
    ),
  });
  const isAdjusting = input.isAdjusting ?? before.isAdjusting;

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
      isAdjusting,
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

/**
 * QB default for a reversing entry: the 1st of the month after the entry date. Ledger dates are
 * calendar days stored at UTC midnight, so UTC getters are used (local getters put the reversal
 * of an entry dated the 1st on that same day in timezones behind UTC).
 */
export function defaultReversalDate(entryDate: Date): Date {
  return new Date(Date.UTC(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1, 1));
}

/** Refuse to void / reverse a document-posted entry from the journal screen (lib/journalScreen.ts). */
function assertJournalScreenEntry(sourceRef: string | null | undefined, op: 'void' | 'reverse'): void {
  if (isJournalScreenEntry(sourceRef, op)) return;
  throw new ServiceError(
    'CONFLICT',
    op === 'void'
      ? 'This entry was posted by a source document. Void the source document instead.'
      : 'This entry was posted by a source document, so it can’t be reversed here. Void or edit the source document instead.',
  );
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
  assertJournalScreenEntry(original.sourceRef, 'reverse');
  const date = asOfDate ?? defaultReversalDate(original.date);
  if (isNaN(date.getTime())) {
    throw validation('A valid reversal date is required.');
  }

  // p1 fx: carry each line's foreign amount so the reversal takes the same foreign amount back
  // out (not a list-rate conversion of the home amount). The side flips with debit/credit.
  const fxRows = await ctx.db
    .select({ id: journalEntryLines.id, currency: journalEntryLines.currency, foreignAmount: journalEntryLines.foreignAmount })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, id));
  const fxById = new Map(fxRows.map((r) => [r.id, r]));
  const fxCurrencies = new Set(fxRows.filter((r) => r.foreignAmount != null && r.currency).map((r) => r.currency!));

  // Swap debits and credits, preserving memo + class on each line.
  const lines: PostingLine[] = original.lines.map((l) => {
    const fx = fxById.get(l.id);
    return {
      accountId: l.accountId,
      debit: l.credit ?? undefined,
      credit: l.debit ?? undefined,
      memo: l.memo,
      classId: l.classId,
      entityType: l.entityType,
      entityId: l.entityId,
      ...(fx?.foreignAmount != null ? { foreignAmount: fx.foreignAmount } : {}),
    };
  });

  return postJournalEntry(ctx, {
    date,
    description: `Reversal of #${original.entryNumber}: ${original.description}`,
    reference: `REV of #${original.entryNumber}`,
    status: 'posted',
    lines,
    sourceRef: `reversal:${id}`,
    isAdjusting: original.isAdjusting,
    ...(fxCurrencies.size === 1 ? { currency: [...fxCurrencies][0] } : {}),
  });
}

// ---------------------------------------------------------------------------
// voidEntry
// ---------------------------------------------------------------------------

/** Void a posted journal entry and reverse its balance impact. */
export async function voidEntry(ctx: ServiceContext, id: string) {
  // Confirm the entry belongs to this company before delegating to the engine.
  const [entry] = await ctx.db
    .select({ id: journalEntries.id, companyId: journalEntries.companyId, sourceRef: journalEntries.sourceRef })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, ctx.companyId)));

  if (!entry) throw notFound('Journal entry');
  await assertAccountantMayVoidEntry(ctx, entry.sourceRef); // Accountant's Copy (I1): only GJ voids travel
  assertJournalScreenEntry(entry.sourceRef, 'void'); // documents are voided through the document
  await assertNoJournalApplications(ctx, id, 'voided');

  if (entry.sourceRef?.startsWith('fixed_asset:')) {
    return inTransaction(ctx, async (tx) => {
      const voided = await voidJournalEntry(tx, id);
      await removeDepreciationForEntry(tx, id);
      return voided;
    });
  }
  return voidJournalEntry(ctx, id);
}

/**
 * A voided depreciation entry (sourceRef `fixed_asset:<assetId>`, fixedAssets.ts postDepreciation)
 * takes its period off the asset: the depreciation_entries row is removed (so the period can be
 * posted again) and the asset's accumulated depreciation drops by its amount, keeping the schedule,
 * the asset and the Accumulated Depreciation account in agreement. Inside the void's transaction.
 */
async function removeDepreciationForEntry(tx: ServiceContext, entryId: string): Promise<void> {
  const rows = await tx.db
    .select({ id: depreciationEntries.id, assetId: depreciationEntries.fixedAssetId, amount: depreciationEntries.amount })
    .from(depreciationEntries)
    .where(and(eq(depreciationEntries.companyId, tx.companyId), eq(depreciationEntries.postedEntryId, entryId)));
  for (const r of rows) {
    const [asset] = await tx.db
      .select({ accumulated: fixedAssets.accumulatedDepreciation })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, r.assetId), eq(fixedAssets.companyId, tx.companyId)));
    await tx.db.delete(depreciationEntries).where(eq(depreciationEntries.id, r.id));
    if (!asset) continue;
    const before = Money.of(asset.accumulated);
    const after = Money.round2(before.minus(Money.of(r.amount)));
    const next = toAmountString(after.isNegative() ? Money.zero() : after);
    await tx.db.update(fixedAssets).set({ accumulatedDepreciation: next }).where(eq(fixedAssets.id, r.assetId));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'fixed_asset',
      entityId: r.assetId,
      oldValues: { accumulatedDepreciation: toAmountString(before) },
      newValues: { accumulatedDepreciation: next, depreciationVoided: r.id, journalEntryId: entryId },
    });
  }
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
  if (opts.to) entryConds.push(onOrBeforeDay(opts.to));

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

/**
 * Account subtypes that get a register in the registers index: bank, credit card, A/R, A/P,
 * plus the other balance-sheet types QuickBooks gives registers (other current asset incl.
 * Undeposited Funds, other asset, fixed asset, other current / long-term liability). The
 * shared list lives in lib/accountTypes.ts.
 */
export const REGISTER_SUBTYPES = REGISTER_SUBTYPE_LIST;

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
  if (opts.to) entryConds.push(onOrBeforeDay(opts.to));

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

// ---------------------------------------------------------------------------
// Adjusting Journal Entries report data (QB Accountant > Adjusting Journal Entries)
// ---------------------------------------------------------------------------

export interface AdjustingEntriesOptions {
  from?: Date;
  to?: Date;
  /** Include voided adjusting entries (default false — QB shows posted only). */
  includeVoid?: boolean;
}

export interface AdjustingEntriesReport {
  from: string | null;
  to: string | null;
  entries: JournalEntryDetail[];
  totalDebit: string;
  totalCredit: string;
}

/**
 * Every journal entry flagged "Adjusting Entry" in the date range, with its lines (account,
 * name, memo, class). Totals are over the included entries; debits always equal credits.
 */
export async function getAdjustingEntries(
  ctx: ServiceContext,
  opts: AdjustingEntriesOptions = {},
): Promise<AdjustingEntriesReport> {
  const conds = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.isAdjusting, true)];
  conds.push(
    opts.includeVoid
      ? inArray(journalEntries.status, ['posted', 'void'])
      : eq(journalEntries.status, 'posted'),
  );
  if (opts.from) conds.push(gte(journalEntries.date, opts.from));
  if (opts.to) conds.push(onOrBeforeDay(opts.to));
  const heads = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(...conds))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber));
  const entries: JournalEntryDetail[] = [];
  let debit = Money.zero();
  let credit = Money.zero();
  for (const h of heads) {
    const e = await getEntry(ctx, h.id);
    entries.push(e);
    if (e.status !== 'posted') continue;
    for (const l of e.lines) {
      debit = debit.plus(Money.of(l.debit));
      credit = credit.plus(Money.of(l.credit));
    }
  }
  return {
    from: opts.from ? opts.from.toISOString() : null,
    to: opts.to ? opts.to.toISOString() : null,
    entries,
    totalDebit: toAmountString(debit),
    totalCredit: toAmountString(credit),
  };
}

// ---------------------------------------------------------------------------
// Named A/R / A/P journal lines as customer / vendor open items
// ---------------------------------------------------------------------------

export interface JournalOpenItem {
  journalEntryId: string;
  lineId: string;
  entryNumber: number;
  date: Date;
  reference: string | null;
  description: string;
  memo: string | null;
  accountId: string;
  entityType: 'customer' | 'vendor';
  entityId: string;
  /**
   * Signed amount still OPEN (or the full line amount with `gross: true`): for A/R a debit is
   * +(customer owes you more), a credit is −; for A/P a credit is +(you owe the vendor more), a
   * debit is −. Applications (payments, bill payments, credits applied to invoices / bills — see
   * journalApplications.ts) reduce it toward zero.
   */
  amount: string;
  /** Signed full amount of the line (before applications). */
  original: string;
  /** Total applied to the line (positive), as of `asOf` when given. */
  applied: string;
}

/**
 * The day an application takes effect: its own date, but never before the invoice / bill it was
 * applied to. The invoice / bill date can move later after the credit was applied (editing an
 * invoice re-dates it); until that day the invoice is not in aging, so the General Journal credit
 * must not count as applied either — otherwise as-of aging drifts from the control account.
 * Postgres GREATEST ignores NULLs, so cash applications (no invoice / bill) keep their own date.
 * Callers must LEFT JOIN invoices and bills on the application's invoice_id / bill_id.
 */
function effectiveApplicationDate() {
  return sql`GREATEST(${journalItemApplications.date}, ${invoices.date}, ${bills.date})`;
}

/**
 * Applied amount per General Journal line (journal_item_applications), as of `asOf` when given.
 * Every application is dated: cash applications ('payment', 'bill_payment') with their payment,
 * credit applications ('invoice_credit', 'bill_credit') on the day the credit was applied — never
 * before the entry or the invoice / bill (journalApplications.ts). Only applications dated on or
 * before `asOf` count; aging adds the later ones back to the invoice / bill they reduced
 * (journalCreditsAppliedAfter), so both sides of an application move on the same day.
 */
export async function journalAppliedByLine(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  opts: { asOf?: Date; lineIds?: string[] } = {},
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const conds = [eq(journalItemApplications.companyId, ctx.companyId), eq(journalItemApplications.side, side)];
  if (opts.asOf) {
    conds.push(sql`${effectiveApplicationDate()} <= ${opts.asOf}`);
  }
  if (opts.lineIds) {
    if (opts.lineIds.length === 0) return new Map();
    conds.push(inArray(journalItemApplications.journalLineId, opts.lineIds));
  }
  const rows = await ctx.db
    .select({
      lineId: journalItemApplications.journalLineId,
      applied: sql<string>`COALESCE(SUM(CAST(${journalItemApplications.amount} AS NUMERIC)), 0)`,
    })
    .from(journalItemApplications)
    .leftJoin(invoices, eq(invoices.id, journalItemApplications.invoiceId))
    .leftJoin(bills, eq(bills.id, journalItemApplications.billId))
    .where(and(...conds))
    .groupBy(journalItemApplications.journalLineId);
  return new Map(rows.map((r) => [r.lineId, Money.of(r.applied)]));
}

/**
 * General Journal credits applied to invoices ('ar') or bills ('ap') AFTER `cutoff`, per invoice /
 * bill id. Invoices and bills carry the credit undated (amountPaid / amountCredited), so as-of
 * aging adds these back: on the cutoff date the credit had not been applied yet, and the General
 * Journal line still shows its full amount (journalAppliedByLine), which keeps aging tied to the
 * A/R / A/P control account on every date.
 */
export async function journalCreditsAppliedAfter(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  cutoff: Date,
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const docCol = side === 'ar' ? journalItemApplications.invoiceId : journalItemApplications.billId;
  const rows = await ctx.db
    .select({
      docId: docCol,
      applied: sql<string>`COALESCE(SUM(CAST(${journalItemApplications.amount} AS NUMERIC)), 0)`,
    })
    .from(journalItemApplications)
    .leftJoin(invoices, eq(invoices.id, journalItemApplications.invoiceId))
    .leftJoin(bills, eq(bills.id, journalItemApplications.billId))
    .where(
      and(
        eq(journalItemApplications.companyId, ctx.companyId),
        eq(journalItemApplications.kind, side === 'ar' ? 'invoice_credit' : 'bill_credit'),
        sql`${effectiveApplicationDate()} > ${cutoff}`,
      ),
    )
    .groupBy(docCol);
  const out = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of rows) if (r.docId) out.set(r.docId, Money.of(r.applied));
  return out;
}

/**
 * Manual ("General Journal") lines on A/R accounts that name a customer, or on A/P accounts that
 * name a vendor. QuickBooks treats each as an open item of that customer / vendor, dated (and
 * due) on the entry date: they belong in the customer / vendor balance, aging and statements.
 * Only manual entries and their reversals are included — document postings (invoices, bills,
 * payments) are already represented by their own documents.
 *
 * By default each item carries its OPEN amount (line amount minus what payments / credits have
 * applied to it) and fully applied lines are left out — that is what aging, customer / vendor
 * balances and the A/R control check need. `gross: true` returns every line at its full amount
 * (statements list activity, and count the payments that paid these lines in full too).
 */
export async function journalOpenItems(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  opts: { asOf?: Date; entityId?: string; gross?: boolean } = {},
): Promise<JournalOpenItem[]> {
  const entityType = side === 'ar' ? 'customer' : 'vendor';
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    // Manual journal entries, reversals, checks, deposits, bank-feed lines, ... — anything that is
    // not a customer/vendor document (those are counted by their own document).
    generalJournalSourceSql(),
    eq(accounts.subtype, side === 'ar' ? 'accounts_receivable' : 'accounts_payable'),
    eq(accounts.type, side === 'ar' ? 'asset' : 'liability'),
    eq(journalEntryLines.entityType, entityType),
  ];
  // Whole as-of day (the trial balance / aging bound): the last instant of asOf's UTC day, used for
  // both the lines and their applications so they stay consistent.
  const asOf = opts.asOf
    ? new Date(Date.UTC(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), opts.asOf.getUTCDate() + 1) - 1)
    : undefined;
  if (asOf) conds.push(lte(journalEntries.date, asOf));
  if (opts.entityId) conds.push(eq(journalEntryLines.entityId, opts.entityId));
  const rows = await ctx.db
    .select({
      journalEntryId: journalEntries.id,
      lineId: journalEntryLines.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      reference: journalEntries.reference,
      description: journalEntries.description,
      memo: journalEntryLines.memo,
      accountId: journalEntryLines.accountId,
      entityId: journalEntryLines.entityId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(asc(journalEntries.date), asc(journalEntries.entryNumber));
  const named = rows.filter((r) => r.entityId);
  const appliedByLine = await journalAppliedByLine(ctx, side, {
    asOf,
    lineIds: opts.entityId ? named.map((r) => r.lineId) : undefined,
  });
  const out: JournalOpenItem[] = [];
  for (const r of named) {
    const dr = Money.of(r.debit);
    const cr = Money.of(r.credit);
    const original = side === 'ar' ? dr.minus(cr) : cr.minus(dr);
    const applied = appliedByLine.get(r.lineId) ?? Money.zero();
    // Applications move the line toward zero, never past it (the services refuse over-application).
    const left = original.abs().minus(applied);
    const openAbs = left.isNegative() ? Money.zero() : left;
    const open = original.isNegative() ? openAbs.negated() : openAbs;
    if (!opts.gross && open.isZero()) continue;
    out.push({
      journalEntryId: r.journalEntryId,
      lineId: r.lineId,
      entryNumber: r.entryNumber,
      date: r.date,
      reference: r.reference ?? null,
      description: r.description,
      memo: r.memo ?? null,
      accountId: r.accountId,
      entityType,
      entityId: r.entityId!,
      amount: toAmountString(opts.gross ? original : open),
      original: toAmountString(original),
      applied: toAmountString(applied),
    });
  }
  return out;
}

/** Net General Journal balance per customer (ar) / vendor (ap): entityId → signed amount. */
export async function journalBalancesByEntity(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  opts: { asOf?: Date } = {},
): Promise<Map<string, string>> {
  const items = await journalOpenItems(ctx, side, opts);
  const sums = new Map<string, ReturnType<typeof Money.zero>>();
  for (const it of items) sums.set(it.entityId, (sums.get(it.entityId) ?? Money.zero()).plus(Money.of(it.amount)));
  return new Map([...sums].map(([k, v]) => [k, toAmountString(v)]));
}
