/**
 * POST /api/print-queue/confirm { items: [{ source, id, checkNumber, reprint? }], allowDuplicateNumber? }
 *   PARITY D3 — QB "Did check(s) print OK?": records the number of every check that printed
 *   correctly (on the check and its journal entry, all in one transaction); the checks marked
 *   `reprint` printed wrong and stay in the queue to be printed again with new numbers.
 *   → { printed: [...], reprint: [...] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { confirmPrintRun } from '@/lib/services/printQueue';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { confirmPrintRunSchema } from '@/lib/validation/purchases';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const parsed = confirmPrintRunSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await confirmPrintRun(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/print-queue/confirm');
  }
}
