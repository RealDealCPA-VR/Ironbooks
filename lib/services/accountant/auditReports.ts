/**
 * Audit-log based accountant reports — wave2 accountant, J11 / J12.
 *
 *  - Closing Date Exception report (J11): every change made on or before the closing date with the
 *    closing-date password (recorded by fiscalPeriods.recordClosingDateException from the posting
 *    engine / reclassify), plus entries dated in the closed period that were entered after the
 *    books were closed (catches anything older than the exception audit).
 *  - Voided/Deleted Transactions Summary & Detail (J12): every void / delete of a transaction from
 *    the audit trail, who did it and when, with the document number/date/amount and (detail) the
 *    original values.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { accounts, auditLogs, classes, companies, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from '../_base';
import { maskForContext } from '../access';
import { companyDayBound } from '../preferences';
import { resolveEntityNames } from '../journal';

/** A 'when it happened' filter: a calendar day is read in the company's time zone (Preferences). */
export type HappenedBound = Date | string | null | undefined;

// ---------------------------------------------------------------------------
// J11 — Closing Date Exception report
// ---------------------------------------------------------------------------

export interface ClosingDateExceptionRow {
  auditLogId: string | null;
  entryId: string;
  entryNumber: number | null;
  operation: string;
  transactionDate: string;
  closingDate: string | null;
  description: string | null;
  amount: string | null;
  user: string | null;
  at: string;
  source: 'override' | 'entered_after_close';
}

/** One line of a transaction version on the exception report (QB: Account / Name / Memo / Debit / Credit). */
export interface ExceptionLine {
  account: string;
  className: string | null;
  name: string | null;
  memo: string | null;
  debit: string | null;
  credit: string | null;
}

/** A transaction as it is now ('latest') or as it was before a change ('prior'). */
export interface ExceptionVersion {
  state: 'latest' | 'prior';
  entryId: string;
  entryNumber: number | null;
  date: string;
  description: string | null;
  amount: string;
  /** latest: when it was entered; prior: when it was changed (replaced, voided or reclassified). */
  at: string;
  /** Who entered it (latest) or who changed it (prior). */
  user: string | null;
  lines: ExceptionLine[];
}

/**
 * QB's Closing Date Exception report shows each changed transaction once, with its LATEST values
 * and every PRIOR version changed in the closed period. A document edit voids its entry and posts
 * a new one (the void and the new post are both exceptions), a General Journal edit names its
 * replacement in the audit trail, a reclassify re-points lines in place (its audit row keeps the
 * old accounts and classes), and a void leaves no latest version.
 */
export interface ClosingDateExceptionGroup {
  key: string;
  /** "Invoice", "Check / Expense", "General Journal"… */
  typeLabel: string;
  transactionDate: string;
  closingDate: string | null;
  /** What happened, newest first (Added / Voided / Reclassified / Entered after close). */
  changes: Array<{ operation: string; source: ClosingDateExceptionRow['source']; at: string; user: string | null }>;
  /** Null when the transaction is void now. */
  latest: ExceptionVersion | null;
  prior: ExceptionVersion[];
  lastChangedAt: string;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  'invoice-cogs': 'Invoice (cost of goods sold)',
  salesreceipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  payment: 'Payment',
  bill: 'Bill',
  bill_payment: 'Bill Payment',
  vendor_credit: 'Bill Credit',
  expense: 'Check / Expense',
  deposit: 'Deposit',
  transfer: 'Transfer',
  paycheck: 'Paycheck',
  item_receipt: 'Item Receipt',
  inventory_transfer: 'Inventory Transfer',
  item: 'Inventory Adjustment',
  refund: 'Refund',
  tax_agency: 'Sales Tax Payment',
  sales_tax_adj: 'Sales Tax Adjustment',
  expense_report: 'Expense Report',
  fixed_asset: 'Depreciation',
};

