/**
 * GET   /api/estimates/:id           — fetch estimate with lines.
 * PATCH /api/estimates/:id           — update status (body: { status }), or — when the body
 *                                      carries `lines` — edit the whole estimate (wave2 sales C1).
 * POST  /api/estimates/:id           — action dispatch:
 *          { action: 'convert' }                              — one-shot full conversion
 *          { action: 'progress', percent }                    — bill % of remaining balance
 *          { action: 'progress', lineAmounts: [{lineId,amount}] } — per-line progress billing
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  getEstimate,
  updateEstimateStatus,
  convertToInvoice,
  createProgressInvoice,
  updateEstimate,
  type EstimateStatus,
} from '@/lib/services/estimates';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createEstimateSchema } from '@/lib/validation/estimates';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'estimates/[id]');
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const estimate = await getEstimate(ctx, id);
    return NextResponse.json(estimate);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json();
    const { status } = body;

    // Full edit (C1): the body is a complete estimate form.
    if (Array.isArray(body?.lines)) {
      const parsed = createEstimateSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
      return NextResponse.json(await updateEstimate(ctx, id, parsed.data));
    }

    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    const updated = await updateEstimateStatus(ctx, id, status as EstimateStatus);
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json();
    const { action } = body;

    if (action === 'convert') {
      const invoice = await convertToInvoice(ctx, id, {
        overrideCreditLimit: body.overrideCreditLimit === true,
      });
      return NextResponse.json(invoice, { status: 201 });
    }

    if (action === 'progress') {
      if (body.percent == null && !Array.isArray(body.lineAmounts)) {
        return NextResponse.json(
          { error: 'Provide percent or lineAmounts for progress invoicing', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      const result = await createProgressInvoice(ctx, id, {
        percent: body.percent ?? null,
        lineAmounts: Array.isArray(body.lineAmounts)
          ? body.lineAmounts.map((la: Record<string, unknown>) => ({
              lineId: la.lineId as string,
              amount: la.amount as string | number,
            }))
          : null,
        date: body.date ? new Date(body.date) : null,
        overrideCreditLimit: body.overrideCreditLimit === true,
      });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json({ error: `Unknown action: "${action}"` }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
