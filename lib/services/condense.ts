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
import { and, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  bankTransactions,
  billPaymentApplications,
  billPayments,
  bills,
  companies,
  creditApplications,
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
  paymentApplications,
  paymentsReceived,
  reconciliationItems,
  reconciliations,
  salesReceipts,
  salesTaxLineLinks,
  transfers,
  vendorCreditApplications,
  vendorCredits,
} from '@/lib/db/schema';
import { resolveDataDir } from '@/lib/db';
import { withPlannerStats } from '@/lib/db/plannerStats';
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
import { inventoryValuationDetail } from './inventory';
import { salesTaxActivity } from './accountant/salesTaxLedger';

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
  /**
   * Sales tax attribution of a line on a sales-tax liability account (the agency + kind the
   * condensed lines were attributed to). A sales_tax_line_links row carries it onto the summary
   * line, so the Sales Tax Liability report keeps owing each agency what it did.
   */
  tax?: { agencyId: string | null; kind: 'collected' | 'payment' | 'adjustment' } | null;
}

/**
 * What a summary entry stands for. 'main' = the month's general summary. Inventory activity is
 * summarized per item ('item' → sourceRef item:<id>) or per assembly component move
 * ('assembly_build' / 'assembly_unbuild' → <kind>:<run>:<from>:<to>), the same source refs the
 * documents themselves post with, so Inventory Valuation (as of a date) still attributes every
 * dollar on an inventory asset account to its item after the detail is gone.
 */
type SummaryRef =
  | { kind: 'main' }
  | { kind: 'item'; itemId: string }
  | { kind: 'assembly_build' | 'assembly_unbuild'; from: string; to: string };

