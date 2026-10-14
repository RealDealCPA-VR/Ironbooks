/**
 * GET /api/sales-forms/:kind/:id/pdf[?templateId=<uuid>] — printable PDF of an A/R form (wave2 sales C8).
 * kind: invoice | estimate | sales_receipt | credit_memo | sales_order. ?download=1 → attachment.
 * Prints with the given form template, else the form's default template, else the built-in layout (B11).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { isSalesFormKind, renderSalesForm } from '@/lib/services/salesForms';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { templateIdParam } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { kind, id } = await params;
    const ctx = await getServerContext();
    if (!isSalesFormKind(kind)) {
      return NextResponse.json({ error: `Unknown form type "${kind}"`, code: 'NOT_FOUND' }, { status: 404 });
    }
    const templateId = templateIdParam(req.nextUrl.searchParams.get('templateId'));
    if (templateId === false) {
      return NextResponse.json({ error: 'templateId must be a valid id', code: 'VALIDATION' }, { status: 400 });
    }
    const form = await renderSalesForm(ctx, kind, id, templateId);
    const res = pdfResponse(form.bytes, form.filename);
    if (req.nextUrl.searchParams.get('download') === '1') {
      res.headers.set('Content-Disposition', `attachment; filename="${form.filename}"`);
    }
    return res;
  } catch (err) {
    return routeError(err, 'GET /api/sales-forms/[kind]/[id]/pdf');
  }
}
