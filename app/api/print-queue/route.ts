/**
 * GET  /api/print-queue[?paymentAccountId=]  — every check waiting to print (checks written with
 *      "Print later", bill payments "To be printed", queued paychecks).
 * POST /api/print-queue { source, id, checkNumber?, allowDuplicateNumber? }
 *      — record a printed check: stamps the number on the document + its journal entry.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listPrintQueue, markPrinted } from '@/lib/services/printQueue';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { markPrintedSchema } from '@/lib/validation/purchases';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const items = await listPrintQueue(ctx, {
      paymentAccountId: req.nextUrl.searchParams.get('paymentAccountId') ?? undefined,
    });
    return NextResponse.json({ items });
  } catch (err) {
    return routeError(err, 'GET /api/print-queue');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = markPrintedSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const doc = await markPrinted(ctx, {
      source: parsed.data.source,
      id: parsed.data.id,
      checkNumber: parsed.data.checkNumber ?? undefined,
      allowDuplicateNumber: parsed.data.allowDuplicateNumber,
    });
    return NextResponse.json({ printed: doc });
  } catch (err) {
    return routeError(err, 'POST /api/print-queue');
  }
}
