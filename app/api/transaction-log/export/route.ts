/**
 * GET /api/transaction-log/export — the filtered transaction log as CSV, EVERY matching record
 * (no row cap), streamed in batches. Filters as GET /api/transaction-log: from, to (YYYY-MM-DD
 * on this computer's calendar, or ISO instants), userId, entityType, action, entityId, q.
 * Owner / admin / accountant only; other companies' records are left out.
 */
import { NextRequest } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { streamTransactionLogCsv } from '@/lib/services/transactionLogExport';

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
    const p = req.nextUrl.searchParams;
    const body = streamTransactionLogCsv(ctx, {
      from: parseDay(p.get('from'), false),
      to: parseDay(p.get('to'), true),
      userId: p.get('userId') || undefined,
      entityType: p.get('entityType') || undefined,
      action: p.get('action') || undefined,
      entityId: p.get('entityId') || undefined,
      search: p.get('q') || undefined,
    });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="transaction-log.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return routeError(err, 'transaction-log/export');
  }
}
