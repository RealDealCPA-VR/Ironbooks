/**
 * Condense / Archive utility (QB Desktop "Condense Data" parity).
 *
 * `condensePeriod(ctx, { beforeDate })` replaces detailed journal entries dated
 * BEFORE the cutoff with ONE summary journal entry per month, whose lines carry
 * the exact gross debit/credit totals per (account, class). This preserves:
 *   - every account's balance trajectory (monthly trial balances are identical),
 *   - gross debit/credit column totals,
 *   - class (department) totals,
 *   - the cached `accounts.balance` values (net GL change is exactly zero).
 *
 * What is removed (IRREVERSIBLY, except via the archive backup written first):
 *   - the detailed journal entries + lines before the cutoff,
 *   - voided entries before the cutoff,
 *   - reconciliation detail items of COMPLETED reconciliations that pointed at
 *     removed lines (the reconciliation summary rows + last-reconciled balance stay),
 *   - matched bank-feed staging rows linked to removed entries,
 *   - GL drill-down links (postedEntryId) on old CLOSED documents — the document
 *     rows themselves are always kept.
 *
 * What is kept intact:
 *   - entries backing documents that still carry an open balance (open/partial
 *     invoices & bills, unapplied credits/payments, un-billed item receipts),
 *   - General Journal entries whose named A/R or A/P lines are still open, and those applied
 *     (journal_item_applications) to a document that is kept — deleting them would also delete
 *     the applications (ON DELETE CASCADE), so aging and customer/vendor balances would stop
 *     tying to A/R and A/P. Applications are only removed when both sides are condensed,
 *   - entries with lines referenced by an in-progress ("current session")
 *     reconciliation,
 *   - draft entries (never posted — nothing to summarize),
 *   - every list (customers, vendors, items, …) and every document row.
 *
 * Safety: requires the condensed range to be CLOSED (closed fiscal periods or
 * the company closing date), and writes BOTH a rotating pre-op backup and a
 * permanent archive .bka snapshot before touching a single row.
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  bankTransactions,
  billPayments,
  bills,
  companies,
  creditMemos,
  deposits,
  depreciationEntries,
  errorDetections,
  expenseReports,
  expenses,
  fiscalPeriods,
  invoices,
  itemReceipts,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  paychecks,
  paymentsReceived,
  reconciliationItems,
  reconciliations,
  salesReceipts,
  transfers,
  vendorCredits,
} from '@/lib/db/schema';
import { resolveDataDir } from '@/lib/db';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  validation,
  writeAudit,
} from './_base';
import { allowLedgerRewrite } from './posting';
import { assertWrite } from './rbac';
import { BACKUP_MANIFEST_ENTRY, FILE_LOCAL_FILES, createBackup, ensurePreOpBackup, restoreBackup } from './backup';
import { recordBackup } from './backupHistory';
import { currentFingerprint } from './backupFingerprint';
import { logTransaction } from './transactionLog';
import { journalOpenItems } from './journal';
import { activeCopy } from './accountantCopy/guard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CondenseInput {
  /** Entries strictly BEFORE this date are condensed. */
  beforeDate: Date;
  /** When true, only compute and return the preview — nothing is modified. */
  dryRun?: boolean;
  /**
   * Data-dir override for the archive/pre-op snapshots (tests / multi-dir
   * setups). Defaults to the active company data dir.
   */
  dataDir?: string;
}

export interface CondensePreview {
  /** ISO date (yyyy-mm-dd) of the cutoff. */
  beforeDate: string;
  /** Months ('YYYY-MM') that will receive a summary entry. */
  months: string[];
  /** Posted detail entries that will be deleted and rolled into summaries. */
  entriesToCondense: number;
  /** Their journal lines (deleted). */
  linesToCondense: number;
  /** Voided entries before the cutoff that will simply be deleted. */
  voidEntriesToDelete: number;
  /** Summary entries/lines that will be created (one entry per month). */
  summaryEntriesToCreate: number;
  summaryLinesToCreate: number;
  /** Entries kept because their source document still has an open balance. */
  keptOpenDocumentEntries: number;
  /** Entries kept because an in-progress reconciliation references their lines. */
  keptInProgressReconciliationEntries: number;
  /** Completed-reconciliation detail rows that will be deleted. */
  reconciliationItemsToDelete: number;
  /** Matched bank-feed staging rows that will be deleted. */
  bankFeedRowsToDelete: number;
  /** Draft entries before the cutoff (left untouched). */
  draftEntriesSkipped: number;
}

