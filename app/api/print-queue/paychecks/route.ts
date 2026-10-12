/**
 * GET  /api/print-queue/paychecks — paychecks never printed and not yet queued
 * POST /api/print-queue/paychecks { paycheckIds } — add them to the Print Checks queue
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listUnprintedPaychecks, queuePaychecks } from '@/lib/services/printQueue';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { queuePaychecksSchema } from '@/lib/validation/purchases';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ paychecks: await listUnprintedPaychecks(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/print-queue/paychecks');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = queuePaychecksSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await queuePaychecks(ctx, parsed.data.paycheckIds));
  } catch (err) {
    return routeError(err, 'POST /api/print-queue/paychecks');
  }
}
