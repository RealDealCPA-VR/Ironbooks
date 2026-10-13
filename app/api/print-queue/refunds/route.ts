/**
 * Customer refund checks for Print Checks (D3).
 * GET  → { items } — customer refunds paid from a bank account that have no check yet.
 * POST { entryId, memo? } → 201 — put the refund in the print queue as a check to the customer.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { queueCustomerRefundCheck, unprintedRefunds } from '@/lib/services/liabilityPayments';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ items: await unprintedRefunds(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/print-queue/refunds');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { entryId?: unknown; memo?: unknown };
    if (typeof body.entryId !== 'string') {
      return NextResponse.json({ error: 'Pick the refund to print.', code: 'VALIDATION' }, { status: 400 });
    }
    const check = await queueCustomerRefundCheck(ctx, {
      entryId: body.entryId,
      memo: typeof body.memo === 'string' ? body.memo : null,
    });
    return NextResponse.json(check, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/print-queue/refunds');
  }
}
