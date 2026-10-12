/**
 * GET /api/sales-forms/:kind/:id/pdf — printable PDF of an A/R form (wave2 sales C8).
 * kind: invoice | estimate | sales_receipt | credit_memo | sales_order. ?download=1 → attachment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { isSalesFormKind, renderSalesForm } from '@/lib/services/salesForms';
import { pdfResponse, routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { kind, id } = await params;
    const ctx = await getServerContext();
    if (!isSalesFormKind(kind)) {
      return NextResponse.json({ error: `Unknown form type "${kind}"`, code: 'NOT_FOUND' }, { status: 404 });
    }
    const form = await renderSalesForm(ctx, kind, id);
    const res = pdfResponse(form.bytes, form.filename);
    if (req.nextUrl.searchParams.get('download') === '1') {
      res.headers.set('Content-Disposition', `attachment; filename="${form.filename}"`);
    }
    return res;
  } catch (err) {
    return routeError(err, 'GET /api/sales-forms/[kind]/[id]/pdf');
  }
}
