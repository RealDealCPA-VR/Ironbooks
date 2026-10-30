/**
 * Commented Reports (QB "Comment on Report", Reports > Commented Reports).
 *
 * A commented report is a picture of a report as it was when someone commented on it: the
 * server runs the report itself (runStandardReport — the caller's permission for that report's
 * area is checked, and the numbers come from the books, never from the browser), keeps its
 * columns and rows without QuickZoom targets (a commented report does not change when the books
 * do, and its links would go stale), and stores the comments typed on its amounts. Comments are
 * numbered in order; each points at one cell (row id + column key) of the snapshot.
 *
 * Only someone who may view the report's area can see, change or delete its commented copies.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { commentedReports } from '@/lib/db/schema';
import { can } from '@/lib/permissions/model';
import { CATALOG_BY_KEY } from '@/lib/reports/catalog';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { requirePermission } from './access';
import { runStandardReport, standardReportEntry } from './reportRegistry';

import type { ReportComment } from '@/lib/reports/comments';

export type { ReportComment };

export const MAX_COMMENTS = 200;
export const MAX_COMMENT_LENGTH = 2000;

/** The report's area: the caller must be able to view it (unknown types: no one may). */
function areaOf(reportType: string) {
  const e = standardReportEntry(reportType);
  if (!e) throw validation(`Unknown report type "${reportType}".`);
  return e.area;
}

function canView(ctx: ServiceContext, reportType: string): boolean {
  if (!ctx.access) return true;
  const e = typeof reportType === 'string' ? CATALOG_BY_KEY[reportType] : undefined;
  return !!e && can(ctx.access, e.area, 'view');
}

/** A static copy of the report: no QuickZoom targets, entry links or explanations. */
export function staticSnapshot(r: StdReport): StdReport {
  const rows: StdRow[] = r.rows.map((row) => {
    const { href: _h, hrefs: _hs, entryId: _e, ...rest } = row;
    void _h;
    void _hs;
    void _e;
    return rest;
  });
  return { key: r.key, title: r.title, subtitle: r.subtitle, columns: r.columns, rows, notes: r.notes, basis: r.basis, range: r.range, balanced: r.balanced, truncated: r.truncated };
}

/** Validate comments against the snapshot: each names an existing row and column, has text. */
export function cleanComments(snapshot: StdReport, input: unknown): ReportComment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw validation('Comments must be a list.');
  if (input.length > MAX_COMMENTS) throw validation(`A commented report can hold at most ${MAX_COMMENTS} comments.`);
  const rowIds = new Set(snapshot.rows.map((r) => r.id));
  const colKeys = new Set(snapshot.columns.map((c) => c.key));
  const out: ReportComment[] = [];
  const seen = new Set<string>();
  for (const [i, c] of input.entries()) {
    if (!c || typeof c !== 'object') throw validation(`Comment ${i + 1} is not valid.`);
    const { rowId, columnKey, text, id } = c as Record<string, unknown>;
    if (typeof rowId !== 'string' || !rowIds.has(rowId)) throw validation(`Comment ${i + 1} is not on a line of this report.`);
    if (typeof columnKey !== 'string' || !colKeys.has(columnKey)) throw validation(`Comment ${i + 1} is not on a column of this report.`);
    if (typeof text !== 'string' || !text.trim()) throw validation(`Comment ${i + 1} is empty.`);
    if (text.length > MAX_COMMENT_LENGTH) throw validation(`Comment ${i + 1} is longer than ${MAX_COMMENT_LENGTH} characters.`);
    const cid = typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id) && !seen.has(id) ? id : randomUUID();
    seen.add(cid);
    out.push({ id: cid, rowId, columnKey, text: text.trim() });
  }
  return out;
}

