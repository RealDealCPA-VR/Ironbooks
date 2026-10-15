/**
 * POST /api/month-end-close/close  Body: { periodEnd, password?, version? }
 *   Final month-end step: sets the company closing date to the period end (the Set Closing Date
 *   flow, incl. the optional closing-date password: a string sets / replaces it, null removes it,
 *   omitted keeps it). Needs Closing Date / Periods: modify; refused while required checklist
 *   steps are still open. → { closingDate, hasPassword, checklist }
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { closeMonth } from '@/lib/services/monthEndClose';
import { zodErrorBody } from '@/lib/validation/helpers';
import { monthEndCloseSchema } from '@/lib/validation/monthEndClose';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const parsed = monthEndCloseSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await closeMonth(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/month-end-close/close');
  }
}
