/**
 * "Why did this number change?" (ux/undo).
 *
 * Given a set of accounts (one account's balance, or a report line such as Total Assets / Net
 * Income) and a moment in the past, list every transaction that was created, edited, voided or
 * deleted since then AND changed that number — with what it contributed before and after, who
 * did it and when.
 *
 * How it is built:
 *  - Every posting is a journal entry, and every change to a posted document is "void the old
 *    entry, post a new one" (lib/services/postedEdit.ts). So the ledger already says what changed
 *    since `since`: entries created after it and entries voided after it.
 *  - Entries are grouped back into the document they belong to (invoice, bill, check, ...) using
 *    the entry's source link, the document tables' postedEntryId, the audit trail (which records
 *    old/new postedEntryId on edits) and the journal-entry replacement chain (updateEntry), so an
 *    edit shows as ONE row with before -> after instead of a void plus a new entry.
 *  - For each document: before = what its entries contributed at `since` (entries that existed
 *    then and were not yet void), after = what its posted entries contribute now. Only documents
 *    whose before != after are listed.
 *  - Who / when come from the audit trail (the same rows that feed the running transaction log,
 *    lib/services/transactionLog.ts), falling back to the entry's creator.
 *
 * Amounts follow the number's own sign: debit-normal for assets and expenses, credit-normal for
 * liabilities, equity and income; Net Income and Total Equity read credit-positive. 'gross'
 * (Trial Balance total) measures the debit volume a transaction moves.
 * Only transactions dated inside the report's date window (from..to / as of) count.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  billPayments,
  bills,
  creditMemos,
  deposits,
  expenses,
  invoices,
  itemReceipts,
  journalEntries,
  journalEntryLines,
  paychecks,
  paymentsReceived,
  salesReceipts,
  transfers,
  users,
  vendorCredits,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, validation } from './_base';
import { entityLabel } from './transactionLog';
import { resolveRange } from './reportEngine';

export type WhyPreset = 'assets' | 'liabilities' | 'equity' | 'income' | 'expenses' | 'net_income' | 'all';
export const WHY_PRESETS: readonly WhyPreset[] = ['assets', 'liabilities', 'equity', 'income', 'expenses', 'net_income', 'all'];

export interface WhyChangedInput {
  /** List changes made after this moment. */
  since: Date;
  /** Explicit accounts (an account register / chart-of-accounts balance). */
  accountIds?: string[];
  /** A report total. */
  preset?: WhyPreset;
  /** Transaction-date window of the number ('YYYY-MM-DD'); omitted = all dates. */
  from?: string | null;
  to?: string | null;
  /** Include sub-accounts of accountIds (a parent's balance rolls them up). */
  includeSubaccounts?: boolean;
  /** With no `from`: start at the fiscal year containing `to` (the P&L default range). */
  fiscalYearToDate?: boolean;
}

export type WhyKind = 'created' | 'edited' | 'voided' | 'deleted';

export interface WhyChange {
  key: string;
  kind: WhyKind;
  /** Plain-language type, e.g. "invoice". */
  type: string;
  /** Description of the newest entry (what the user typed / the document summary). */
  label: string;
  /** Transaction date of the newest entry (YYYY-MM-DD). */
  date: string;
  /** Newest journal entry of the document (open it with QuickZoom). */
  entryId: string;
  entryNumber: number;
  sourceRef: string | null;
  before: string;
  after: string;
  delta: string;
  who: string | null;
  /** ISO time of the latest change. */
  when: string;
}

export interface WhyChangedResult {
  since: string;
  measure: 'natural' | 'credit' | 'debit' | 'gross';
  accounts: Array<{ id: string; code: string; name: string }>;
  /** The number now, then (at `since`, as far as these changes explain it), and the difference. */
  totalNow: string;
  totalThen: string;
  totalDelta: string;
  changes: WhyChange[];
  /** True when more than MAX_ENTRIES entries changed; the oldest were left out. */
  truncated: boolean;
}

const MAX_ENTRIES = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Source-link prefixes that carry the document's own id (lib/services/*: sourceRef `<prefix>:<id>`). */
const DOC_PREFIX: Record<string, string> = {
  invoice: 'invoice',
  'invoice-cogs': 'invoice',
  bill: 'bill',
  expense: 'expense',
  deposit: 'deposit',
  salesreceipt: 'sales_receipt',
  sales_receipt: 'sales_receipt',
  credit_memo: 'credit_memo',
  'creditmemo-cogs': 'credit_memo',
  vendor_credit: 'vendor_credit',
  payment: 'payment_received',
  item_receipt: 'item_receipt',
  item_receipt_edit: 'item_receipt',
  item_receipt_void: 'item_receipt',
  paycheck: 'paycheck',
  transfer: 'transfer',
};

