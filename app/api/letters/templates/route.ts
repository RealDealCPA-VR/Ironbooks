/**
 * GET  /api/letters/templates — built-in + company letter templates
 * POST /api/letters/templates — save a company letter template { category, name, body }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createLetterTemplate, listLetterTemplates } from '@/lib/services/letters';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { letterTemplateSchema } from '@/lib/validation/prefs';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listLetterTemplates(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/letters/templates');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = letterTemplateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createLetterTemplate(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/letters/templates');
  }
}
