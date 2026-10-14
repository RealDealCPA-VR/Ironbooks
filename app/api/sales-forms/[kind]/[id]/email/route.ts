/**
 * POST /api/sales-forms/:kind/:id/email — email an A/R form as a PDF (wave2 sales C7).
 * Body: { to?: string, templateId?: string }. Sent through sendMail (SMTP config + company network
 * policy). The PDF prints with `templateId`, else the form's default template (B11).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailSalesForm, isSalesFormKind } from '@/lib/services/salesForms';
import { routeError } from '@/lib/routeErrors';
import { templateIdParam } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { kind, id } = await params;
    const ctx = await getServerContext();
    if (!isSalesFormKind(kind)) {
      return NextResponse.json({ error: `Unknown form type "${kind}"`, code: 'NOT_FOUND' }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { to?: unknown; templateId?: unknown };
    const to = typeof body?.to === 'string' && body.to.trim() ? body.to.trim() : null;
    let templateId: string | null = null;
    if (typeof body?.templateId === 'string' && body.templateId) {
      const t = templateIdParam(body.templateId);
      if (t === false) {
        return NextResponse.json({ error: 'templateId must be a valid id', code: 'VALIDATION' }, { status: 400 });
      }
      templateId = t;
    }
    return NextResponse.json(await emailSalesForm(ctx, kind, id, to, templateId));
  } catch (err) {
    return routeError(err, 'POST /api/sales-forms/[kind]/[id]/email');
  }
}
