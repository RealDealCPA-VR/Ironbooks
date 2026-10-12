/**
 * GET /api/payments/credits?customerId= — open credits the customer can use in Receive
 * Payments (credit memos with unapplied credit + unapplied earlier payments). wave2 sales C4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAvailableCredits } from '@/lib/services/payments';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ credits: await listAvailableCredits(ctx, customerId) });
  } catch (err) {
    return routeError(err, 'GET /api/payments/credits');
  }
}
