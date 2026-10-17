/**
 * POST /api/plaid/sync
 * Body: { accessToken: string; bankAccountId: string }
 * Pulls new transactions from Plaid and stages them in bank_transactions.
 * Returns { imported: number; total: number }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { syncTransactions } from '@/lib/services/plaid';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[plaid/sync] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { accessToken, bankAccountId } = body as {
      accessToken?: string;
      bankAccountId?: string;
    };

    if (!accessToken || typeof accessToken !== 'string') {
      return NextResponse.json({ error: 'accessToken is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!bankAccountId || typeof bankAccountId !== 'string') {
      return NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
    }

    const result = await syncTransactions(ctx, { accessToken, bankAccountId });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
