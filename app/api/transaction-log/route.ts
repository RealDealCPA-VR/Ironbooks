/**
 * GET /api/transaction-log — the running transaction log (transactions.bktlg), newest first.
 *
 * Query: from, to (YYYY-MM-DD, inclusive), userId, entityType, action, entityId, q (text),
 *        limit (default 200, max 5000), offset.
 * Response: { rows, total, users, entityTypes } — rows are full records incl. `data`.
 * Records of other companies sharing the data dir are hidden. Owner/admin/accountant only.
 *
 * SECURITY: middleware excludes /api from the session check, so this handler fails closed
 * via getServerContext() before reading anything.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { queryTransactionLog } from '@/lib/services/transactionLog';
import { redactSecretsDeep } from '@/lib/services/company';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[transaction-log] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * A From / To bound. Records carry the instant they were written, so a calendar day means the
 * day on THIS computer's calendar (read as a UTC day, a change made at 9:30 pm in New York was
 * listed under the next day). The window may also send exact instants (ISO date-times).
 */
function parseDay(value: string | null, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const local = endOfDay ? new Date(y, mo, d, 23, 59, 59, 999) : new Date(y, mo, d, 0, 0, 0, 0);
    return isNaN(local.getTime()) || local.getDate() !== d ? undefined : local;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const instant = new Date(value);
  return isNaN(instant.getTime()) ? undefined : instant;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // The log carries full before/after data (incl. user records) — not for staff/viewers.
    if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'accountant') {
      throw new ServiceError('FORBIDDEN', 'Only the owner, an admin or the accountant can view the transaction log.');
    }
    const p = req.nextUrl.searchParams;
    const dir = dataDirOf(ctx.db) ?? resolveDataDir();
    const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 5000);
    const offset = Math.max(Number(p.get('offset')) || 0, 0);
    const page = queryTransactionLog(dir, {
      companyId: ctx.companyId,
      from: parseDay(p.get('from'), false),
      to: parseDay(p.get('to'), true),
      userId: p.get('userId') || undefined,
      entityType: p.get('entityType') || undefined,
      action: p.get('action') || undefined,
      entityId: p.get('entityId') || undefined,
      search: p.get('q') || undefined,
      limit,
      offset,
    });
    // Records written by older builds can carry the closing-date password hash in a settings
    // snapshot: the file keeps them (hash chain), the response never does.
    return NextResponse.json({ ...page, rows: page.rows.map((r) => ({ ...r, data: redactSecretsDeep(r.data) })) });
  } catch (err) {
    return errorResponse(err);
  }
}
