/**
 * Data-integrity verification service.
 *
 * Runs a battery of sanity checks against the live database and returns a
 * structured report. Each check is independent so partial failures are
 * visible alongside passing checks.
 *
 * Checks:
 *  1. Every posted journal entry is balanced (sum debit == sum credit).
 *  2. Each account's cached `balance` column matches the GL-derived balance.
 *  3. A/R control account (code 1200) balance equals sum of open invoices' balanceDue.
 *  4. No journal_entry_lines reference an account belonging to another company.
 *  5. The database ledger guards (drizzle/0017_team_ledger.sql) are installed and enabled.
 *
 * `booksInBalance` is the live "Books in balance" status shown on the Integrity page: trial
 * balance, accrual + cash-basis balance sheets, cached balances and the DB guards in one call.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  billPaymentApplications,
  billPayments,
  bills,
  classes,
  creditMemos,
  customers,
  employees,
  inventoryLayers,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { journalOpenItems } from './journal';
import { unappliedCustomerPayments } from './customerCredits';
import { generalJournalSourceSql } from './posting';
import { ServiceError, inTransaction, writeAudit } from './_base';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { LedgerIntegrityError } from './ledgerAssert';
import { balanceSheet, trialBalance } from './reports';

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IntegrityResult {
  checks: IntegrityCheck[];
  allOk: boolean;
}

const DEBIT_NORMAL = new Set(['asset', 'expense']);

// ---------------------------------------------------------------------------
// Check 1: Every posted journal entry has balanced lines (debits == credits).
// ---------------------------------------------------------------------------
async function checkEntriesBalanced(ctx: ServiceContext): Promise<IntegrityCheck> {
  const name = 'Journal entries balanced';

  // Aggregate per entry: sum(debit) and sum(credit). We only care about posted entries.
  const rows = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      lineCount: sql<number>`COUNT(*)::int`,
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .groupBy(journalEntryLines.journalEntryId);

  const unbalanced: string[] = [];
  for (const row of rows) {
    // Exact: ledger amounts are 2dp, so any difference at all is an imbalance.
    if (!Money.eq(row.totalDebit, row.totalCredit) || Number(row.lineCount) < 2) {
      unbalanced.push(row.entryId);
    }
  }

  if (unbalanced.length === 0) {
    return { name, ok: true, detail: `All ${rows.length} posted entries are balanced.` };
  }
  return {
    name,
    ok: false,
    detail: `${unbalanced.length} unbalanced entr${unbalanced.length === 1 ? 'y' : 'ies'} found: ${unbalanced.slice(0, 5).join(', ')}${unbalanced.length > 5 ? ` …+${unbalanced.length - 5} more` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Check 2: Cached account.balance matches GL-derived balance.
// ---------------------------------------------------------------------------

/**
 * Compute each account's GL-derived natural balance and compare with the cached
 * column. Shared by the verify check and the 'account_balances' rebuild action.
 */
async function computeAccountBalanceDrifts(
  ctx: ServiceContext,
): Promise<Array<{ accountId: string; code: string; cached: string; derived: string }>> {
  // Compute GL-derived natural balance per account from posted entries.
  const glRows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(accounts.companyId, ctx.companyId),
      ),
    )
    .groupBy(journalEntryLines.accountId);

  // Load all account rows for this company (to get cached balance + type).
  const accountRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, type: accounts.type, balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));

  const glByAccountId = new Map(glRows.map((r) => [r.accountId, r]));

  const drifts: Array<{ accountId: string; code: string; cached: string; derived: string }> = [];
  for (const acct of accountRows) {
    const gl = glByAccountId.get(acct.id);
    const derivedDebit = Money.of(gl?.totalDebit ?? 0);
    const derivedCredit = Money.of(gl?.totalCredit ?? 0);
    const debitNet = derivedDebit.minus(derivedCredit);
    // Natural balance: debit-normal types use debitNet, credit-normal use negated.
    const glBalance = DEBIT_NORMAL.has(acct.type) ? debitNet : debitNet.negated();
    if (!Money.eq(glBalance, acct.balance)) {
      drifts.push({
        accountId: acct.id,
        code: acct.code,
        cached: toAmountString(acct.balance),
        derived: toAmountString(glBalance),
      });
    }
  }
  return drifts;
}