const UUID_IN_REF = /^([a-z_-]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Group the exception rows by transaction with prior vs latest values (see ClosingDateExceptionGroup). */
async function exceptionGroups(ctx: ServiceContext, rows: ClosingDateExceptionRow[]): Promise<ClosingDateExceptionGroup[]> {
  if (rows.length === 0) return [];
  type Head = { id: string; entryNumber: number; date: Date; description: string; status: string; sourceRef: string | null; createdAt: Date; voidedAt: Date | null; user: string | null };
  const heads = new Map<string, Head>();
  const loadHeads = async (where: ReturnType<typeof and>) => {
    const found = await ctx.db
      .select({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        date: journalEntries.date,
        description: journalEntries.description,
        status: journalEntries.status,
        sourceRef: journalEntries.sourceRef,
        createdAt: journalEntries.createdAt,
        voidedAt: journalEntries.voidedAt,
        user: users.name,
      })
      .from(journalEntries)
      .leftJoin(users, eq(journalEntries.createdBy, users.id))
      .where(where);
    for (const h of found) heads.set(h.id, { ...h, status: String(h.status) });
  };
  const rowIds = [...new Set(rows.map((r) => r.entryId))];
  for (let i = 0; i < rowIds.length; i += 1000) {
    await loadHeads(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.id, rowIds.slice(i, i + 1000))));
  }
  // Every entry of the same document (its earlier and later versions share its source).
  const docRefs = [...new Set([...heads.values()].map((h) => h.sourceRef).filter((s): s is string => !!s && UUID_IN_REF.test(s)))];
  for (let i = 0; i < docRefs.length; i += 1000) {
    await loadHeads(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.sourceRef, docRefs.slice(i, i + 1000))));
  }

  // Union-find over entries: same document, or a General Journal entry and its replacement.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byDoc = new Map<string, string>();
  for (const h of heads.values()) {
    parent.set(h.id, parent.get(h.id) ?? h.id);
    if (h.sourceRef && UUID_IN_REF.test(h.sourceRef)) {
      const first = byDoc.get(h.sourceRef);
      if (first) union(first, h.id);
      else byDoc.set(h.sourceRef, h.id);
    }
  }
  // Entry audits: replacements (journal edits) and the accounts / classes before a reclassify.
  const entryAudits = [] as Array<{ entityId: string; oldValues: unknown; newValues: unknown; createdAt: Date }>;
  for (let i = 0; i < rowIds.length; i += 1000) {
    entryAudits.push(
      ...(await ctx.db
        .select({ entityId: auditLogs.entityId, oldValues: auditLogs.oldValues, newValues: auditLogs.newValues, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.companyId, ctx.companyId),
            eq(auditLogs.entityType, 'journal_entry'),
            eq(auditLogs.action, 'update'),
            inArray(auditLogs.entityId, rowIds.slice(i, i + 1000)),
          ),
        )),
    );
  }
  const replacements: string[] = [];
  for (const a of entryAudits) {
    const by = ((a.newValues ?? {}) as Record<string, unknown>).replacedBy;
    if (typeof by === 'string' && /^[0-9a-f-]{36}$/i.test(by)) {
      replacements.push(by);
      parent.set(by, parent.get(by) ?? by);
      union(a.entityId, by);
    }
  }
  const missing = replacements.filter((id) => !heads.has(id));
  if (missing.length) await loadHeads(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.id, missing)));

  // Lines of every entry involved, with account / class / name labels.
  const ids = [...heads.keys()];
  const lines = [] as Array<{ id: string; entryId: string; accountId: string; code: string; acct: string; classId: string | null; memo: string | null; debit: string | null; credit: string | null; entityType: string | null; entityId: string | null }>;
  for (let i = 0; i < ids.length; i += 1000) {
    lines.push(
      ...(await ctx.db
        .select({
          id: journalEntryLines.id,
          entryId: journalEntryLines.journalEntryId,
          accountId: journalEntryLines.accountId,
          code: accounts.code,
          acct: accounts.name,
          classId: journalEntryLines.classId,
          memo: journalEntryLines.memo,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          entityType: journalEntryLines.entityType,
          entityId: journalEntryLines.entityId,
        })
        .from(journalEntryLines)
        .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
        .where(inArray(journalEntryLines.journalEntryId, ids.slice(i, i + 1000)))),
    );
  }
  const acctRows = await ctx.db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const acctLabel = new Map(acctRows.map((a) => [a.id, `${a.code} · ${a.name}`]));
  const classRows = await ctx.db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.companyId, ctx.companyId));
  const className = new Map(classRows.map((c) => [c.id, c.name]));
  const names = await resolveEntityNames(ctx, lines);
  const linesOf = new Map<string, typeof lines>();
  for (const l of lines) (linesOf.get(l.entryId) ?? linesOf.set(l.entryId, []).get(l.entryId)!).push(l);

  const toLine = (l: (typeof lines)[number], override?: { accountId?: string | null; classId?: string | null }): ExceptionLine => {
    const accountId = override?.accountId ?? l.accountId;
    const classId = override && 'classId' in override ? override.classId ?? null : l.classId;
    return {
      account: acctLabel.get(accountId) ?? `${l.code} · ${l.acct}`,
      className: classId ? className.get(classId) ?? null : null,
      name: l.entityType && l.entityId ? names.get(`${l.entityType}:${l.entityId}`) ?? null : null,
      memo: l.memo ?? null,
      debit: l.debit && !Money.isZero(l.debit) ? toAmountString(l.debit) : null,
      credit: l.credit && !Money.isZero(l.credit) ? toAmountString(l.credit) : null,
    };
  };
  const total = (ls: ExceptionLine[]) => toAmountString(ls.reduce((s, l) => s.plus(Money.of(l.debit ?? 0)), Money.zero()));

  const groups = new Map<string, ClosingDateExceptionGroup>();
  const rowsByGroup = new Map<string, ClosingDateExceptionRow[]>();
  for (const r of rows) {
    const g = heads.has(r.entryId) ? find(r.entryId) : r.entryId;
    (rowsByGroup.get(g) ?? rowsByGroup.set(g, []).get(g)!).push(r);
  }
  const membersOf = new Map<string, Head[]>();
  for (const h of heads.values()) {
    const g = find(h.id);
    (membersOf.get(g) ?? membersOf.set(g, []).get(g)!).push(h);
  }
  for (const [g, grows] of rowsByGroup) {
    const members = (membersOf.get(g) ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const posted = members.filter((m) => m.status === 'posted');
    let latest: ExceptionVersion | null = null;
    if (posted.length) {
      const main = posted[0];
      const ls = posted.flatMap((m) => (linesOf.get(m.id) ?? []).map((l) => toLine(l)));
      latest = {
        state: 'latest',
        entryId: main.id,
        entryNumber: main.entryNumber,
        date: main.date.toISOString().slice(0, 10),
        description: main.description,
        amount: total(ls),
        at: posted[posted.length - 1].createdAt.toISOString(),
        user: posted[posted.length - 1].user ?? null,
        lines: ls,
      };
    }
    const prior: ExceptionVersion[] = [];
    for (const r of grows) {
      const h = heads.get(r.entryId);
      if (!h) continue;
      const own = linesOf.get(h.id) ?? [];
      if (r.operation === 'void') {
        const ls = own.map((l) => toLine(l));
        prior.push({ state: 'prior', entryId: h.id, entryNumber: h.entryNumber, date: h.date.toISOString().slice(0, 10), description: h.description, amount: total(ls), at: r.at, user: r.user, lines: ls });
      } else if (r.operation === 'reclassify') {
        // The reclassify audit row written with this change keeps each line's account and class before it.
        const at = new Date(r.at).getTime();
        const audit = entryAudits
          .filter((a) => a.entityId === h.id && Array.isArray(((a.oldValues ?? {}) as Record<string, unknown>).reclassify))
          .sort((a, b) => Math.abs(a.createdAt.getTime() - at) - Math.abs(b.createdAt.getTime() - at))[0];
        const before = new Map<string, { accountId: string | null; classId: string | null }>();
        for (const x of ((audit?.oldValues ?? {}) as { reclassify?: Array<{ lineId: string; accountId: string | null; classId: string | null }> }).reclassify ?? []) {
          before.set(x.lineId, { accountId: x.accountId, classId: x.classId });
        }
        const ls = own.map((l) => (before.has(l.id) ? toLine(l, before.get(l.id)) : toLine(l)));
        prior.push({ state: 'prior', entryId: h.id, entryNumber: h.entryNumber, date: h.date.toISOString().slice(0, 10), description: h.description, amount: total(ls), at: r.at, user: r.user, lines: ls });
      }
    }
    prior.sort((a, b) => b.at.localeCompare(a.at));
    const anyHead = heads.get(grows[0].entryId);
    const prefix = anyHead?.sourceRef ? (UUID_IN_REF.exec(anyHead.sourceRef)?.[1] ?? anyHead.sourceRef.split(':')[0]) : 'manual';
    const typeLabel = SOURCE_TYPE_LABELS[prefix] ?? 'General Journal';
    const changes = grows
      .map((r) => ({ operation: r.operation, source: r.source, at: r.at, user: r.user }))
      .sort((a, b) => b.at.localeCompare(a.at));
    groups.set(g, {
      key: g,
      typeLabel,
      transactionDate: latest?.date ?? grows[0].transactionDate,
      closingDate: grows.map((r) => r.closingDate).find((c) => c) ?? null,
      changes,
      latest,
      prior,
      lastChangedAt: changes[0].at,
    });
  }
  return [...groups.values()].sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt));
}

