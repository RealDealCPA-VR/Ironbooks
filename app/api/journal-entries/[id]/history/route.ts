/**
 * GET /api/journal-entries/:id/history — QB "Transaction History" for an entry.
 *
 * Resolves the entry's sourceRef to its source document (invoice, bill,
 * payment, deposit, paycheck, ...) and returns the linked-transactions tree
 * (root + children + grandchildren). Manual entries return reversal /
 * replacement links instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { entryHistory } from '@/lib/services/linkedTransactions';
import { serviceErrorStatus } from '@/lib/routeErrors';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const history = await entryHistory(ctx, id);
    return NextResponse.json({ history });
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapper (code -> HTTP status).
// ---------------------------------------------------------------------------
function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[journal-entries/[id]/history] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
