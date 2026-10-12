/**
 * PATCH /api/sales-forms/:kind/:id/flags — set "to be printed" / "to be emailed" (wave2 sales C7).
 * Body: { toBePrinted?: boolean, toBeEmailed?: boolean }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { isSalesFormKind, setSendFlags } from '@/lib/services/salesForms';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { kind, id } = await params;
    const ctx = await getServerContext();
    if (!isSalesFormKind(kind)) {
      return NextResponse.json({ error: `Unknown form type "${kind}"`, code: 'NOT_FOUND' }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { toBePrinted?: unknown; toBeEmailed?: unknown };
    const flags: { toBePrinted?: boolean; toBeEmailed?: boolean } = {};
    if (typeof body.toBePrinted === 'boolean') flags.toBePrinted = body.toBePrinted;
    if (typeof body.toBeEmailed === 'boolean') flags.toBeEmailed = body.toBeEmailed;
    return NextResponse.json(await setSendFlags(ctx, kind, id, flags));
  } catch (err) {
    return routeError(err, 'PATCH /api/sales-forms/[kind]/[id]/flags');
  }
}
