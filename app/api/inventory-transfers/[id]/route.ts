/**
 * GET  /api/inventory-transfers/:id — transfer with lines
 * POST /api/inventory-transfers/:id — { action: 'void' } (refused once the destination no
 *                                     longer holds the transferred stock)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getInventoryTransfer, voidInventoryTransfer } from '@/lib/services/inventoryTransfers';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-transfers/:id]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getInventoryTransfer(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as { action?: string };
    if (body.action !== 'void') {
      return NextResponse.json({ error: 'action must be "void"', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await voidInventoryTransfer(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}