const DOC_TABLES = [
  ['invoice', invoices],
  ['bill', bills],
  ['expense', expenses],
  ['deposit', deposits],
  ['payment_received', paymentsReceived],
  ['bill_payment', billPayments],
  ['sales_receipt', salesReceipts],
  ['credit_memo', creditMemos],
  ['vendor_credit', vendorCredits],
  ['transfer', transfers],
  ['item_receipt', itemReceipts],
  ['paycheck', paychecks],
] as const;

type Sign = 'debit' | 'credit';
function naturalSign(type: string): Sign {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

function presetSpec(p: WhyPreset): { types: string[]; measure: WhyChangedResult['measure'] } {
  switch (p) {
    case 'assets':
      return { types: ['asset'], measure: 'debit' };
    case 'liabilities':
      return { types: ['liability'], measure: 'credit' };
    // Total equity on the balance sheet includes retained earnings / net income to date.
    case 'equity':
      return { types: ['equity', 'revenue', 'expense'], measure: 'credit' };
    case 'income':
      return { types: ['revenue'], measure: 'credit' };
    case 'expenses':
      return { types: ['expense'], measure: 'debit' };
    case 'net_income':
      return { types: ['revenue', 'expense'], measure: 'credit' };
    case 'all':
      return { types: ['asset', 'liability', 'equity', 'revenue', 'expense'], measure: 'gross' };
  }
}

const dayStart = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dayEnd = (s: string) => new Date(`${s}T23:59:59.999Z`);
/** A YYYY-MM-DD string that is a real calendar date (not 2026-13-45, not 2026-02-31). */
const isRealDay = (s: string) => {
  if (!DAY.test(s)) return false;
  const d = dayStart(s);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export async function whyChanged(ctx: ServiceContext, input: WhyChangedInput): Promise<WhyChangedResult> {
  if (!(input.since instanceof Date) || isNaN(input.since.getTime())) throw validation('Choose a valid "since" date and time.');
  if (input.from && !isRealDay(input.from)) throw validation('The "from" date must be a real date, like 2026-01-31.');
  if (input.to && !isRealDay(input.to)) throw validation('The "to" date must be a real date, like 2026-01-31.');
  const since = input.since;

  // ---- 1. The account set and how each account's lines count ----
  const allAccounts = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  let measure: WhyChangedResult['measure'];
  let chosen: typeof allAccounts;
  if (input.accountIds && input.accountIds.length) {
    const ids = new Set(input.accountIds);
    for (const id of ids) if (!UUID.test(id)) throw validation('That account id is not valid.');
    if (input.includeSubaccounts) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const a of allAccounts) if (a.parentId && ids.has(a.parentId) && !ids.has(a.id)) { ids.add(a.id); grew = true; }
      }
    }
    chosen = allAccounts.filter((a) => ids.has(a.id));
    if (chosen.length === 0) throw validation('Those accounts do not exist in this company.');
    measure = 'natural';
  } else if (input.preset) {
    if (!WHY_PRESETS.includes(input.preset)) throw validation(`Unknown report line "${input.preset}".`);
    const spec = presetSpec(input.preset);
    chosen = allAccounts.filter((a) => spec.types.includes(a.type));
    measure = spec.measure;
  } else {
    throw validation('Choose an account or a report total.');
  }
  const signOf = new Map(chosen.map((a) => [a.id, measure === 'natural' ? naturalSign(a.type) : (measure as Sign)]));
  const accountIds = chosen.map((a) => a.id);

  let from = input.from ? dayStart(input.from) : null;
  if (!from && input.fiscalYearToDate) {
    from = (await resolveRange(ctx, { from: undefined, to: input.to ?? undefined })).from;
  }
  const to = input.to ? dayEnd(input.to) : null;
  const inWindow = (d: Date) => (!from || d >= from) && (!to || d <= to);
  const effectOf = (lines: Array<{ accountId: string; debit: string | null; credit: string | null }>) => {
    let total = Money.zero();
    for (const l of lines) {
      const sign = signOf.get(l.accountId);
      if (!sign) continue;
      const dr = Money.of(l.debit ?? 0);
      const cr = Money.of(l.credit ?? 0);
      total =
        measure === 'gross'
          ? total.plus(dr)
          : sign === 'debit'
            ? total.plus(dr).minus(cr)
            : total.plus(cr).minus(dr);
    }
    return total;
  };

  // ---- 2. The number now ----
  let totalNow = Money.zero();
  /** Net debit balance per account now (Trial Balance total = sum of the debit-side balances). */
  const netNow = new Map<string, ReturnType<typeof Money.zero>>();
  if (accountIds.length) {
    const dateConds = [];
    if (from) dateConds.push(gte(journalEntries.date, from));
    if (to) dateConds.push(lte(journalEntries.date, to));
    const sums = await ctx.db
      .select({
        accountId: journalEntryLines.accountId,
        debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          inArray(journalEntryLines.accountId, accountIds),
          ...dateConds,
        ),
      )
      .groupBy(journalEntryLines.accountId);
    totalNow = effectOf(sums.map((s) => ({ accountId: s.accountId, debit: String(s.debit), credit: String(s.credit) })));
    for (const s of sums) netNow.set(s.accountId, Money.of(String(s.debit)).minus(Money.of(String(s.credit))));
  }
  const tbTotal = (nets: Map<string, ReturnType<typeof Money.zero>>) => {
    let t = Money.zero();
    for (const v of nets.values()) if (v.greaterThan(0)) t = t.plus(v);
    return t;
  };
  if (measure === 'gross') totalNow = tbTotal(netNow);

  // ---- 3. Entries created or voided since `since` that touch the accounts ----
  const entries = accountIds.length
    ? await ctx.db
        .select({
          id: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          date: journalEntries.date,
          description: journalEntries.description,
          reference: journalEntries.reference,
          status: journalEntries.status,
          sourceRef: journalEntries.sourceRef,
          createdAt: journalEntries.createdAt,
          voidedAt: journalEntries.voidedAt,
          createdBy: journalEntries.createdBy,
        })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            inArray(journalEntries.status, ['posted', 'void']),
            or(gte(journalEntries.createdAt, since), and(isNotNull(journalEntries.voidedAt), gte(journalEntries.voidedAt, since))),
            sql`EXISTS (SELECT 1 FROM ${journalEntryLines} WHERE ${journalEntryLines.journalEntryId} = ${journalEntries.id} AND ${inArray(journalEntryLines.accountId, accountIds)})`,
          ),
        )
        .orderBy(desc(journalEntries.createdAt))
        .limit(MAX_ENTRIES + 1)
    : [];
  const truncated = entries.length > MAX_ENTRIES;
  if (truncated) entries.length = MAX_ENTRIES;
  const entryIds = entries.map((e) => e.id);

  const lines = entryIds.length
    ? await ctx.db
        .select({
          entryId: journalEntryLines.journalEntryId,
          accountId: journalEntryLines.accountId,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
        })
        .from(journalEntryLines)
        .where(and(inArray(journalEntryLines.journalEntryId, entryIds), inArray(journalEntryLines.accountId, accountIds)))
    : [];
  const linesByEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesByEntry.get(l.entryId) ?? [];
    list.push(l);
    linesByEntry.set(l.entryId, list);
  }

  // ---- 4. Group entries into documents ----
  const docOfEntry = new Map<string, { type: string; id: string }>();
  // a) the documents' current postedEntryId
  if (entryIds.length) {
    for (const [type, t] of DOC_TABLES) {
      const rows = await ctx.db
        .select({ id: t.id, entryId: t.postedEntryId })
        .from(t)
        .where(and(eq(t.companyId, ctx.companyId), inArray(t.postedEntryId, entryIds)));
      for (const r of rows) if (r.entryId) docOfEntry.set(r.entryId, { type, id: r.id });
    }
  }
  // b) audit trail since `since`: old / new postedEntryId of edited documents, JE replacements
  const audits = await ctx.db
    .select({
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      action: auditLogs.action,
      userId: auditLogs.userId,
      createdAt: auditLogs.createdAt,
      oldEntry: sql<string | null>`${auditLogs.oldValues} ->> 'postedEntryId'`,
      newEntry: sql<string | null>`${auditLogs.newValues} ->> 'postedEntryId'`,
      replacedBy: sql<string | null>`${auditLogs.newValues} ->> 'replacedBy'`,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), gte(auditLogs.createdAt, since)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(20_000);
  const replacedFrom = new Map<string, string>(); // replacement entry -> entry it replaced
  for (const a of audits) {
    if (a.entityType !== 'journal_entry') {
      for (const e of [a.oldEntry, a.newEntry]) {
        if (e && !docOfEntry.has(e)) docOfEntry.set(e, { type: a.entityType, id: a.entityId });
      }
    } else if (a.replacedBy) {
      replacedFrom.set(a.replacedBy, a.entityId);
    }
  }
  const rootOf = (id: string) => {
    let cur = id;
    const seen = new Set<string>();
    while (replacedFrom.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = replacedFrom.get(cur)!;
    }
    return cur;
  };
  const keyOf = (e: (typeof entries)[number]): { type: string; id: string } => {
    const [prefix, rest] = (e.sourceRef ?? '').split(':');
    if (rest && UUID.test(rest) && DOC_PREFIX[prefix]) return { type: DOC_PREFIX[prefix], id: rest };
    const doc = docOfEntry.get(e.id);
    if (doc) return doc;
    return { type: 'journal_entry', id: rootOf(e.id) };
  };

  interface Group {
    type: string;
    docId: string;
    entries: typeof entries;
    before: ReturnType<typeof Money.zero>;
    after: ReturnType<typeof Money.zero>;
    existedThen: boolean;
    existsNow: boolean;
  }
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const k = keyOf(e);
    const key = `${k.type}:${k.id}`;
    const g = groups.get(key) ?? { type: k.type, docId: k.id, entries: [], before: Money.zero(), after: Money.zero(), existedThen: false, existsNow: false };
    g.entries.push(e);
    const effect = inWindow(e.date) ? effectOf(linesByEntry.get(e.id) ?? []) : Money.zero();
    const existedThen = e.createdAt < since && (!e.voidedAt || e.voidedAt >= since);
    const postedNow = e.status === 'posted';
    if (existedThen) {
      g.before = g.before.plus(effect);
      g.existedThen = true;
    }
    if (postedNow) {
      g.after = g.after.plus(effect);
      g.existsNow = true;
    }
    groups.set(key, g);
  }

  // ---- 5. Who / when ----
  const auditByDoc = new Map<string, (typeof audits)[number]>();
  for (const a of audits) {
    const key = a.entityType === 'journal_entry' ? `journal_entry:${rootOf(a.entityId)}` : `${a.entityType}:${a.entityId}`;
    if (!auditByDoc.has(key)) auditByDoc.set(key, a); // newest first
  }
  const userIds = new Set<string>();
  for (const g of groups.values()) {
    const a = auditByDoc.get(`${g.type}:${g.docId}`);
    if (a?.userId) userIds.add(a.userId);
    for (const e of g.entries) userIds.add(e.createdBy);
  }
  const names = new Map<string, string>();
  if (userIds.size) {
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const r of rows) names.set(r.id, r.name || r.email);
  }

  // Per-account net change of every document (exact "then" for the Trial Balance total).
  const netThen = new Map(netNow);
  if (measure === 'gross') {
    for (const e of entries) {
      if (!inWindow(e.date)) continue;
      const existedThen = e.createdAt < since && (!e.voidedAt || e.voidedAt >= since);
      const postedNow = e.status === 'posted';
      if (existedThen === postedNow) continue;
      for (const l of linesByEntry.get(e.id) ?? []) {
        const net = Money.of(l.debit ?? 0).minus(Money.of(l.credit ?? 0));
        const cur = netThen.get(l.accountId) ?? Money.zero();
        netThen.set(l.accountId, postedNow ? cur.minus(net) : cur.plus(net));
      }
    }
  }

  const changes: WhyChange[] = [];
  let totalDelta = Money.zero();
  for (const [key, g] of groups) {
    const delta = g.after.minus(g.before);
    if (delta.isZero()) continue;
    totalDelta = totalDelta.plus(delta);
    const newest = [...g.entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const audit = auditByDoc.get(key);
    let kind: WhyKind = !g.existedThen ? 'created' : !g.existsNow ? 'voided' : 'edited';
    if (audit?.action === 'delete' && !g.existsNow) kind = 'deleted';
    const latestEntryChange = Math.max(...g.entries.map((e) => Math.max(e.createdAt.getTime(), e.voidedAt?.getTime() ?? 0)));
    const when = audit ? Math.max(audit.createdAt.getTime(), 0) : latestEntryChange;
    const whoId = audit?.userId ?? newest.createdBy;
    changes.push({
      key,
      kind,
      type: entityLabel(g.type),
      // References that are internal ids (sales-receipt COGS lines) are not shown.
      label:
        newest.description +
        (newest.reference && !UUID.test(newest.reference) && newest.reference.length <= 24 ? ` (ref ${newest.reference})` : ''),
      date: newest.date.toISOString().slice(0, 10),
      entryId: newest.id,
      entryNumber: newest.entryNumber,
      sourceRef: newest.sourceRef,
      before: toAmountString(g.before),
      after: toAmountString(g.after),
      delta: toAmountString(delta),
      who: names.get(whoId) ?? null,
      when: new Date(when).toISOString(),
    });
  }
  changes.sort((a, b) => b.when.localeCompare(a.when));

  return {
    since: since.toISOString(),
    measure,
    accounts: chosen.map((a) => ({ id: a.id, code: a.code, name: a.name })),
    totalNow: toAmountString(totalNow),
    totalThen: toAmountString(measure === 'gross' ? tbTotal(netThen) : totalNow.minus(totalDelta)),
    totalDelta: toAmountString(measure === 'gross' ? totalNow.minus(tbTotal(netThen)) : totalDelta),
    changes,
    truncated,
  };
}