function publicRow(row: typeof commentedReports.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    reportType: row.reportType,
    params: row.params,
    snapshot: row.snapshot as unknown as StdReport,
    comments: row.comments as ReportComment[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type CommentedReport = ReturnType<typeof publicRow>;

/** Commented reports of this company the caller may see (newest first; without the snapshots). */
export async function listCommentedReports(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      id: commentedReports.id,
      name: commentedReports.name,
      reportType: commentedReports.reportType,
      comments: commentedReports.comments,
      createdAt: commentedReports.createdAt,
      updatedAt: commentedReports.updatedAt,
    })
    .from(commentedReports)
    .where(eq(commentedReports.companyId, ctx.companyId))
    .orderBy(desc(commentedReports.createdAt));
  return rows
    .filter((r) => canView(ctx, r.reportType))
    .map((r) => ({ id: r.id, name: r.name, reportType: r.reportType, reportTitle: CATALOG_BY_KEY[r.reportType]?.title ?? r.reportType, commentCount: (r.comments as ReportComment[]).length, createdAt: r.createdAt, updatedAt: r.updatedAt }));
}

async function loadRow(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(commentedReports)
    .where(and(eq(commentedReports.id, id), eq(commentedReports.companyId, ctx.companyId)));
  if (!row) throw notFound('Commented report');
  if (!canView(ctx, row.reportType)) throw notFound('Commented report');
  return row;
}

export async function getCommentedReport(ctx: ServiceContext, id: string): Promise<CommentedReport> {
  return publicRow(await loadRow(ctx, id));
}

/**
 * Save a commented report: run the report with `params` (checked like any run) and keep the
 * result as a static picture with the comments.
 */
export async function saveCommentedReport(
  ctx: ServiceContext,
  input: { name: string; reportType: string; params?: Record<string, unknown>; comments?: unknown },
): Promise<CommentedReport> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw validation('Give the commented report a name.');
  if (name.length > 255) throw validation('The name is too long.');
  if (typeof input.reportType !== 'string') throw validation('Report type is required.');
  requirePermission(ctx, areaOf(input.reportType), 'view');
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) if (v !== undefined && v !== null && String(v) !== '') params[k] = String(v);
  const report = await runStandardReport(ctx, input.reportType, params);
  const snapshot = staticSnapshot(report);
  const comments = cleanComments(snapshot, input.comments);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(commentedReports)
      .values({
        companyId: tx.companyId,
        name,
        reportType: input.reportType,
        params,
        snapshot: snapshot as unknown as Record<string, unknown>,
        comments,
        createdBy: tx.userId ?? null,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'commented_report', entityId: row.id, newValues: { name, reportType: input.reportType, comments: comments.length } });
    return publicRow(row);
  });
}

/** Rename a commented report or change its comments (the snapshot never changes). */
export async function updateCommentedReport(
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; comments?: unknown },
): Promise<CommentedReport> {
  const before = await loadRow(ctx, id);
  const name = patch.name !== undefined ? String(patch.name).trim() : before.name;
  if (!name) throw validation('Give the commented report a name.');
  if (name.length > 255) throw validation('The name is too long.');
  const comments = patch.comments !== undefined ? cleanComments(before.snapshot as unknown as StdReport, patch.comments) : (before.comments as ReportComment[]);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(commentedReports)
      .set({ name, comments, updatedAt: new Date() })
      .where(and(eq(commentedReports.id, id), eq(commentedReports.companyId, tx.companyId)))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'commented_report',
      entityId: id,
      oldValues: { name: before.name, comments: (before.comments as ReportComment[]).length },
      newValues: { name, comments: comments.length },
    });
    return publicRow(row);
  });
}

export async function deleteCommentedReport(ctx: ServiceContext, id: string): Promise<{ deleted: true }> {
  const before = await loadRow(ctx, id);
  return inTransaction(ctx, async (tx) => {
    await tx.db.delete(commentedReports).where(and(eq(commentedReports.id, id), eq(commentedReports.companyId, tx.companyId)));
    await writeAudit(tx, { action: 'delete', entityType: 'commented_report', entityId: id, oldValues: { name: before.name, reportType: before.reportType } });
    return { deleted: true as const };
  });
}
