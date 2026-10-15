/**
 * API route: /api/deposits/[id]
 *
 * GET    — fetch a single deposit with its lines
 * DELETE — void the deposit (reverses GL; payments/sales receipts return to
 *          the Undeposited Funds picker)
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getDeposit, updateDeposit, voidDeposit } from '@/lib/services/deposits';
import { routeError, serviceErrorBody } from '@/lib/routeErrors';
import { createDepositSchema } from '@/lib/validation/deposits';
import { ServiceError } from '@/lib/services/_base';

function errorStatus(code: ServiceError['code']): number {
  switch (code) {
    case 'NOT_FOUND':     return 404;
    case 'VALIDATION':    return 400;
    case 'UNBALANCED':    return 400;
    case 'FORBIDDEN':     return 403;
    case 'CONFLICT':      return 409;
    case 'PERIOD_CLOSED': return 422;
    default:              return 500;
  }
}

function errorResponse(err: unknown, label: string) {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      serviceErrorBody(err),
      { status: errorStatus(err.code) },
    );
  }
  console.error(`[${label}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const deposit = await getDeposit(ctx, id);
    return NextResponse.json(deposit);
  } catch (err) {
    return errorResponse(err, 'GET /api/deposits/[id]');
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'deposit', id, expectedVersion(req), (c) => voidDeposit(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err, 'DELETE /api/deposits/[id]');
  }
}

/** PATCH /api/deposits/:id — edit a saved deposit (same body as POST /api/deposits). */
export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createDepositSchema.safeParse(body);
    if (!parsed.success) return zodErrorWithFixes(ctx, parsed.error, body, 'bank', { purpose: 'deposit' });
    const deposit = await withVersionCheck(ctx, 'deposit', id, expectedVersion(req), (c) => updateDeposit(c, id, parsed.data));
    return NextResponse.json(deposit);
  } catch (err) {
    return routeError(err, 'PATCH /api/deposits/[id]');
  }
}