interface MonthGroup {
  key: string; // YYYY-MM
  /** Summary entry date: the latest condensed entry date within the month (and group). */
  date: Date;
  ref: SummaryRef;
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
      sourceRef: journalEntries.sourceRef,
    })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), lt(journalEntries.date, cutoff)));

  const draftsSkipped = candidates.filter((e) => e.status === 'draft').length;

  // 2. Protected entries — documents with an OPEN balance keep their detail.
  const protectedIds = new Set<string>();
  const openStatuses = ['open', 'partial', 'overdue'] as const;
  // Kept A/R and A/P documents by id: their COGS / restock / refund entries stay with them.
  const keep = {
    invoice: new Set<string>(),
    creditMemo: new Set<string>(),
    bill: new Set<string>(),
    vendorCredit: new Set<string>(),
  };
  const keepDocs = (set: Set<string>, rows: Array<{ id: string | null; entry: string | null }>) => {
    for (const r of rows) {
      if (r.id) set.add(r.id);
      if (r.entry) protectedIds.add(r.entry);
    }
  };
  keepDocs(keep.invoice, await ctx.db.select({ id: invoices.id, entry: invoices.postedEntryId }).from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.status, [...openStatuses]))));
  keepDocs(keep.bill, await ctx.db.select({ id: bills.id, entry: bills.postedEntryId }).from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.status, [...openStatuses]))));
  keepDocs(keep.creditMemo, await ctx.db.select({ id: creditMemos.id, entry: creditMemos.postedEntryId }).from(creditMemos)
    .where(and(
      eq(creditMemos.companyId, ctx.companyId),
      or(inArray(creditMemos.status, [...openStatuses]), sql`${creditMemos.unapplied} <> 0`),
    )));
  keepDocs(keep.vendorCredit, await ctx.db.select({ id: vendorCredits.id, entry: vendorCredits.postedEntryId }).from(vendorCredits)
    .where(and(
      eq(vendorCredits.companyId, ctx.companyId),
      or(inArray(vendorCredits.status, [...openStatuses]), sql`${vendorCredits.unapplied} <> 0`),
    )));
  // 2a. A document settled ON or AFTER the cutoff (a payment, credit, vendor credit, General
  //     Journal credit or refund dated then) was still open at the cutoff — QB never condenses a
  //     transaction linked to one after the condense date. Cash-basis reports recognize its income
  //     / expense on those later settlement dates from its own posted lines, so its detail stays.
  const late = await Promise.all([
    ctx.db.select({ invoiceId: paymentApplications.invoiceId }).from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentsReceived.id, paymentApplications.paymentId))
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), gte(paymentsReceived.date, cutoff))),
    ctx.db.select({ invoiceId: creditApplications.invoiceId, memoId: creditApplications.creditMemoId }).from(creditApplications)
      .where(and(eq(creditApplications.companyId, ctx.companyId), gte(creditApplications.date, cutoff))),
    ctx.db.select({ billId: billPaymentApplications.billId }).from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPayments.id, billPaymentApplications.billPaymentId))
      .where(and(eq(billPayments.companyId, ctx.companyId), gte(billPayments.date, cutoff))),
    ctx.db.select({ billId: vendorCreditApplications.billId, creditId: vendorCreditApplications.vendorCreditId }).from(vendorCreditApplications)
      .where(and(eq(vendorCreditApplications.companyId, ctx.companyId), gte(vendorCreditApplications.date, cutoff))),
    ctx.db.select({ invoiceId: journalItemApplications.invoiceId, billId: journalItemApplications.billId }).from(journalItemApplications)
      .where(and(eq(journalItemApplications.companyId, ctx.companyId), gte(journalItemApplications.date, cutoff))),
    ctx.db.select({ sourceRef: journalEntries.sourceRef }).from(journalEntries)
      .where(and(
        eq(journalEntries.companyId, ctx.companyId),
        gte(journalEntries.date, cutoff),
        sql`${journalEntries.sourceRef} LIKE 'refund:%'`,
      )),
  ]);
  const lateInvoices = new Set<string>();
  const lateBills = new Set<string>();
  const lateMemos = new Set<string>();
  const lateCredits = new Set<string>();
  for (const r of late[0]) lateInvoices.add(r.invoiceId);
  for (const r of late[1]) { lateInvoices.add(r.invoiceId); lateMemos.add(r.memoId); }
  for (const r of late[2]) lateBills.add(r.billId);
  for (const r of late[3]) { lateBills.add(r.billId); lateCredits.add(r.creditId); }
  for (const r of late[4]) { if (r.invoiceId) lateInvoices.add(r.invoiceId); if (r.billId) lateBills.add(r.billId); }
  for (const r of late[5]) {
    const id = (r.sourceRef ?? '').slice('refund:'.length);
    if (UUID_ONLY_RE.test(id)) { lateMemos.add(id); lateCredits.add(id); }
  }
  const lateDocs: Array<[Set<string>, Set<string>, typeof invoices | typeof bills | typeof creditMemos | typeof vendorCredits]> = [
    [lateInvoices, keep.invoice, invoices],
    [lateBills, keep.bill, bills],
    [lateMemos, keep.creditMemo, creditMemos],
    [lateCredits, keep.vendorCredit, vendorCredits],
  ];
  for (const [ids, set, table] of lateDocs) {
    for (const idChunk of chunks([...ids])) {
      keepDocs(set, await ctx.db.select({ id: table.id, entry: table.postedEntryId }).from(table)
        .where(and(eq(table.companyId, ctx.companyId), inArray(table.id, idChunk))));
    }
  }
  //     The COGS entries of a kept invoice (invoice-cogs:<id>), the restock entries of a kept credit
  //     memo (creditmemo-cogs:<id>) and the refunds of a kept credit belong to the document: the
  //     cash basis defers and recognizes them with it.
  for (const e of candidates) {
    const ref = e.sourceRef ?? '';
    const i = ref.indexOf(':');
    const kind = i >= 0 ? ref.slice(0, i) : '';
    const id = i >= 0 ? ref.slice(i + 1) : '';
    if (
      (kind === 'invoice-cogs' && keep.invoice.has(id)) ||
      (kind === 'creditmemo-cogs' && keep.creditMemo.has(id)) ||
      (kind === 'refund' && (keep.creditMemo.has(id) || keep.vendorCredit.has(id)))
    ) {
      protectedIds.add(e.id);
    }
  }
  const protectorQueries = [
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
  // 2b'. Entries with a line attributed to a sales tax agency ("Fix Incorrectly Recorded Sales
  //      Tax" links): the link is the agency's liability history and is deleted with its line
  //      (ON DELETE CASCADE), so those entries stay in detail.
  const taxLinked = await ctx.db
    .selectDistinct({ id: journalEntryLines.journalEntryId })
    .from(salesTaxLineLinks)
    .innerJoin(journalEntryLines, eq(journalEntryLines.id, salesTaxLineLinks.journalEntryLineId))
    .where(eq(salesTaxLineLinks.companyId, ctx.companyId));
  for (const row of taxLinked) protectedIds.add(row.id);
  // 2b''. Inventory: which item(s) each candidate entry's inventory-asset postings belong to
  //       (Inventory Valuation's own attribution). Entries of one item are summarized per item,
  //       assembly moves per (component, assembly) pair; a document spread over several items
  //       (a bill / check / receipt for many items) keeps its detail, since a summary could not
  //       say which item each dollar belongs to.
  const itemsByEntry = new Map<string, Set<string>>();
  for (const it of (await inventoryValuationDetail(ctx, { to: cutoff })).items) {
    for (const m of it.movements) {
      const set = itemsByEntry.get(m.entryId) ?? new Set<string>();
      set.add(it.itemId);
      itemsByEntry.set(m.entryId, set);
    }
  }
  const inventoryRef = new Map<string, SummaryRef>();
  for (const e of candidates) {
    const itemSet = itemsByEntry.get(e.id);
    if (!itemSet || e.status !== 'posted') continue;
    const ref = e.sourceRef ?? '';
    const kind = ref.slice(0, Math.max(0, ref.indexOf(':')));
    if (kind === 'assembly_build' || kind === 'assembly_unbuild') {
      const [, from, to] = ref.slice(kind.length + 1).split(':');
      if (from && to) {
        inventoryRef.set(e.id, { kind, from, to });
        continue;
      }
    }
    if (itemSet.size === 1) inventoryRef.set(e.id, { kind: 'item', itemId: [...itemSet][0] });
    else protectedIds.add(e.id);
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
    tax: SummaryLine['tax'];
  };
  // Summary key (month + what the summary stands for) -> group key -> running totals.
  const monthTotals = new Map<string, Map<string, Totals>>();
  const monthDates = new Map<string, Date>();
  const summaryInfo = new Map<string, { month: string; ref: SummaryRef }>();
  const refKey = (r: SummaryRef) =>
    r.kind === 'main' ? 'main' : r.kind === 'item' ? `item|${r.itemId}` : `${r.kind}|${r.from}|${r.to}`;
  // Sales tax attribution of every liability line (salesTaxActivity: by document, rate and agency).
  const LINK_KIND = { collected: 'collected', credited: 'collected', paid: 'payment', adjustment: 'adjustment' } as const;
  const taxByLine = new Map<string, Array<{ tax: NonNullable<SummaryLine['tax']>; amount: ReturnType<typeof Money.zero> }>>();
  for (const r of await salesTaxActivity(ctx, { to: cutoff })) {
    const kind = LINK_KIND[r.kind as keyof typeof LINK_KIND];
    if (!kind) continue; // unattributed: stays a plain line, as it was
    const list = taxByLine.get(r.lineId) ?? [];
    list.push({ tax: { agencyId: r.agencyId, kind }, amount: Money.of(r.amount) });
    taxByLine.set(r.lineId, list);
  }

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
      const ref = inventoryRef.get(entry.id) ?? { kind: 'main' as const };
      const sk = `${mk}|${refKey(ref)}`;
      if (!summaryInfo.has(sk)) summaryInfo.set(sk, { month: mk, ref });
      const prevDate = monthDates.get(sk);
      if (!prevDate || entry.date > prevDate) monthDates.set(sk, entry.date);

      let groups = monthTotals.get(sk);
      if (!groups) {
        groups = new Map();
        monthTotals.set(sk, groups);
      }
      const group = (tax: SummaryLine['tax']) => {
        const gk = `${line.accountId}|${line.classId ?? ''}|${line.currency ?? ''}|${tax ? `${tax.agencyId ?? ''}:${tax.kind}` : ''}`;
        let g = groups!.get(gk);
        if (!g) {
          g = {
            accountId: line.accountId, classId: line.classId ?? null, currency: line.currency ?? null,
            debit: Money.zero(), credit: Money.zero(), fDebit: Money.zero(), fCredit: Money.zero(), hasForeign: false,
            tax: tax ?? null,
          };
          groups!.set(gk, g);
        }
        return g;
      };
      // A one-sided home-currency line on a sales-tax liability account is split by the agency
      // (and kind) it was attributed to, so each agency keeps its balance on the summary.
      const taxParts = taxByLine.get(line.id);
      const oneSided = (line.debit == null || Money.of(line.debit).isZero()) !== (line.credit == null || Money.of(line.credit).isZero());
      if (taxParts && line.foreignAmount == null && oneSided) {
        for (const p of taxParts) {
          const g = group(p.tax);
          if (p.amount.greaterThan(0)) {
            g.credit = g.credit.plus(p.amount);
            g.fCredit = g.fCredit.plus(p.amount);
          } else {
            g.debit = g.debit.plus(p.amount.negated());
            g.fDebit = g.fDebit.plus(p.amount.negated());
          }
        }
        continue;
      }
      const g = group(null);
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
    .map(([sk, groups]) => {
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
        const tax = g.tax ? { tax: g.tax } : {};
        if (g.debit.greaterThan(0) || (g.hasForeign && !g.fDebit.isZero())) {
          lines.push({ accountId: g.accountId, classId: g.classId, debit: toAmountString(g.debit), credit: null, ...fx(g.debit, g.fDebit), ...tax });
        }
        if (g.credit.greaterThan(0) || (g.hasForeign && !g.fCredit.isZero())) {
          lines.push({ accountId: g.accountId, classId: g.classId, debit: null, credit: toAmountString(g.credit), ...fx(g.credit, g.fCredit), ...tax });
        }
      }
      const info = summaryInfo.get(sk)!;
      return { key: info.month, ref: info.ref, date: monthDates.get(sk)!, lines };
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
    months: [...new Set(plan.months.map((m) => m.key))],
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
  if (input.dryRun) return condensePeriodUnlocked(ctx, input);
  // One condense at a time per company: a double-submitted condense waits for the first one
  // (so the two never write the same archive file) and then finds nothing new to condense.
  // Condensing shrinks the ledger tables: fresh planner statistics afterwards (best-effort).
  return serializeCondense(ctx.companyId, () =>
    withPlannerStats(ctx.db, 'condense', () => condensePeriodUnlocked(ctx, input)),
  );
}

/** Per-company queue of running condenses (this process; a company folder has one process). */
const condenseRuns = new Map<string, Promise<unknown>>();

function serializeCondense<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = condenseRuns.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  condenseRuns.set(key, tail);
  void tail.then(() => {
    if (condenseRuns.get(key) === tail) condenseRuns.delete(key);
  });
  return run;
}