export interface CondenseResult extends CondensePreview {
  dryRun: boolean;
  /** Path of the permanent archive .bka written before condensing (null on dry run). */
  archivePath: string | null;
  /** Id of the condense run (also the audit-log entityId). Null on dry run. */
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Internal plan
// ---------------------------------------------------------------------------

interface SummaryLine {
  accountId: string;
  classId: string | null;
  debit: string | null;
  credit: string | null;
  /**
   * p1 fx: foreign-currency columns carried onto the summary so a foreign-currency account keeps
   * its balance in its own currency (fxLedger reads COALESCE(foreign_amount, home amount)).
   */
  currency: string | null;
  foreignAmount: string | null;
  exchangeRate: string | null;
}

interface MonthGroup {
  key: string; // YYYY-MM
  /** Summary entry date: the latest condensed entry date within the month. */
  date: Date;
  lines: SummaryLine[];
}

interface CondensePlan {
  postedIds: string[];
  voidIds: string[];
  lineIds: string[];
  months: MonthGroup[];
  keptOpenDoc: number;
  keptInProgressRecon: number;
  reconItemsToDelete: number;
  bankFeedRowsToDelete: number;
  draftsSkipped: number;
}

const CHUNK = 300;

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Tables that link documents to their posted GL entry. After the detail entries
 * are deleted, these links are set to NULL on the (closed) documents that
 * pointed at them. All of these tables carry both companyId and postedEntryId.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const POSTED_REF_TABLES: Array<{ table: any; companyCol: any; refCol: any }> = [
  { table: invoices, companyCol: invoices.companyId, refCol: invoices.postedEntryId },
  { table: paymentsReceived, companyCol: paymentsReceived.companyId, refCol: paymentsReceived.postedEntryId },
  { table: salesReceipts, companyCol: salesReceipts.companyId, refCol: salesReceipts.postedEntryId },
  { table: bills, companyCol: bills.companyId, refCol: bills.postedEntryId },
  { table: billPayments, companyCol: billPayments.companyId, refCol: billPayments.postedEntryId },
  { table: expenses, companyCol: expenses.companyId, refCol: expenses.postedEntryId },
  { table: transfers, companyCol: transfers.companyId, refCol: transfers.postedEntryId },
  { table: paychecks, companyCol: paychecks.companyId, refCol: paychecks.postedEntryId },
  { table: creditMemos, companyCol: creditMemos.companyId, refCol: creditMemos.postedEntryId },
  { table: vendorCredits, companyCol: vendorCredits.companyId, refCol: vendorCredits.postedEntryId },
  { table: expenseReports, companyCol: expenseReports.companyId, refCol: expenseReports.postedEntryId },
  { table: itemReceipts, companyCol: itemReceipts.companyId, refCol: itemReceipts.postedEntryId },
  { table: deposits, companyCol: deposits.companyId, refCol: deposits.postedEntryId },
  { table: depreciationEntries, companyCol: depreciationEntries.companyId, refCol: depreciationEntries.postedEntryId },
];

// ---------------------------------------------------------------------------
// Plan computation (shared by dry-run preview and execution)
// ---------------------------------------------------------------------------

async function computePlan(ctx: ServiceContext, cutoff: Date): Promise<CondensePlan> {
  // 1. Candidate entries: everything dated strictly before the cutoff.
  const candidates = await ctx.db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      status: journalEntries.status,
    })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), lt(journalEntries.date, cutoff)));

  const draftsSkipped = candidates.filter((e) => e.status === 'draft').length;

  // 2. Protected entries — documents with an OPEN balance keep their detail.
  const protectedIds = new Set<string>();
  const openStatuses = ['open', 'partial', 'overdue'] as const;
  const protectorQueries = [
    ctx.db.select({ id: invoices.postedEntryId }).from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.status, [...openStatuses]))),
    ctx.db.select({ id: bills.postedEntryId }).from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.status, [...openStatuses]))),
    ctx.db.select({ id: creditMemos.postedEntryId }).from(creditMemos)
      .where(and(
        eq(creditMemos.companyId, ctx.companyId),
        or(inArray(creditMemos.status, [...openStatuses]), sql`${creditMemos.unapplied} <> 0`),
      )),
    ctx.db.select({ id: vendorCredits.postedEntryId }).from(vendorCredits)
      .where(and(
        eq(vendorCredits.companyId, ctx.companyId),
        or(inArray(vendorCredits.status, [...openStatuses]), sql`${vendorCredits.unapplied} <> 0`),
      )),
    ctx.db.select({ id: paymentsReceived.postedEntryId }).from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), sql`${paymentsReceived.unapplied} <> 0`)),
    ctx.db.select({ id: itemReceipts.postedEntryId }).from(itemReceipts)
      .where(and(eq(itemReceipts.companyId, ctx.companyId), eq(itemReceipts.status, 'open'))),
  ];
  for (const q of protectorQueries) {
    for (const row of await q) {
      if (row.id) protectedIds.add(row.id);
    }
  }
  // 2b. General Journal open items (named A/R / A/P lines with an open amount) are open
  //     transactions too: aging and customer / vendor balances list them.
  for (const side of ['ar', 'ap'] as const) {
    for (const item of await journalOpenItems(ctx, side)) protectedIds.add(item.journalEntryId);
  }
  // 2c. Keep applications consistent: a journal entry applied to (or paid by) a document whose
  //     entry is kept must stay too — deleting the entry would cascade-delete the application
  //     while the document still counts it.
  const apps = await ctx.db
    .select({
      journalEntryId: journalItemApplications.journalEntryId,
      paymentEntry: paymentsReceived.postedEntryId,
      billPaymentEntry: billPayments.postedEntryId,
      invoiceEntry: invoices.postedEntryId,
      billEntry: bills.postedEntryId,
    })
    .from(journalItemApplications)
    .leftJoin(paymentsReceived, eq(paymentsReceived.id, journalItemApplications.paymentId))
    .leftJoin(billPayments, eq(billPayments.id, journalItemApplications.billPaymentId))
    .leftJoin(invoices, eq(invoices.id, journalItemApplications.invoiceId))
    .leftJoin(bills, eq(bills.id, journalItemApplications.billId))
    .where(eq(journalItemApplications.companyId, ctx.companyId));
  //     The same goes for a document that is not being condensed at all (dated on/after the
  //     cutoff, a draft, or one whose entry was already condensed away): if that payment is later
  //     voided, the A/R or A/P charge must still be there with its application to re-open it.
  //     Repeat until stable, since keeping one entry can keep the entries applied to it.
  const condensable = new Set(candidates.filter((e) => e.status !== 'draft').map((e) => e.id));
  const removable = (id: string | null) => !!id && condensable.has(id) && !protectedIds.has(id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of apps) {
      if (!removable(a.journalEntryId)) continue;
      const counterparts = [a.paymentEntry, a.billPaymentEntry, a.invoiceEntry, a.billEntry];
      // Every application names exactly one counterpart document; a missing posted entry means
      // the document is not being condensed now, so the application has to stay.
      const linked = counterparts.filter((id) => id !== null && id !== undefined);
      if (linked.length === 0 || linked.some((id) => id !== a.journalEntryId && !removable(id))) {
        protectedIds.add(a.journalEntryId);
        changed = true;
      }
    }
  }
  const openDocProtected = new Set(protectedIds);

  // 3. Protected entries — lines referenced by an IN-PROGRESS reconciliation
  //    ("reconciled-current-session data stays intact").
  const reconProtected = new Set<string>();
  const inProgressLines = await ctx.db
    .select({ entryId: journalEntryLines.journalEntryId })
    .from(reconciliationItems)
    .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
    .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
    .where(ne(reconciliations.status, 'completed'));
  for (const row of inProgressLines) {
    reconProtected.add(row.entryId);
    protectedIds.add(row.entryId);
  }

  const posted = candidates.filter((e) => e.status === 'posted' && !protectedIds.has(e.id));
  const voids = candidates.filter((e) => e.status === 'void' && !protectedIds.has(e.id));
  const keptOpenDoc = candidates.filter(
    (e) => e.status !== 'draft' && openDocProtected.has(e.id),
  ).length;
  const keptInProgressRecon = candidates.filter(
    (e) => e.status !== 'draft' && reconProtected.has(e.id) && !openDocProtected.has(e.id),
  ).length;

  // 4. The condensed range must be CLOSED. Every entry being removed must fall
  //    inside a closed fiscal period or on/before the company closing date.
  const closedPeriods = await ctx.db
    .select({ start: fiscalPeriods.periodStart, end: fiscalPeriods.periodEnd })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.companyId, ctx.companyId), eq(fiscalPeriods.isClosed, true)));
  const [co] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const closingDate = (co?.settings as Record<string, unknown> | null)?.closingDate;
  const isLocked = (d: Date): boolean => {
    if (typeof closingDate === 'string' && closingDate && d.toISOString().slice(0, 10) <= closingDate) {
      return true;
    }
    return closedPeriods.some((p) => p.start <= d && d <= p.end);
  };
  const unlocked = [...posted, ...voids].filter((e) => !isLocked(e.date));
  if (unlocked.length > 0) {
    const earliest = unlocked.reduce((a, b) => (a.date < b.date ? a : b)).date;
    throw new ServiceError(
      'PERIOD_CLOSED',
      `Condense requires the affected period to be closed first. ${unlocked.length} ` +
        `entr${unlocked.length === 1 ? 'y is' : 'ies are'} not in a closed period ` +
        `(earliest: ${earliest.toISOString().slice(0, 10)}). Close the period or set the ` +
        `closing date through ${new Date(cutoff.getTime() - 86_400_000).toISOString().slice(0, 10)} first.`,
    );
  }

  // 5. Load the posted lines and build per-month, per-(account,class) totals.
  const postedIds = posted.map((e) => e.id);
  const entryById = new Map(posted.map((e) => [e.id, e]));
  const lineIds: string[] = [];
  // monthKey -> groupKey(account|class|currency) -> running totals. Foreign totals use the same
  // COALESCE(foreign_amount, home amount) reading as fxLedger, so the account-currency balance of a
  // foreign account is exactly preserved; hasForeign = at least one line carried a foreign amount.
  type Totals = {
    accountId: string; classId: string | null; currency: string | null;
    debit: ReturnType<typeof Money.zero>; credit: ReturnType<typeof Money.zero>;
    fDebit: ReturnType<typeof Money.zero>; fCredit: ReturnType<typeof Money.zero>;
    hasForeign: boolean;
  };
  const monthTotals = new Map<string, Map<string, Totals>>();
  const monthDates = new Map<string, Date>();

  for (const idChunk of chunks(postedIds)) {
    const lines = await ctx.db
      .select({
        id: journalEntryLines.id,
        journalEntryId: journalEntryLines.journalEntryId,
        accountId: journalEntryLines.accountId,
        classId: journalEntryLines.classId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        currency: journalEntryLines.currency,
        foreignAmount: journalEntryLines.foreignAmount,
      })
      .from(journalEntryLines)
      .where(inArray(journalEntryLines.journalEntryId, idChunk));
    for (const line of lines) {
      lineIds.push(line.id);
      const entry = entryById.get(line.journalEntryId)!;
      const mk = monthKey(entry.date);
      const prevDate = monthDates.get(mk);
      if (!prevDate || entry.date > prevDate) monthDates.set(mk, entry.date);

      let groups = monthTotals.get(mk);
      if (!groups) {
        groups = new Map();
        monthTotals.set(mk, groups);
      }
      const gk = `${line.accountId}|${line.classId ?? ''}|${line.currency ?? ''}`;
      let g = groups.get(gk);
      if (!g) {
        g = {
          accountId: line.accountId, classId: line.classId ?? null, currency: line.currency ?? null,
          debit: Money.zero(), credit: Money.zero(), fDebit: Money.zero(), fCredit: Money.zero(), hasForeign: false,
        };
        groups.set(gk, g);
      }
      g.debit = g.debit.plus(Money.of(line.debit));
      g.credit = g.credit.plus(Money.of(line.credit));
      if (line.foreignAmount != null) g.hasForeign = true;
      if (line.debit != null) g.fDebit = g.fDebit.plus(Money.of(line.foreignAmount ?? line.debit));
      if (line.credit != null) g.fCredit = g.fCredit.plus(Money.of(line.foreignAmount ?? line.credit));
    }
  }

  // Also collect void entries' line ids so they are deleted with their entries.
  const voidIds = voids.map((e) => e.id);
  for (const idChunk of chunks(voidIds)) {
    const rows = await ctx.db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(inArray(journalEntryLines.journalEntryId, idChunk));
    for (const r of rows) lineIds.push(r.id);
  }

  // 6. Materialize summary line lists (gross debit + credit per account/class,
  //    emitted as up-to-two one-sided lines so debit/credit column totals survive).
  const months: MonthGroup[] = [...monthTotals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, groups]) => {
      const lines: SummaryLine[] = [];
      for (const g of groups.values()) {
        const fx = (home: ReturnType<typeof Money.zero>, foreign: ReturnType<typeof Money.zero>) =>
          g.hasForeign
            ? {
                currency: g.currency,
                foreignAmount: toAmountString(foreign),
                exchangeRate: foreign.isZero() ? null : home.dividedBy(foreign).toFixed(8),
              }
            : { currency: g.currency, foreignAmount: null, exchangeRate: null };
        // A side with no home amount can still carry a foreign amount (never in practice, but a
        // revaluation-style line is the reverse: home amount, foreign 0). Emit a side whenever
        // either total is non-zero so neither ledger loses anything.
        if (g.debit.greaterThan(0) || (g.hasForeign && !g.fDebit.isZero())) {
          lines.push({ accountId: g.accountId, classId: g.classId, debit: toAmountString(g.debit), credit: null, ...fx(g.debit, g.fDebit) });
        }
        if (g.credit.greaterThan(0) || (g.hasForeign && !g.fCredit.isZero())) {
          lines.push({ accountId: g.accountId, classId: g.classId, debit: null, credit: toAmountString(g.credit), ...fx(g.credit, g.fCredit) });
        }
      }
      return { key, date: monthDates.get(key)!, lines };
    })
    .filter((m) => m.lines.length > 0);

  // 7. Counts of linked non-essential rows that will be removed.
  const deletedIds = [...postedIds, ...voidIds];
  let reconItemsToDelete = 0;
  for (const idChunk of chunks(lineIds)) {
    const [row] = await ctx.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(reconciliationItems)
      .where(inArray(reconciliationItems.journalEntryLineId, idChunk));
    reconItemsToDelete += row?.n ?? 0;
  }
  let bankFeedRowsToDelete = 0;
  for (const idChunk of chunks(deletedIds)) {
    const [row] = await ctx.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(bankTransactions)
      .where(and(
        eq(bankTransactions.companyId, ctx.companyId),
        inArray(bankTransactions.matchedEntryId, idChunk),
      ));
    bankFeedRowsToDelete += row?.n ?? 0;
  }

  return {
    postedIds,
    voidIds,
    lineIds,
    months,
    keptOpenDoc,
    keptInProgressRecon,
    reconItemsToDelete,
    bankFeedRowsToDelete,
    draftsSkipped,
  };
}

