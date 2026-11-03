/**
 * Memorized (saved) reports — store a report type + its settings / filters so users can re-run a
 * customized report later (QuickBooks "Memorized Reports"), organised in Memorized Report Groups,
 * run a whole group at once ("Process Multiple Reports") and run on a schedule (exports saved to
 * a local folder; the desktop shell's timer calls runDueSchedules), optionally emailed to the
 * schedule's recipients (QB "Send report as e-mail") through lib/services/email.ts.
 *
 * Config shape for standard reports: { params: { from, to, accountId, … }, display: { … } }.
 * Report builder ("custom") reports keep their own config shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { memorizedReportGroups, memorizedReports, reportSchedules } from '@/lib/db/schema';
import { resolveDataDir } from '@/lib/db';
import { buildXlsx, buildXlsxWorkbook } from '@/lib/export/xlsx';
import { localDateISO } from '@/lib/dates';
import { reportToCsv, reportToTable, type StdReport } from '@/lib/reports/types';
import { type ServiceContext, notFound, validation, writeAudit, inTransaction } from './_base';
import { runStandardReport, standardReportEntry } from './reportRegistry';
import { runReport, type ReportConfig } from './reportBuilder';
import { requireActivity, requirePermission, resolveAccess } from './access';
import { reportActivity } from '@/lib/reports/catalog';
import { requireAnyReportAccess } from './reportsAccess';
import { assertNotSandbox } from './sandboxState';
import { sendMail } from './email';
import { getCompany, getPreferences } from './company';
import { fillMergeFields } from '@/lib/preferences';
import { can, canActivity, type Area, type EffectiveAccess } from '@/lib/permissions/model';

/**
 * Permission area a memorized report's data belongs to. Report builder ("custom") reports read
 * general-ledger lines, so they need the financial reports area. Unknown types → undefined.
 */
function areaForReportType(reportType: string): Area | undefined {
  if (reportType === 'custom') return 'reports_financial';
  return standardReportEntry(reportType)?.area;
}

/** The caller must be able to view the report's area (and so run it) to save or change it. */
function requireReportTypeAccess(ctx: ServiceContext, reportType: string): void {
  const area = areaForReportType(reportType);
  if (!area) throw validation(`Unknown report type "${reportType}".`);
  requireReportView(ctx, reportType, area);
}

/** View of the report's own activity (prefsperms), or of Custom Reports for the report builder. */
function requireReportView(ctx: ServiceContext, reportType: string, area: Area): void {
  const entry = standardReportEntry(reportType);
  if (entry) requireActivity(ctx, reportActivity(entry), 'view');
  else if (reportType === 'custom') requireActivity(ctx, 'reports_financial.custom', 'view');
  else requirePermission(ctx, area, 'view');
}

/**
 * Gate for changing or removing an existing row. Rows saved before report types were validated
 * may carry a type no longer in the catalog; they can't be run (NOT_FOUND), so they expose no data,
 * and anyone with report access may rename, move or delete them instead of being stuck forever.
 */
function requireExistingRowAccess(ctx: ServiceContext, reportType: string): void {
  const area = typeof reportType === 'string' ? areaForReportType(reportType) : undefined;
  if (!area) {
    requireAnyReportAccess(ctx);
    return;
  }
  requireReportView(ctx, reportType, area);
}

// ---------------------------------------------------------------------------
// Memorized reports
// ---------------------------------------------------------------------------

export async function listMemorizedReports(ctx: ServiceContext) {
  requireAnyReportAccess(ctx);
  return ctx.db
    .select()
    .from(memorizedReports)
    .where(eq(memorizedReports.companyId, ctx.companyId))
    .orderBy(asc(memorizedReports.name));
}

async function assertGroup(ctx: ServiceContext, groupId: string | null | undefined) {
  if (!groupId) return;
  const [g] = await ctx.db
    .select({ id: memorizedReportGroups.id })
    .from(memorizedReportGroups)
    .where(and(eq(memorizedReportGroups.id, groupId), eq(memorizedReportGroups.companyId, ctx.companyId)));
  if (!g) throw notFound('Report group');
}

