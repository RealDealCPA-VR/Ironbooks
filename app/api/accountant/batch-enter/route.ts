/**
 * POST /api/accountant/batch-enter — Batch Enter Transactions.
 * Body: { type, bankAccountId?, rows[], mode?: 'all'|'row', validateOnly? } (batchEnterSchema).
 * Answers 200 with a per-row report (also when rows fail validation).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { batchEnterTransactions } from '@/lib/services/accountant/batchEnter';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchEnterSchema } from '@/lib/validation/accountant';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = batchEnterSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await batchEnterTransactions(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/accountant/batch-enter');
  }
}
