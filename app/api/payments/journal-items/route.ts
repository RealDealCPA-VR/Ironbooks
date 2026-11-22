/**
 * General Journal A/R items of a customer in Receive Payments (QB invariant I11).
 *
 * GET  /api/payments/journal-items?customerId=
 *        → { charges, credits } — open JE A/R debits (payable) and credits (applicable to invoices)
 * POST /api/payments/journal-items
 *        { action: 'apply_credit', journalLineId, invoiceId | chargeLineId, amount, date? }
 *                                   — JE credit → invoice, or → General Journal charge
 *        { action: 'apply_payment', paymentId, items: [{ journalLineId, amount }] }
 *                                   — an earlier payment's unapplied credit → JE charges
 *        { action: 'unapply', applicationId } — remove one application
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  applyJournalCredit,
  applyPaymentToJournalCharges,
  listJournalOpenItems,
  unapplyJournalApplication,
} from '@/lib/services/journalApplications';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { paymentJournalItemsSchema } from '@/lib/validation/payments';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await listJournalOpenItems(ctx, 'ar', customerId));
  } catch (err) {
    return routeError(err, 'GET /api/payments/journal-items');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = paymentJournalItemsSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const b = parsed.data;
    if (b.action === 'apply_credit') {
      const application = await applyJournalCredit(ctx, {
        journalLineId: b.journalLineId,
        invoiceId: b.invoiceId ?? null,
        chargeLineId: b.chargeLineId ?? null,
        amount: b.amount,
        date: b.date ?? null,
      }, { side: 'ar' }); // this screen's side only (an A/P credit is not applied here)
      return NextResponse.json({ application }, { status: 201 });
    }
    if (b.action === 'apply_payment') {
      const payment = await applyPaymentToJournalCharges(ctx, { paymentId: b.paymentId, items: b.items });
      return NextResponse.json({ payment });
    }
    const application = await unapplyJournalApplication(ctx, b.applicationId, { side: 'ar' });
    return NextResponse.json({ application });
  } catch (err) {
    return routeError(err, 'POST /api/payments/journal-items');
  }
}
