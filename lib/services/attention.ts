/**
 * "Needs attention" inbox (team home): ONE prioritized list of everything waiting on the
 * signed-in person, most urgent first.
 *
 * Item kinds (each built from one or two company-scoped queries):
 *  - bank_txn         bank-feed transactions waiting to be sorted (categorized)       Banking: create
 *  - overdue_invoice  customer invoices past their due date (with days overdue)       Customers: view
 *  - bill_due         vendor bills overdue or due within 7 days                       Vendors: create
 *  - ai_error         open findings of the error scan (AI Review)                     Accounting: view
 *  - reconcile        bank / credit-card accounts not reconciled through last month   Accounting: create
 *  - payroll_tax      payroll taxes withheld that are due to be deposited             Payroll: create
 *  - todo             to-dos due today or earlier (mine or unassigned)                any member
 *  - backup           no backup of the company file in the last 7 days                File admin
 *  - undeposited      customer payments sitting in Undeposited Funds for N+ days      Banking: create
 *
 * Only items the person can act on are returned (Users & Roles). Each person can snooze an item
 * (1 day / 1 week) or dismiss it; that state lives in attention_item_states, keyed by a stable
 * item key, so a dismissed "reconcile through September" comes back by itself for October.
 *
 * Read-only apart from the snooze/dismiss state, the payment-reminder email (audited) and the
 * Back up now action. Postings never happen here: the inbox's one-click actions call the same
 * services/routes as the full screens (categorize → bankCategorize.categorize → posting.ts).
 * Works fully with AI off: the AI error kind lists the rules-based scan's stored findings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  accounts,
  attentionItemStates,
  auditLogs,
  backupLog,
  bankAccounts,
  bankTransactions,
  bills,
  companies,
  customers,
  errorDetections,
  invoices,
  journalEntries,
  journalEntryLines,
  reconciliations,
  todos,
  vendors,
} from '@/lib/db/schema';
import type { DB } from '@/lib/db';
import { resolveDataDir } from '@/lib/db';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import { can, type Action, type Area } from '@/lib/permissions/model';
import { addDaysIso, todayInTimeZone } from '@/lib/preferences';
import { ServiceError, notFound, validation, writeAudit, type ServiceContext } from './_base';
import { getCompany, getPreferences } from './company';
import { listUndepositedPayments } from './deposits';
import { canSeeTodoLink } from './todos';
import { requireFileAdmin } from './access';
import { isConfigured as emailIsConfigured, sendMail } from './email';
import { createBackup } from './backup';
import { buildInvoicePdf } from '@/lib/pdf/forms';
import { ATTENTION_KINDS, type AttentionKind } from '@/lib/attentionKinds';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export { ATTENTION_KINDS, ATTENTION_KIND_LABELS, type AttentionKind } from '@/lib/attentionKinds';

/** How the item is fixed in one click. */
export type AttentionAction =
  | { type: 'categorize' }
  | { type: 'email_reminder' }
  | { type: 'open'; label: string; href: string }
  | { type: 'mark_done' }
  | { type: 'backup_now' };

export type AttentionSeverity = 'urgent' | 'due' | 'upcoming';

export interface AttentionItem {
  /** Stable id for snooze / dismiss ('<kind>:<…>'). */
  key: string;
  kind: AttentionKind;
  /** One plain-language line: what needs doing. */
  title: string;
  /** Second line: why / when. */
  detail: string;
  /** Money involved (2dp string), when there is one. */
  amount: string | null;
  /** The date that matters ('YYYY-MM-DD'): due date, transaction date, statement date… */
  date: string | null;
  /** Higher = more urgent. Roughly "days late", weighted by what being late costs. */
  urgency: number;
  severity: AttentionSeverity;
  /** The full screen for this item (always available as "Open"). */
  href: string;
  action: AttentionAction;
  /** Kind-specific facts the inline action needs. */
  data: Record<string, unknown>;
  /** Present only when listed with includeHidden: why it is hidden. */
  hidden?: { snoozedUntil: string | null; dismissed: boolean };
}

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface AttentionResult {
  asOf: string;
  /** Visible (not snoozed / dismissed) items, most urgent first; at most PER_KIND_LIMIT per kind. */
  items: AttentionItem[];
  /** Visible items per kind (full counts, even when the list is capped). */
  counts: Record<AttentionKind, number>;
  total: number;
  /** Items this person snoozed or dismissed (count). */
  hiddenCount: number;
  /** Snoozed / dismissed items themselves (only with includeHidden). */
  hidden?: AttentionItem[];
  /** Accounts for the inline "what was it for?" picker (only when bank items are listed). */
  accountOptions: AccountOption[];
  /** Whether outgoing email (SMTP) is set up on this computer. */
  emailConfigured: boolean;
}

export interface AttentionOptions {
  /** 'YYYY-MM-DD' (defaults to today in the company's time zone). */
  today?: string;
  /** Current moment, for snooze comparisons (tests). */
  now?: Date;
  /** Also return the snoozed / dismissed items. */
  includeHidden?: boolean;
  /** Skip the extras the list view needs (suggestions, account picker): the sidebar badge. */
  countOnly?: boolean;
  /** Undeposited Funds older than this many days are flagged (default 3). */
  undepositedDays?: number;
}

export const BILL_HORIZON_DAYS = 7;
export const BACKUP_STALE_DAYS = 7;
export const DEFAULT_UNDEPOSITED_DAYS = 3;
export const PER_KIND_LIMIT = 50;
export const SNOOZE_DAYS = [1, 7] as const;

