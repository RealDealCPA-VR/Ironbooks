/**
 * POST /api/bank-transactions/match
 *
 * Match a staged bank transaction to an EXISTING posted journal entry without
 * posting anything new (QB Bank Feeds "Match" — vs "Quick Add").
 *
 * Request body:
 *   {
 *     bankTransactionId: string;   // UUID of the bank_transactions row
 *     journalEntryId: string;      // UUID of the existing journal entry
 *   }
 *
 * Response 200: { transaction, entry }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { matchTransaction } from '@/lib/services/bankCategorize';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { bankTransactionId, journalEntryId } = body ?? {};

    if (!bankTransactionId) {
      return NextResponse.json({ error: 'bankTransactionId is required.' }, { status: 400 });
    }
    if (!journalEntryId) {
      return NextResponse.json({ error: 'journalEntryId is required.' }, { status: 400 });
    }

    const result = await matchTransaction(ctx, bankTransactionId, journalEntryId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/bank-transactions/match]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