async function checkCachedBalances(ctx: ServiceContext): Promise<IntegrityCheck> {
  const name = 'Cached account balances match GL';

  const [drifts, [{ total }]] = await Promise.all([
    computeAccountBalanceDrifts(ctx),
    ctx.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId)),
  ]);

  if (drifts.length === 0) {
    return { name, ok: true, detail: `All ${total} account balances are consistent with the GL.` };
  }
  const mismatches = drifts.map((d) => `${d.code} (cached ${d.cached}, GL ${d.derived})`);
  return {
    name,
    ok: false,
    detail: `${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}: ${mismatches.slice(0, 3).join('; ')}${mismatches.length > 3 ? ` …+${mismatches.length - 3} more` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Check 3: A/R control account (code 1200) balance == sum of open invoice balanceDue.
// ---------------------------------------------------------------------------
async function checkARControl(ctx: ServiceContext): Promise<IntegrityCheck> {
  const name = 'A/R control account (1200) matches open invoices';

  // Look up the 1200 account.
  const [arAccount] = await ctx.db
    .select({ id: accounts.id, balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1200')));

  if (!arAccount) {
    return { name, ok: true, detail: 'Account 1200 (A/R) not found — check skipped.' };
  }

  // Sum balanceDue across open/partial/overdue invoices for this company.
  const [invRow] = await ctx.db
    .select({
      totalDue: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        // Only statuses that still have an outstanding balance.
        sql`${invoices.status} IN ('open', 'partial', 'overdue')`,
      ),
    );

  const arBalance = Money.of(arAccount.balance);
  // Named General Journal lines on A/R are customer open items too (journal.ts journalOpenItems).
  const journalItems = (await journalOpenItems(ctx, 'ar')).filter((j) => j.accountId === arAccount.id);
  // Unapplied customer payments were credited to A/R in full, so they are credits here too.
  const unappliedCredits = (await unappliedCustomerPayments(ctx)).reduce(
    (sum, p) => sum.plus(Money.of(p.amount)),
    Money.zero(),
  );
  // Credit memos credit A/R in full at creation; the part not yet applied to an invoice is
  // still a customer credit (QB shows it as a negative open item), so it nets against A/R too.
  const [memoRow] = await ctx.db
    .select({
      unapplied: sql<string>`COALESCE(SUM(CAST(${creditMemos.unapplied} AS NUMERIC)), 0)`,
    })
    .from(creditMemos)
    .where(
      and(
        eq(creditMemos.companyId, ctx.companyId),
        ne(creditMemos.status, 'void'),
        sql`CAST(${creditMemos.unapplied} AS NUMERIC) > 0`,
      ),
    );
  const unappliedMemos = Money.of(memoRow?.unapplied ?? 0);
  const invoicesDue = Money.of(invRow?.totalDue ?? 0)
    .plus(journalItems.reduce((sum, j) => sum.plus(Money.of(j.amount)), Money.zero()))
    .minus(unappliedCredits)
    .minus(unappliedMemos);

  if (Money.equalWithinCent(arBalance, invoicesDue)) {
    return {
      name,
      ok: true,
      detail: `A/R balance ${toAmountString(arBalance)} matches open invoice balanceDue ${toAmountString(invoicesDue)}.`,
    };
  }
  // Journal entries made before names were required can hit A/R with no customer. Those amounts
  // are in the GL but in no customer's balance; tell the user how to fix it.
  const [unnamed] = await ctx.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, arAccount.id),
        generalJournalSourceSql(),
        sql`${journalEntryLines.entityId} IS NULL`,
      ),
    );
  const unnamedCount = Number(unnamed?.n ?? 0);
  const hint =
    unnamedCount > 0
      ? ` ${unnamedCount} journal entry line(s) on Accounts Receivable have no customer name (entered before names were required). Reverse each one and re-enter it with the customer in the Name column so it shows in that customer's balance.`
      : '';
  return {
    name,
    ok: false,
    detail: `A/R cached balance ${toAmountString(arBalance)} != open invoice balanceDue ${toAmountString(invoicesDue)} (diff ${toAmountString(arBalance.minus(invoicesDue))}).${hint}`,
  };
}

