/**
 * POST /api/recurring/run    — run all due templates as of a given date
 *   Body: { asOf?: string }  — ISO date string; defaults to now
 *
 * POST /api/recurring/run    — also supports { id: string, date? } to run a single template immediately
 *                              and { group: string } to enter a whole memorized group
 */
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { asc } from 'drizzle-orm';
import { getServerContext, isArchivedCompany } from '@/lib/context';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { runDue, runGroup, runTemplateNow } from '@/lib/services/recurring';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { runRecurringSchema } from '@/lib/validation/recurring';

/**
 * Trusted local-system path. The Electron main process has no session cookie, so it
 * authenticates its launch-time recurring run with a per-launch random token it generated
 * itself and passed to this server as BKA_INTERNAL_TOKEN (see electron/main.js). The server
 * is bound to 127.0.0.1 and the token never leaves the machine, so this does not reopen the
 * unauthenticated-impersonation hole closed in lib/context.ts.
 */
async function internalContexts(req: NextRequest): Promise<ServiceContext[] | null> {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return null;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: companies.id, ownerId: companies.ownerId, settings: companies.settings })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id));
  // One context per company in the file (oldest first), each acting as that company's owner.
  // Archived (soft-deleted) companies no longer enter memorized transactions — same rule as
  // the scheduled-reports timer (app/api/report-schedules/_internal.ts internalContexts).
  return rows
    .filter((c) => !isArchivedCompany(c.settings))
    .map((c) => ({ db, companyId: c.id, userId: c.ownerId }));
}

type DueResult = Awaited<ReturnType<typeof runDue>>;

/** Trusted timer: run every due template in EVERY non-archived company; one failure never stops the rest. */
async function runDueForCompanies(ctxs: ServiceContext[], asOf: Date | undefined): Promise<DueResult> {
  const out: DueResult = { generated: [], reminders: [], failed: [] };
  for (const ctx of ctxs) {
    try {
      const r = await runDue(ctx, asOf);
      out.generated.push(...r.generated);
      out.reminders.push(...r.reminders);
      out.failed.push(...r.failed);
    } catch (err) {
      console.error(`[recurring/run] company ${ctx.companyId} failed:`, err);
    }
  }
  return out;
}

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED'
          ? 400
          : err.code === 'CONFLICT'
            ? 409
            : err.code === 'FORBIDDEN'
              ? 403
              : err.code === 'PERIOD_CLOSED'
                ? 400
                : 500;
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[recurring/run/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const internal = await internalContexts(req);
    const body = await req.json().catch(() => ({}));
    const parsed = runRecurringSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    if (internal) {
      // The desktop shell's launch-time / hourly run: due templates only, across every company.
      if (parsed.data.id || parsed.data.group) {
        return NextResponse.json(
          { error: 'The internal run only enters due templates.', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      return NextResponse.json(await runDueForCompanies(internal, parsed.data.asOf ?? undefined));
    }
    const ctx = await getServerContext();

    // If an explicit template id is provided, run just that one immediately.
    if (parsed.data.id) {
      const doc = await runTemplateNow(ctx, parsed.data.id, parsed.data.date ?? undefined);
      return NextResponse.json({ generated: [doc], reminders: [], failed: [] });
    }
    // A memorized group: enter every template in it now.
    if (parsed.data.group) {
      const result = await runGroup(ctx, parsed.data.group);
      return NextResponse.json({ ...result, reminders: [] });
    }

    // Otherwise run all due templates up to asOf. Auto-enter templates post;
    // remind-only templates come back in `reminders` without posting.
    const result = await runDue(ctx, parsed.data.asOf ?? undefined);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