export async function saveMemorizedReport(
  ctx: ServiceContext,
  input: { name: string; reportType: string; config: Record<string, unknown>; groupId?: string | null },
) {
  requireAnyReportAccess(ctx);
  if (!input.name?.trim()) throw validation('Report name is required.');
  if (typeof input.reportType !== 'string' || !input.reportType.trim()) throw validation('Report type is required.');
  requireReportTypeAccess(ctx, input.reportType);
  await assertGroup(ctx, input.groupId);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(memorizedReports)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        reportType: input.reportType,
        config: input.config ?? {},
        groupId: input.groupId ?? null,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'memorized_report',
      entityId: row.id,
      newValues: { name: row.name, reportType: row.reportType, groupId: row.groupId },
    });
    return row;
  });
}

async function getMemorized(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(memorizedReports)
    .where(and(eq(memorizedReports.id, id), eq(memorizedReports.companyId, ctx.companyId)));
  if (!row) throw notFound('Memorized report');
  return row;
}

/** Rename, move to another group, or replace the saved settings ("Memorize → Replace"). */
export async function updateMemorizedReport(
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; config?: Record<string, unknown>; groupId?: string | null },
) {
  requireAnyReportAccess(ctx);
  const before = await getMemorized(ctx, id);
  // Only someone who may run this report can rename, move or re-point it.
  requireExistingRowAccess(ctx, before.reportType);
  if (patch.name !== undefined && !patch.name.trim()) throw validation('Report name is required.');
  if (patch.groupId !== undefined) await assertGroup(ctx, patch.groupId);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(memorizedReports)
      .set({
        name: patch.name !== undefined ? patch.name.trim() : before.name,
        config: patch.config ?? before.config,
        groupId: patch.groupId !== undefined ? patch.groupId : before.groupId,
        updatedAt: new Date(),
      })
      .where(eq(memorizedReports.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'memorized_report',
      entityId: id,
      oldValues: { name: before.name, groupId: before.groupId, config: before.config },
      newValues: { name: row.name, groupId: row.groupId, config: row.config },
    });
    return row;
  });
}

export async function deleteMemorizedReport(ctx: ServiceContext, id: string) {
  requireAnyReportAccess(ctx);
  const row = await getMemorized(ctx, id);
  requireExistingRowAccess(ctx, row.reportType);
  return inTransaction(ctx, async (tx) => {
    // Schedules that run this report go with it.
    await tx.db.delete(reportSchedules).where(and(eq(reportSchedules.companyId, tx.companyId), eq(reportSchedules.memorizedReportId, id)));
    await tx.db.delete(memorizedReports).where(eq(memorizedReports.id, id));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'memorized_report',
      entityId: id,
      oldValues: { name: row.name, reportType: row.reportType },
    });
    return { deleted: true };
  });
}

/** Turn a report-builder result into the standard report shape (for groups / schedules). */
async function runCustomReport(ctx: ServiceContext, name: string, config: Record<string, unknown>): Promise<StdReport> {
  // Report builder output is general-ledger data: same gate as the GL / financial reports.
  requirePermission(ctx, 'reports_financial.custom', 'view');
  const res = await runReport(ctx, config as unknown as ReportConfig);
  return {
    key: 'custom',
    title: name,
    subtitle: [config.from, config.to].filter(Boolean).join(' – ') || 'All dates',
    columns: [
      { key: 'label', header: 'Group' },
      { key: 'debit', header: 'Debit', type: 'money' },
      { key: 'credit', header: 'Credit', type: 'money' },
      { key: 'net', header: 'Net', type: 'money' },
    ],
    rows: [
      ...res.rows.map((r) => ({ id: r.key, depth: 0, kind: 'data' as const, cells: { label: r.label, debit: r.debit, credit: r.credit, net: r.net } })),
      { id: 'total', depth: 0, kind: 'grand' as const, cells: { label: 'TOTAL', ...res.totals } },
    ],
  };
}