function toPreview(cutoff: Date, plan: CondensePlan): CondensePreview {
  return {
    beforeDate: cutoff.toISOString().slice(0, 10),
    months: plan.months.map((m) => m.key),
    entriesToCondense: plan.postedIds.length,
    linesToCondense: plan.lineIds.length,
    voidEntriesToDelete: plan.voidIds.length,
    summaryEntriesToCreate: plan.months.length,
    summaryLinesToCreate: plan.months.reduce((n, m) => n + m.lines.length, 0),
    keptOpenDocumentEntries: plan.keptOpenDoc,
    keptInProgressReconciliationEntries: plan.keptInProgressRecon,
    reconciliationItemsToDelete: plan.reconItemsToDelete,
    bankFeedRowsToDelete: plan.bankFeedRowsToDelete,
    draftEntriesSkipped: plan.draftsSkipped,
  };
}

// ---------------------------------------------------------------------------
// condensePeriod
// ---------------------------------------------------------------------------

/**
 * Condense all journal detail dated before `beforeDate` into monthly summary
 * entries. IRREVERSIBLE except by restoring the archive .bka snapshot this
 * function writes first. Pass `dryRun: true` for a read-only preview.
 */
export async function condensePeriod(
  ctx: ServiceContext,
  input: CondenseInput,
): Promise<CondenseResult> {
  const cutoff = input.beforeDate;
  if (!(cutoff instanceof Date) || isNaN(cutoff.getTime())) {
    throw validation('beforeDate must be a valid date.');
  }
  // Condense deletes and summarizes old transactions, so it would destroy entries an
  // Accountant's Copy has locked (and its changes file could no longer be imported).
  if (await activeCopy(ctx.db, ctx.companyId)) {
    throw new ServiceError(
      'CONFLICT',
      "Condense Data isn't available while an Accountant's Copy is out. Import your accountant's changes or cancel the Accountant's Copy first.",
      { accountantCopy: true },
    );
  }

  const plan = await computePlan(ctx, cutoff);
  const preview = toPreview(cutoff, plan);

  if (input.dryRun) {
    return { ...preview, dryRun: true, archivePath: null, runId: null };
  }

  assertWrite(ctx); // destructive from here on — viewers blocked
  if (plan.postedIds.length === 0 && plan.voidIds.length === 0) {
    throw validation('Nothing to condense before that date.');
  }
  if (!ctx.userId) {
    throw new ServiceError('FORBIDDEN', 'Condense requires an authenticated user.');
  }

  // --- Snapshots FIRST: rotating pre-op backup + permanent archive copy. ---
  // QB Desktop parity: a complete archive copy of the file is written (and verified readable)
  // before a single row is touched. If it cannot be written, nothing is condensed.
  ensurePreOpBackup(ctx, 'condense', input.dataDir);
  const [co] = await ctx.db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const archivePath = writeCondenseArchive(co?.name, input.dataDir);

  const runId = randomUUID();
  const deletedIds = [...plan.postedIds, ...plan.voidIds];

  try {
    await runCondense(ctx, plan, preview, runId, deletedIds, archivePath);
  } catch (err) {
    // Nothing was condensed (the transaction rolled back) — the archive copy is not needed.
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {
      /* a leftover archive is harmless */
    }
    throw err;
  }

  // Record the archive copy so the Backup page can offer "Restore archive copy".
  recordCondenseArchive({
    id: runId,
    path: archivePath,
    filename: path.basename(archivePath),
    createdAt: new Date().toISOString(),
    dataDir: resolveDataDir(input.dataDir),
    companyId: ctx.companyId,
    companyName: co?.name ?? null,
    beforeDate: preview.beforeDate,
    entriesCondensed: preview.entriesToCondense,
    sizeBytes: fs.statSync(archivePath).size,
  });

  return { ...preview, dryRun: false, archivePath, runId };
}

