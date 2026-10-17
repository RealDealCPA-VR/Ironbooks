/**
 * GET /api/reconciliations/info?bankAccountId=<uuid>
 *
 * Begin-Reconciliation info for a bank account: beginning (carried-forward)
 * balance, last reconciled date, whether it is a credit-card account, and a
 * beginning-balance discrepancy check (reconciled-then-voided detection).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { getReconcileInfo } from '@/lib/services/reconcile';
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
    const bankAccountId = req.nextUrl.searchParams.get('bankAccountId');
    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId is required.' }, { status: 400 });
    }
    const info = await getReconcileInfo(ctx, bankAccountId);
    return NextResponse.json(info);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/reconciliations/info]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