// ---------------------------------------------------------------------------
// Check 4: No journal_entry_lines reference an account from another company.
// ---------------------------------------------------------------------------
async function checkCrossCompanyLines(ctx: ServiceContext): Promise<IntegrityCheck> {
  const name = 'No cross-company journal entry lines';

  // Find lines where the entry belongs to this company but the account does not.
  const leaks = await ctx.db
    .select({ lineId: journalEntryLines.id })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        ne(accounts.companyId, ctx.companyId),
      ),
    );

  if (leaks.length === 0) {
    return { name, ok: true, detail: 'No cross-company account references found.' };
  }
  return {
    name,
    ok: false,
    detail: `${leaks.length} journal entry line${leaks.length === 1 ? '' : 's'} reference accounts from another company.`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifyIntegrity(ctx: ServiceContext): Promise<IntegrityResult> {
  const checks = await Promise.all([
    checkEntriesBalanced(ctx),
    checkCachedBalances(ctx),
    checkARControl(ctx),
    checkCrossCompanyLines(ctx),
    checkLedgerGuards(ctx),
  ]);

  return { checks, allOk: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------------------
// Check 5: the database-level ledger guards are installed and enabled.
// ---------------------------------------------------------------------------

/** Triggers installed by drizzle/0017_team_ledger.sql, keyed by name → what they guarantee. */
export const LEDGER_GUARD_TRIGGERS: Record<string, string> = {
  bka_jel_balanced: 'Posted entries must balance (checked at commit, lines)',
  bka_je_balanced: 'Posted entries must balance (checked at commit, headers)',
  bka_jel_guard: 'Posted journal lines are immutable',
  bka_je_guard: 'Posted journal entries cannot be deleted, re-dated or un-voided',
  bka_jel_sync_ins: 'Account balances follow new journal lines',
  bka_jel_sync_upd: 'Account balances follow changed journal lines',
  bka_jel_sync_del: 'Account balances follow removed journal lines',
  bka_je_sync_upd: 'Account balances follow post / void transitions',
  bka_accounts_guard: 'Account balances cannot be edited directly',
  bka_jel_no_truncate: 'Journal lines cannot be truncated',
  bka_je_no_truncate: 'Journal entries cannot be truncated',
  // drizzle/0025_wave2_foundation.sql
  bka_jel_non_posting: 'Non-posting accounts never carry posted amounts (lines)',
  bka_je_non_posting: 'Non-posting accounts never carry posted amounts (post transitions)',
  bka_accounts_non_posting: 'Accounts with history cannot become non-posting',
  bka_transfers_no_ar_ap: 'Transfers never move money into or out of A/R or A/P',
};

async function ledgerGuardStatus(ctx: ServiceContext): Promise<{ missing: string[]; total: number }> {
  // Every guard must be ENABLE ALWAYS (tgenabled 'A'). Origin mode ('O') is skipped when a
  // session sets session_replication_role = replica, so it does not count as active.
  const res = await ctx.db.execute(
    sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'A' AND tgname LIKE 'bka%'`,
  );
  const rows = (res as unknown as { rows: Array<{ tgname: string }> }).rows ?? [];
  const present = new Set(rows.map((r) => r.tgname));
  const expected = Object.keys(LEDGER_GUARD_TRIGGERS);
  return { missing: expected.filter((t) => !present.has(t)), total: expected.length };
}

async function checkLedgerGuards(ctx: ServiceContext): Promise<IntegrityCheck> {
  const name = 'Database ledger guards active';
  const { missing, total } = await ledgerGuardStatus(ctx);
  if (missing.length === 0) {
    return {
      name,
      ok: true,
      detail: `All ${total} database guards are active: unbalanced or altered posted entries and hand-edited balances are refused.`,
    };
  }
  return {
    name,
    ok: false,
    detail: `${missing.length} database guard${missing.length === 1 ? ' is' : 's are'} missing or disabled: ${missing.join(', ')}. Reopen the company file to re-run migrations.`,
  };
}

// ---------------------------------------------------------------------------
// Live "Books in balance" status
// ---------------------------------------------------------------------------

export interface BooksInBalanceSection {
  ok: boolean;
  /** Human-readable totals, e.g. "Debits 1,000.00 = Credits 1,000.00". */
  detail: string;
}

export interface BooksInBalance {
  inBalance: boolean;
  checkedAt: string;
  trialBalance: BooksInBalanceSection & { totalDebit: string; totalCredit: string };
  balanceSheet: BooksInBalanceSection & { totalAssets: string; totalLiabilitiesAndEquity: string };
  cashBasisBalanceSheet: BooksInBalanceSection & { totalAssets: string; totalLiabilitiesAndEquity: string };
  accountBalances: BooksInBalanceSection & { drifted: number };
  guards: BooksInBalanceSection & { missing: string[] };
}

/** Run a report; an INTEGRITY failure becomes a failed section instead of an exception. */
async function safely<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof LedgerIntegrityError) return { error: err.message };
    throw err;
  }
}

/**
 * The live "Books in balance" check: trial balance debits = credits, accrual and cash-basis
 * balance sheets balance, every cached account balance equals its ledger-derived balance, and
 * the database guards that make all of this impossible to break are in place.
 */
export async function booksInBalance(ctx: ServiceContext): Promise<BooksInBalance> {
  const [tb, bs, cash, drifts, guards] = await Promise.all([
    safely(() => trialBalance(ctx)),
    safely(() => balanceSheet(ctx)),
    safely(() => balanceSheetCashBasis(ctx)),
    computeAccountBalanceDrifts(ctx),
    ledgerGuardStatus(ctx),
  ]);

  const tbSection = tb.value
    ? {
        ok: tb.value.balanced,
        detail: `Debits ${tb.value.totalDebit} = Credits ${tb.value.totalCredit}`,
        totalDebit: tb.value.totalDebit,
        totalCredit: tb.value.totalCredit,
      }
    : { ok: false, detail: tb.error ?? 'Trial balance failed', totalDebit: '', totalCredit: '' };

  const bsSection = bs.value
    ? {
        ok: bs.value.balanced,
        detail: `Assets ${bs.value.totalAssets} = Liabilities + Equity ${toAmountString(
          Money.add(bs.value.totalLiabilities, bs.value.totalEquity),
        )}`,
        totalAssets: bs.value.totalAssets,
        totalLiabilitiesAndEquity: toAmountString(Money.add(bs.value.totalLiabilities, bs.value.totalEquity)),
      }
    : { ok: false, detail: bs.error ?? 'Balance sheet failed', totalAssets: '', totalLiabilitiesAndEquity: '' };

  const cashSection = cash.value
    ? {
        ok: cash.value.balanced,
        detail: `Assets ${cash.value.totals.totalAssets} = Liabilities + Equity ${cash.value.totals.totalLiabilitiesAndEquity}`,
        totalAssets: cash.value.totals.totalAssets,
        totalLiabilitiesAndEquity: cash.value.totals.totalLiabilitiesAndEquity,
      }
    : { ok: false, detail: cash.error ?? 'Cash-basis balance sheet failed', totalAssets: '', totalLiabilitiesAndEquity: '' };

  const balSection = {
    ok: drifts.length === 0,
    detail:
      drifts.length === 0
        ? 'Every account balance equals the sum of its posted journal lines.'
        : `${drifts.length} account balance${drifts.length === 1 ? '' : 's'} differ from the ledger.`,
    drifted: drifts.length,
  };

  const guardSection = {
    ok: guards.missing.length === 0,
    detail:
      guards.missing.length === 0
        ? `All ${guards.total} database guards active.`
        : `Missing or disabled: ${guards.missing.join(', ')}.`,
    missing: guards.missing,
  };

  return {
    inBalance: tbSection.ok && bsSection.ok && cashSection.ok && balSection.ok && guardSection.ok,
    checkedAt: new Date().toISOString(),
    trialBalance: tbSection,
    balanceSheet: bsSection,
    cashBasisBalanceSheet: cashSection,
    accountBalances: balSection,
    guards: guardSection,
  };
}

// ===========================================================================
// REBUILD DATA (QB Verify/Rebuild parity)
//
// Each action repairs ONE class of safe drift by recomputing a cached value
// from its source of truth. Every action is:
//   - previewable  : previewRebuild() returns the exact fixes without writing
//   - idempotent   : a second apply finds zero drift
//   - audited      : applyRebuild() writes one audit row describing the batch
// ===========================================================================

export type RebuildAction =
  | 'account_balances'
  | 'document_balances'
  | 'item_quantities'
  | 'orphaned_audit_refs';

export const REBUILD_ACTIONS: Array<{ action: RebuildAction; title: string; description: string }> = [
  {
    action: 'account_balances',
    title: 'Recompute account balances from the GL',
    description:
      'Resets each account’s cached balance to the sum of its posted journal entry lines.',
  },
  {
    action: 'document_balances',
    title: 'Recompute invoice & bill balances',
    description:
      'Recomputes invoice balance due from amount paid, and bill amount paid / balance due from payment applications.',
  },
  {
    action: 'item_quantities',
    title: 'Recompute inventory quantities from FIFO layers',
    description:
      'Resets each inventory item’s quantity on hand to the sum of its remaining FIFO cost layers.',
  },
  {
    action: 'orphaned_audit_refs',
    title: 'Remove orphaned audit references',
    description:
      'Deletes audit rows that point at records which no longer exist and have no recorded deletion (data damage).',
  },
];

/** One concrete repair: what record, what it says now, what it will say after. */
export interface RebuildFix {
  /** Target row id (account/invoice/bill/item/audit-log id). */
  id: string;
  /** Human-readable target, e.g. "Account 1000" or "Invoice #12". */
  label: string;
  current: string;
  expected: string;
}

export interface RebuildPreview {
  action: RebuildAction;
  fixes: RebuildFix[];
  count: number;
}

// ---- account_balances -----------------------------------------------------

async function computeAccountBalanceFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const drifts = await computeAccountBalanceDrifts(ctx);
  return drifts.map((d) => ({
    id: d.accountId,
    label: `Account ${d.code}`,
    current: `balance ${d.cached}`,
    expected: `balance ${d.derived}`,
  }));
}

async function applyAccountBalanceFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const drifts = await computeAccountBalanceDrifts(ctx);
  for (const d of drifts) {
    await ctx.db
      .update(accounts)
      .set({ balance: d.derived, updatedAt: new Date() })
      .where(and(eq(accounts.id, d.accountId), eq(accounts.companyId, ctx.companyId)));
  }
  return drifts.map((d) => ({
    id: d.accountId,
    label: `Account ${d.code}`,
    current: `balance ${d.cached}`,
    expected: `balance ${d.derived}`,
  }));
}

// ---- document_balances ----------------------------------------------------

interface InvoiceFix extends RebuildFix {
  newBalanceDue: string;
  newStatus: string;
}

/**
 * Invoices: balanceDue must equal (total − retainage) − amountPaid, mirroring
 * markPaidAmount. amountPaid itself is trusted (credit-memo applications add to
 * it without an application row, so it cannot be re-derived from rows alone).
 */
async function computeInvoiceFixes(ctx: ServiceContext): Promise<InvoiceFix[]> {
  const rows = await ctx.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      total: invoices.total,
      retainageAmount: invoices.retainageAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), notInArray(invoices.status, ['void', 'draft'])));

  const fixes: InvoiceFix[] = [];
  for (const inv of rows) {
    const billedBase = Money.round2(Money.of(inv.total).minus(Money.of(inv.retainageAmount ?? 0)));
    const newBalance = Money.round2(billedBase.minus(Money.of(inv.amountPaid)));
    const newBalanceDue = toAmountString(Money.abs(newBalance)); // guard tiny negative rounding
    const newStatus = newBalance.lessThanOrEqualTo(0)
      ? 'paid'
      : Money.isPositive(inv.amountPaid)
        ? 'partial'
        : inv.status === 'overdue'
          ? 'overdue' // keep overdue flag — it is still open
          : 'open';
    if (!Money.eq(inv.balanceDue, newBalanceDue) || inv.status !== newStatus) {
      fixes.push({
        id: inv.id,
        label: `Invoice #${inv.invoiceNumber}`,
        current: `balanceDue ${toAmountString(inv.balanceDue)}, status ${inv.status}`,
        expected: `balanceDue ${newBalanceDue}, status ${newStatus}`,
        newBalanceDue,
        newStatus,
      });
    }
  }
  return fixes;
}