/** The destructive part of condensePeriod, in one transaction. */
async function runCondense(
  ctx: ServiceContext,
  plan: CondensePlan,
  preview: CondensePreview,
  runId: string,
  deletedIds: string[],
  archivePath: string,
): Promise<void> {
  await inTransaction(ctx, async (tx) => {
    // Condense is a sanctioned ledger rewrite: it deletes posted lines/entries and replaces
    // them with summaries. The DB still verifies every summary balances at COMMIT, and the
    // balance triggers net the deletes against the inserts (zero change per account).
    await allowLedgerRewrite(tx, 'condense');

    // a) Completed-reconciliation detail rows pointing at removed lines.
    //    (In-progress reconciliations protected their entries in computePlan.)
    for (const idChunk of chunks(plan.lineIds)) {
      await tx.db
        .delete(reconciliationItems)
        .where(inArray(reconciliationItems.journalEntryLineId, idChunk));
    }

    // b) Matched bank-feed staging rows linked to removed entries.
    for (const idChunk of chunks(deletedIds)) {
      await tx.db
        .delete(bankTransactions)
        .where(and(
          eq(bankTransactions.companyId, tx.companyId),
          inArray(bankTransactions.matchedEntryId, idChunk),
        ));
    }

    // c) Detach soft references so FKs allow the entry deletes. Document rows
    //    are KEPT — only their GL drill-down link is cleared.
    for (const idChunk of chunks(deletedIds)) {
      await tx.db
        .update(errorDetections)
        .set({ journalEntryId: null })
        .where(and(
          eq(errorDetections.companyId, tx.companyId),
          inArray(errorDetections.journalEntryId, idChunk),
        ));
      for (const t of POSTED_REF_TABLES) {
        await tx.db
          .update(t.table)
          .set({ postedEntryId: null })
          .where(and(eq(t.companyCol, tx.companyId), inArray(t.refCol, idChunk)));
      }
    }

    // d) Delete the detail lines, then the entries.
    for (const idChunk of chunks(deletedIds)) {
      await tx.db
        .delete(journalEntryLines)
        .where(inArray(journalEntryLines.journalEntryId, idChunk));
      await tx.db
        .delete(journalEntries)
        .where(and(
          eq(journalEntries.companyId, tx.companyId),
          inArray(journalEntries.id, idChunk),
        ));
    }

    // e) Insert the monthly summary entries DIRECTLY (not via postJournalEntry):
    //    the period is closed by design. The summaries replace exactly what was
    //    deleted, so the trigger-maintained accounts.balance nets to zero change.
    const [maxRow] = await tx.db
      .select({ max: sql<number>`COALESCE(MAX(${journalEntries.entryNumber}), 0)` })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, tx.companyId));
    let entryNumber = (maxRow?.max ?? 0) + 1;

    for (const month of plan.months) {
      const [entry] = await tx.db
        .insert(journalEntries)
        .values({
          companyId: tx.companyId,
          entryNumber: entryNumber++,
          date: month.date,
          description: `Condensed detail for ${month.key} (condensed through ${preview.beforeDate})`,
          status: 'posted',
          sourceRef: `condense:${runId}`,
          createdBy: tx.userId!,
        })
        .returning();
      for (const lineChunk of chunks(month.lines, 200)) {
        await tx.db.insert(journalEntryLines).values(
          lineChunk.map((l) => ({
            journalEntryId: entry.id,
            accountId: l.accountId,
            classId: l.classId,
            debit: l.debit,
            credit: l.credit,
            currency: l.currency,
            foreignAmount: l.foreignAmount,
            exchangeRate: l.exchangeRate,
            memo: 'Condensed activity',
          })),
        );
      }
      // Running transaction log: the summary entries are new posted entries.
      await logTransaction(tx.db, {
        companyId: tx.companyId,
        userId: tx.userId,
        action: 'create',
        entityType: 'journal_entry',
        entityId: entry.id,
        summary: `Created condensed summary entry #${entry.entryNumber} for ${month.key}`,
        data: { new: { entryNumber: entry.entryNumber, description: entry.description, lines: month.lines } },
      });
    }

    // f) Audit row — condense is itself auditable.
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'condense',
      entityId: runId,
      newValues: { ...preview, archivePath },
    });
  });
}

