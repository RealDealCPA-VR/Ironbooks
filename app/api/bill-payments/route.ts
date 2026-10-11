/**
 * API route: /api/bill-payments
 *
 * GET  /api/bill-payments[?vendorId=&limit=&offset=]
 *   → 200 { payments: BillPayment[] }
 *
 * POST /api/bill-payments
 *   Body: {
 *     vendorId:         string,
 *     date:             string (ISO),
 *     method:           'cash'|'check'|'credit_card'|'ach'|'bank_transfer'|'other',
 *     reference?:       string,
 *     paymentAccountId: string,
 *     discountAccountId?: string,   // required if any application takes a discount
 *     applications: Array<{ billId: string, amountApplied: string, discountTaken?: string }>
 *   }
 *   → 201 { payment: BillPayment }
 *
 * ServiceError codes → HTTP:
 *   NOT_FOUND   → 404
 *   VALIDATION
 *   UNBALANCED  → 400
 *   FORBIDDEN   → 403
 *   CONFLICT    → 409
 *   else        → 500
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { payBills, listBillPayments } from '@/lib/services/billPayments';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { payBillsSchema } from '@/lib/validation/billPayments';

// Map ServiceError codes to HTTP status codes.
function errorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':    return 404;
    case 'VALIDATION':
    case 'UNBALANCED':   return 400;
    case 'FORBIDDEN':    return 403;
    case 'CONFLICT':     return 409;
    default:             return 500;
  }
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const vendorId = searchParams.get('vendorId') ?? undefined;
    const limit    = searchParams.has('limit')  ? Number(searchParams.get('limit'))  : undefined;
    const offset   = searchParams.has('offset') ? Number(searchParams.get('offset')) : undefined;

    const payments = await listBillPayments(ctx, { vendorId, limit, offset });
    return NextResponse.json({ payments });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details ?? null },
        { status: errorStatus(err.code) },
      );
    }
    console.error('[GET /api/bill-payments]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const ctx  = await getServerContext();
    const body = await req.json().catch(() => ({}));

    const parsed = payBillsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const { allowDuplicateNumber, ...input } = parsed.data;
    const payment = await payBills(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber });

    return NextResponse.json({ payment }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details ?? null },
        { status: errorStatus(err.code) },
      );
    }
    console.error('[POST /api/bill-payments]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