export async function closingDateExceptionReport(
  ctx: ServiceContext,
  rangeIn: { from?: HappenedBound; to?: HappenedBound } = {},
): Promise<{ closingDate: string | null; rows: ClosingDateExceptionRow[]; groups: ClosingDateExceptionGroup[] }> {
  const range = {
    from: await companyDayBound(ctx, rangeIn.from, 'from'),
    to: await companyDayBound(ctx, rangeIn.to, 'to', true),
  };
  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const closingDate = ((company?.settings ?? {}) as Record<string, unknown>).closingDate;
  const cd = typeof closingDate === 'string' && closingDate ? closingDate : null;

  const conds = [eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'closing_date_exception')];
  if (range.from) conds.push(gte(auditLogs.createdAt, range.from));
  if (range.to) conds.push(lte(auditLogs.createdAt, range.to));
  const logs = await ctx.db
    .select({ id: auditLogs.id, entityId: auditLogs.entityId, newValues: auditLogs.newValues, createdAt: auditLogs.createdAt, user: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt));

  const entryIds = [...new Set(logs.map((l) => l.entityId))];
  const amounts = await entryAmounts(ctx, entryIds);
  const rows: ClosingDateExceptionRow[] = logs.map((l) => {
    const v = (l.newValues ?? {}) as Record<string, unknown>;
    return {
      auditLogId: l.id,
      entryId: l.entityId,
      entryNumber: typeof v.entryNumber === 'number' ? v.entryNumber : null,
      operation: String(v.operation ?? 'change'),
      transactionDate: String(v.transactionDate ?? ''),
      closingDate: typeof v.closingDate === 'string' ? v.closingDate : null,
      description: typeof v.description === 'string' ? v.description : null,
      amount: amounts.get(l.entityId) ?? null,
      user: l.user ?? null,
      at: l.createdAt.toISOString(),
      source: 'override',
    };
  });

  // Entries dated on/before the CURRENT closing date that were entered while the books were already
  // closed on their date. Each entry is checked against the closing date IN EFFECT when it was
  // entered (the closing-date history from the audit trail), not against one start time:
  //  - an entry made while the period was open again (closing date moved back or cleared, then set
  //    again) is not an exception;
  //  - one imported while January was closed stays one after February is closed and reopened;
  //  - a save that kept the same date (a password change) changes nothing.
  if (cd) {
    const setLogs = await ctx.db
      .select({ createdAt: auditLogs.createdAt, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(asc(auditLogs.createdAt));
    const periods = closedPeriods(setLogs);
    const seen = new Set(rows.map((r) => r.entryId));
    const late = new Map<string, { e: LateEntry; closedThrough: string }>();
    // A handful of closing-date changes in practice; chunked so a long history never builds one
    // enormous statement.
    for (let i = 0; i < periods.length; i += 200) {
      const chunk = periods.slice(i, i + 200);
      const found = await ctx.db
        .select({
          id: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          date: journalEntries.date,
          description: journalEntries.description,
          createdAt: journalEntries.createdAt,
          user: users.name,
        })
        .from(journalEntries)
        .leftJoin(users, eq(journalEntries.createdBy, users.id))
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            sql`${journalEntries.status} IN ('posted', 'void')`,
            range.from ? gte(journalEntries.createdAt, range.from) : undefined,
            range.to ? lte(journalEntries.createdAt, range.to) : undefined,
            or(
              ...chunk.map((p) =>
                and(
                  gte(journalEntries.createdAt, p.from),
                  p.to ? lt(journalEntries.createdAt, p.to) : undefined,
                  lte(journalEntries.date, new Date(`${p.closingDate < cd ? p.closingDate : cd}T23:59:59.999Z`)),
                ),
              ),
            ),
          ),
        );
      for (const e of found) {
        if (seen.has(e.id) || late.has(e.id)) continue;
        const p = periodAt(periods, e.createdAt);
        if (p) late.set(e.id, { e, closedThrough: p.closingDate });
      }
    }
    const lateAmounts = await entryAmounts(ctx, [...late.keys()]);
    for (const { e, closedThrough } of late.values()) {
      rows.push({
        auditLogId: null,
        entryId: e.id,
        entryNumber: e.entryNumber,
        operation: 'post',
        transactionDate: e.date.toISOString().slice(0, 10),
        closingDate: closedThrough,
        description: e.description,
        amount: lateAmounts.get(e.id) ?? null,
        user: e.user ?? null,
        at: e.createdAt.toISOString(),
        source: 'entered_after_close',
      });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return { closingDate: cd, rows, groups: await exceptionGroups(ctx, rows) };
}

interface LateEntry {
  id: string;
  entryNumber: number;
  date: Date;
  description: string;
  createdAt: Date;
  user: string | null;
}

interface ClosedPeriod {
  /** When this closing date took effect. */
  from: Date;
  /** When it was moved or cleared (null: still in effect). */
  to: Date | null;
  closingDate: string;
}

/**
 * The closing-date history, oldest first: each span of time during which the books were closed
 * through one date. Built from the company audit rows that carry a closing date (Set Closing Date
 * writes { closingDate } — null when cleared); a save that kept the date extends the span.
 */
function closedPeriods(logs: { createdAt: Date; newValues: unknown }[]): ClosedPeriod[] {
  const out: ClosedPeriod[] = [];
  for (const l of logs) {
    const v = (l.newValues ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(v, 'closingDate')) continue;
    const next = typeof v.closingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.closingDate) ? v.closingDate : null;
    const last = out[out.length - 1];
    if (last && last.to === null) {
      if (last.closingDate === next) continue; // same date saved again (password change)
      last.to = l.createdAt;
    }
    if (next) out.push({ from: l.createdAt, to: null, closingDate: next });
  }
  return out;
}