/**
 * Permanent (non-rotating) archive snapshot written into an `archives` folder
 * next to the data dir. This is the ONLY way back after a condense.
 */
function writeCondenseArchive(companyName: string | undefined, dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  const fingerprint = currentFingerprint(dir);
  const { buffer, filename } = createBackup(companyName, dir);
  const outDir = condenseArchiveDir(dir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename.replace(/^(ironbooks|bookkeeper)-backup/, 'condense-archive'));
  fs.writeFileSync(outPath, buffer);

  // Verify the archive on disk is a complete, readable copy before anything is deleted.
  try {
    const zip = new AdmZip(fs.readFileSync(outPath));
    const entries = zip.getEntries();
    const names = new Set(entries.map((e) => e.entryName.replace(/\\/g, '/')));
    const fileEntries = entries.filter((e) => !e.isDirectory).length - 1; // minus the manifest
    if (!names.has('PG_VERSION') || !names.has(BACKUP_MANIFEST_ENTRY) || fileEntries < countFiles(dir, true)) {
      throw new Error('archive is incomplete');
    }
    // Force a full read of every entry (CRC-checked by adm-zip) so a truncated write fails here.
    for (const e of entries) if (!e.isDirectory) e.getData();
  } catch (err) {
    fs.rmSync(outPath, { force: true });
    throw new ServiceError(
      'INTERNAL',
      `Condense stopped: the archive copy could not be verified (${(err as Error).message}). Nothing was changed.`,
    );
  }
  recordBackup(
    {
      source: 'pre-op',
      kind: 'full',
      filename: path.basename(outPath),
      path: outPath,
      sizeBytes: buffer.byteLength,
      fingerprint,
      note: 'Archive copy made before condensing',
    },
    dir,
  );
  return outPath;
}

