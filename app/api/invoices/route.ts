/**
 * GET  /api/invoices          — list invoices (optional ?customerId=&status= filters)
 * POST /api/invoices          — create a new invoice and post to the GL.
 *                               Optional body.billables = { billLineIds, expenseLineIds,
 *                               timeEntryIds, markupPercent } pulls unbilled billable
 *                               time & costs onto the invoice and stamps them billed
 *                               in the same transaction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createInvoice, listInvoices } from '@/lib/services/invoices';
import { createInvoiceWithBillables, type BillableSelection } from '@/lib/services/billables';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createInvoiceBodySchema, hasBillableSelection } from '@/lib/validation/invoices';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'invoices/route.ts');
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listInvoices(ctx, { customerId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createInvoiceBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    // Billable time & costs selection (optional). When present, manual lines may
    // be empty — the billables become the lines.
    const { billables: rawBillables, ...input } = parsed.data;
    const billables: BillableSelection | null = hasBillableSelection(rawBillables)
      ? {
          billLineIds: rawBillables!.billLineIds ?? [],
          expenseLineIds: rawBillables!.expenseLineIds ?? [],
          timeEntryIds: rawBillables!.timeEntryIds ?? [],
          markupPercent: rawBillables!.markupPercent ?? null,
        }
      : null;

    const invoice = billables
      ? await createInvoiceWithBillables(ctx, input, billables)
      : await createInvoice(ctx, input);

    return NextResponse.json(invoice, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