interface BillFix extends RebuildFix {
  newAmountPaid: string;
  newBalanceDue: string;
  newStatus: string;
}

/**
 * Bills: amountPaid is re-derived from bill payment applications (void payments
 * delete their applications, so the surviving rows ARE the truth), then
 * balanceDue = total − amountPaid − amountCredited.
 */
async function computeBillFixes(ctx: ServiceContext): Promise<BillFix[]> {
  const rows = await ctx.db
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      total: bills.total,
      amountPaid: bills.amountPaid,
      amountCredited: bills.amountCredited,
      balanceDue: bills.balanceDue,
      status: bills.status,
    })
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), notInArray(bills.status, ['void', 'draft'])));

  const appRows = await ctx.db
    .select({
      billId: billPaymentApplications.billId,
      applied: sql<string>`COALESCE(SUM(${billPaymentApplications.amountApplied}), 0)`,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .where(and(eq(billPayments.companyId, ctx.companyId), isNull(billPayments.voidedAt)))
    .groupBy(billPaymentApplications.billId);
  const appliedByBill = new Map(appRows.map((r) => [r.billId, r.applied]));

  const fixes: BillFix[] = [];
  for (const bill of rows) {
    const newAmountPaid = toAmountString(appliedByBill.get(bill.id) ?? 0);
    const newBalance = Money.round2(
      Money.of(bill.total).minus(Money.of(newAmountPaid)).minus(Money.of(bill.amountCredited)),
    );
    const newBalanceDue = toAmountString(Money.abs(newBalance));
    const settledAny = Money.isPositive(newAmountPaid) || Money.isPositive(bill.amountCredited);
    const newStatus = newBalance.lessThanOrEqualTo(0)
      ? 'paid'
      : settledAny
        ? 'partial'
        : bill.status === 'overdue'
          ? 'overdue'
          : 'open';
    if (
      !Money.eq(bill.amountPaid, newAmountPaid) ||
      !Money.eq(bill.balanceDue, newBalanceDue) ||
      bill.status !== newStatus
    ) {
      fixes.push({
        id: bill.id,
        label: `Bill ${bill.billNumber ?? bill.id.slice(0, 8)}`,
        current: `amountPaid ${toAmountString(bill.amountPaid)}, balanceDue ${toAmountString(bill.balanceDue)}, status ${bill.status}`,
        expected: `amountPaid ${newAmountPaid}, balanceDue ${newBalanceDue}, status ${newStatus}`,
        newAmountPaid,
        newBalanceDue,
        newStatus,
      });
    }
  }
  return fixes;
}

async function computeDocumentBalanceFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const [inv, bill] = await Promise.all([computeInvoiceFixes(ctx), computeBillFixes(ctx)]);
  return [...inv, ...bill];
}

