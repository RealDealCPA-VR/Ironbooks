/**
 * Shared internal-token handling for the scheduled-reports run-due routes
 * (/api/report-schedules/run-due and /api/reports/schedules/run-due).
 */
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { reportExportRoot, runDueSchedules, type ScheduleRunResult } from '@/lib/services/memorizedReports';

/** True when the request carries the per-launch internal token (constant-time compare). */
function hasInternalToken(req: NextRequest): boolean {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Trusted local-system path (same pattern as /api/recurring/run). The Electron main process has
 * no session cookie, so it authenticates with the per-launch random token it generated and passed
 * to this server as BKA_INTERNAL_TOKEN. A missing or wrong token returns null (the caller falls
 * through to the normal session check, which fails closed for a cookieless caller).
 *
 * Returns one context per company in the file (oldest first), each acting as that company's
 * owner. Each schedule then runs with its own creator's current access in its own company (see
 * runDueSchedules), so one company's schedules never see another company's data.
 */
export async function internalContexts(req: NextRequest): Promise<ServiceContext[] | null> {
  if (!hasInternalToken(req)) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: companies.id, ownerId: companies.ownerId })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id));
  return rows.map((c) => ({ db, companyId: c.id, userId: c.ownerId }));
}

/**
 * Where a company's scheduled exports go. The oldest company keeps the report-export folder
 * itself (unchanged from single-company files); every other company gets a sub-folder named
 * after it, so two companies' "Monthly P&L" exports never overwrite each other.
 */
export async function companyExportDir(ctx: ServiceContext): Promise<string> {
  const root = reportExportRoot();
  const rows = await ctx.db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id));
  const idx = rows.findIndex((c) => c.id === ctx.companyId);
  if (idx <= 0) return root;
  const safe = rows[idx].name.replace(/[^A-Za-z0-9 _.&()'-]/g, '-').replace(/\.{2,}/g, '.').trim().slice(0, 80);
  return path.join(root, 'Companies', safe && safe !== '.' ? safe : rows[idx].id);
}

/** @deprecated The oldest company's internal context only; use internalContexts. */
export async function internalContext(req: NextRequest): Promise<ServiceContext | null> {
  const all = await internalContexts(req);
  return all?.[0] ?? null;
}

export type DueRunResult = ScheduleRunResult & { companyId?: string };

/**
 * Trusted timer: run every due schedule in EVERY company in the file (each as that company's
 * owner, each schedule with its creator's access). A failure in one company is reported and the
 * others still run.
 */
export async function runDueForCompanies(ctxs: ServiceContext[]): Promise<DueRunResult[]> {
  const results: DueRunResult[] = [];
  for (const ctx of ctxs) {
    try {
      for (const r of await runDueSchedules(ctx, { outDir: await companyExportDir(ctx) })) results.push({ ...r, companyId: ctx.companyId });
    } catch (e) {
      results.push({
        companyId: ctx.companyId,
        scheduleId: '',
        name: '',
        status: 'failed',
        files: [],
        message: e instanceof Error ? e.message : 'Scheduled reports could not run for this company.',
      });
    }
  }
  return results;
}

/** "Run due reports now": the signed-in user's current company, with that user's permissions. */
export async function runDueForUser(ctx: ServiceContext): Promise<DueRunResult[]> {
  return runDueSchedules(ctx, { outDir: await companyExportDir(ctx) });
}
