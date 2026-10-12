/**
 * GET    /api/recurring/:id — one memorized transaction
 * PATCH  /api/recurring/:id — edit name, schedule, how-often mode, group, number remaining,
 *                             days in advance, active flag, or the memorized payload
 * DELETE /api/recurring/:id — remove it from the Memorized Transaction List
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteTemplate, getTemplate, updateTemplate } from '@/lib/services/recurring';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateRecurringTemplateSchema } from '@/lib/validation/recurring';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getTemplate(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/recurring/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateRecurringTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateTemplate(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/recurring/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteTemplate(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/recurring/[id]');
  }
}