/** Run one memorized report with its saved settings (permission-checked per report area). */
export async function runMemorizedReport(ctx: ServiceContext, id: string): Promise<StdReport> {
  requireAnyReportAccess(ctx);
  const row = await getMemorized(ctx, id);
  return runMemorizedRow(ctx, row);
}

async function runMemorizedRow(
  ctx: ServiceContext,
  row: { name: string; reportType: string; config: Record<string, unknown> },
  opts: { now?: Date } = {},
): Promise<StdReport> {
  if (row.reportType === 'custom') return runCustomReport(ctx, row.name, row.config ?? {});
  const cfg = row.config ?? {};
  const params = (cfg.params && typeof cfg.params === 'object' ? cfg.params : cfg) as Record<string, unknown>;
  const report = await runStandardReport(ctx, row.reportType, params, { now: opts.now });
  const display = (cfg.display ?? {}) as { title?: string; subtitle?: string };
  return { ...report, title: display.title?.trim() || row.name || report.title, subtitle: display.subtitle?.trim() || report.subtitle };
}

// ---------------------------------------------------------------------------
// Memorized report groups + Process Multiple Reports
// ---------------------------------------------------------------------------

export async function listMemorizedGroups(ctx: ServiceContext) {
  requireAnyReportAccess(ctx);
  return ctx.db
    .select()
    .from(memorizedReportGroups)
    .where(eq(memorizedReportGroups.companyId, ctx.companyId))
    .orderBy(asc(memorizedReportGroups.name));
}

export async function createMemorizedGroup(ctx: ServiceContext, input: { name: string }) {
  requireAnyReportAccess(ctx);
  if (!input.name?.trim()) throw validation('Group name is required.');
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(memorizedReportGroups)
      .values({ companyId: tx.companyId, name: input.name.trim() })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'memorized_report_group', entityId: row.id, newValues: { name: row.name } });
    return row;
  });
}

async function getGroup(ctx: ServiceContext, id: string) {
  const [g] = await ctx.db
    .select()
    .from(memorizedReportGroups)
    .where(and(eq(memorizedReportGroups.id, id), eq(memorizedReportGroups.companyId, ctx.companyId)));
  if (!g) throw notFound('Report group');
  return g;
}

/** Report types a schedule would run: its one memorized report, or every report in its group. */
async function scheduleReportTypes(
  ctx: ServiceContext,
  target: { memorizedReportId?: string | null; groupId?: string | null },
): Promise<string[]> {
  if (target.memorizedReportId) {
    const [row] = await ctx.db
      .select({ reportType: memorizedReports.reportType })
      .from(memorizedReports)
      .where(and(eq(memorizedReports.id, target.memorizedReportId), eq(memorizedReports.companyId, ctx.companyId)));
    return row ? [row.reportType] : [];
  }
  if (target.groupId) {
    const rows = await ctx.db
      .select({ reportType: memorizedReports.reportType })
      .from(memorizedReports)
      .where(and(eq(memorizedReports.companyId, ctx.companyId), eq(memorizedReports.groupId, target.groupId)));
    return rows.map((r) => r.reportType);
  }
  return [];
}

/**
 * True when `access` may view every report a schedule runs. Report types no longer in the catalog
 * can't run (and expose no data), so they don't block. Undefined access = trusted context.
 */
function canRunReportTypes(access: EffectiveAccess | undefined, types: string[]): boolean {
  if (!access) return true;
  return types.every((t) => {
    const area = typeof t === 'string' ? areaForReportType(t) : undefined;
    if (!area) return true;
    // prefsperms: the report's own activity, as runStandardReport checks it.
    const entry = standardReportEntry(t);
    if (entry) return canActivity(access, reportActivity(entry), 'view');
    if (t === 'custom') return canActivity(access, 'reports_financial.custom', 'view');
    return can(access, area, 'view'); // an area with no catalog entry: the whole area (fail closed)
  });
}