async function condensePeriodUnlocked(
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
  // Only the summaries of an earlier condense are left: re-condensing them changes nothing.
  if (await onlyCondensedSummaries(ctx, plan)) throw new ServiceError('CONFLICT', ALREADY_CONDENSED);
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

  let condensed: CondensePreview;
  try {
    condensed = await runCondense(ctx, cutoff, runId, archivePath);
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
    fileId: fileIdOf(resolveDataDir(input.dataDir), true),
    companyId: ctx.companyId,
    companyName: co?.name ?? null,
    beforeDate: condensed.beforeDate,
    entriesCondensed: condensed.entriesToCondense,
    sizeBytes: fs.statSync(archivePath).size,
  });

  return { ...condensed, dryRun: false, archivePath, runId };
}

/**
 * NOT NULL referrers that are pure derived / undo state and may be deleted with the entry or
 * bank-feed row they describe. ai_auto_applied is the AI auto-categorize undo log (bank-feed row
 * + the entry it created): once the entry is condensed that undo can no longer happen.
 */
const DERIVED_REFERRER_TABLES = new Set(['ai_auto_applied']);

const UUID_ONLY_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Release every single-column FOREIGN KEY that would block deleting `ids` from `targetTable`
 * (ON DELETE NO ACTION / RESTRICT; CASCADE and SET NULL keys are left to the database):
 * a nullable reference is set to NULL, a NOT NULL one means the row only describes the removed
 * row (e.g. an AI auto-apply undo record of a condensed entry) and is deleted — after its own
 * referrers are released the same way. Columns in `skip` ("table.column") are handled by the
 * caller.
 */
