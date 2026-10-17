/**
 * GET    /api/reconciliations/[id]  — fetch reconciliation progress.
 * PATCH  /api/reconciliations/[id]  — complete, toggle a line, or correct the statement.
 * DELETE /api/reconciliations/[id]  — cancel an in-progress reconciliation.
 *
 * PATCH request body variants:
 *
 *   Complete the reconciliation:
 *     { action: "complete" }
 *
 *   Toggle a journal entry line as cleared / un-cleared:
 *     { action: "toggleCleared", journalEntryLineId: string, isCleared: boolean }
 *
 *   Correct the statement balance and/or date (in-progress only):
 *     { action: "updateStatement", statementBalance?: string, statementDate?: string }
 *
 *   Record statement adjustments (auto-posted + auto-cleared, in-progress only):
 *     { action: "adjustments",
 *       serviceCharge?:  { amount: string, accountId: string },
 *       interestEarned?: { amount: string, accountId: string } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import {
  getProgress,
  completeReconciliation,
  cancelReconciliation,
  toggleCleared,
  updateStatement,
  listClearable,
  addStatementAdjustments,
} from '@/lib/services/reconcile';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

/** Map ServiceErrorCode to an HTTP status. */
function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

// ---------------------------------------------------------------------------
// GET /api/reconciliations/[id]
// ---------------------------------------------------------------------------
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const progress = await getProgress(ctx, id);
    return NextResponse.json(progress);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/reconciliations/:id]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/reconciliations/[id]
// ---------------------------------------------------------------------------
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { action } = body ?? {};

    if (action === 'complete') {
      const completed = await completeReconciliation(ctx, id);
      return NextResponse.json(completed);
    }

    if (action === 'toggleCleared') {
      const { journalEntryLineId, isCleared } = body ?? {};
      if (!journalEntryLineId) {
        return NextResponse.json({ error: 'journalEntryLineId is required.' }, { status: 400 });
      }
      if (typeof isCleared !== 'boolean') {
        return NextResponse.json({ error: 'isCleared (boolean) is required.' }, { status: 400 });
      }
      await toggleCleared(ctx, id, journalEntryLineId, isCleared);
      // Return updated progress so the client can refresh in one round-trip.
      const progress = await getProgress(ctx, id);
      return NextResponse.json(progress);
    }

    if (action === 'updateStatement') {
      const { statementBalance, statementDate } = body ?? {};
      if (statementBalance == null && !statementDate) {
        return NextResponse.json(
          { error: 'statementBalance and/or statementDate is required.' },
          { status: 400 },
        );
      }
      await updateStatement(ctx, id, {
        statementBalance: statementBalance ?? undefined,
        statementDate: statementDate ? new Date(statementDate) : undefined,
      });
      // Return updated progress so the client can refresh in one round-trip.
      const progress = await getProgress(ctx, id);
      return NextResponse.json(progress);
    }

    if (action === 'adjustments') {
      const { serviceCharge, interestEarned, exchangeRate } = body ?? {};
      if (!serviceCharge && !interestEarned) {
        return NextResponse.json(
          { error: 'serviceCharge and/or interestEarned is required.' },
          { status: 400 },
        );
      }
      const progress = await addStatementAdjustments(ctx, id, {
        serviceCharge: serviceCharge ?? null,
        interestEarned: interestEarned ?? null,
        exchangeRate: exchangeRate ?? null,
      });
      return NextResponse.json(progress);
    }

    return NextResponse.json(
      {
        error: `Unknown action "${action}". Expected "complete", "toggleCleared", "updateStatement", or "adjustments".`,
      },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[PATCH /api/reconciliations/:id]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/reconciliations/[id] — cancel an in-progress reconciliation
// ---------------------------------------------------------------------------
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await cancelReconciliation(ctx, id);
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[DELETE /api/reconciliations/:id]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
