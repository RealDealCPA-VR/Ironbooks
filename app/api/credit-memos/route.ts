/**
 * GET  /api/credit-memos          — list credit memos (optional ?customerId=&status=)
 * POST /api/credit-memos          — create a credit memo and post to the GL
 *
 * POST body supports sales tax + inventory restocking:
 *   { customerId, date, taxRateId?, memo?,
 *     lines: [{ itemId?, accountId?, description?, quantity, rate,
 *               taxable? (default true), restock? (default true; false = damaged write-off) }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createCreditMemo, listCreditMemos } from '@/lib/services/creditMemos';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createCreditMemoSchema } from '@/lib/validation/creditMemos';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[credit-memos/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const rows = await listCreditMemos(ctx, { customerId, status });
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createCreditMemoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const memo = await createCreditMemo(ctx, parsed.data);

    return NextResponse.json(memo, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
