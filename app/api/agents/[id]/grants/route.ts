/**
 * GET /api/agents/[id]/grants?live= — the agent's standing permissions, for the detail page's
 * "Live grants with Revoke" (plan 4.4, 7.1). Live ones only (unexpired, not taken back, not used
 * up) unless live=0. Answers { grants: AgentGrantView[] }.
 *
 * A person's window only (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listGrants } from '@/lib/services/agentGrants';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentGrantsQuerySchema } from '@/lib/validation/agentAccess';
import { NO_STORE, badId, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent');
    if (bad) return bad;
    const query = agentGrantsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const live = query.data.live !== '0' && query.data.live !== 'false';
    return NextResponse.json({ grants: await listGrants(ctx, { agentId: id, live }) }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/grants/route');
  }
}
