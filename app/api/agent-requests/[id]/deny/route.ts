/**
 * POST /api/agent-requests/[id]/deny { note? } — a person says no (plan 7.2). The note is for the
 * agent: it reads it with the request. Answers { request }.
 *
 * A person's window only (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { denyAgentRequest } from '@/lib/services/agentRequests';
import { requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { denyRequestSchema } from '@/lib/validation/agentAccess';
import { NO_STORE, badId, refuseAgent, refuseAgentRequest, refuseOutsideWindow, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent request');
    if (bad) return bad;
    const parsed = denyRequestSchema.safeParse(await requireJsonObject(req, { optional: true }));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    return NextResponse.json({ request: await denyAgentRequest(ctx, id, parsed.data.note) }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent-requests/[id]/deny/route');
  }
}
