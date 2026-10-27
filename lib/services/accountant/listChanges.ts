/**
 * Review List Changes (QB Client Data Review → Review List Changes) — wave2 accountant, I10.
 *
 * Shows every change to master lists (chart of accounts, items, customers, vendors, employees,
 * payroll items, classes, sales tax items…) since a date, straight from the audit trail, with the
 * fields that changed. The accountant marks changes reviewed; that mark is stored per audit row
 * (list_change_reviews) and is itself audited.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { auditLogs, listChangeReviews, users } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, validation, writeAudit } from '../_base';
import { maskForContext } from '../access';
import { companyDayBound } from '../preferences';

export const LIST_ENTITY_TYPES: Record<string, string> = {
  account: 'Chart of Accounts',
  item: 'Items',
  customer: 'Customers',
  vendor: 'Vendors',
  employee: 'Employees',
  payroll_item: 'Payroll Items',
  class: 'Classes',
  location: 'Locations',
  job: 'Jobs',
  tax_rate: 'Sales Tax Items',
  tax_agency: 'Sales Tax Agencies',
  tax_rate_components: 'Sales Tax Items',
  sales_rep: 'Sales Reps',
  price_level: 'Price Levels',
  currency: 'Currencies',
};

export interface ListChangeRow {
  auditLogId: string;
  list: string;
  entityType: string;
  entityId: string;
  action: string;
  label: string;
  changedFields: string[];
  changedBy: string | null;
  changedAt: string;
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'id', 'companyId']);

/** Field names whose value differs between old and new snapshots. */
export function diffFields(oldV: unknown, newV: unknown): string[] {
  const o = (oldV && typeof oldV === 'object' ? oldV : {}) as Record<string, unknown>;
  const n = (newV && typeof newV === 'object' ? newV : {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
  const out: string[] = [];
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue;
    if (!(k in n) && Object.keys(n).length > 0 && Object.keys(o).length > 0) continue; // partial new snapshot
    if (JSON.stringify(o[k] ?? null) !== JSON.stringify(n[k] ?? null)) out.push(k);
  }
  return out.sort();
}

function labelOf(v: unknown): string {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pick = ['displayName', 'name', 'firstName', 'code', 'sku'];
  const parts: string[] = [];
  if (typeof r.code === 'string' && typeof r.name === 'string') return `${r.code} · ${r.name}`;
  if (typeof r.firstName === 'string') return `${r.firstName} ${typeof r.lastName === 'string' ? r.lastName : ''}`.trim();
  for (const k of pick) if (typeof r[k] === 'string' && r[k]) parts.push(String(r[k]));
  return parts[0] ?? '';
}

export async function listListChanges(
  ctx: ServiceContext,
  opts: { since?: Date | string | null; includeReviewed?: boolean; entityType?: string | null; limit?: number } = {},
): Promise<{ rows: ListChangeRow[]; unreviewed: number }> {
  // A 'since' day is the start of that calendar day in the company's time zone.
  const since = await companyDayBound(ctx, opts.since, 'since');
  const types = opts.entityType ? [opts.entityType] : Object.keys(LIST_ENTITY_TYPES);
  if (opts.entityType && !LIST_ENTITY_TYPES[opts.entityType]) throw validation('Unknown list.');
  const conds = [eq(auditLogs.companyId, ctx.companyId), inArray(auditLogs.entityType, types)];
  if (since) conds.push(gte(auditLogs.createdAt, since));
  const notReviewed = sql`NOT EXISTS (SELECT 1 FROM list_change_reviews r WHERE r.company_id = ${auditLogs.companyId} AND r.audit_log_id = ${auditLogs.id})`;
  // The count covers every unreviewed change, not just the rows on screen.
  const [{ n: unreviewed }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(...conds, notReviewed));
  // Hide reviewed changes BEFORE the limit: the newest 1,000 changes being reviewed (a large
  // QuickBooks conversion) must never hide an older one nobody has looked at.
  if (!opts.includeReviewed) conds.push(notReviewed);
  const rows = await ctx.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
      createdAt: auditLogs.createdAt,
      userName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(opts.limit ?? 1000, 5000));
  const ids = rows.map((r) => r.id);
  const reviews = ids.length
    ? await ctx.db
        .select({ auditLogId: listChangeReviews.auditLogId, reviewedAt: listChangeReviews.reviewedAt, reviewer: users.name })
        .from(listChangeReviews)
        .leftJoin(users, eq(listChangeReviews.reviewedBy, users.id))
        .where(and(eq(listChangeReviews.companyId, ctx.companyId), inArray(listChangeReviews.auditLogId, ids)))
    : [];
  const rev = new Map(reviews.map((r) => [r.auditLogId, r]));
  // Labels: latest known snapshot per entity (new values first, then old).
  const out: ListChangeRow[] = [];
  for (const r of rows) {
    const rv = rev.get(r.id);
    if (rv && !opts.includeReviewed) continue; // reviewed since the query above
    const oldV = maskForContext(ctx, r.oldValues);
    const newV = maskForContext(ctx, r.newValues);
    out.push({
      auditLogId: r.id,
      list: LIST_ENTITY_TYPES[r.entityType] ?? r.entityType,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      label: labelOf(newV) || labelOf(oldV) || r.entityId.slice(0, 8),
      changedFields: r.action === 'update' ? diffFields(oldV, newV) : [],
      changedBy: r.userName ?? null,
      changedAt: r.createdAt.toISOString(),
      reviewed: Boolean(rv),
      reviewedBy: rv?.reviewer ?? null,
      reviewedAt: rv ? rv.reviewedAt.toISOString() : null,
    });
  }
  return { rows: out, unreviewed };
}

/** Mark (or unmark) list changes as reviewed. */
export async function markListChangesReviewed(
  ctx: ServiceContext,
  input: { auditLogIds: string[]; reviewed: boolean },
): Promise<{ updated: number }> {
  const ids = [...new Set(input.auditLogIds ?? [])];
  if (ids.length === 0) throw validation('Select at least one change.');
  return inTransaction(ctx, async (tx) => {
    const valid = await tx.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, tx.companyId),
          inArray(auditLogs.id, ids),
          inArray(auditLogs.entityType, Object.keys(LIST_ENTITY_TYPES)),
        ),
      );
    const validIds = valid.map((v) => v.id);
    if (validIds.length === 0) return { updated: 0 };
    const existing = await tx.db
      .select({ id: listChangeReviews.id, auditLogId: listChangeReviews.auditLogId })
      .from(listChangeReviews)
      .where(and(eq(listChangeReviews.companyId, tx.companyId), inArray(listChangeReviews.auditLogId, validIds)));
    const have = new Set(existing.map((e) => e.auditLogId));
    let updated = 0;
    if (input.reviewed) {
      const toAdd = validIds.filter((id) => !have.has(id));
      if (toAdd.length) {
        await tx.db
          .insert(listChangeReviews)
          .values(toAdd.map((auditLogId) => ({ companyId: tx.companyId, auditLogId, reviewedBy: tx.userId })));
      }
      updated = toAdd.length;
    } else if (existing.length) {
      await tx.db.delete(listChangeReviews).where(inArray(listChangeReviews.id, existing.map((e) => e.id)));
      updated = existing.length;
    }
    if (updated > 0) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'list_change_review',
        entityId: validIds[0],
        newValues: { reviewed: input.reviewed, auditLogIds: validIds },
      });
    }
    return { updated };
  });
}
