/**
 * Batch Delete/Void — restore deleted transactions (QB keeps a restorable list of what Batch
 * Delete removed).
 * POST /api/accountant/batch-void/restore { ids: [<snapshot id>, ...] } → per-row results
 * Each one is re-created through its normal create service (lib/services/accountant/batchVoid.ts).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { restoreDeletedTransactions } from '@/lib/services/accountant/batchVoid';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchRestoreSchema } from '@/lib/validation/accountant';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = batchRestoreSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await restoreDeletedTransactions(ctx, parsed.data.ids));
  } catch (err) {
    return routeError(err, '/api/accountant/batch-void/restore');
  }
}
