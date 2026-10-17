/**
 * Rebuild Data utility (QB Verify/Rebuild parity) — repair safe drifts found by
 * the /api/integrity checks.
 *
 *   GET  /api/import/rebuild?action=<action>   — dry-run preview (no writes)
 *   POST /api/import/rebuild  { action }       — apply the repair (audited, idempotent)
 *
 * Actions: account_balances | document_balances | item_quantities | orphaned_audit_refs.
 * Lives under /api/import because this agent owns app/api/import/** (the integrity
 * API file is owned elsewhere); the integrity page calls this route for repairs.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  REBUILD_ACTIONS,
  applyRebuild,
  isRebuildAction,
  previewRebuild,
} from '@/lib/services/integrity';
import { ServiceError } from '@/lib/services/_base';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[import/rebuild] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const action = req.nextUrl.searchParams.get('action');

    // No action → list the available rebuild actions (for the UI).
    if (!action) return NextResponse.json({ actions: REBUILD_ACTIONS });

    if (!isRebuildAction(action)) {
      return NextResponse.json(
        { error: `Unknown rebuild action "${action}".`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    return NextResponse.json(await previewRebuild(ctx, action));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as { action?: string };
    if (!body.action || !isRebuildAction(body.action)) {
      return NextResponse.json(
        { error: 'action must be one of the rebuild actions.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    // Rebuild rewrites cached balances — owner/admin only, single-user while others are on.
    await assertExclusiveAccess(ctx, 'Rebuild Data');
    return NextResponse.json(await applyRebuild(ctx, body.action));
  } catch (err) {
    return errorResponse(err);
  }
}
