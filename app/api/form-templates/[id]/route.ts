/**
 * GET    /api/form-templates/:id
 * PATCH  /api/form-templates/:id — { name?, design?, isDefault?, isActive? }
 * DELETE /api/form-templates/:id
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteFormTemplate, getFormTemplate, updateFormTemplate } from '@/lib/services/formTemplates';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateFormTemplateSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getFormTemplate(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/form-templates/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateFormTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateFormTemplate(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/form-templates/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteFormTemplate(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/form-templates/[id]');
  }
}
