/**
 * GET   /api/estimates/:id           — fetch estimate with lines.
 * PATCH /api/estimates/:id           — update status (body: { status }), or — when the body
 *                                      carries `lines` — edit the whole estimate (wave2 sales C1).
 * POST  /api/estimates/:id           — action dispatch:
 *          { action: 'convert' }                              — one-shot full conversion
 *          { action: 'progress', percent }                    — bill % of the entire estimate
 *          { action: 'progress', remaining: true }            — bill everything not billed yet
 *          { action: 'progress', lines: [{lineId, percent|quantity|amount}] } — selected lines
 *          (lineAmounts: [{lineId,amount}] still accepted). Billing over 100% of a line answers
 *          409 { code: 'PROGRESS_OVERBILL' }; resend with allowOverBilling: true to save anyway.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getEstimate,
  updateEstimateStatus,
  convertToInvoice,
  createProgressInvoice,
  updateEstimate,
  PROGRESS_OVERBILL_WARNING,
  type EstimateStatus,
} from '@/lib/services/estimates';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createEstimateSchema } from '@/lib/validation/estimates';

function errorResponse(err: unknown) {
  // Over-billing an estimate line is a soft warning (QB asks, then lets you go ahead).
  if (
    err instanceof ServiceError &&
    (err.details as { warning?: unknown } | undefined)?.warning === PROGRESS_OVERBILL_WARNING
  ) {
    return NextResponse.json(
      { error: err.message, code: PROGRESS_OVERBILL_WARNING, details: err.details },
      { status: 409 },
    );
  }
  return routeErrorWithWarnings(err, 'estimates/[id]');
}

type Num = string | number;
const numOrNull = (v: unknown): Num | null =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? (v as Num) : null;

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
      return NextResponse.json(await withVersionCheck(ctx, 'estimate', id, expectedVersion(req), (c) => updateEstimate(c, id, parsed.data)));
    }

    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    const updated = await withVersionCheck(ctx, 'estimate', id, expectedVersion(req), (c) => updateEstimateStatus(c, id, status as EstimateStatus));
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
      if (body.percent == null && body.remaining !== true && !Array.isArray(body.lines) && !Array.isArray(body.lineAmounts)) {
        return NextResponse.json(
          { error: 'Choose a percentage, the remaining amounts, or amounts for selected lines.', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      const date = body.date ? new Date(body.date) : null;
      if (date && isNaN(date.getTime())) {
        return NextResponse.json({ error: 'Invalid invoice date.', code: 'VALIDATION' }, { status: 400 });
      }
      const result = await createProgressInvoice(ctx, id, {
        percent: numOrNull(body.percent),
        remaining: body.remaining === true,
        lines: Array.isArray(body.lines)
          ? body.lines.map((l: Record<string, unknown>) => ({
              lineId: String(l.lineId ?? ''),
              percent: numOrNull(l.percent),
              quantity: numOrNull(l.quantity),
              amount: numOrNull(l.amount),
            }))
          : null,
        lineAmounts: Array.isArray(body.lineAmounts)
          ? body.lineAmounts.map((la: Record<string, unknown>) => ({
              lineId: String(la.lineId ?? ''),
              amount: numOrNull(la.amount) ?? 0,
            }))
          : null,
        date,
        overrideCreditLimit: body.overrideCreditLimit === true,
        allowOverBilling: body.allowOverBilling === true,
      });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json({ error: `Unknown action: "${action}"` }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