const OPEN_DOC_STATUSES = ['open', 'partial', 'overdue'] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function allowed(ctx: ServiceContext, area: Area, action: Action = 'view'): boolean {
  return !ctx.access || can(ctx.access, area, action);
}

function isoDay(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

/** Whole days from a to b ('YYYY-MM-DD'): positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function endOfDay(iso: string): Date {
  return new Date(`${iso}T23:59:59.999Z`);
}

/** Last day of the month before `today` ('YYYY-MM-DD'). */
export function lastMonthEnd(today: string): string {
  const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function monthEndOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** Month ends after `from` up to and including `to` (both 'YYYY-MM-DD'). */
function monthEndsBetween(from: string | null, to: string): number {
  if (!from) return 0;
  let n = 0;
  let cur = monthEndOf(from);
  if (cur <= from) cur = monthEndOf(addDaysIso(cur, 1));
  while (cur <= to && n < 600) {
    n++;
    cur = monthEndOf(addDaysIso(cur, 1));
  }
  return n;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'Oct 3, 2026' */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function severityOf(urgency: number): AttentionSeverity {
  if (urgency >= 14) return 'urgent';
  if (urgency >= 0) return 'due';
  return 'upcoming';
}

function item(i: Omit<AttentionItem, 'severity'>): AttentionItem {
  return { ...i, severity: severityOf(i.urgency) };
}

const docNo = (ref: string | null, n: number | null) => (ref && ref.trim() ? ref.trim() : n != null ? String(n) : '');

// ---------------------------------------------------------------------------
// Payment reminder text (email body, or copy / mailto when email isn't set up)
// ---------------------------------------------------------------------------

export function paymentReminderText(p: {
  customerName: string;
  invoiceNumber: string;
  balance: string;
  dueDate: string | null;
  daysOverdue: number;
  companyName: string;
}): { subject: string; body: string } {
  const amount = formatCurrency(p.balance);
  const due = p.dueDate ? ` was due on ${shortDate(p.dueDate)}` : ' is past due';
  const late = p.daysOverdue > 0 ? ` (${plural(p.daysOverdue, 'day')} ago)` : '';
  return {
    subject: `Payment reminder: invoice ${p.invoiceNumber} from ${p.companyName}`,
    body: [
      `Dear ${p.customerName},`,
      '',
      `This is a friendly reminder that invoice ${p.invoiceNumber} for ${amount}${due}${late}.`,
      'If you have already sent your payment, thank you, and please ignore this message.',
      'Otherwise, we would appreciate payment at your earliest convenience. A copy of the invoice is attached.',
      '',
      'Thank you for your business.',
      p.companyName,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceEnv {
  ctx: ServiceContext;
  today: string;
  countOnly: boolean;
  /** Item keys of this kind the person hid (to keep bank-feed paging exact). */
  hiddenKeys: Set<string>;
  undepositedDays: number;
  companyName: string;
  companyCreatedAt: Date | null;
  payrollLiabilityAccountId: string | null;
}

interface SourceResult {
  items: AttentionItem[];
  /**
   * Visible items of this kind when the source paged its query (bank feed): `items` then holds
   * at most a page of visible items plus every hidden one.
   */
  pagedTotal?: number;
}

type Source = (env: SourceEnv) => Promise<SourceResult>;

/** Bank-feed lines not yet sorted: oldest first, with a suggestion from the rules or history. */
const bankTxnSource: Source = async ({ ctx, today, countOnly, hiddenKeys }) => {
  const hiddenIds = [...hiddenKeys].filter((k) => k.startsWith('bank_txn:')).map((k) => k.slice('bank_txn:'.length));
  const base = and(
    eq(bankTransactions.companyId, ctx.companyId),
    eq(bankTransactions.matched, false),
    eq(bankTransactions.excluded, false),
  );
  const visibleCond = hiddenIds.length ? and(base, notInArray(bankTransactions.id, hiddenIds)) : base;
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(bankTransactions)
    .where(visibleCond);
  const select = (where: ReturnType<typeof and>) => ctx.db
    .select({
      id: bankTransactions.id,
      date: bankTransactions.date,
      description: bankTransactions.description,
      payee: bankTransactions.payee,
      amount: bankTransactions.amount,
      suggestedAccountId: bankTransactions.suggestedAccountId,
      bankAccountId: bankTransactions.bankAccountId,
      bankGlAccountId: bankAccounts.accountId,
      bankName: bankAccounts.bankName,
      bankGlName: accounts.name,
    })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(where)
    .orderBy(asc(bankTransactions.date), asc(bankTransactions.createdAt));
  const rows = [
    ...(n > 0 ? await select(visibleCond).limit(PER_KIND_LIMIT) : []),
    // The person's hidden lines that still wait (so "Snoozed / dismissed" can list them).
    ...(hiddenIds.length ? await select(and(base, inArray(bankTransactions.id, hiddenIds))) : []),
  ];

  // Suggestion: the rule's account, else what the same payee was sorted to last time.
  const history = new Map<string, string>();
  if (!countOnly) {
    const names = [...new Set(rows.filter((r) => !r.suggestedAccountId).map((r) => (r.payee || r.description || '').trim().toLowerCase()))].filter(Boolean);
    if (names.length) {
      const nameExpr = sql<string>`lower(trim(coalesce(nullif(${bankTransactions.payee}, ''), ${bankTransactions.description}, '')))`;
      const past = await ctx.db
        .select({ name: nameExpr, accountId: journalEntryLines.accountId, bankGl: bankAccounts.accountId })
        .from(bankTransactions)
        .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
        .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, bankTransactions.matchedEntryId))
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
        .where(
          and(
            eq(bankTransactions.companyId, ctx.companyId),
            eq(bankTransactions.matched, true),
            eq(journalEntries.status, 'posted'),
            inArray(nameExpr, names),
          ),
        )
        .orderBy(desc(bankTransactions.date))
        .limit(500);
      for (const p of past) {
        if (p.accountId === p.bankGl || history.has(p.name)) continue;
        history.set(p.name, p.accountId);
      }
    }
  }

  const items = rows.map((r) => {
    const date = isoDay(r.date)!;
    const age = Math.max(0, daysBetween(date, today));
    const out = Money.isNegative(r.amount);
    const who = (r.payee || r.description || 'Bank transaction').trim();
    const nameKey = (r.payee || r.description || '').trim().toLowerCase();
    const suggestion = r.suggestedAccountId
      ? { accountId: r.suggestedAccountId, source: 'rule' as const }
      : history.has(nameKey)
        ? { accountId: history.get(nameKey)!, source: 'history' as const }
        : null;
    return item({
      key: `bank_txn:${r.id}`,
      kind: 'bank_txn',
      title: `Sort ${out ? 'payment' : 'deposit'}: ${who}`,
      detail: `${out ? 'Money out of' : 'Money into'} ${r.bankGlName} on ${shortDate(date)}. Choose what it was for.`,
      amount: toAmountString(Money.abs(r.amount)),
      date,
      // A week to sort the feed is normal; older lines keep the books out of date.
      urgency: age - 7,
      href: '/bank-review',
      action: { type: 'categorize' },
      data: {
        bankTransactionId: r.id,
        bankAccountId: r.bankAccountId,
        bankGlAccountId: r.bankGlAccountId,
        direction: out ? 'out' : 'in',
        payee: r.payee,
        description: r.description,
        suggestedAccountId: suggestion?.accountId ?? null,
        suggestionSource: suggestion?.source ?? null,
      },
    });
  });
  return { items, pagedTotal: n };
};

/** Invoices past due with money still owed. */
const overdueInvoiceSource: Source = async ({ ctx, today, countOnly, companyName }) => {
  const rows = await ctx.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
      currency: invoices.currency,
      customerId: customers.id,
      customerName: customers.displayName,
      customerEmail: customers.email,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoices.status, [...OPEN_DOC_STATUSES]),
        gt(invoices.balanceDue, '0'),
        isNotNull(invoices.dueDate),
        lt(invoices.dueDate, new Date(`${today}T00:00:00.000Z`)),
      ),
    )
    .orderBy(asc(invoices.dueDate));

  // When was a payment reminder last emailed (audit trail)?
  const lastSent = new Map<string, string>();
  if (!countOnly && rows.length) {
    const sent = await ctx.db
      .select({ id: auditLogs.entityId, at: sql<string>`MAX(${auditLogs.createdAt})` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'payment_reminder'),
          inArray(auditLogs.entityId, rows.map((r) => r.id)),
        ),
      )
      .groupBy(auditLogs.entityId);
    for (const s of sent) lastSent.set(s.id, isoDay(s.at) ?? '');
  }

  const canEmail = allowed(ctx, 'customers', 'print');
  const items = rows.map((r) => {
    const due = isoDay(r.dueDate)!;
    const days = daysBetween(due, today);
    const number = docNo(r.refNumber, r.invoiceNumber);
    const text = countOnly
      ? null
      : paymentReminderText({
          customerName: r.customerName,
          invoiceNumber: number,
          balance: r.balanceDue,
          dueDate: due,
          daysOverdue: days,
          companyName,
        });
    const sentOn = lastSent.get(r.id);
    return item({
      key: `overdue_invoice:${r.id}`,
      kind: 'overdue_invoice',
      title: `${r.customerName} is ${plural(days, 'day')} late paying invoice ${number}`,
      detail: `It was due ${shortDate(due)}.${sentOn ? ` You last sent a reminder on ${shortDate(sentOn)}.` : ''}`,
      amount: toAmountString(r.balanceDue),
      date: due,
      urgency: days,
      href: `/invoices?focus=${r.id}`,
      action: canEmail ? { type: 'email_reminder' } : { type: 'open', label: 'Open invoice', href: `/invoices?focus=${r.id}` },
      data: {
        invoiceId: r.id,
        invoiceNumber: number,
        customerId: r.customerId,
        customerName: r.customerName,
        customerEmail: r.customerEmail,
        daysOverdue: days,
        currency: r.currency,
        lastReminderOn: sentOn ?? null,
        reminder: text,
      },
    });
  });
  return { items };
};