export async function renameMemorizedGroup(ctx: ServiceContext, id: string, input: { name: string }) {
  requireAnyReportAccess(ctx);
  const g = await getGroup(ctx, id);
  if (!input.name?.trim()) throw validation('Group name is required.');
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(memorizedReportGroups)
      .set({ name: input.name.trim() })
      .where(eq(memorizedReportGroups.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'memorized_report_group', entityId: id, oldValues: { name: g.name }, newValues: { name: row.name } });
    return row;
  });
}

/** Delete a group; its reports are kept (moved to "no group"), its schedules are removed. */
export async function deleteMemorizedGroup(ctx: ServiceContext, id: string) {
  requireAnyReportAccess(ctx);
  const g = await getGroup(ctx, id);
  return inTransaction(ctx, async (tx) => {
    await tx.db.update(memorizedReports).set({ groupId: null }).where(and(eq(memorizedReports.companyId, tx.companyId), eq(memorizedReports.groupId, id)));
    await tx.db.delete(reportSchedules).where(and(eq(reportSchedules.companyId, tx.companyId), eq(reportSchedules.groupId, id)));
    await tx.db.delete(memorizedReportGroups).where(eq(memorizedReportGroups.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'memorized_report_group', entityId: id, oldValues: { name: g.name } });
    return { deleted: true };
  });
}

export interface ProcessedReport {
  id: string;
  name: string;
  report?: StdReport;
  error?: string;
}

/**
 * Process Multiple Reports: run every report in a group (or the given ids). A report the caller
 * may not run, or that fails, is reported with its error instead of aborting the batch.
 */
export async function processMultipleReports(
  ctx: ServiceContext,
  input: { groupId?: string; ids?: string[] },
  opts: { now?: Date } = {},
): Promise<ProcessedReport[]> {
  requireAnyReportAccess(ctx);
  let rows;
  if (input.groupId) {
    await getGroup(ctx, input.groupId);
    rows = await ctx.db
      .select()
      .from(memorizedReports)
      .where(and(eq(memorizedReports.companyId, ctx.companyId), eq(memorizedReports.groupId, input.groupId)))
      .orderBy(asc(memorizedReports.name));
  } else if (input.ids?.length) {
    rows = await ctx.db
      .select()
      .from(memorizedReports)
      .where(and(eq(memorizedReports.companyId, ctx.companyId), inArray(memorizedReports.id, input.ids)))
      .orderBy(asc(memorizedReports.name));
  } else {
    throw validation('Choose a report group or at least one memorized report.');
  }
  const out: ProcessedReport[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, name: r.name, report: await runMemorizedRow(ctx, r, opts) });
    } catch (err) {
      out.push({ id: r.id, name: r.name, error: err instanceof Error ? err.message : 'Report failed.' });
    }
  }
  return out;
}

/** One workbook, one sheet per report (Process Multiple Reports → Export all). */
export function reportsToWorkbook(reports: StdReport[]): Buffer {
  const used = new Set<string>();
  return buildXlsxWorkbook(
    reports.map((r) => {
      const t = reportToTable(r);
      let sheet = r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Report';
      let n = 2;
      while (used.has(sheet.toLowerCase())) sheet = `${sheet.slice(0, 25)} ${n++}`;
      used.add(sheet.toLowerCase());
      return { sheetName: sheet, title: r.title, subtitle: r.subtitle, columns: t.columns, rows: t.rows };
    }),
  );
}

// ---------------------------------------------------------------------------
// Scheduled reports
// ---------------------------------------------------------------------------

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

/**
 * Next run after `from`. Monthly schedules keep their anchor day (the start date's day of month):
 * one started Jan 31 runs Feb 28, then Mar 31 — the clamped day never becomes the new anchor.
 */
