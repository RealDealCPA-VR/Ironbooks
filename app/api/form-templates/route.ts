/**
 * GET  /api/form-templates[?formType=invoice] — the company's form templates (any member: forms
 *      offer a template picker when printing)
 * POST /api/form-templates — create { formType, name, design?, isDefault?, copyFromId? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createFormTemplate, listFormTemplates } from '@/lib/services/formTemplates';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createFormTemplateSchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const formType = req.nextUrl.searchParams.get('formType') || undefined;
    return NextResponse.json(await listFormTemplates(ctx, formType));
  } catch (err) {
    return routeError(err, 'GET /api/form-templates');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = createFormTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createFormTemplate(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/form-templates');
  }
}
