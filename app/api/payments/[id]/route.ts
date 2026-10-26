/**
 * API route: /api/payments/[id]
 *
 * GET    — fetch a single payment with its applications
 * POST   — actions on a payment:
 *            { action: 'apply',   applications: [{ invoiceId, amountApplied }] }
 *            { action: 'unapply', invoiceId, amount? }
 *            { action: 'refund',  bankAccountId, amount, date?, memo? }
 *            { action: 'bounce',  date?, bankFee?, bankFeeAccountId?, customerFee?, customerFeeAccountId?, memo? }
 *                                  — Record Bounced Check (wave2 sales F2)
 * PUT/PATCH — edit the payment (wave2 sales C1; same body as POST /api/payments)
 * DELETE — void the payment (reverses GL, rolls back invoice balances)
 */
import { NextRequest, NextResponse } from 'next/server';
import { serviceErrorBody, serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getPayment,
  voidPayment,
  applyPayment,
  unapplyFromInvoice,
  refundPayment,
  updatePayment,
  recordBouncedCheck,
} from '@/lib/services/payments';
import { ServiceError } from '@/lib/services/_base';
import { parseDateInput, zodErrorBody } from '@/lib/validation/helpers';
import { bouncedCheckSchema, receivePaymentSchema } from '@/lib/validation/payments';

// Map ServiceError codes to HTTP status codes.
function errorStatus(code: ServiceError['code']): number {
  return serviceErrorStatus(code, { PERIOD_CLOSED: 422 });
}

function errorResponse(err: unknown, label: string) {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      serviceErrorBody(err),
      { status: errorStatus(err.code) },
    );
  }
  console.error(`[${label}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const payment = await getPayment(ctx, id);
    return NextResponse.json(payment);
  } catch (err) {
    return errorResponse(err, 'GET /api/payments/[id]');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    switch (body.action) {
      case 'apply': {
        if (!Array.isArray(body.applications) || body.applications.length === 0) {
          return NextResponse.json(
            { error: 'applications must be a non-empty array.', code: 'VALIDATION' },
            { status: 400 },
          );
        }
        const result = await applyPayment(ctx, { paymentId: id, applications: body.applications });
        return NextResponse.json(result);
      }
      case 'unapply': {
        if (!body.invoiceId) {
          return NextResponse.json(
            { error: 'invoiceId is required.', code: 'VALIDATION' },
            { status: 400 },
          );
        }
        const result = await unapplyFromInvoice(ctx, {
          paymentId: id,
          invoiceId: body.invoiceId,
          amount: body.amount ?? null,
        });
        return NextResponse.json(result);
      }
      case 'refund': {
        if (!body.bankAccountId) {
          return NextResponse.json(
            { error: 'bankAccountId is required.', code: 'VALIDATION' },
            { status: 400 },
          );
        }
        if (body.amount === undefined || body.amount === null || body.amount === '') {
          return NextResponse.json(
            { error: 'amount is required.', code: 'VALIDATION' },
            { status: 400 },
          );
        }
        // An unreadable date is a 400 (new Date('garbage') reached the service as Invalid Date → 500).
        const date = body.date ? (typeof body.date === 'string' ? parseDateInput(body.date) : null) : null;
        if (body.date && !date) {
          return NextResponse.json({ error: `date: "${body.date}" is not a valid date`, code: 'VALIDATION' }, { status: 400 });
        }
        const result = await refundPayment(ctx, {
          paymentId: id,
          bankAccountId: body.bankAccountId,
          amount: body.amount,
          date,
          memo: body.memo ?? null,
        });
        return NextResponse.json(result);
      }
      case 'bounce': {
        const parsed = bouncedCheckSchema.safeParse(body);
        if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
        const result = await recordBouncedCheck(ctx, { paymentId: id, ...parsed.data });
        return NextResponse.json(result, { status: 201 });
      }
      default:
        return NextResponse.json(
          {
            error: `Unknown action '${body.action}'. Supported: apply, unapply, refund, bounce.`,
            code: 'VALIDATION',
          },
          { status: 400 },
        );
    }
  } catch (err) {
    return errorResponse(err, 'POST /api/payments/[id]');
  }
}

/** Edit a received payment (void + re-post onto the same record, in one transaction). */
export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req, { optional: true });
    const parsed = receivePaymentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const result = await withVersionCheck(ctx, 'payment_received', id, expectedVersion(req), (c) => updatePayment(c, id, parsed.data));
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, 'PUT /api/payments/[id]');
  }
}

/** Alias of PUT — the shared api client exposes patch. */
export async function PATCH(req: NextRequest, rc: RouteContext) {
  return PUT(req, rc);
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'payment_received', id, expectedVersion(req), (c) => voidPayment(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err, 'DELETE /api/payments/[id]');
  }
}
