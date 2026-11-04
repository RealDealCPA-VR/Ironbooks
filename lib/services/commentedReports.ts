/**
 * Commented Reports (QB "Comment on Report", Reports > Commented Reports).
 *
 * A commented report is a picture of a report as it was when someone commented on it: the
 * server runs the report itself (runStandardReport — the caller's right to that report's own
 * activity is checked, and the numbers come from the books, never from the browser), keeps its
 * columns and rows without QuickZoom targets (a commented report does not change when the books
 * do, and its links would go stale), and stores the comments typed on its amounts. Comments are
 * numbered in order; each points at one cell (row id + column key) of the snapshot.
 *
 * Only someone who may view the report itself (its QB Enterprise report activity, e.g.
 * Accountant & Taxes reports, not merely any report of the area) can see, change or delete its
 * commented copies.
 *
 * Sensitive data: the picture is shared with every reader, so it never holds what some reader
 * may not see. It is taken with the sensitive-data rights switched off (SSNs / tax ids and bank
 * account numbers come out masked to the last four digits, as for a user without "view sensitive
 * payroll data" / "view full account numbers"), and every picture is masked again when read —
 * which also covers pictures saved before this rule.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { commentedReports } from '@/lib/db/schema';
import { canActivity, fullAccess } from '@/lib/permissions/model';
import type { ActivityKey } from '@/lib/permissions/activities';
import { maskAccountNumber, maskSensitive, maskSsn } from '@/lib/permissions/mask';
import { CATALOG_BY_KEY, reportActivity } from '@/lib/reports/catalog';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { requireActivity } from './access';
import { runStandardReport, standardReportEntry } from './reportRegistry';

import type { ReportComment } from '@/lib/reports/comments';

export type { ReportComment };

export const MAX_COMMENTS = 200;
export const MAX_COMMENT_LENGTH = 2000;

/** The report's own activity (memorizedReports / runStandardReport check the same); null for unknown types. */
function activityOf(reportType: unknown): ActivityKey | null {
  const e = typeof reportType === 'string' ? standardReportEntry(reportType) : undefined;
  if (!e) return null;
  try {
    return reportActivity(e);
  } catch {
    return null; // a report area with no activity: no one may see it (fail closed)
  }
}

function canView(ctx: ServiceContext, reportType: string): boolean {
  if (!ctx.access) return true;
  const activity = activityOf(reportType);
  return !!activity && canActivity(ctx.access, activity, 'view');
}

/** The caller's context with the sensitive-data rights off: what the picture is taken with. */
function maskedRunContext(ctx: ServiceContext): ServiceContext {
  const base = ctx.access ?? fullAccess();
  return { ...ctx, access: { ...base, flags: { ...base.flags, sensitivePayroll: false, fullAccountNumbers: false } } };
}

const NO_SENSITIVE = { flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false } };
const SSN_TEXT_KEYS = new Set(['ssn', 'employeeSsn', 'taxId']);
/** "ssn: 123-45-6789" inside a text cell (Voided/Deleted Detail's "Original values" summary). */
const SENSITIVE_IN_TEXT = /\b(ssn|employeeSsn|taxId|accountNumber|routingNumber|bankAccountNumber)(\s*[:=]\s*)([^·;\n]*?)(?=\s*[·;\n]|$)/g;

function maskText(v: string): string {
  return v.replace(SENSITIVE_IN_TEXT, (_m, key: string, sep: string, value: string) => {
    if (!value.trim()) return `${key}${sep}${value}`;
    const masked = SSN_TEXT_KEYS.has(key) ? maskSsn(value.trim()) : maskAccountNumber(value.trim());
    return `${key}${sep}${masked ?? ''}`;
  });
}

function maskStrings(v: unknown): unknown {
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map(maskStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskStrings(x)]));
  return v;
}

/**
 * A picture as every reader may see it: SSN / tax-id and account-number cells masked to the last
 * four digits (by column key, as maskSensitive does for API answers) and the same values masked
 * where a text cell quotes them. Idempotent (a masked value stays as it is).
 */
export function maskSnapshot(r: StdReport): StdReport {
  const rows = maskStrings(maskSensitive(r.rows, NO_SENSITIVE)) as StdRow[];
  return { ...r, rows };
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
    snapshot: maskSnapshot(row.snapshot as unknown as StdReport),
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
  const activity = activityOf(input.reportType);
  if (!activity) throw validation(`Unknown report type "${input.reportType}".`);
  requireActivity(ctx, activity, 'view');
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) if (v !== undefined && v !== null && String(v) !== '') params[k] = String(v);
  // Taken with the sensitive-data rights off: the picture is shown to readers who may lack them.
  const report = await runStandardReport(maskedRunContext(ctx), input.reportType, params);
  const snapshot = maskSnapshot(staticSnapshot(report));
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
