/**
 * Memorized (saved) reports — store a report type + its settings / filters so users can re-run a
 * customized report later (QuickBooks "Memorized Reports"), organised in Memorized Report Groups,
 * run a whole group at once ("Process Multiple Reports") and run on a schedule (exports saved to
 * a local folder; the desktop shell's timer calls runDueSchedules).
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
import { reportToCsv, reportToTable, type StdReport } from '@/lib/reports/types';
import { type ServiceContext, notFound, validation, writeAudit, inTransaction } from './_base';
import { isStandardReport, runStandardReport } from './reportRegistry';
import { runReport, type ReportConfig } from './reportBuilder';

// ---------------------------------------------------------------------------
// Memorized reports
// ---------------------------------------------------------------------------

export async function listMemorizedReports(ctx: ServiceContext) {
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
  if (!input.name?.trim()) throw validation('Report name is required.');
  if (!input.reportType?.trim()) throw validation('Report type is required.');
  if (input.reportType !== 'custom' && !isStandardReport(input.reportType)) {
    throw validation(`Unknown report type "${input.reportType}".`);
  }
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
  const before = await getMemorized(ctx, id);
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
  const row = await getMemorized(ctx, id);
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
  const row = await getMemorized(ctx, id);
  return runMemorizedRow(ctx, row);
}

async function runMemorizedRow(
  ctx: ServiceContext,
  row: { name: string; reportType: string; config: Record<string, unknown> },
): Promise<StdReport> {
  if (row.reportType === 'custom') return runCustomReport(ctx, row.name, row.config ?? {});
  const cfg = row.config ?? {};
  const params = (cfg.params && typeof cfg.params === 'object' ? cfg.params : cfg) as Record<string, unknown>;
  const report = await runStandardReport(ctx, row.reportType, params);
  const display = (cfg.display ?? {}) as { title?: string; subtitle?: string };
  return { ...report, title: display.title?.trim() || row.name || report.title, subtitle: display.subtitle?.trim() || report.subtitle };
}

// ---------------------------------------------------------------------------
// Memorized report groups + Process Multiple Reports
// ---------------------------------------------------------------------------

export async function listMemorizedGroups(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(memorizedReportGroups)
    .where(eq(memorizedReportGroups.companyId, ctx.companyId))
    .orderBy(asc(memorizedReportGroups.name));
}

export async function createMemorizedGroup(ctx: ServiceContext, input: { name: string }) {
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

export async function renameMemorizedGroup(ctx: ServiceContext, id: string, input: { name: string }) {
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
): Promise<ProcessedReport[]> {
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
      out.push({ id: r.id, name: r.name, report: await runMemorizedRow(ctx, r) });
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

export function nextRunAfter(from: Date, frequency: ScheduleFrequency): Date {
  const d = new Date(from);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
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
  const dataDir = resolveDataDir();
  return path.join(path.dirname(dataDir), 'Report Exports', path.basename(dataDir));
}

function safeSegment(s: string, fallback: string): string {
  const out = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\.{2,}/g, '.').trim().slice(0, 80);
  return out && out !== '.' ? out : fallback;
}

export async function listReportSchedules(ctx: ServiceContext) {
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
  },
) {
  if (!!input.memorizedReportId === !!input.groupId) throw validation('Choose either one memorized report or one report group.');
  if (input.memorizedReportId) await getMemorized(ctx, input.memorizedReportId);
  if (input.groupId) await getGroup(ctx, input.groupId);
  const start = input.startDate ? new Date(`${input.startDate}T06:00:00.000Z`) : new Date();
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
        format: input.format ?? 'csv',
        folder: input.folder?.trim() || null,
        isActive: input.isActive ?? true,
        createdBy: tx.userId,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'report_schedule', entityId: row.id, newValues: { name: row.name, frequency: row.frequency, nextRunAt: row.nextRunAt } });
    return row;
  });
}

export async function updateReportSchedule(
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; frequency?: ScheduleFrequency; isActive?: boolean; format?: 'csv' | 'xlsx' },
) {
  const [before] = await ctx.db.select().from(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.companyId, ctx.companyId)));
  if (!before) throw notFound('Report schedule');
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(reportSchedules)
      .set({
        name: patch.name?.trim() || before.name,
        frequency: patch.frequency ?? before.frequency,
        isActive: patch.isActive ?? before.isActive,
        format: patch.format ?? before.format,
      })
      .where(eq(reportSchedules.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'report_schedule', entityId: id, oldValues: { name: before.name, frequency: before.frequency, isActive: before.isActive }, newValues: { name: row.name, frequency: row.frequency, isActive: row.isActive } });
    return row;
  });
}

export async function deleteReportSchedule(ctx: ServiceContext, id: string) {
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
  status: 'ok' | 'partial' | 'failed';
  files: string[];
  message?: string;
}

/**
 * Run every active schedule whose next run is due (≤ now): run its report(s), write the export
 * files into the export folder, then advance nextRunAt past `now` (missed runs are not replayed
 * one by one). Email delivery is intentionally not done here — reports leave the machine only if
 * the user sends them.
 */
