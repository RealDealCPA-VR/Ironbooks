/**
 * POST /api/bank-transactions/categorize
 *
 * Categorize a single staged bank transaction into the GL (QB "Add to register").
 *
 * Request body:
 *   {
 *     bankTransactionId: string;   // UUID of the bank_transactions row
 *     accountId: string;           // offsetting GL account (income, expense, etc.)
 *     payee?: string;              // optional payee override
 *     memo?: string;               // optional memo / reference
 *     exchangeRate?: string;       // foreign-currency account: home units per 1 unit (default: list rate)
 *   }
 *
 * Response 200: { transaction, entry }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { categorize } from '@/lib/services/bankCategorize';

function errResponse(err: ServiceError): NextResponse {
  const statusMap: Record<string, number> = {
    NOT_FOUND: 404,
    VALIDATION: 400,
    UNBALANCED: 400,
    FORBIDDEN: 403,
    CONFLICT: 409,
    PERIOD_CLOSED: 400,
  };
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: statusMap[err.code] ?? 500 },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json();

    const { bankTransactionId, accountId, payee, memo, exchangeRate } = body ?? {};

    if (!bankTransactionId) {
      return NextResponse.json({ error: 'bankTransactionId is required.' }, { status: 400 });
    }
    if (!accountId) {
      return NextResponse.json({ error: 'accountId is required.' }, { status: 400 });
    }

    const result = await categorize(ctx, {
      bankTransactionId,
      accountId,
      payee: payee ?? null,
      memo: memo ?? null,
      exchangeRate: exchangeRate ?? null,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/bank-transactions/categorize]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
