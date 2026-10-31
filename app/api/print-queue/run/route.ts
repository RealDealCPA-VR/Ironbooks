/**
 * POST /api/print-queue/run { items: [{ source, id, checkNumber }], allowDuplicateNumber? }
 *   PARITY D3 — step 1 of QB Print Checks: the checks are still waiting to be printed, drawn on one
 *   bank account, and the numbers they print with are free (409 duplicateNumber otherwise, asked
 *   BEFORE the check paper is used). Nothing is recorded; the page prints the PDF next and then
 *   asks "Did check(s) print OK?" (POST /api/print-queue/confirm).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { preparePrintRun } from '@/lib/services/printQueue';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { printRunSchema } from '@/lib/validation/purchases';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const parsed = printRunSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await preparePrintRun(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/print-queue/run');
  }
}