export async function runDueSchedules(
  ctx: ServiceContext,
  opts: { now?: Date; outDir?: string } = {},
): Promise<ScheduleRunResult[]> {
  const now = opts.now ?? new Date();
  const root = opts.outDir ?? reportExportRoot();
  const due = await ctx.db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.companyId, ctx.companyId), eq(reportSchedules.isActive, true), lte(reportSchedules.nextRunAt, now)));
  const results: ScheduleRunResult[] = [];
  for (const s of due) {
    const files: string[] = [];
    let status: ScheduleRunResult['status'] = 'ok';
    let message: string | undefined;
    try {
      const processed = s.groupId
        ? await processMultipleReports(ctx, { groupId: s.groupId })
        : await processMultipleReports(ctx, { ids: [s.memorizedReportId!] });
      const ok = processed.filter((p) => p.report);
      const failed = processed.filter((p) => p.error);
      if (processed.length === 0) throw new Error('The memorized report or group no longer exists.');
      const dir = path.join(root, safeSegment(s.folder ?? '', 'Scheduled'));
      fs.mkdirSync(dir, { recursive: true });
      const stamp = now.toISOString().slice(0, 10);
      if (s.format === 'xlsx' && ok.length) {
        const file = path.join(dir, `${safeSegment(s.name, 'Reports')} ${stamp}.xlsx`);
        fs.writeFileSync(file, ok.length === 1 ? buildXlsx({ sheetName: ok[0].report!.title.slice(0, 28), title: ok[0].report!.title, subtitle: ok[0].report!.subtitle, ...reportToTable(ok[0].report!) }) : reportsToWorkbook(ok.map((p) => p.report!)));
        files.push(file);
      } else {
        for (const p of ok) {
          const file = path.join(dir, `${safeSegment(p.name, 'Report')} ${stamp}.csv`);
          fs.writeFileSync(file, '﻿' + reportToCsv(p.report!), 'utf8');
          files.push(file);
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
    let next = nextRunAfter(s.nextRunAt, s.frequency as ScheduleFrequency);
    let guard = 0;
    while (next <= now && guard++ < 5000) next = nextRunAfter(next, s.frequency as ScheduleFrequency);
    await inTransaction(ctx, async (tx) => {
      await tx.db
        .update(reportSchedules)
        .set({ lastRunAt: now, lastStatus: status, lastMessage: message ?? (files.length ? `Saved ${files.length} file(s)` : null), nextRunAt: next })
        .where(eq(reportSchedules.id, s.id));
      await writeAudit(tx, { action: 'update', entityType: 'report_schedule', entityId: s.id, newValues: { ran: now, status, files: files.map((f) => path.basename(f)) } });
    });
    results.push({ scheduleId: s.id, name: s.name, status, files, message });
  }
  return results;
}