export function nextRunAfter(from: Date, frequency: ScheduleFrequency, anchorDay?: number | null): Date {
  // Calendar arithmetic on this computer's LOCAL calendar (the desktop timer's clock): a run stays
  // at the same local time of day across daylight-saving changes and on its local calendar day,
  // which is the day its relative dates ("Last month") are resolved on.
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else {
    const day = anchorDay && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return d;
}

/**
 * Root folder for scheduled exports: BKA_REPORT_EXPORT_DIR when the desktop shell sets one,
 * else "Report Exports/<company file>" next to the company's data folder. Never inside the
 * database directory itself.
 */
export function reportExportRoot(): string {
  if (process.env.BKA_REPORT_EXPORT_DIR) return path.resolve(process.env.BKA_REPORT_EXPORT_DIR);
  // A single company file (1.6): the server runs on its private working copy under
  // %LOCALAPPDATA%\Ironbooks\Working\…\data — a cache that is replaced and cleaned up — so the
  // exports go next to the company file itself ("Report Exports/<file name>").
  const companyFile = process.env.BKA_COMPANY_FILE?.trim();
  if (companyFile) {
    const file = path.resolve(companyFile);
    return path.join(path.dirname(file), 'Report Exports', path.basename(file, path.extname(file)));
  }
  const dataDir = resolveDataDir();
  return path.join(path.dirname(dataDir), 'Report Exports', path.basename(dataDir));
}

/** Local midnight of a 'YYYY-MM-DD' calendar day (Invalid Date for anything else). */
function localMidnight(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return new Date(NaN);
  const d = new Date(2000, Number(m[2]) - 1, Number(m[3]));
  d.setFullYear(Number(m[1])); // years below 100 are not 19xx
  return d.getDate() === Number(m[3]) && d.getMonth() === Number(m[2]) - 1 ? d : new Date(NaN);
}

function safeSegment(s: string, fallback: string): string {
  const out = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\.{2,}/g, '.').trim().slice(0, 80);
  return out && out !== '.' ? out : fallback;
}

/** Most recipients one schedule may email (QB keeps a short To list on a report email). */
export const MAX_SCHEDULE_RECIPIENTS = 20;
const EMAIL_RE = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;

/**
 * A schedule's recipients: comma / semicolon / space separated addresses, trimmed, duplicates
 * (any case) dropped, joined with ", ". Empty → null (files only). Anything that is not a plain
 * email address (a name, a header injection, a list of 21) is refused.
 */
export function normalizeRecipients(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw validation('Recipients must be email addresses.');
  if (/[\r\n]/.test(input)) throw validation('Recipients must be email addresses, one after another.');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,;\s]+/)) {
    const a = raw.trim();
    if (!a) continue;
    if (a.length > 254 || !EMAIL_RE.test(a)) throw validation(`"${a.slice(0, 60)}" is not a valid email address.`);
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  if (out.length > MAX_SCHEDULE_RECIPIENTS) throw validation(`A schedule can email at most ${MAX_SCHEDULE_RECIPIENTS} people.`);
  return out.length ? out.join(', ') : null;
}

/**
 * Write a file so a reader never sees half of it: into a temporary file next to it, then renamed
 * over the old one. A write that fails (disk full, the folder went away) leaves the previous
 * export as it was and no temporary file behind.
 */
function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    if (typeof data === 'string') fs.writeFileSync(tmp, data, 'utf8');
    else fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the temporary file could not be removed either: nothing more to do */
    }
    throw err;
  }
}

/** Email wording of a scheduled report (Send Forms "report" template when the company has one). */
const DEFAULT_REPORT_EMAIL = {
  subject: '{{report.name}} — {{date}} from {{company.name}}',
  body: 'Hello,\n\nAttached: {{report.list}}.\n\nThis report was sent by a schedule in {{company.name}} ({{schedule.frequency}}).\n\n{{company.name}}',
};