/** The closing date in effect at `at` (periods sorted and not overlapping). */
function periodAt(periods: ClosedPeriod[], at: Date): ClosedPeriod | null {
  let lo = 0;
  let hi = periods.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = periods[mid];
    if (at < p.from) hi = mid - 1;
    else if (p.to && at >= p.to) lo = mid + 1;
    else return p;
  }
  return null;
}

async function entryAmounts(ctx: ServiceContext, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // In chunks: entries posted after the books were closed can be a whole imported history, more
  // ids than the database accepts bound parameters in one statement (65,535).
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await ctx.db
      .select({ id: journalEntryLines.journalEntryId, total: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)` })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntryLines.journalEntryId, ids.slice(i, i + 1000))))
      .groupBy(journalEntryLines.journalEntryId);
    for (const r of rows) out.set(r.id, toAmountString(r.total));
  }
  return out;
}

// ---------------------------------------------------------------------------
// J12 — Voided/Deleted Transactions Summary & Detail
// ---------------------------------------------------------------------------

export const TRANSACTION_ENTITY_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  payment_received: 'Payment',
  estimate: 'Estimate',
  sales_order: 'Sales Order',
  bill: 'Bill',
  bill_payment: 'Bill Payment',
  vendor_credit: 'Bill Credit',
  purchase_order: 'Purchase Order',
  item_receipt: 'Item Receipt',
  expense: 'Check / Expense',
  deposit: 'Deposit',
  transfer: 'Transfer',
  journal_entry: 'Journal Entry',
  paycheck: 'Paycheck',
  inventory_transfer: 'Inventory Transfer',
  time_entry: 'Time Entry',
  expense_report: 'Expense Report',
};

export interface VoidedDeletedRow {
  auditLogId: string;
  entityType: string;
  typeLabel: string;
  entityId: string;
  action: 'void' | 'delete';
  number: string | null;
  transactionDate: string | null;
  name: string | null;
  amount: string | null;
  user: string | null;
  at: string;
  /** Detail only: the values before the void/delete (masked per permissions). */
  original?: unknown;
}

function pickStr(v: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const x = v[k];
    if (x !== undefined && x !== null && x !== '') return String(x);
  }
  return null;
}

export async function voidedDeletedTransactions(
  ctx: ServiceContext,
  optsIn: { from?: HappenedBound; to?: HappenedBound; detail?: boolean } = {},
): Promise<{ rows: VoidedDeletedRow[]; count: number }> {
  const opts = {
    from: await companyDayBound(ctx, optsIn.from, 'from'),
    to: await companyDayBound(ctx, optsIn.to, 'to', true),
    detail: optsIn.detail,
  };
  const types = Object.keys(TRANSACTION_ENTITY_LABELS);
  const conds = [
    eq(auditLogs.companyId, ctx.companyId),
    inArray(auditLogs.action, ['void', 'delete']),
    inArray(auditLogs.entityType, types),
  ];
  if (opts.from) conds.push(gte(auditLogs.createdAt, opts.from));
  if (opts.to) conds.push(lte(auditLogs.createdAt, opts.to));
  const logs = await ctx.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
      createdAt: auditLogs.createdAt,
      user: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(5000);

  // Pull number/date/total from the (still existing) voided documents and journal entries.
  const info = new Map<string, { number: string | null; date: string | null; amount: string | null; name: string | null }>();
  const byType = new Map<string, string[]>();
  for (const l of logs) byType.set(l.entityType, [...(byType.get(l.entityType) ?? []), l.entityId]);
  // num: the number the form shows (a typed ref number first, as everywhere else in the app);
  // fallbackName: the payee when the document has no vendor (a one-time payee on a check).
  const docTables: Record<string, { table: string; num: string; total: string; party?: string; partyTable?: string; fallbackName?: string }> = {
    invoice: { table: 'invoices', num: "COALESCE(NULLIF(t.ref_number, ''), t.invoice_number::text)", total: 'total', party: 'customer_id', partyTable: 'customers' },
    sales_receipt: { table: 'sales_receipts', num: "COALESCE(NULLIF(t.ref_number, ''), t.receipt_number::text)", total: 'total', party: 'customer_id', partyTable: 'customers' },
    credit_memo: { table: 'credit_memos', num: "COALESCE(NULLIF(t.ref_number, ''), t.memo_number::text)", total: 'total', party: 'customer_id', partyTable: 'customers' },
    payment_received: { table: 'payments_received', num: 't.reference', total: 'amount', party: 'customer_id', partyTable: 'customers' },
    bill: { table: 'bills', num: 't.bill_number', total: 'total', party: 'vendor_id', partyTable: 'vendors' },
    bill_payment: { table: 'bill_payments', num: 't.reference', total: 'amount', party: 'vendor_id', partyTable: 'vendors' },
    vendor_credit: { table: 'vendor_credits', num: 't.ref_number', total: 'total', party: 'vendor_id', partyTable: 'vendors' },
    expense: { table: 'expenses', num: 't.reference', total: 'total', party: 'vendor_id', partyTable: 'vendors', fallbackName: 't.payee_name' },
    deposit: { table: 'deposits', num: 't.memo', total: 'total' },
    // Non-posting forms (salesar): voided ones are still on file; deleted ones fall back to the
    // number / date / name / amount their delete audit row keeps (lib/services/nonPostingDocs.ts).
    estimate: { table: 'estimates', num: "COALESCE(NULLIF(t.ref_number, ''), t.estimate_number::text)", total: 'total', party: 'customer_id', partyTable: 'customers' },
    sales_order: { table: 'sales_orders', num: "COALESCE(NULLIF(t.ref_number, ''), t.order_number::text)", total: 'total', party: 'customer_id', partyTable: 'customers' },
    purchase_order: { table: 'purchase_orders', num: "COALESCE(NULLIF(t.ref_number, ''), t.po_number::text)", total: 'total', party: 'vendor_id', partyTable: 'vendors' },
  };
  for (const [type, ids] of byType) {
    const spec = docTables[type];
    const uniq = [...new Set(ids)];
    if (type === 'journal_entry') {
      const amts = await entryAmounts(ctx, uniq);
      const rows = await ctx.db
        .select({ id: journalEntries.id, n: journalEntries.entryNumber, d: journalEntries.date, desc: journalEntries.description })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.id, uniq)));
      for (const r of rows) info.set(r.id, { number: String(r.n), date: r.d.toISOString(), amount: amts.get(r.id) ?? null, name: r.desc });
      continue;
    }
    if (!spec) continue;
    try {
      const partySel = spec.party
        ? sql.raw(`, ${spec.fallbackName ? `COALESCE(p.display_name, ${spec.fallbackName})` : 'p.display_name'} AS party`)
        : sql.raw(`, NULL AS party`);
      const partyJoin = spec.party ? sql.raw(` LEFT JOIN ${spec.partyTable} p ON p.id = t.${spec.party}`) : sql.raw('');
      const res = await ctx.db.execute(
        sql`SELECT t.id, (${sql.raw(spec.num)})::text AS num, t.date, t.${sql.raw(spec.total)}::text AS total${partySel}
            FROM ${sql.raw(spec.table)} t${partyJoin}
            WHERE t.company_id = ${ctx.companyId} AND t.id IN (${sql.join(uniq.map((id) => sql`${id}::uuid`), sql`, `)})`,
      );
      const rows = ((res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
      for (const r of rows) {
        info.set(String(r.id), {
          number: r.num == null ? null : String(r.num),
          date: r.date ? new Date(r.date as string).toISOString() : null,
          amount: r.total == null ? null : toAmountString(r.total as string),
          name: r.party == null ? null : String(r.party),
        });
      }
    } catch {
      // Unknown column layout on an older file — fall back to the audit snapshot below.
    }
  }

  const rows: VoidedDeletedRow[] = logs.map((l) => {
    const snap = { ...((l.oldValues ?? {}) as Record<string, unknown>), ...((l.newValues ?? {}) as Record<string, unknown>) };
    const i = info.get(l.entityId);
    let amountRaw = i?.amount ?? pickStr(snap, ['total', 'amount', 'netPay']);
    if (amountRaw == null && Array.isArray(snap.lines)) {
      // Deleted journal entries (older audit rows) carry only their lines — the amount is the debit side.
      try {
        amountRaw = toAmountString(
          (snap.lines as Array<{ debit?: string | number | null }>).reduce(
            (sum, ln) => sum.plus(Money.of(ln?.debit ?? '0')),
            Money.zero(),
          ),
        );
      } catch {
        amountRaw = null;
      }
    }
    let amount: string | null = null;
    try {
      amount = amountRaw == null ? null : toAmountString(Money.of(amountRaw));
    } catch {
      amount = null;
    }
    const row: VoidedDeletedRow = {
      auditLogId: l.id,
      entityType: l.entityType,
      typeLabel: TRANSACTION_ENTITY_LABELS[l.entityType] ?? l.entityType,
      entityId: l.entityId,
      action: l.action as 'void' | 'delete',
      number:
        i?.number ??
        pickStr(snap, ['invoiceNumber', 'receiptNumber', 'memoNumber', 'entryNumber', 'billNumber', 'reference', 'number', 'estimateNumber', 'orderNumber', 'poNumber']),
      transactionDate: i?.date ?? pickStr(snap, ['date']),
      name: i?.name ?? pickStr(snap, ['customerName', 'vendorName', 'payeeName', 'description']),
      amount,
      user: l.user ?? null,
      at: l.createdAt.toISOString(),
    };
    if (opts.detail) row.original = maskForContext(ctx, l.oldValues ?? l.newValues);
    return row;
  });
  return { rows, count: rows.length };
}
