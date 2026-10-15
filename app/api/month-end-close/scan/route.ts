/**
 * POST /api/month-end-close/scan  Body: { periodEnd }
 *   Runs the error scan (the rules behind AI Review — works with AI turned off), records when it
 *   ran for the period and returns { found, checklist } with the Verify Data results.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { runMonthEndErrorScan } from '@/lib/services/monthEndClose';
import { zodErrorBody } from '@/lib/validation/helpers';
import { monthEndScanSchema } from '@/lib/validation/monthEndClose';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const parsed = monthEndScanSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await runMonthEndErrorScan(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/month-end-close/scan');
  }
}