/** Bills overdue or due within the next week. */
const billSource: Source = async ({ ctx, today }) => {
  const horizon = endOfDay(addDaysIso(today, BILL_HORIZON_DAYS));
  const dueExpr = sql<Date>`COALESCE(${bills.dueDate}, ${bills.date})`;
  const rows = await ctx.db
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      due: dueExpr,
      balanceDue: bills.balanceDue,
      vendorId: vendors.id,
      vendorName: vendors.displayName,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        inArray(bills.status, [...OPEN_DOC_STATUSES]),
        gt(bills.balanceDue, '0'),
        lte(dueExpr, horizon),
      ),
    )
    .orderBy(asc(dueExpr));
  const items = rows.map((r) => {
    const due = isoDay(r.due)!;
    const late = daysBetween(due, today); // > 0 overdue, 0 today, < 0 upcoming
    const name = `Bill${r.billNumber ? ` ${r.billNumber}` : ''} from ${r.vendorName}`;
    const title =
      late > 0 ? `${name} is ${plural(late, 'day')} overdue` : late === 0 ? `${name} is due today` : `${name} is due in ${plural(-late, 'day')}`;
    const href = `/pay-bills?vendor=${r.vendorId}&bill=${r.id}`;
    return item({
      key: `bill_due:${r.id}`,
      kind: 'bill_due',
      title,
      detail: `Due ${shortDate(due)}. Paying on time avoids late fees.`,
      amount: toAmountString(r.balanceDue),
      date: due,
      urgency: late + 3,
      href,
      action: { type: 'open', label: 'Pay', href },
      data: { billId: r.id, vendorId: r.vendorId, vendorName: r.vendorName, daysOverdue: Math.max(late, 0) },
    });
  });
  return { items };
};

