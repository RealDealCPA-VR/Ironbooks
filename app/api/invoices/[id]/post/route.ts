/**
 * POST /api/invoices/:id/post — post a pending (draft) invoice to the GL.
 *
 * Drafts are saved without any journal entry or inventory relief; this
 * endpoint validates them again, posts the GL entry + COGS, and flips the
 * status to open/partial/paid. The fiscal-period check happens here (post
 * time) via the posting engine.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { postDraftInvoice } from '@/lib/services/invoices';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';

function errorResponse(err: unknown) {
  return routeErrorWithWarnings(err, 'invoices/[id]/post/route.ts');
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { overrideCreditLimit?: unknown };
    const posted = await postDraftInvoice(ctx, id, {
      overrideCreditLimit: body?.overrideCreditLimit === true,
    });
    return NextResponse.json(posted);
  } catch (err) {
    return errorResponse(err);
  }
}
