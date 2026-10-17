/**
 * GET /api/reconciliations/[id]/clearable
 *
 * Returns all clearable journal entry lines for the bank account linked to this
 * reconciliation, scoped to lines dated on or before the reconciliation's
 * statementDate.  Each line carries an `isCleared` flag reflecting the current
 * session's toggle state.
 *
 * Response 200: ClearableLine[]
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { getProgress, listClearable } from '@/lib/services/reconcile';
import { eq, and } from 'drizzle-orm';
import { reconciliations, bankAccounts } from '@/lib/db/schema';
import { serviceErrorStatus } from '@/lib/routeErrors';

/** Map ServiceErrorCode to HTTP status. */
function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();

    // Load the reconciliation row joined to bankAccounts to get bankAccountId +
    // statementDate, and also enforce company scope.
    const [row] = await ctx.db
      .select({
        bankAccountId: reconciliations.bankAccountId,
        statementDate: reconciliations.statementDate,
        companyId: bankAccounts.companyId,
      })
      .from(reconciliations)
      .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
      .where(eq(reconciliations.id, id));

    if (!row || row.companyId !== ctx.companyId) {
      return NextResponse.json({ error: 'Reconciliation not found.' }, { status: 404 });
    }

    const lines = await listClearable(
      ctx,
      row.bankAccountId,
      row.statementDate,
      id, // pass reconciliationId so isCleared reflects this session
    );

    return NextResponse.json(lines);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[GET /api/reconciliations/:id/clearable]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
