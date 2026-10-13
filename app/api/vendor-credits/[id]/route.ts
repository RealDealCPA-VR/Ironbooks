/**
 * GET    /api/vendor-credits/:id                      — fetch a credit with its lines
 * POST   /api/vendor-credits/:id  { action: 'apply', billId, amount }    — apply to a bill
 * POST   /api/vendor-credits/:id  { action: 'unapply', billId, amount }  — reverse an application
 * POST   /api/vendor-credits/:id  { action: 'refund', bankAccountId, amount, date?, memo? }
 *                                                     — record a vendor refund (cash back)
 * DELETE /api/vendor-credits/:id                      — void the credit
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getVendorCredit,
  applyToBill,
  unapplyFromBill,
  refundVendorCredit,
  voidVendorCredit,
  updateVendorCredit,
} from '@/lib/services/vendorCredits';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createVendorCreditSchema } from '@/lib/validation/vendorCredits';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED' || err.code === 'PERIOD_CLOSED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[vendor-credits/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Reads an optional date from the request body. Missing means "today" (null); anything that is
 * not a real calendar date (e.g. "not-a-date", "2026-13-45") is a validation error, not a crash.
 */
function readDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const bad = () => new ServiceError('VALIDATION', 'Enter a valid date (for example 2026-07-15).');
  if (typeof value !== 'string' && typeof value !== 'number') throw bad();
  const input: string | number = typeof value === 'string' ? value.trim() : value;
  if (typeof input === 'string') {
    // Only a calendar date, optionally with a time and zone. Anything else (e.g. trailing junk
    // like '2026-07-15junk', which JS would read leniently as another date) is refused.
    const m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(input);
    if (!m) throw bad();
    const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const probe = new Date(Date.UTC(y, mo - 1, da));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) throw bad();
  }
  const out = new Date(input);
  if (Number.isNaN(out.getTime())) throw bad();
  return out;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const credit = await getVendorCredit(ctx, id);
    return NextResponse.json(credit);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json();

    if (body.action === 'refund') {
      if (!body.bankAccountId) {
        return NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (!body.amount) {
        return NextResponse.json({ error: 'amount is required', code: 'VALIDATION' }, { status: 400 });
      }
      const result = await refundVendorCredit(ctx, {
        vendorCreditId: id,
        bankAccountId: body.bankAccountId,
        amount: body.amount,
        date: readDate(body.date),
        memo: body.memo ?? null,
        exchangeRate: body.exchangeRate ?? null,
      });
      return NextResponse.json(result);
    }

    if (body.action !== 'apply' && body.action !== 'unapply') {
      return NextResponse.json(
        { error: 'Unknown action. Expected action: "apply", "unapply" or "refund".', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!body.billId) {
      return NextResponse.json({ error: 'billId is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!body.amount) {
      return NextResponse.json({ error: 'amount is required', code: 'VALIDATION' }, { status: 400 });
    }

    const fn = body.action === 'apply' ? applyToBill : unapplyFromBill;
    const result = await fn(ctx, {
      vendorCreditId: id,
      billId: body.billId,
      amount: body.amount,
      date: readDate(body.date),
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'vendor_credit', id, expectedVersion(req), (c) => voidVendorCredit(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/vendor-credits/:id — edit a saved vendor credit (same body as POST /api/vendor-credits). */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createVendorCreditSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const credit = await withVersionCheck(ctx, 'vendor_credit', id, expectedVersion(req), (c) => updateVendorCredit(c, id, parsed.data));
    return NextResponse.json(credit);
  } catch (err) {
    return routeError(err, 'PATCH /api/vendor-credits/[id]');
  }
}
