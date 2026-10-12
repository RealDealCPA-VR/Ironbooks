/**
 * GET  /api/invoices/retainage?asOf=YYYY-MM-DD&customerId= — retainage held / billed / still open
 *                                                             by customer (ties to account 1250).
 * POST /api/invoices/retainage — bill released retainage: { customerId, date, amount?, dueDate?,
 *                                memo?, refNumber?, allowDuplicateNumber?, overrideCreditLimit? }
 *                                → a new invoice moving the amount from Retainage Receivable to A/R.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { billRetainage, retainageReport } from '@/lib/services/retainage';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zDate, zDocNumber, zMoney, zUuid, zodErrorBody } from '@/lib/validation/helpers';

const billSchema = z.object({
  customerId: zUuid,
  date: zDate,
  amount: zMoney.nullish(),
  dueDate: zDate.nullish(),
  memo: z.string().max(4000).nullish(),
  refNumber: zDocNumber,
  allowDuplicateNumber: z.boolean().nullish(),
  classId: zUuid.nullish(),
  overrideCreditLimit: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const asOfRaw = sp.get('asOf');
    const asOf = asOfRaw ? new Date(asOfRaw) : null;
    if (asOf && Number.isNaN(asOf.getTime())) {
      return NextResponse.json({ error: 'asOf must be a date (YYYY-MM-DD).' }, { status: 400 });
    }
    return NextResponse.json(
      await retainageReport(ctx, { asOf, customerId: sp.get('customerId') || null }),
    );
  } catch (err) {
    return routeErrorWithWarnings(err, 'GET /api/invoices/retainage');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = billSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await billRetainage(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeErrorWithWarnings(err, 'POST /api/invoices/retainage');
  }
}