const ERROR_TITLES: Record<string, string> = {
  unbalanced: "An entry doesn't balance",
  duplicate: 'Possible duplicate entry',
  missing_field: 'An entry is missing details',
  unusual_pattern: 'Unusually large amount',
  miscategorized: 'Possibly the wrong account',
  date_inconsistency: 'A date looks wrong',
  account_mismatch: "Accounts don't match",
};
const SEVERITY_URGENCY: Record<string, number> = { critical: 60, high: 30, medium: 5, low: -10 };

/** Open findings of the error scan (AI Review), worst first. */
const aiErrorSource: Source = async ({ ctx, today }) => {
  const rows = await ctx.db
    .select({
      id: errorDetections.id,
      errorType: errorDetections.errorType,
      severity: errorDetections.severity,
      description: errorDetections.description,
      detectedAt: errorDetections.detectedAt,
      journalEntryId: errorDetections.journalEntryId,
    })
    .from(errorDetections)
    .where(and(eq(errorDetections.companyId, ctx.companyId), isNull(errorDetections.resolvedAt)))
    .orderBy(asc(errorDetections.detectedAt));
  const items = rows.map((r) => {
    const found = isoDay(r.detectedAt) ?? today;
    const href = `/errors?focus=${r.id}`;
    return item({
      key: `ai_error:${r.id}`,
      kind: 'ai_error',
      title: ERROR_TITLES[r.errorType] ?? 'Possible mistake in your books',
      detail: r.description,
      amount: null,
      date: found,
      urgency: SEVERITY_URGENCY[r.severity] ?? 0,
      href,
      action: { type: 'open', label: 'See the fix', href },
      data: { detectionId: r.id, severity: r.severity, errorType: r.errorType, journalEntryId: r.journalEntryId },
    });
  });
  return { items };
};

/** Bank / credit-card accounts with activity not reconciled through the last month end. */
const reconcileSource: Source = async ({ ctx, today }) => {
  const through = lastMonthEnd(today);
  const rows = await ctx.db
    .select({
      id: bankAccounts.id,
      glAccountId: bankAccounts.accountId,
      lastReconciledDate: bankAccounts.lastReconciledDate,
      name: accounts.name,
      subtype: accounts.subtype,
      isActive: accounts.isActive,
      lastCompleted: sql<string | null>`(SELECT MAX(${reconciliations.statementDate}) FROM ${reconciliations} WHERE ${reconciliations.bankAccountId} = ${bankAccounts.id} AND ${reconciliations.status} = 'completed')`,
      inProgress: sql<number>`(SELECT COUNT(*)::int FROM ${reconciliations} WHERE ${reconciliations.bankAccountId} = ${bankAccounts.id} AND ${reconciliations.status} = 'in_progress')`,
      firstActivity: sql<string | null>`(SELECT MIN(${journalEntries.date}) FROM ${journalEntryLines} INNER JOIN ${journalEntries} ON ${journalEntries.id} = ${journalEntryLines.journalEntryId} WHERE ${journalEntryLines.accountId} = ${bankAccounts.accountId} AND ${journalEntries.companyId} = ${ctx.companyId} AND ${journalEntries.status} = 'posted')`,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
    .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(accounts.isActive, true)));
  const items: AttentionItem[] = [];
  for (const r of rows) {
    const first = isoDay(r.firstActivity);
    if (!first || first > through) continue; // nothing to reconcile through last month yet
    const done = [isoDay(r.lastReconciledDate), isoDay(r.lastCompleted)].filter(Boolean).sort().pop() ?? null;
    if (done && done >= through) continue;
    // Statements behind: month ends from the last reconciled one (or the first activity).
    const behind = done ? monthEndsBetween(done, through) : monthEndsBetween(addDaysIso(first, -1), through);
    // The oldest statement still waiting closed on this day.
    const oldest = done ? monthEndOf(addDaysIso(done, 1)) : monthEndOf(first);
    const waited = daysBetween(oldest, today);
    const isCard = r.subtype === 'credit_card';
    const href = `/reconcile?account=${r.id}&through=${through}`;
    items.push(
      item({
        key: `reconcile:${r.id}:${through}`,
        kind: 'reconcile',
        title: `Reconcile ${r.name} through ${shortDate(through)}`,
        detail: done
          ? `Last reconciled through ${shortDate(done)}. ${plural(Math.max(behind, 1), 'statement')} to check against your ${isCard ? 'card' : 'bank'} records.`
          : `Never reconciled. Compare it with your ${isCard ? 'card' : 'bank'} statements so you know the balance is right.`,
        amount: null,
        date: through,
        // About two weeks after month end is when statements arrive and reconciling is normal.
        urgency: waited - 15,
        href,
        action: { type: 'open', label: r.inProgress ? 'Continue reconciling' : 'Reconcile', href },
        data: { bankAccountId: r.id, through, lastReconciled: done, statementsBehind: Math.max(behind, 1) },
      }),
    );
  }
  return { items };
};

