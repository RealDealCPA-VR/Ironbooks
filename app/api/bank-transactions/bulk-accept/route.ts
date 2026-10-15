/**
 * POST /api/bank-transactions/bulk-accept
 *   { bankAccountId, allHighConfidence: true, minConfidence? } — every line ≥ 90% (computed on the server)
 *   { items: [{ bankTransactionId, accountId?, classId?, payee?, memo?, splits? }] }
 *        — the selected lines (no accountId = take the line's suggestion)
 * → { accepted, failed, offers }. Each line posts in its own transaction through the normal
 *   bank-feed categorize service; failures are reported per line and skipped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { bulkAccept, type BulkAcceptInput } from '@/lib/services/bankSuggest';
import { bulkAcceptSchema } from '@/lib/bankRules/schemas';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bulkAcceptSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await bulkAccept(ctx, parsed.data as BulkAcceptInput));
  } catch (err) {
    return routeError(err, 'POST /api/bank-transactions/bulk-accept');
  }
}
