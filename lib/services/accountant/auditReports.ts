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
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { auditLogs, companies, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from '../_base';
import { maskForContext } from '../access';

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

export async function closingDateExceptionReport(
  ctx: ServiceContext,
  range: { from?: Date; to?: Date } = {},
): Promise<{ closingDate: string | null; rows: ClosingDateExceptionRow[] }> {
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

  // Entries dated on/before the CURRENT closing date but created after it was set.
  if (cd) {
    const setLogs = await ctx.db
      .select({ createdAt: auditLogs.createdAt, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(asc(auditLogs.createdAt));
    const setAt = setLogs
      .filter((s) => ((s.newValues ?? {}) as Record<string, unknown>).closingDate === cd)
      .map((s) => s.createdAt)[0];
    if (setAt) {
      const seen = new Set(rows.map((r) => r.entryId));
      const late = await ctx.db
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
            lte(journalEntries.date, new Date(`${cd}T23:59:59.999Z`)),
            gt(journalEntries.createdAt, setAt),
          ),
        );
      const lateAmounts = await entryAmounts(ctx, late.map((l) => l.id));
      for (const e of late) {
        if (seen.has(e.id)) continue;
        if (range.from && e.createdAt < range.from) continue;
        if (range.to && e.createdAt > range.to) continue;
        rows.push({
          auditLogId: null,
          entryId: e.id,
          entryNumber: e.entryNumber,
          operation: 'post',
          transactionDate: e.date.toISOString().slice(0, 10),
          closingDate: cd,
          description: e.description,
          amount: lateAmounts.get(e.id) ?? null,
          user: e.user ?? null,
          at: e.createdAt.toISOString(),
          source: 'entered_after_close',
        });
      }
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return { closingDate: cd, rows };
}

async function entryAmounts(ctx: ServiceContext, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: journalEntryLines.journalEntryId, total: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntryLines.journalEntryId, ids)))
    .groupBy(journalEntryLines.journalEntryId);
  return new Map(rows.map((r) => [r.id, toAmountString(r.total)]));
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
  opts: { from?: Date; to?: Date; detail?: boolean } = {},
): Promise<{ rows: VoidedDeletedRow[]; count: number }> {
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
  const docTables: Record<string, { table: string; num: string; total: string; party?: string; partyTable?: string }> = {
    invoice: { table: 'invoices', num: 'invoice_number', total: 'total', party: 'customer_id', partyTable: 'customers' },
    sales_receipt: { table: 'sales_receipts', num: 'receipt_number', total: 'total', party: 'customer_id', partyTable: 'customers' },
    credit_memo: { table: 'credit_memos', num: 'memo_number', total: 'total', party: 'customer_id', partyTable: 'customers' },
    payment_received: { table: 'payments_received', num: 'reference', total: 'amount', party: 'customer_id', partyTable: 'customers' },
    bill: { table: 'bills', num: 'bill_number', total: 'total', party: 'vendor_id', partyTable: 'vendors' },
    bill_payment: { table: 'bill_payments', num: 'reference', total: 'amount', party: 'vendor_id', partyTable: 'vendors' },
    vendor_credit: { table: 'vendor_credits', num: 'memo', total: 'total', party: 'vendor_id', partyTable: 'vendors' },
    expense: { table: 'expenses', num: 'reference', total: 'total', party: 'vendor_id', partyTable: 'vendors' },
    deposit: { table: 'deposits', num: 'memo', total: 'total' },
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
      const partySel = spec.party ? sql.raw(`, p.display_name AS party`) : sql.raw(`, NULL AS party`);
      const partyJoin = spec.party ? sql.raw(` LEFT JOIN ${spec.partyTable} p ON p.id = t.${spec.party}`) : sql.raw('');
      const res = await ctx.db.execute(
        sql`SELECT t.id, t.${sql.raw(spec.num)}::text AS num, t.date, t.${sql.raw(spec.total)}::text AS total${partySel}
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
      number: i?.number ?? pickStr(snap, ['invoiceNumber', 'receiptNumber', 'memoNumber', 'entryNumber', 'billNumber', 'reference', 'number']),
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