async function emailScheduledReport(
  ctx: ServiceContext,
  schedule: { name: string; frequency: string; emailTo: string },
  attachments: { filename: string; content: Buffer; contentType: string }[],
  reportNames: string[],
  stamp: string,
): Promise<void> {
  const [company, prefs] = await Promise.all([getCompany(ctx), getPreferences(ctx)]);
  // The Send Forms preferences may carry a "report" template (prefsperms); else the default.
  const tpl = (prefs.sendForms as unknown as Record<string, { subject?: string; body?: string } | undefined>).report;
  const merge = {
    'report.name': schedule.name,
    'report.list': reportNames.join(', '),
    'company.name': company?.name ?? '',
    date: stamp,
    'schedule.frequency': schedule.frequency === 'daily' ? 'every day' : schedule.frequency === 'weekly' ? 'every week' : 'every month',
  };
  await sendMail(
    {
      to: schedule.emailTo,
      subject: fillMergeFields(tpl?.subject || DEFAULT_REPORT_EMAIL.subject, merge),
      text: fillMergeFields(tpl?.body || DEFAULT_REPORT_EMAIL.body, merge),
      attachments,
    },
    ctx,
  );
}

export async function listReportSchedules(ctx: ServiceContext) {
  requirePermission(ctx, 'file_utilities.schedules', 'view');
  return ctx.db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.companyId, ctx.companyId))
    .orderBy(asc(reportSchedules.nextRunAt));
}

export async function createReportSchedule(
  ctx: ServiceContext,
  input: {
    name: string;
    memorizedReportId?: string | null;
    groupId?: string | null;
    frequency: ScheduleFrequency;
    startDate?: string;
    format?: 'csv' | 'xlsx';
    folder?: string;
    isActive?: boolean;
    /** Also email the export to these addresses (comma / semicolon separated); empty = files only. */
    emailTo?: string | null;
  },
) {
  requirePermission(ctx, 'file_utilities.schedules', 'create');
  const emailTo = normalizeRecipients(input.emailTo);
  if (!!input.memorizedReportId === !!input.groupId) throw validation('Choose either one memorized report or one report group.');
  if (input.memorizedReportId) {
    // A schedule later runs unattended and writes the report to disk, so the person setting it up
    // must be able to view that report's own area (file_utilities alone is not enough).
    const row = await getMemorized(ctx, input.memorizedReportId);
    requireExistingRowAccess(ctx, row.reportType);
  }
  if (input.groupId) {
    await getGroup(ctx, input.groupId);
    requireAnyReportAccess(ctx);
    for (const t of await scheduleReportTypes(ctx, { groupId: input.groupId })) {
      const area = typeof t === 'string' ? areaForReportType(t) : undefined;
      if (area) requireReportView(ctx, t, area);
    }
  }
  // The first run is at the start (local midnight) of the start date on this computer's calendar:
  // 06:00 UTC was the previous evening west of UTC, so a schedule set to start on the 1st ran on
  // the last day of the month before and its "Last month" exported the wrong month.
  const start = input.startDate ? localMidnight(input.startDate) : new Date();
  if (Number.isNaN(start.getTime())) throw validation('Invalid start date.');
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(reportSchedules)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        memorizedReportId: input.memorizedReportId ?? null,
        groupId: input.groupId ?? null,
        frequency: input.frequency,
        nextRunAt: start,
        anchorDay: start.getDate(),
        format: input.format ?? 'csv',
        folder: input.folder?.trim() || null,
        isActive: input.isActive ?? true,
        createdBy: tx.userId,
        emailTo,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'report_schedule', entityId: row.id, newValues: { name: row.name, frequency: row.frequency, nextRunAt: row.nextRunAt, emailTo } });
    return row;
  });
}