async function applyDocumentBalanceFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const invFixes = await computeInvoiceFixes(ctx);
  for (const f of invFixes) {
    await ctx.db
      .update(invoices)
      .set({ balanceDue: f.newBalanceDue, status: f.newStatus as never, updatedAt: new Date() })
      .where(and(eq(invoices.id, f.id), eq(invoices.companyId, ctx.companyId)));
  }
  const billFixes = await computeBillFixes(ctx);
  for (const f of billFixes) {
    await ctx.db
      .update(bills)
      .set({
        amountPaid: f.newAmountPaid,
        balanceDue: f.newBalanceDue,
        status: f.newStatus as never,
        updatedAt: new Date(),
      })
      .where(and(eq(bills.id, f.id), eq(bills.companyId, ctx.companyId)));
  }
  return [...invFixes, ...billFixes];
}

// ---- item_quantities --------------------------------------------------------

interface ItemQtyFix extends RebuildFix {
  newQty: string;
}

/** Inventory items: quantityOnHand must equal the sum of remaining FIFO layers. */
async function computeItemQuantityFixes(ctx: ServiceContext): Promise<ItemQtyFix[]> {
  const itemRows = await ctx.db
    .select({ id: items.id, name: items.name, quantityOnHand: items.quantityOnHand })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));

  const layerRows = await ctx.db
    .select({
      itemId: inventoryLayers.itemId,
      qty: sql<string>`COALESCE(SUM(${inventoryLayers.quantityRemaining}), 0)`,
    })
    .from(inventoryLayers)
    .where(eq(inventoryLayers.companyId, ctx.companyId))
    .groupBy(inventoryLayers.itemId);
  const qtyByItem = new Map(layerRows.map((r) => [r.itemId, r.qty]));

  const fixes: ItemQtyFix[] = [];
  for (const item of itemRows) {
    const expected = Money.of(qtyByItem.get(item.id) ?? 0);
    const current = Money.of(item.quantityOnHand ?? 0);
    if (!Money.eq(current, expected)) {
      const newQty = expected.toFixed(4);
      fixes.push({
        id: item.id,
        label: `Item ${item.name}`,
        current: `quantityOnHand ${current.toFixed(4)}`,
        expected: `quantityOnHand ${newQty}`,
        newQty,
      });
    }
  }
  return fixes;
}

