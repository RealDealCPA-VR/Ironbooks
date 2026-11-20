/**
 * GET /api/agents/[id]/activity?limit= — what the agent ran and asked, newest first, linked to the
 * audit trail (plan 7.1; at most 200). Answers { activity: AgentActivityRow[] }.
 *
 * A person's window only (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAgentActivity } from '@/lib/services/agentPolicies';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentActivityQuerySchema } from '@/lib/validation/agentAccess';
import { NO_STORE, badId, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

const ACTIVITY_MAX = 200;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent');
    if (bad) return bad;
    const query = agentActivityQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const activity = await listAgentActivity(ctx, id, query.data.limit ?? ACTIVITY_MAX);
    return NextResponse.json({ activity }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/activity/route');
  }
}