async function detachForeignReferences(
  tx: ServiceContext,
  targetTable: string,
  ids: string[],
  skip: string[] = [],
  depth = 0,
): Promise<void> {
  if (ids.length === 0) return;
  if (depth > 8) throw new ServiceError('INTERNAL', 'Condense: foreign key chain is too deep.');
  for (const id of ids) {
    if (!UUID_ONLY_RE.test(id)) throw new ServiceError('INTERNAL', `Condense: not a uuid: ${id}`);
  }
  const res = await tx.db.execute(sql`
    SELECT src.relname AS child, att.attname AS col, att.attnotnull AS notnull,
           EXISTS (SELECT 1 FROM pg_attribute ia WHERE ia.attrelid = con.conrelid AND ia.attname = 'id' AND NOT ia.attisdropped) AS has_id
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = ref.relnamespace
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND array_length(con.conkey, 1) = 1
       AND con.confdeltype IN ('a', 'r')
       AND ref.relname = ${targetTable}
       AND ns.nspname = current_schema()
     ORDER BY 1, 2`);
  const fks = ((res as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    child: string; col: string; notnull: boolean; has_id: boolean;
  }>;
  const list = ids.map((id) => `'${id}'::uuid`).join(', ');
  const skipSet = new Set(skip);
  for (const fk of fks) {
    if (skipSet.has(`${fk.child}.${fk.col}`)) continue;
    const where = `${quoteIdent(fk.col)} IN (${list})`;
    if (!fk.notnull) {
      await tx.db.execute(sql.raw(`UPDATE ${quoteIdent(fk.child)} SET ${quoteIdent(fk.col)} = NULL WHERE ${where}`));
      continue;
    }
    // A NOT NULL referrer cannot outlive the removed row. Only rows that are pure derived / undo
    // state may be removed with it; anything else would silently change history, so refuse.
    if (!DERIVED_REFERRER_TABLES.has(fk.child)) {
      const hit = await tx.db.execute(sql.raw(`SELECT 1 FROM ${quoteIdent(fk.child)} WHERE ${where} LIMIT 1`));
      if ((((hit as unknown as { rows?: unknown[] }).rows) ?? []).length === 0) continue;
      throw validation(
        `Condense cannot remove these transactions: records in "${fk.child}" still depend on them. ` +
          'Nothing was changed. Pick an earlier date, or contact support.',
      );
    }
    if (fk.has_id) {
      const found = await tx.db.execute(sql.raw(`SELECT id::text AS id FROM ${quoteIdent(fk.child)} WHERE ${where}`));
      const childIds = (((found as unknown as { rows?: unknown[] }).rows ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (childIds.length === 0) continue;
      await detachForeignReferences(tx, fk.child, childIds, [], depth + 1);
    }
    await tx.db.execute(sql.raw(`DELETE FROM ${quoteIdent(fk.child)} WHERE ${where}`));
  }
}

const ALREADY_CONDENSED =
  'Everything before that date has already been condensed. Nothing new to condense.';

/** True when every entry a plan would condense is already a condense summary (nothing new). */
async function onlyCondensedSummaries(ctx: ServiceContext, plan: CondensePlan): Promise<boolean> {
  if (plan.voidIds.length > 0) return false;
  for (const idChunk of chunks(plan.postedIds)) {
    const [row] = await ctx.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(journalEntries)
      .where(and(
        inArray(journalEntries.id, idChunk),
        sql`COALESCE(${journalEntries.sourceRef}, '') NOT LIKE 'condense:%'`,
        // Per-item / assembly summaries carry the item's source ref and the run in `reference`.
        sql`COALESCE(${journalEntries.reference}, '') NOT LIKE 'condense:%'`,
      ));
    if ((row?.n ?? 0) > 0) return false;
  }
  return true;
}

/**
 * The destructive part of condensePeriod, in one transaction. The plan is computed again INSIDE
 * the transaction (the preview outside it can be stale), so a condense that ran in the meantime
 * is seen and nothing is summarized twice. Returns the preview of what was actually condensed.
 */
async function runCondense(
  ctx: ServiceContext,
  cutoff: Date,
  runId: string,
  archivePath: string,
): Promise<CondensePreview> {
  return inTransaction(ctx, async (tx) => {
    const plan = await computePlan(tx, cutoff);
    if (plan.postedIds.length === 0 && plan.voidIds.length === 0) {
      throw validation('Nothing to condense before that date.');
    }
    if (await onlyCondensedSummaries(tx, plan)) throw new ServiceError('CONFLICT', ALREADY_CONDENSED);
    const preview = toPreview(cutoff, plan);
    const deletedIds = [...plan.postedIds, ...plan.voidIds];

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

    // b) Matched bank-feed staging rows linked to removed entries. Anything else pointing at
    //    those rows (the AI auto-apply undo log, ...) is detached / removed first.
    for (const idChunk of chunks(deletedIds)) {
      const feedRows = await tx.db
        .select({ id: bankTransactions.id })
        .from(bankTransactions)
        .where(and(
          eq(bankTransactions.companyId, tx.companyId),
          inArray(bankTransactions.matchedEntryId, idChunk),
        ));
      const feedIds = feedRows.map((r) => r.id);
      if (feedIds.length === 0) continue;
      await detachForeignReferences(tx, 'bank_transactions', feedIds);
      await tx.db.delete(bankTransactions).where(inArray(bankTransactions.id, feedIds));
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
    // c2) Every other FOREIGN KEY to the removed lines / entries (Sales Tax Payment and
    //     liability checks, bounced checks, landed cost allocations, the AI auto-apply log, and
    //     any table added later), found from the database catalogue: optional links are
    //     cleared, rows that cannot exist without the entry are removed.
    for (const idChunk of chunks(plan.lineIds)) {
      await detachForeignReferences(tx, 'journal_entry_lines', idChunk);
    }
    for (const idChunk of chunks(deletedIds)) {
      await detachForeignReferences(tx, 'journal_entries', idChunk, ['journal_entry_lines.journal_entry_id']);
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
      const ref = month.ref;
      const [entry] = await tx.db
        .insert(journalEntries)
        .values({
          companyId: tx.companyId,
          entryNumber: entryNumber++,
          date: month.date,
          description:
            ref.kind === 'main'
              ? `Condensed detail for ${month.key} (condensed through ${preview.beforeDate})`
              : `Condensed inventory activity for ${month.key} (condensed through ${preview.beforeDate})`,
          status: 'posted',
          // Inventory summaries post under the item's / assembly move's own source ref (that is how
          // Inventory Valuation attributes them); the run id goes in `reference`.
          sourceRef:
            ref.kind === 'main'
              ? `condense:${runId}`
              : ref.kind === 'item'
                ? `item:${ref.itemId}`
                : `${ref.kind}:${runId}:${ref.from}:${ref.to}`,
          reference: ref.kind === 'main' ? null : `condense:${runId}`,
          createdBy: tx.userId!,
        })
        .returning();
      const lineValues = (l: SummaryLine) => ({
        journalEntryId: entry.id,
        accountId: l.accountId,
        classId: l.classId,
        debit: l.debit,
        credit: l.credit,
        currency: l.currency,
        foreignAmount: l.foreignAmount,
        exchangeRate: l.exchangeRate,
        memo: 'Condensed activity',
      });
      const plain = month.lines.filter((l) => !l.tax);
      for (const lineChunk of chunks(plain, 200)) {
        await tx.db.insert(journalEntryLines).values(lineChunk.map(lineValues));
      }
      // Sales tax summary lines keep their agency through a sales_tax_line_links row.
      for (const l of month.lines.filter((x) => x.tax)) {
        const [row] = await tx.db.insert(journalEntryLines).values(lineValues(l)).returning({ id: journalEntryLines.id });
        await tx.db.insert(salesTaxLineLinks).values({
          companyId: tx.companyId,
          journalEntryLineId: row.id,
          agencyId: l.tax!.agencyId,
          kind: l.tax!.kind,
          note: `Condensed sales tax activity for ${month.key}`,
          createdBy: tx.userId!,
        });
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
    return preview;
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

/**
 * Folder holding condense archive copies: a sibling `archives` folder of the data dir — or, for
 * the open SINGLE company file, an `archives` folder next to the company file itself. Its
 * database runs from a working copy in this computer's local app data, which nobody looks in
 * and which other computers that open the file do not have; like QuickBooks' "Archive Copy"
 * beside the .QBW, the archive goes where the company file is.
 */
export function condenseArchiveDir(dataDir?: string): string {
  const dir = resolveDataDir(dataDir);
  return path.join(singleCompanyFileHome(dir) ?? path.dirname(dir), 'archives');
}

/**
 * The folder holding the open single company file when `dir` is its working copy's database
 * folder (electron/companySession.js: <working copy>/data next to state.json); else null.
 */
function singleCompanyFileHome(dir: string): string | null {
  const file = process.env.BKA_COMPANY_FILE;
  const state = process.env.BKA_COMPANY_STATE;
  if (!file || !state) return null;
  const working = path.join(path.dirname(path.resolve(state)), 'data');
  const same = process.platform === 'win32' ? working.toLowerCase() === dir.toLowerCase() : working === dir;
  return same ? path.dirname(path.resolve(file)) : null;
}

/**
 * The company file's own identity (`.file-id`, the one session tokens are bound to; lib/auth.ts):
 * it travels inside the file, so an archive copy is found again on any computer — the data
 * folder's path differs on each. Made here when the file has none yet (same format as lib/auth).
 */
function fileIdOf(dir: string, create = false): string | null {
  const file = path.join(dir, '.file-id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (id) return id;
  } catch {
    /* none yet */
  }
  if (!create) return null;
  try {
    const id = randomUUID();
    fs.writeFileSync(file, id, { mode: 0o600, flag: 'wx' });
    return id;
  } catch {
    return fileIdOf(dir, false);
  }
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
  /** The company file's identity (.file-id): the same on every computer, unlike dataDir. */
  fileId?: string | null;
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
  const archDir = condenseArchiveDir(dir);
  const fileId = fileIdOf(dir);
  return readArchiveIndex(archDir)
    .filter((a) => (a.fileId && fileId ? a.fileId === fileId : path.resolve(a.dataDir) === dir))
    .map((a) => {
      // The archives folder as this computer reaches it (a share mapped to another drive letter
      // here, or reached by its \\server name there).
      const here = path.join(archDir, path.basename(a.filename || a.path));
      const p = fs.existsSync(a.path) ? a.path : here;
      return { ...a, path: p, available: fs.existsSync(p) };
    })
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
