/**
 * POST /api/agents/pause-all { paused } — "Pause all agents" in the title bar (plan 7.1): the
 * Integrated Applications switch of this company, one click away. While it is on, every agent is
 * refused everything. Answers { paused }.
 *
 * A person's window only, the host's or a teammate's (app/api/agent-requests/_guards.ts): the kill
 * switch stays with people, in both directions (plan 4.6). Who may use it is the service's to decide; the title bar asks
 * GET /api/agent-requests/count (canPauseAll) whether to show it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { pauseAllAgents } from '@/lib/services/agentPolicies';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { pauseAgentsSchema } from '@/lib/validation/agentAccess';
import { NO_STORE, refuseAgent, refuseOutsideWindow } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const parsed = pauseAgentsSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    await pauseAllAgents(ctx, parsed.data.paused);
    return NextResponse.json({ paused: parsed.data.paused }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/pause-all/route');
  }
}
