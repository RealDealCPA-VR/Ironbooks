/**
 * Batch Delete/Void Transactions.
 * GET  /api/accountant/batch-void?from=&to=&type= → transactions
 * POST /api/accountant/batch-void { keys: ['invoice:<id>', ...] } → per-row results
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  BATCH_TXN_TYPES,
  type BatchTxnType,
  batchVoidTransactions,
  listBatchTransactions,
} from '@/lib/services/accountant/batchVoid';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchVoidSchema } from '@/lib/validation/accountant';
import { dayParam } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const type = sp.get('type');
    return NextResponse.json({
      transactions: await listBatchTransactions(ctx, {
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
        type: type && (BATCH_TXN_TYPES as readonly string[]).includes(type) ? (type as BatchTxnType) : null,
      }),
    });
  } catch (err) {
    return routeError(err, '/api/accountant/batch-void');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = batchVoidSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await batchVoidTransactions(ctx, parsed.data.keys));
  } catch (err) {
    return routeError(err, '/api/accountant/batch-void');
  }
}
