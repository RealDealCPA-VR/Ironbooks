/**
 * GET    /api/invoices/:id   — fetch an invoice with its lines
 * PUT    /api/invoices/:id   — edit an open, unpaid invoice (void + re-post in one transaction)
 * PATCH  /api/invoices/:id   — alias of PUT (the shared api client exposes patch)
 * DELETE /api/invoices/:id   — void an invoice (reverses its GL entry)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getInvoice, updateInvoice, voidInvoice } from '@/lib/services/invoices';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateInvoiceSchema } from '@/lib/validation/invoices';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'invoices/[id]/route.ts');
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const invoice = await getInvoice(ctx, id);
    return NextResponse.json(invoice);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    // Multi-user: 409 if someone else saved this invoice since it was loaded.
    const updated = await withVersionCheck(ctx, 'invoice', id, expectedVersion(req), (c) =>
      updateInvoice(c, id, parsed.data),
    );

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT — the shared api client only exposes get/post/patch/del. */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return PUT(req, ctx);
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'invoice', id, expectedVersion(req), (c) => voidInvoice(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err);
  }
}
