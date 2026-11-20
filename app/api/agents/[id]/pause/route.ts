/**
 * POST /api/agents/[id]/pause { paused } — pause one agent, or let it work again (plan 7.1). A
 * paused agent is refused everything until a person resumes it; an agent that asked too often in
 * an hour is paused this way too (plan 11.2). Answers AgentDetail.
 *
 * A person's window only (app/api/agent-requests/_guards.ts): pausing and resuming stay with people.
 * Allowed from any person's window (the host's, or a teammate's through the multi-user proxy), so
 * stopping an agent is never more than a click away; not from another program on this computer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getAgentDetail, pauseAgent } from '@/lib/services/agentPolicies';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { pauseAgentsSchema } from '@/lib/validation/agentAccess';
import { NO_STORE, badId, refuseAgent, refuseOutsideWindow } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent');
    if (bad) return bad;
    const parsed = pauseAgentsSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    await pauseAgent(ctx, id, parsed.data.paused);
    return NextResponse.json(await getAgentDetail(ctx, id), { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/pause/route');
  }
}
