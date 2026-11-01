/**
 * POST /api/print-queue/reprint { source, id }
 *   PARITY D3 — reprint a check that was already printed (QB: "Print Later" on a printed check):
 *   it goes back in the print queue and its old number is cleared, so the reprint records the
 *   number of the new check paper. Closing date and Accountant's Copy rules apply.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requeueForReprint } from '@/lib/services/printQueue';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { reprintCheckSchema } from '@/lib/validation/purchases';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const parsed = reprintCheckSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await requeueForReprint(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/print-queue/reprint');
  }
}
