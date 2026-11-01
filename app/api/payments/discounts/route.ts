/**
 * GET /api/payments/discounts?customerId=&date=YYYY-MM-DD&paymentId= — suggested early-payment
 * discounts for the customer's open invoices when paid on `date` (default: today on the company's
 * calendar). wave2 sales C3; salesar: the terms' percent of the invoice amount, from the invoice's
 * Terms list entry, with the discount date per invoice. `paymentId` is the payment being edited
 * (its own amounts are handed back to the invoices it paid).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { suggestEarlyPaymentDiscounts } from '@/lib/services/payments';
import { companyToday } from '@/lib/services/salesDates';
import { routeError } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const customerId = sp.get('customerId');
    if (!customerId || !UUID_RE.test(customerId)) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    const paymentId = sp.get('paymentId') || null;
    if (paymentId && !UUID_RE.test(paymentId)) {
      return NextResponse.json({ error: 'paymentId is not a valid id', code: 'VALIDATION' }, { status: 400 });
    }
    const dateStr = sp.get('date');
    const date = dateStr ? parseDateInput(dateStr) : await companyToday(ctx);
    if (!date) {
      return NextResponse.json({ error: 'date is not a valid date', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({
      discounts: await suggestEarlyPaymentDiscounts(ctx, { customerId, paymentDate: date, paymentId }),
    });
  } catch (err) {
    return routeError(err, 'GET /api/payments/discounts');
  }
}
