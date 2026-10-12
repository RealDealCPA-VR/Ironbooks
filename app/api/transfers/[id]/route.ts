/**
 * GET    /api/transfers/:id — one transfer
 * PATCH  /api/transfers/:id — edit (memo-only edits keep the entry; otherwise void + repost)
 * DELETE /api/transfers/:id — void the transfer (reverses its entry)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getTransfer, updateTransfer, voidTransfer } from '@/lib/services/transfers';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createTransferSchema } from '@/lib/validation/transfers';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getTransfer(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/transfers/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createTransferSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateTransfer(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/transfers/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await voidTransfer(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/transfers/[id]');
  }
}
