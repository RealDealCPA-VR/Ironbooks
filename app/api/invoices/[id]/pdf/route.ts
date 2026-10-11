/**
 * GET /api/invoices/:id/pdf[?templateId=<uuid>]
 *
 * Prints the invoice with the chosen form template (or the invoice default template, or the
 * standard layout) and returns it inline (Content-Disposition: inline; invoice-<number>.pdf).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { buildInvoicePdf } from '@/lib/pdf/forms';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { templateIdParam } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const templateId = templateIdParam(req.nextUrl.searchParams.get('templateId'));
    if (templateId === false) {
      return NextResponse.json({ error: 'templateId must be a valid id', code: 'VALIDATION' }, { status: 400 });
    }
    const { bytes, number } = await buildInvoicePdf(ctx, id, templateId);
    return pdfResponse(bytes, `invoice-${number}.pdf`);
  } catch (err) {
    return routeError(err, 'invoices/[id]/pdf');
  }
}
