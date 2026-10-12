/**
 * POST /api/sales-forms/:kind/:id/email — email an A/R form as a PDF (wave2 sales C7).
 * Body: { to?: string }. Sent through sendMail (SMTP config + company network policy).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailSalesForm, isSalesFormKind } from '@/lib/services/salesForms';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { kind, id } = await params;
    const ctx = await getServerContext();
    if (!isSalesFormKind(kind)) {
      return NextResponse.json({ error: `Unknown form type "${kind}"`, code: 'NOT_FOUND' }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { to?: unknown };
    const to = typeof body?.to === 'string' && body.to.trim() ? body.to.trim() : null;
    return NextResponse.json(await emailSalesForm(ctx, kind, id, to));
  } catch (err) {
    return routeError(err, 'POST /api/sales-forms/[kind]/[id]/email');
  }
}
