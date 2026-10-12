/**
 * GET /api/payments/discounts?customerId=&date=YYYY-MM-DD — suggested early-payment discounts
 * for the customer's open invoices when paid on `date` (from their terms). wave2 sales C3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { suggestEarlyPaymentDiscounts } from '@/lib/services/payments';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const customerId = sp.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    const dateStr = sp.get('date');
    const date = dateStr ? new Date(dateStr) : new Date();
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ error: 'date is not a valid date', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ discounts: await suggestEarlyPaymentDiscounts(ctx, { customerId, paymentDate: date }) });
  } catch (err) {
    return routeError(err, 'GET /api/payments/discounts');
  }
}
