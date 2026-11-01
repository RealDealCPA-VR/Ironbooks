/**
 * GET /api/reconciliations/discrepancies[?bankAccountId=<uuid>]
 *
 * Previous Reconciliation Discrepancy report: lines cleared in a COMPLETED reconciliation
 * that were changed afterwards (amount changed / moved off the account after QB's warning —
 * reconciledEdits.ts) or whose journal entry was voided (historical anomalies — new voids of
 * reconciled lines are blocked by the posting engine). Each row has the reconciled amount, the
 * type of change and its effect on the reconciled balance.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { reconciliationDiscrepancies } from '@/lib/services/reconcile';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const bankAccountId = req.nextUrl.searchParams.get('bankAccountId') ?? undefined;
    const rows = await reconciliationDiscrepancies(ctx, bankAccountId);
    return NextResponse.json(rows);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/reconciliations/discrepancies]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
