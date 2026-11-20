/**
 * GET    /api/agents/[id] — the agent's detail page (plan 7.1): roles, preset, the policy grid with
 *                           the cells that cannot change and why, limits, paused (AgentDetail).
 * PATCH  /api/agents/[id] — change its policy: AgentPolicyInput (lib/agent/contract.ts). Answers
 *                           AgentDetail.
 * DELETE /api/agents/[id] — take an agent's access away (AGENT_ACCESS.md). Its token stops
 *                           working with the next request. The agent stays in the list as removed,
 *                           and what it did stays in the audit trail under its name.
 *
 * For an Admin (the services check). Changing an agent's permissions or removing it is done on the
 * computer that holds the company file, like making one (app/api/agents/route.ts): the policy
 * decides what may reach the books from outside the app's own window, and its folders are folders
 * of that computer. An agent never sees or changes agents (plan 4.6, D9;
 * app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { revokeAgent } from '@/lib/services/agents';
import { getAgentDetail, saveAgentPolicy } from '@/lib/services/agentPolicies';
import { hostOnlyResponse, isRemoteRequest, HOST_ONLY_ACTION_MESSAGE } from '@/lib/net/hostOnly';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentPolicySchema } from '@/lib/validation/agentAccess';
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
    return NextResponse.json(await getAgentDetail(ctx, id), { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/route');
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const { id } = await params;
    const bad = badId(id, 'That agent');
    if (bad) return bad;
    const parsed = agentPolicySchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    await saveAgentPolicy(ctx, id, parsed.data);
    return NextResponse.json(await getAgentDetail(ctx, id), { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/route');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const { id } = await params;
    return NextResponse.json({ agent: await revokeAgent(ctx, id) }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/[id]/route');
  }
}
