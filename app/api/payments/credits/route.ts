/**
 * GET /api/payments/credits?customerId= — open credits the customer can use in Receive
 * Payments (credit memos with unapplied credit, unapplied earlier payments, General Journal A/R
 * credits). wave2 sales C4; salesar C4: each credit carries its currency (null = home) and an
 * unapplied payment in a foreign currency is listed too (usable on invoices in that currency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAvailableCredits } from '@/lib/services/payments';
import { routeError } from '@/lib/routeErrors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId || !UUID_RE.test(customerId)) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ credits: await listAvailableCredits(ctx, customerId, { includeForeign: true }) });
  } catch (err) {
    return routeError(err, 'GET /api/payments/credits');
  }
}
