/**
 * POST   /api/form-templates/:id/logo — upload/replace the logo { filename, mimeType, base64 }
 *        (PNG or JPEG, up to 2 MB; stored locally in the company file)
 * DELETE /api/form-templates/:id/logo — remove the logo
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { removeFormTemplateLogo, setFormTemplateLogo } from '@/lib/services/formTemplates';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { uploadFileSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = uploadFileSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await setFormTemplateLogo(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/form-templates/[id]/logo');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await removeFormTemplateLogo(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/form-templates/[id]/logo');
  }
}