/**
 * Payroll taxes owed: the payroll liabilities account's credits by month (paychecks), paid off
 * oldest-first by its debits (deposits). Each month still owed is due the 15th of the next month
 * (monthly deposit schedule); shown from a week before it is due.
 */
const payrollTaxSource: Source = async ({ ctx, today, payrollLiabilityAccountId }) => {
  let liabId = payrollLiabilityAccountId;
  if (liabId) {
    const [ok] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, liabId), eq(accounts.companyId, ctx.companyId)));
    if (!ok) liabId = null;
  }
  if (!liabId) {
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2300')));
    liabId = row?.id ?? null;
  }
  if (!liabId) return { items: [] };
  const monthExpr = sql<string>`to_char(${journalEntries.date}, 'YYYY-MM')`;
  const rows = await ctx.db
    .select({
      month: monthExpr,
      credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, liabId),
      ),
    )
    .groupBy(monthExpr)
    .orderBy(monthExpr);
  let paid = Money.add(...rows.map((r) => r.debit));
  const items: AttentionItem[] = [];
  for (const r of rows) {
    let owed = Money.of(r.credit);
    const used = Money.lt(paid, owed) ? paid : owed;
    owed = owed.minus(used);
    paid = paid.minus(used);
    if (!owed.greaterThan(0)) continue;
    const [y, m] = r.month.split('-').map(Number);
    const due = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-15`;
    const late = daysBetween(due, today);
    if (late < -BILL_HORIZON_DAYS) continue;
    const when = late > 0 ? `was due ${shortDate(due)}` : late === 0 ? 'is due today' : `is due ${shortDate(due)}`;
    items.push(
      item({
        key: `payroll_tax:${r.month}`,
        kind: 'payroll_tax',
        title: `Deposit payroll taxes for ${MONTHS_LONG[m - 1]} ${y}`,
        detail: `Taxes withheld from ${MONTHS_LONG[m - 1]} paychecks ${when} (monthly deposit schedule). Late deposits carry IRS penalties.`,
        amount: toAmountString(owed),
        date: due,
        urgency: late + 10,
        href: '/pay-liabilities',
        action: { type: 'open', label: 'Pay', href: '/pay-liabilities' },
        data: { month: r.month, dueDate: due },
      }),
    );
  }
  return { items };
};

/** Open to-dos due today or earlier (or whose "remind me on" day came), mine or unassigned. */
const todoSource: Source = async ({ ctx, today }) => {
  const mine = ctx.userId
    ? or(isNull(todos.assignedUserId), eq(todos.assignedUserId, ctx.userId))
    : isNull(todos.assignedUserId);
  const rows = await ctx.db
    .select({
      id: todos.id,
      title: todos.title,
      dueDate: todos.dueDate,
      remindOn: todos.remindOn,
      priority: todos.priority,
      kind: todos.kind,
      entityType: todos.entityType,
    })
    .from(todos)
    .where(
      and(
        eq(todos.companyId, ctx.companyId),
        eq(todos.status, 'open'),
        mine,
        or(lte(todos.remindOn, today), and(isNull(todos.remindOn), lte(todos.dueDate, today))),
      ),
    )
    .orderBy(asc(todos.dueDate));
  const items = rows
    .filter((r) => canSeeTodoLink(ctx, r.entityType))
    .map((r) => {
      const late = r.dueDate ? daysBetween(r.dueDate, today) : 0;
      const bump = r.priority === 'high' ? 5 : r.priority === 'low' ? -3 : 0;
      return item({
        key: `todo:${r.id}`,
        kind: 'todo',
        title: r.title,
        detail: r.dueDate
          ? late > 0
            ? `To-do, ${plural(late, 'day')} overdue (due ${shortDate(r.dueDate)}).`
            : late === 0
              ? 'To-do, due today.'
              : `To-do, due ${shortDate(r.dueDate)}.`
          : 'To-do reminder.',
        amount: null,
        date: r.dueDate ?? r.remindOn,
        urgency: Math.max(late, 0) + bump,
        href: '/todos',
        action: { type: 'mark_done' },
        data: { todoId: r.id, priority: r.priority, todoKind: r.kind },
      });
    });
  return { items };
};

/** No backup of the company file for more than a week. */
const backupSource: Source = async ({ ctx, today, companyCreatedAt }) => {
  if (ctx.access) {
    try {
      await requireFileAdmin(ctx);
    } catch {
      return { items: [] }; // only a file Admin can back up the whole file
    }
  }
  const [row] = await ctx.db
    .select({ at: sql<string | null>`MAX(${backupLog.createdAt})` })
    .from(backupLog)
    .where(eq(backupLog.companyId, ctx.companyId));
  const last = isoDay(row?.at ?? null);
  const since = last ?? isoDay(companyCreatedAt) ?? today;
  const age = daysBetween(since, today);
  if (age <= BACKUP_STALE_DAYS) return { items: [] };
  return {
    items: [
      item({
        key: `backup:${last ?? 'never'}`,
        kind: 'backup',
        title: last ? `Back up your books: the last backup was ${plural(age, 'day')} ago` : 'Back up your books: no backup yet',
        detail: 'A backup copy protects you if this computer fails. It stays on this computer; nothing is sent anywhere.',
        amount: null,
        date: last,
        urgency: age - BACKUP_STALE_DAYS,
        href: '/company-file',
        action: { type: 'backup_now' },
        data: { lastBackupOn: last },
      }),
    ],
  };
};

/** Customer payments waiting in Undeposited Funds for more than N days (one grouped item). */
const undepositedSource: Source = async ({ ctx, today, undepositedDays }) => {
  let rows;
  try {
    rows = await listUndepositedPayments(ctx);
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NOT_FOUND') return { items: [] }; // no 1050 account
    throw err;
  }
  const cutoff = addDaysIso(today, -undepositedDays);
  const old = rows
    .map((r) => ({ ...r, day: isoDay(r.date)! }))
    .filter((r) => r.day <= cutoff)
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  if (!old.length) return { items: [] };
  const oldest = old[0];
  const home = old.filter((r) => !r.currency);
  const total = home.length === old.length ? toAmountString(Money.add(...home.map((r) => r.amount))) : null;
  const age = daysBetween(oldest.day, today);
  return {
    items: [
      item({
        key: `undeposited:${oldest.id}`,
        kind: 'undeposited',
        title: `Deposit ${plural(old.length, 'payment')} you received`,
        detail: `The oldest, from ${oldest.customerName ?? 'a customer'}, has been waiting since ${shortDate(oldest.day)}. Record the bank deposit so your bank balance matches.`,
        amount: total,
        date: oldest.day,
        urgency: age - undepositedDays,
        href: '/deposits?new=1',
        action: { type: 'open', label: 'Make deposit', href: '/deposits?new=1' },
        data: { count: old.length, oldestPaymentId: oldest.id },
      }),
    ],
  };
};

/** Which sources a person may see: they must be able to act on the item. */
const SOURCES: Array<{ kind: AttentionKind; source: Source; area: Area | null; action: Action }> = [
  { kind: 'bank_txn', source: bankTxnSource, area: 'banking', action: 'create' },
  { kind: 'overdue_invoice', source: overdueInvoiceSource, area: 'customers', action: 'view' },
  { kind: 'bill_due', source: billSource, area: 'vendors', action: 'create' },
  { kind: 'ai_error', source: aiErrorSource, area: 'accounting', action: 'view' },
  { kind: 'reconcile', source: reconcileSource, area: 'accounting', action: 'create' },
  { kind: 'payroll_tax', source: payrollTaxSource, area: 'payroll', action: 'create' },
  { kind: 'todo', source: todoSource, area: null, action: 'view' },
  { kind: 'backup', source: backupSource, area: 'file_utilities', action: 'create' },
  { kind: 'undeposited', source: undepositedSource, area: 'banking', action: 'create' },
];

/** The kinds this person can act on (Users & Roles). */
export function attentionKindsFor(ctx: ServiceContext): AttentionKind[] {
  return SOURCES.filter((s) => !s.area || allowed(ctx, s.area, s.action)).map((s) => s.kind);
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

function compareItems(a: AttentionItem, b: AttentionItem): number {
  if (b.urgency !== a.urgency) return b.urgency - a.urgency;
  const ad = a.date ?? '9999-12-31';
  const bd = b.date ?? '9999-12-31';
  if (ad !== bd) return ad.localeCompare(bd);
  const am = a.amount ? Money.of(a.amount) : Money.zero();
  const bm = b.amount ? Money.of(b.amount) : Money.zero();
  if (!am.equals(bm)) return bm.greaterThan(am) ? 1 : -1;
  return a.key.localeCompare(b.key);
}

/**
 * Everything that needs this person's attention, most urgent first. One call: the sources run
 * in parallel, each a company-scoped query or two; a failing source never breaks the rest.
 */
export async function getAttention(ctx: ServiceContext, opts: AttentionOptions = {}): Promise<AttentionResult> {
  const now = opts.now ?? new Date();
  const [prefs, company] = await Promise.all([getPreferences(ctx), getCompany(ctx)]);
  const today = opts.today ?? todayInTimeZone(prefs.timezone, now);

  // This person's snoozes / dismissals.
  const states = ctx.userId
    ? await ctx.db
        .select({ key: attentionItemStates.itemKey, until: attentionItemStates.snoozedUntil, dismissedAt: attentionItemStates.dismissedAt })
        .from(attentionItemStates)
        .where(and(eq(attentionItemStates.companyId, ctx.companyId), eq(attentionItemStates.userId, ctx.userId)))
    : [];
  const hiddenState = new Map<string, { snoozedUntil: string | null; dismissed: boolean }>();
  for (const s of states) {
    const dismissed = !!s.dismissedAt;
    const snoozed = !!s.until && s.until.getTime() > now.getTime();
    if (dismissed || snoozed) hiddenState.set(s.key, { dismissed, snoozedUntil: snoozed ? s.until!.toISOString() : null });
  }

  const env: SourceEnv = {
    ctx,
    today,
    countOnly: !!opts.countOnly,
    hiddenKeys: new Set(hiddenState.keys()),
    undepositedDays: opts.undepositedDays ?? DEFAULT_UNDEPOSITED_DAYS,
    companyName: company?.name ?? 'Your company',
    companyCreatedAt: company?.createdAt ?? null,
    payrollLiabilityAccountId: prefs.payrollLiabilityAccountId ?? null,
  };

  const kinds = new Set(attentionKindsFor(ctx));
  const results = await Promise.all(
    SOURCES.filter((s) => kinds.has(s.kind)).map(async (s) => {
      try {
        return { kind: s.kind, result: await s.source(env) };
      } catch (err) {
        console.warn(`[attention] ${s.kind} unavailable:`, err instanceof Error ? err.message : err);
        return { kind: s.kind, result: { items: [] } as SourceResult };
      }
    }),
  );

  const counts = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, 0])) as Record<AttentionKind, number>;
  const visible: AttentionItem[] = [];
  const hidden: AttentionItem[] = [];
  let hiddenCount = 0;
  for (const { kind, result } of results) {
    const shown = result.items.filter((i) => !hiddenState.has(i.key));
    const hid = result.items.filter((i) => hiddenState.has(i.key));
    // Bank feed: paged in SQL, so its visible total comes from a COUNT.
    counts[kind] = result.pagedTotal ?? shown.length;
    hiddenCount += hid.length;
    visible.push(...shown.sort(compareItems).slice(0, PER_KIND_LIMIT));
    if (opts.includeHidden) hidden.push(...hid.map((i) => ({ ...i, hidden: hiddenState.get(i.key)! })));
  }
  visible.sort(compareItems);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  let accountOptions: AccountOption[] = [];
  if (!opts.countOnly && visible.some((i) => i.kind === 'bank_txn')) {
    accountOptions = await ctx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true), ne(accounts.subtype, 'non_posting')))
      .orderBy(asc(accounts.code));
  }

  return {
    asOf: today,
    items: visible,
    counts,
    total,
    hiddenCount,
    ...(opts.includeHidden ? { hidden: hidden.sort(compareItems) } : {}),
    accountOptions,
    emailConfigured: emailIsConfigured(),
  };
}

/** Just the number for the sidebar badge. */
export async function attentionCount(ctx: ServiceContext, opts: Omit<AttentionOptions, 'countOnly' | 'includeHidden'> = {}): Promise<number> {
  return (await getAttention(ctx, { ...opts, countOnly: true })).total;
}

// ---------------------------------------------------------------------------
// Snooze / dismiss (per person)
// ---------------------------------------------------------------------------

const KEY_RE = /^([a-z_]+):[A-Za-z0-9._:-]{1,180}$/;

export type AttentionStateAction = 'snooze' | 'dismiss' | 'restore';

export interface AttentionStateInput {
  key: string;
  action: AttentionStateAction;
  /** Snooze length: 1 (until tomorrow) or 7 (a week). */
  days?: number;
}

export function parseAttentionStateBody(body: unknown): AttentionStateInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  const action = b.action;
  if (action !== 'snooze' && action !== 'dismiss' && action !== 'restore') {
    throw validation('action must be snooze, dismiss or restore.');
  }
  const days = b.days === undefined ? undefined : Number(b.days);
  return { key, action, days };
}

/**
 * Snooze (1 day / 1 week), dismiss or bring back one item for the signed-in person. Per-person
 * view state only (like My Preferences), so it is not an audited change to the books.
 */
export async function setAttentionState(
  ctx: ServiceContext,
  input: AttentionStateInput,
  now: Date = new Date(),
): Promise<{ key: string; snoozedUntil: string | null; dismissed: boolean }> {
  if (!ctx.userId) throw validation('Sign in to snooze or dismiss items.');
  const m = KEY_RE.exec(input.key ?? '');
  if (!m || !(ATTENTION_KINDS as readonly string[]).includes(m[1])) throw validation('Unknown item.');
  const where = and(
    eq(attentionItemStates.companyId, ctx.companyId),
    eq(attentionItemStates.userId, ctx.userId),
    eq(attentionItemStates.itemKey, input.key),
  );
  // Housekeeping: forget this person's snoozes that have run out.
  await ctx.db
    .delete(attentionItemStates)
    .where(
      and(
        eq(attentionItemStates.companyId, ctx.companyId),
        eq(attentionItemStates.userId, ctx.userId),
        isNull(attentionItemStates.dismissedAt),
        lt(attentionItemStates.snoozedUntil, now),
      ),
    );
  if (input.action === 'restore') {
    await ctx.db.delete(attentionItemStates).where(where);
    return { key: input.key, snoozedUntil: null, dismissed: false };
  }
  let snoozedUntil: Date | null = null;
  let dismissedAt: Date | null = null;
  if (input.action === 'snooze') {
    const days = input.days ?? 1;
    if (!(SNOOZE_DAYS as readonly number[]).includes(days)) throw validation('Snooze for 1 day or 1 week.');
    snoozedUntil = new Date(now.getTime() + days * 86_400_000);
  } else {
    dismissedAt = now;
  }
  await ctx.db
    .insert(attentionItemStates)
    .values({ companyId: ctx.companyId, userId: ctx.userId, itemKey: input.key, snoozedUntil, dismissedAt, updatedAt: now })
    .onConflictDoUpdate({
      target: [attentionItemStates.companyId, attentionItemStates.userId, attentionItemStates.itemKey],
      set: { snoozedUntil, dismissedAt, updatedAt: now },
    });
  return { key: input.key, snoozedUntil: snoozedUntil?.toISOString() ?? null, dismissed: !!dismissedAt };
}

// ---------------------------------------------------------------------------
// Payment reminder email
// ---------------------------------------------------------------------------

export const EMAIL_NOT_SET_UP =
  'Email is not set up on this computer yet. Whoever installed Ironbooks can add the SMTP settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM). Until then, copy the reminder or open it in your own email program.';

/**
 * Email a friendly payment reminder (with the invoice PDF) for an open invoice. Goes through the
 * existing email service (SMTP + the company's network policy) and is recorded in the audit
 * trail so the inbox can show when the last reminder went out.
 */
export async function sendPaymentReminder(
  ctx: ServiceContext,
  invoiceId: string,
  to?: string | null,
): Promise<{ ok: true; to: string }> {
  if (typeof invoiceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(invoiceId)) throw notFound('Invoice');
  const [inv] = await ctx.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
      status: invoices.status,
      customerName: customers.displayName,
      customerEmail: customers.email,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, ctx.companyId)));
  if (!inv) throw notFound('Invoice');
  if (!(OPEN_DOC_STATUSES as readonly string[]).includes(inv.status) || !Money.gt(inv.balanceDue, 0)) {
    throw validation('This invoice has nothing left to pay, so no reminder is needed.');
  }
  const recipient = (typeof to === 'string' && to.trim()) || inv.customerEmail;
  if (!recipient) {
    throw validation(`There is no email address for ${inv.customerName}. Type one in, or add it to the customer record.`);
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) throw validation('That email address does not look right.');
  if (!emailIsConfigured()) throw validation(EMAIL_NOT_SET_UP);

  const prefs = await getPreferences(ctx);
  const today = todayInTimeZone(prefs.timezone);
  const company = await getCompany(ctx);
  const number = docNo(inv.refNumber, inv.invoiceNumber);
  const due = isoDay(inv.dueDate);
  const text = paymentReminderText({
    customerName: inv.customerName,
    invoiceNumber: number,
    balance: inv.balanceDue,
    dueDate: due,
    daysOverdue: due ? Math.max(daysBetween(due, today), 0) : 0,
    companyName: company?.name ?? 'Your company',
  });
  const { bytes } = await buildInvoicePdf(ctx, inv.id);
  await sendMail(
    {
      to: recipient,
      subject: text.subject,
      text: text.body,
      attachments: [
        {
          filename: `invoice-${number.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`,
          content: Buffer.from(bytes),
          contentType: 'application/pdf',
        },
      ],
    },
    ctx,
  );
  await writeAudit(ctx, {
    action: 'create',
    entityType: 'payment_reminder',
    entityId: inv.id,
    newValues: { to: recipient, invoiceNumber: number, balanceDue: toAmountString(inv.balanceDue) },
  });
  return { ok: true, to: recipient };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * Note that a backup was made. A whole-file backup ('full' / 'auto' / 'quick') covers every
 * company in the file; a per-company one only that company. Never throws (bookkeeping only).
 */
export async function recordBackup(
  db: DB,
  input: { kind: 'full' | 'company' | 'auto' | 'quick'; companyId?: string; userId?: string | null; filename?: string | null },
): Promise<void> {
  try {
    const ids =
      input.kind === 'company' && input.companyId
        ? [input.companyId]
        : (await db.select({ id: companies.id }).from(companies)).map((c) => c.id);
    if (!ids.length) return;
    await db.insert(backupLog).values(
      ids.map((companyId) => ({
        companyId,
        userId: input.userId ?? null,
        kind: input.kind,
        filename: input.filename ? input.filename.slice(0, 255) : null,
      })),
    );
  } catch (err) {
    console.warn('[attention] could not record backup:', err instanceof Error ? err.message : err);
  }
}

/** Folder for Back up now copies: beside the company data folder, never inside it. */
export function quickBackupDir(dataDir?: string): string {
  return path.join(path.dirname(resolveDataDir(dataDir)), 'Ironbooks Backups');
}

export const QUICK_BACKUP_KEEP = 20;

/**
 * Back up now: write a full backup (.bka) of the company file to the backups folder on this
 * computer (nothing leaves the machine), keep the newest QUICK_BACKUP_KEEP, and record it.
 * Only an Admin of every company in the file may do this (the archive holds all of them).
 */
export async function backupNow(
  ctx: ServiceContext,
  opts: { dir?: string; dataDir?: string } = {},
): Promise<{ filename: string; folder: string; createdAt: string }> {
  await requireFileAdmin(ctx);
  const company = await getCompany(ctx);
  const { buffer, filename } = createBackup(company?.name ?? undefined, opts.dataDir);
  const folder = opts.dir ?? quickBackupDir(opts.dataDir);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, filename), buffer);
  try {
    const files = fs
      .readdirSync(folder)
      .filter((f) => f.startsWith('ironbooks-backup') && f.endsWith('.bka'))
      .map((f) => ({ f, t: fs.statSync(path.join(folder, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
    for (const old of files.slice(QUICK_BACKUP_KEEP)) fs.rmSync(path.join(folder, old.f), { force: true });
  } catch {
    /* pruning is best effort */
  }
  await recordBackup(ctx.db, { kind: 'quick', userId: ctx.userId, filename });
  return { filename, folder, createdAt: new Date().toISOString() };
}
