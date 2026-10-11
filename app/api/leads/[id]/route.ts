/**
 * GET    /api/leads/:id
 * PATCH  /api/leads/:id
 * DELETE /api/leads/:id (not allowed once converted: make it inactive instead)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteLead, getLead, updateLead } from '@/lib/services/leads';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateLeadSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getLead(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/leads/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateLeadSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateLead(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/leads/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteLead(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/leads/[id]');
  }
}