async function applyItemQuantityFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const fixes = await computeItemQuantityFixes(ctx);
  for (const f of fixes) {
    await ctx.db
      .update(items)
      .set({ quantityOnHand: f.newQty, updatedAt: new Date() })
      .where(and(eq(items.id, f.id), eq(items.companyId, ctx.companyId)));
  }
  return fixes;
}

// ---- orphaned_audit_refs ----------------------------------------------------

/** Audit entityTypes we can verify against a real table. Unknown types are never touched. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AUDIT_ENTITY_TABLES: Record<string, { table: any; idCol: any }> = {
  account: { table: accounts, idCol: accounts.id },
  journal_entry: { table: journalEntries, idCol: journalEntries.id },
  customer: { table: customers, idCol: customers.id },
  vendor: { table: vendors, idCol: vendors.id },
  item: { table: items, idCol: items.id },
  invoice: { table: invoices, idCol: invoices.id },
  bill: { table: bills, idCol: bills.id },
  employee: { table: employees, idCol: employees.id },
  class: { table: classes, idCol: classes.id },
};

/**
 * An audit row is ORPHANED when it references an entity that no longer exists
 * AND no delete/void was ever recorded for that entity — i.e. the entity
 * vanished outside the books (data damage), so the reference is dangling.
 * Rows that document a legitimate deletion are kept (that IS the audit trail).
 */