export async function updateReportSchedule(
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; frequency?: ScheduleFrequency; isActive?: boolean; format?: 'csv' | 'xlsx'; emailTo?: string | null },
) {
  requirePermission(ctx, 'file_utilities.schedules', 'modify');
  const emailTo = patch.emailTo !== undefined ? normalizeRecipients(patch.emailTo) : undefined;
  const [before] = await ctx.db.select().from(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.companyId, ctx.companyId)));
  if (!before) throw notFound('Report schedule');
  // Monthly schedules run on an anchor day of month. Keep it when frequency is unchanged (and set);
  // otherwise derive it from the next scheduled run so a switch to monthly doesn't drift.
  const frequency = patch.frequency ?? before.frequency;
  const anchorDay =
    frequency === before.frequency && before.anchorDay ? before.anchorDay : new Date(before.nextRunAt).getDate();
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(reportSchedules)
      .set({
        name: patch.name?.trim() || before.name,
        frequency,
        anchorDay,
        isActive: patch.isActive ?? before.isActive,
        format: patch.format ?? before.format,
        ...(emailTo !== undefined ? { emailTo } : {}),
      })
      .where(eq(reportSchedules.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'report_schedule',
      entityId: id,
      oldValues: { name: before.name, frequency: before.frequency, isActive: before.isActive, emailTo: before.emailTo },
      newValues: { name: row.name, frequency: row.frequency, isActive: row.isActive, emailTo: row.emailTo },
    });
    return row;
  });
}

export async function deleteReportSchedule(ctx: ServiceContext, id: string) {
  requirePermission(ctx, 'file_utilities.schedules', 'delete');
  const [before] = await ctx.db.select().from(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.companyId, ctx.companyId)));
  if (!before) throw notFound('Report schedule');
  return inTransaction(ctx, async (tx) => {
    await tx.db.delete(reportSchedules).where(eq(reportSchedules.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'report_schedule', entityId: id, oldValues: { name: before.name } });
    return { deleted: true };
  });
}

export interface ScheduleRunResult {
  scheduleId: string;
  name: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  files: string[];
  message?: string;
}

/**
 * Run every active schedule whose next run is due (≤ now): run its report(s), write the export
 * files into the export folder, then advance nextRunAt past `now` (missed runs are not replayed
 * one by one). A schedule with recipients (emailTo) then emails the files it saved, attached,
 * through sendMail — the Send Forms / SMTP settings, sandbox mode and the company's network
 * opt-in apply; the people who set the schedule up chose to send them. A failed email never loses
 * the saved files: the run is 'partial' and says why.
 *
 * Whose access a schedule runs with:
 *  - Trusted context (the desktop timer's internal token): the schedule's creator's current access,
 *    so a report added later to a scheduled group, or an area the creator has since lost, is not
 *    exported. A creator who is no longer an active member → the run fails (and moves on).
 *  - A signed-in user ("Run due reports now"): that user's access. A schedule that would run a
 *    report the user can't view is skipped and left due (not marked failed, nextRunAt unchanged),
 *    so the timer or its owner still runs it and that period's export is not lost.
 */
