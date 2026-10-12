/**
 * GET /api/transaction-log/verify — check the running transaction log: hash chain intact and
 * every posted journal entry present. Response: TransactionLogVerification.
 *
 * SECURITY: fails closed via getServerContext().
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { verifyTransactionLog } from '@/lib/services/transactionLog';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[transaction-log/verify] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const result = await verifyTransactionLog(ctx.db, dataDirOf(ctx.db) ?? resolveDataDir());
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