async function computeOrphanedAuditFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const rows = await ctx.db
    .select({
      id: auditLogs.id,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      action: auditLogs.action,
    })
    .from(auditLogs)
    .where(eq(auditLogs.companyId, ctx.companyId));

  // Entities with a recorded delete/void are legitimate history, never orphans.
  const legitimized = new Set(
    rows.filter((r) => r.action === 'delete' || r.action === 'void').map((r) => `${r.entityType}:${r.entityId}`),
  );

  const fixes: RebuildFix[] = [];
  for (const [entityType, spec] of Object.entries(AUDIT_ENTITY_TABLES)) {
    const typed = rows.filter((r) => r.entityType === entityType);
    if (!typed.length) continue;
    const ids = [...new Set(typed.map((r) => r.entityId))];
    const existing = await ctx.db
      .select({ id: spec.idCol as typeof auditLogs.id })
      .from(spec.table)
      .where(inArray(spec.idCol, ids));
    const existingIds = new Set(existing.map((e) => e.id));
    for (const r of typed) {
      if (existingIds.has(r.entityId)) continue;
      if (legitimized.has(`${r.entityType}:${r.entityId}`)) continue;
      fixes.push({
        id: r.id,
        label: `Audit row (${r.action} ${r.entityType})`,
        current: `references missing ${r.entityType} ${r.entityId}`,
        expected: 'remove orphaned audit row',
      });
    }
  }
  return fixes;
}

