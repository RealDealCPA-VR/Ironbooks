/**
 * Shared internal-token context for the scheduled-reports run-due routes
 * (/api/report-schedules/run-due and /api/reports/schedules/run-due).
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';

/**
 * Trusted local-system path (same pattern as /api/recurring/run). The Electron main process has
 * no session cookie, so it authenticates with the per-launch random token it generated and passed
 * to this server as BKA_INTERNAL_TOKEN. Constant-time compare; a missing or wrong token falls
 * through to the normal session check, which fails closed for a cookieless caller. Each schedule
 * then runs with its creator's current access (see runDueSchedules).
 */
export async function internalContext(req: NextRequest): Promise<ServiceContext | null> {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return null;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const [company] = await db
    .select({ id: companies.id, ownerId: companies.ownerId })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!company) return null;
  return { db, companyId: company.id, userId: company.ownerId };
}