export async function runDueSchedules(
  ctx: ServiceContext,
  opts: { now?: Date; outDir?: string } = {},
): Promise<ScheduleRunResult[]> {
  requirePermission(ctx, 'file_utilities.schedules', 'create');
  assertNotSandbox('Scheduled reports'); // sandbox mode: schedules wait for the real file
  const now = opts.now ?? new Date();
  const root = opts.outDir ?? reportExportRoot();
  const due = await ctx.db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.companyId, ctx.companyId), eq(reportSchedules.isActive, true), lte(reportSchedules.nextRunAt, now)));
  const results: ScheduleRunResult[] = [];
  const creatorAccess = new Map<string, EffectiveAccess | null>();
  for (const s of due) {
    if (ctx.access && !canRunReportTypes(ctx.access, await scheduleReportTypes(ctx, s))) {
      results.push({
        scheduleId: s.id,
        name: s.name,
        status: 'skipped',
        files: [],
        message: 'You do not have permission to run this report. It stays due and will run for someone who can.',
      });
      continue;
    }
    const files: string[] = [];
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    let reportNames: string[] = [];
    let status: ScheduleRunResult['status'] = 'ok';
    let message: string | undefined;
    let runCtx: ServiceContext = ctx;
    try {
      if (!ctx.access && s.createdBy) {
        if (!creatorAccess.has(s.createdBy)) {
          const r = await resolveAccess(ctx.db, ctx.companyId, s.createdBy);
          creatorAccess.set(s.createdBy, r.member && r.active ? r.access : null);
        }
        const access = creatorAccess.get(s.createdBy);
        if (!access) throw new Error('The person who set up this schedule no longer has access to this company.');
        runCtx = { ...ctx, access };
      }
      // Relative dates resolve on the run's own moment (`now`), like the export's date stamp.
      const processed = s.groupId
        ? await processMultipleReports(runCtx, { groupId: s.groupId }, { now })
        : await processMultipleReports(runCtx, { ids: [s.memorizedReportId!] }, { now });
      const ok = processed.filter((p) => p.report);
      const failed = processed.filter((p) => p.error);
      if (processed.length === 0) throw new Error('The memorized report or group no longer exists.');
      const dir = path.join(root, safeSegment(s.folder ?? '', 'Scheduled'));
      fs.mkdirSync(dir, { recursive: true });
      // The run's local calendar day (the UTC day is tomorrow in US evenings).
      const stamp = localDateISO(now);
      reportNames = ok.map((p) => p.name);
      if (s.format === 'xlsx' && ok.length) {
        const file = path.join(dir, `${safeSegment(s.name, 'Reports')} ${stamp}.xlsx`);
        const content = ok.length === 1 ? buildXlsx({ sheetName: ok[0].report!.title.slice(0, 28), title: ok[0].report!.title, subtitle: ok[0].report!.subtitle, ...reportToTable(ok[0].report!) }) : reportsToWorkbook(ok.map((p) => p.report!));
        writeFileAtomic(file, content);
        files.push(file);
        attachments.push({ filename: path.basename(file), content: Buffer.from(content), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      } else {
        // One file per report, never two with the same name: reports named alike (or alike once
        // made file-safe — "A/R" and "A:R") overwrote each other's export. Windows names are
        // case-insensitive.
        const used = new Set<string>();
        for (const p of ok) {
          const base = `${safeSegment(p.name, 'Report')} ${stamp}`;
          let name = base;
          for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
          used.add(name.toLowerCase());
          const file = path.join(dir, `${name}.csv`);
          const content = '﻿' + reportToCsv(p.report!);
          writeFileAtomic(file, content);
          files.push(file);
          attachments.push({ filename: path.basename(file), content: Buffer.from(content, 'utf8'), contentType: 'text/csv; charset=utf-8' });
        }
      }
      if (failed.length) {
        status = ok.length ? 'partial' : 'failed';
        message = failed.map((f) => `${f.name}: ${f.error}`).join('; ');
      }
    } catch (err) {
      status = 'failed';
      message = err instanceof Error ? err.message : 'Scheduled report failed.';
    }
    let emailed = false;
    if (s.emailTo && attachments.length) {
      try {
        await emailScheduledReport(runCtx, { name: s.name, frequency: s.frequency, emailTo: s.emailTo }, attachments, reportNames, localDateISO(now));
        emailed = true;
      } catch (err) {
        if (status === 'ok') status = 'partial';
        const why = err instanceof Error ? err.message : 'the email could not be sent';
        message = [message, `Saved but not emailed: ${why}`].filter(Boolean).join('; ');
      }
    }
    const freq = s.frequency as ScheduleFrequency;
    let next = nextRunAfter(s.nextRunAt, freq, s.anchorDay);
    let guard = 0;
    while (next <= now && guard++ < 5000) next = nextRunAfter(next, freq, s.anchorDay);
    await inTransaction(ctx, async (tx) => {
      await tx.db
        .update(reportSchedules)
        .set({
          lastRunAt: now,
          lastStatus: status,
          lastMessage: message ?? (files.length ? `Saved ${files.length} file(s)${emailed ? ` and emailed to ${s.emailTo}` : ''}` : null),
          nextRunAt: next,
        })
        .where(eq(reportSchedules.id, s.id));
      await writeAudit(tx, { action: 'update', entityType: 'report_schedule', entityId: s.id, newValues: { ran: now, status, files: files.map((f) => path.basename(f)), ...(emailed ? { emailedTo: s.emailTo } : {}) } });
    });
    results.push({ scheduleId: s.id, name: s.name, status, files, message });
  }
  return results;
}

