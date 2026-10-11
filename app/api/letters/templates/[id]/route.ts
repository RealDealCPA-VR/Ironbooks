/**
 * PATCH  /api/letters/templates/:id — edit a company letter template
 * DELETE /api/letters/templates/:id — delete it (built-in letters cannot be changed)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteLetterTemplate, updateLetterTemplate } from '@/lib/services/letters';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateLetterTemplateSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateLetterTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateLetterTemplate(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/letters/templates/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteLetterTemplate(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/letters/templates/[id]');
  }
}
