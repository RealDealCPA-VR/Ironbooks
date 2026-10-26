/**
 * /api/pay-liabilities
 *
 * Payroll liabilities only (payroll area). Sales tax is paid on Pay Sales Tax
 * (/api/sales-tax/pay, sales_tax area) — a payroll-only user cannot pay sales tax here.
 *
 * GET  → { payrollLiabilitiesDue: string }   Current credit balance of 2300 from the posted GL.
 *
 * POST body:
 *   {
 *     type:             'payroll',
 *     amount:           string,          // decimal, e.g. "120.00"
 *     date:             string,          // ISO 8601, e.g. "2025-04-01"
 *     paymentAccountId: string,          // bank account uuid (writes a Liability Check)
 *     memo?:            string,
 *     vendorId?, payeeName?, checkNumber?, toPrint?, allowDuplicateNumber?   // check fields
 *   }
 *
 * POST → 201 { entry: JournalEntry }
 *
 * ServiceError → HTTP:
 *   NOT_FOUND  → 404
 *   VALIDATION / UNBALANCED → 400
 *   FORBIDDEN  → 403
 *   else       → 500
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { payrollLiabilitiesDue, payPayrollLiabilities } from '@/lib/services/liabilityPayments';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

function errorStatus(code: string): number {
  return serviceErrorStatus(code);
}

function serviceError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details ?? null },
      { status: errorStatus(err.code) },
    );
  }
  console.error('[/api/pay-liabilities]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ payrollLiabilitiesDue: await payrollLiabilitiesDue(ctx) });
  } catch (err) {
    return serviceError(err);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const { type, amount, date, paymentAccountId, memo } = body as {
      type?: string;
      amount?: string;
      date?: string;
      paymentAccountId?: string;
      memo?: string;
    };

    if (type === 'sales_tax') {
      return NextResponse.json(
        { error: 'Sales tax is paid on the Pay Sales Tax page.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (type !== undefined && type !== 'payroll') {
      return NextResponse.json({ error: 'type must be "payroll".' }, { status: 400 });
    }
    if (!amount || typeof amount !== 'string') {
      return NextResponse.json({ error: 'amount (decimal string) is required.' }, { status: 400 });
    }
    if (!date || typeof date !== 'string') {
      return NextResponse.json({ error: 'date (ISO string) is required.' }, { status: 400 });
    }
    if (!paymentAccountId || typeof paymentAccountId !== 'string') {
      return NextResponse.json({ error: 'paymentAccountId is required.' }, { status: 400 });
    }

    const parsedDate = parseDateInput(date);
    if (!parsedDate) {
      return NextResponse.json({ error: 'date must be a real calendar day (YYYY-MM-DD).', code: 'VALIDATION' }, { status: 400 });
    }

    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const entry = await payPayrollLiabilities(ctx, {
      amount,
      date: parsedDate,
      paymentAccountId,
      memo: memo ?? null,
      vendorId: str(body.vendorId),
      payeeName: str(body.payeeName),
      checkNumber: str(body.checkNumber),
      toPrint: body.toPrint === true,
      allowDuplicateNumber: body.allowDuplicateNumber === true,
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return serviceError(err);
  }
}
