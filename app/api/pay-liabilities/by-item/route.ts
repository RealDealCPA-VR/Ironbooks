/**
 * /api/pay-liabilities/by-item — QB-style "Pay Scheduled Liabilities" by payroll item.
 *
 * GET  [?asOf=YYYY-MM-DD] → PayrollLiabilityBalancesResult
 *        Per-item accrued / paid / balance figures for account 2300.
 *
 * POST body:
 *   {
 *     date:             string,                    // ISO 8601
 *     paymentAccountId: string,                    // bank/cash account uuid
 *     memo?:            string,
 *     items:            [{ name: string, amount: string }]   // per-item amounts
 *   }
 * → 201 { entry } — one journal entry: Dr 2300 per item (memo = item name),
 *   Cr bank for the total. Item memos let payments reconcile against specific taxes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { payPayrollLiabilities } from '@/lib/services/liabilityPayments';
import { payrollLiabilityBalances } from '@/lib/services/payrollReports';
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
  console.error('[/api/pay-liabilities/by-item]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const asOfParam = req.nextUrl.searchParams.get('asOf');
    // A real calendar day only ("2026-02-30" used to roll over to March 2).
    const asOf = asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? parseDateInput(asOfParam) : null;
    if (asOfParam && !asOf) {
      return NextResponse.json(
        { error: 'asOf must be YYYY-MM-DD', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const balances = await payrollLiabilityBalances(ctx, asOf ? { asOf } : undefined);
    return NextResponse.json(balances);
  } catch (err) {
    return serviceError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as {
      date?: string;
      paymentAccountId?: string;
      memo?: string;
      items?: Array<{ name?: string; amount?: string }>;
      vendorId?: string;
      payeeName?: string;
      checkNumber?: string;
      toPrint?: boolean;
      allowDuplicateNumber?: boolean;
    };

    if (!body.date || typeof body.date !== 'string') {
      return NextResponse.json({ error: 'date (ISO string) is required.' }, { status: 400 });
    }
    // Malformed ("garbage" → 500) or impossible ("2026-02-30" → March 2) dates are refused.
    const date = parseDateInput(body.date);
    if (!date) {
      return NextResponse.json({ error: `"${body.date}" is not a valid date.`, code: 'VALIDATION' }, { status: 400 });
    }
    if (!body.paymentAccountId || typeof body.paymentAccountId !== 'string') {
      return NextResponse.json({ error: 'paymentAccountId is required.' }, { status: 400 });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items (non-empty array of { name, amount }) is required.' },
        { status: 400 },
      );
    }

    const entry = await payPayrollLiabilities(ctx, {
      date,
      paymentAccountId: body.paymentAccountId,
      memo: body.memo ?? null,
      items: body.items.map((i) => ({ name: i.name ?? '', amount: i.amount ?? '' })),
      vendorId: typeof body.vendorId === 'string' ? body.vendorId : null,
      payeeName: typeof body.payeeName === 'string' ? body.payeeName : null,
      checkNumber: typeof body.checkNumber === 'string' ? body.checkNumber : null,
      toPrint: body.toPrint === true,
      allowDuplicateNumber: body.allowDuplicateNumber === true,
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return serviceError(err);
  }
}