async function applyOrphanedAuditFixes(ctx: ServiceContext): Promise<RebuildFix[]> {
  const fixes = await computeOrphanedAuditFixes(ctx);
  if (fixes.length) {
    await ctx.db
      .delete(auditLogs)
      .where(
        and(eq(auditLogs.companyId, ctx.companyId), inArray(auditLogs.id, fixes.map((f) => f.id))),
      );
  }
  return fixes;
}

// ---- public API ---------------------------------------------------------------

const PREVIEWERS: Record<RebuildAction, (ctx: ServiceContext) => Promise<RebuildFix[]>> = {
  account_balances: computeAccountBalanceFixes,
  document_balances: computeDocumentBalanceFixes,
  item_quantities: async (ctx) => computeItemQuantityFixes(ctx),
  orphaned_audit_refs: computeOrphanedAuditFixes,
};

const APPLIERS: Record<RebuildAction, (ctx: ServiceContext) => Promise<RebuildFix[]>> = {
  account_balances: applyAccountBalanceFixes,
  document_balances: applyDocumentBalanceFixes,
  item_quantities: applyItemQuantityFixes,
  orphaned_audit_refs: applyOrphanedAuditFixes,
};

export function isRebuildAction(value: string): value is RebuildAction {
  return Object.prototype.hasOwnProperty.call(PREVIEWERS, value);
}

/** Dry-run: list exactly what applyRebuild(action) would change, without writing. */
export async function previewRebuild(ctx: ServiceContext, action: RebuildAction): Promise<RebuildPreview> {
  const previewer = PREVIEWERS[action];
  if (!previewer) throw new ServiceError('VALIDATION', `Unknown rebuild action "${action}".`);
  const fixes = await previewer(ctx);
  return { action, fixes, count: fixes.length };
}

export interface RebuildResult {
  action: RebuildAction;
  fixed: number;
  fixes: RebuildFix[];
}

/**
 * Apply one rebuild action inside a single transaction. The drift is recomputed
 * inside the transaction (never trusted from an earlier preview), each repair is
 * idempotent (a second run fixes 0 rows), and the batch is recorded in the audit
 * trail with every fix it made.
 */
export async function applyRebuild(ctx: ServiceContext, action: RebuildAction): Promise<RebuildResult> {
  const applier = APPLIERS[action];
  if (!applier) throw new ServiceError('VALIDATION', `Unknown rebuild action "${action}".`);

  return inTransaction(ctx, async (tx) => {
    const fixes = await applier(tx);
    if (fixes.length) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'data_rebuild',
        entityId: randomUUID(),
        newValues: { rebuildAction: action, fixed: fixes.length, fixes },
      });
    }
    return { action, fixed: fixes.length, fixes };
  });
}