/** Files a backup of `dir` must contain (root-level FILE_LOCAL_FILES never go into a backup). */
function countFiles(dir: string, root = false): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (root && !entry.isDirectory() && FILE_LOCAL_FILES.includes(entry.name)) continue;
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Archive copies (QB "archive copy" written before condensing)
// ---------------------------------------------------------------------------

/** Folder holding condense archive copies: a sibling `archives` folder of the data dir. */
export function condenseArchiveDir(dataDir?: string): string {
  return path.join(path.dirname(resolveDataDir(dataDir)), 'archives');
}

const ARCHIVE_INDEX = 'condense-archives.json';

export interface CondenseArchive {
  /** The condense run id. */
  id: string;
  path: string;
  filename: string;
  createdAt: string;
  /** Data dir the archive was taken from (several company files may share an archives folder). */
  dataDir: string;
  companyId: string;
  companyName: string | null;
  beforeDate: string;
  entriesCondensed: number;
  sizeBytes: number;
}

function readArchiveIndex(dir: string): CondenseArchive[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVE_INDEX), 'utf8'));
    return Array.isArray(raw) ? (raw as CondenseArchive[]) : [];
  } catch {
    return [];
  }
}

function recordCondenseArchive(entry: CondenseArchive): void {
  const dir = path.dirname(entry.path);
  const list = readArchiveIndex(dir).filter((a) => a.id !== entry.id);
  list.push(entry);
  fs.writeFileSync(path.join(dir, ARCHIVE_INDEX), JSON.stringify(list, null, 2), 'utf8');
}

