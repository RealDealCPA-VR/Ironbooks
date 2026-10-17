/**
 * POST /api/condense — condense/archive journal detail before a cutoff date.
 *
 * Request body:
 *   {
 *     beforeDate: "YYYY-MM-DD";   // entries strictly before this date are condensed
 *     dryRun?: boolean;           // true = read-only preview, nothing modified
 *   }
 *
 * Response 200: CondenseResult (counts, months, archivePath, runId).
 *
 * The execute path is IRREVERSIBLE (except by restoring the archive .bka the
 * service writes first). It requires the affected period to be closed and a
 * non-viewer role; the service enforces both.
 *
 * SECURITY: middleware excludes /api from the session check, so this handler
 * fails closed via getServerContext() before doing anything.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { condensePeriod } from '@/lib/services/condense';
import { ServiceError } from '@/lib/services/_base';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[condense] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));

    const beforeDate = typeof body?.beforeDate === 'string' ? body.beforeDate : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
      return NextResponse.json(
        { error: 'beforeDate (YYYY-MM-DD) is required.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const cutoff = new Date(`${beforeDate}T00:00:00.000Z`);
    if (isNaN(cutoff.getTime())) {
      return NextResponse.json(
        { error: 'beforeDate is not a valid date.', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    // Multi-user: condensing rewrites history — owner/admin only, and single-user mode while
    // anyone else is connected (QB Enterprise parity). The read-only preview is not gated.
    if (body?.dryRun !== true) await assertExclusiveAccess(ctx, 'Condense Data');

    const result = await condensePeriod(ctx, {
      beforeDate: cutoff,
      dryRun: body?.dryRun === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
