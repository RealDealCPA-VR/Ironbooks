/**
 * GET /api/purchase-orders/:id/pdf[?templateId=<uuid>]
 *
 * Prints the purchase order with the chosen form template (or the P.O. default template, or the
 * standard layout) inline as application/pdf.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { buildPurchaseOrderPdf } from '@/lib/pdf/forms';
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
    const { bytes, number } = await buildPurchaseOrderPdf(ctx, id, templateId);
    return pdfResponse(bytes, `po-${number}.pdf`);
  } catch (err) {
    return routeError(err, 'purchase-orders/[id]/pdf');
  }
}
