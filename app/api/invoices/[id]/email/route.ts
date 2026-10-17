/**
 * POST /api/invoices/:id/email
 *
 * Renders the invoice as a PDF and emails it to the customer (or to a supplied
 * `to` address). Body: { to?: string }
 *
 * Responses:
 *   200  { ok: true }
 *   400  VALIDATION error (SMTP not configured, no recipient, etc.)
 *   404  Invoice / company not found
 *   500  Internal error
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailInvoice } from '@/lib/services/email';
import { templateIdParam } from '@/lib/validation/prefs';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[invoices/[id]/email POST]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();

    let to: string | undefined;
    let templateId: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.to === 'string' && body.to.trim()) {
        to = body.to.trim();
      }
      // Optional form template (Templates); default = the invoice default template.
      if (body && typeof body.templateId === 'string' && body.templateId) {
        const t = templateIdParam(body.templateId);
        if (t === false) {
          return NextResponse.json({ error: 'templateId must be a valid id', code: 'VALIDATION' }, { status: 400 });
        }
        templateId = t ?? undefined;
      }
    } catch {
      // No body or non-JSON body — fall back to customer email.
    }

    await emailInvoice(ctx, id, to, templateId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
