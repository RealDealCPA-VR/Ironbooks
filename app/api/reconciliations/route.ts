/**
 * GET  /api/reconciliations — list all reconciliations for the company.
 * POST /api/reconciliations — start a new bank reconciliation session.
 *
 * POST request body:
 *   { bankAccountId: string, statementDate: string (ISO), statementBalance: string }
 *
 * Response 201: the new reconciliations row.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { startReconciliation, listReconciliations } from '@/lib/services/reconcile';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

/** Map ServiceErrorCode to HTTP status. */
function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const rows = await listReconciliations(ctx);
    return NextResponse.json(rows);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/reconciliations]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const { bankAccountId, statementDate, statementBalance } = body ?? {};

    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId is required.' }, { status: 400 });
    }
    if (!statementDate) {
      return NextResponse.json({ error: 'statementDate is required.' }, { status: 400 });
    }
    if (statementBalance == null) {
      return NextResponse.json({ error: 'statementBalance is required.' }, { status: 400 });
    }

    const recon = await startReconciliation(ctx, {
      bankAccountId,
      // The day as typed: the service refuses an impossible one (new Date rolled 2026-02-30 to Mar 2).
      statementDate,
      statementBalance,
    });

    return NextResponse.json(recon, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/reconciliations]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