/** Archive copies recorded for this company file (newest first; missing files flagged). */
export function listCondenseArchives(dataDir?: string): Array<CondenseArchive & { available: boolean }> {
  const dir = resolveDataDir(dataDir);
  return readArchiveIndex(condenseArchiveDir(dir))
    .filter((a) => path.resolve(a.dataDir) === dir)
    .map((a) => ({ ...a, available: fs.existsSync(a.path) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Restore a recorded archive copy over the current company file, bringing back the full
 * pre-condense detail. Only archives recorded in the index can be restored (never an
 * arbitrary path). restoreBackup snapshots the current file first (pre-op backup), so the
 * post-condense state stays recoverable too, and verifies the restored books before they go
 * live: an archive copy whose ledger guards were turned off or whose books do not balance is
 * refused (VALIDATION) and the current file is kept.
 */
export async function restoreCondenseArchive(
  ctx: ServiceContext,
  archiveId: string,
  dataDir?: string,
): Promise<{ restored: true; archive: CondenseArchive; notices?: string[] }> {
  assertWrite(ctx);
  if (ctx.role && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', 'Only the company owner or an admin can restore an archive copy.');
  }
  const archive = listCondenseArchives(dataDir).find((a) => a.id === archiveId);
  if (!archive) throw new ServiceError('NOT_FOUND', 'Archive copy not found.');
  if (!archive.available) {
    throw new ServiceError('NOT_FOUND', `The archive file is missing: ${archive.filename}`);
  }
  const result = await restoreBackup(fs.readFileSync(archive.path), resolveDataDir(dataDir));
  return result.notices?.length ? { restored: true, archive, notices: result.notices } : { restored: true, archive };
}
