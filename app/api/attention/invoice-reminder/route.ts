/**
 * POST /api/attention/invoice-reminder — email a friendly payment reminder (invoice PDF
 * attached) for an overdue invoice, through the existing email service. Recorded in the audit
 * trail. When email (SMTP) isn't set up the answer is a 400 explaining how; the inbox then
 * offers "Copy reminder" / "Open in my email program" instead.
 *
 * Body: { invoiceId: string, to?: string }
 * Response: { ok: true, to: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { sendPaymentReminder } from '@/lib/services/attention';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : '';
    const to = typeof body.to === 'string' ? body.to : null;
    return NextResponse.json(await sendPaymentReminder(ctx, invoiceId, to));
  } catch (err) {
    return routeError(err, 'POST /api/attention/invoice-reminder');
  }
}
