/**
 * GET /api/agent-requests/count — what the title bar polls (plan 7.1, 7.2): the badge (pending
 * requests this person could approve), the newest of them for the desktop notice, and whether to
 * show "Pause all agents" (AgentRequestCount, lib/agent/contract.ts).
 *
 * Polled every 20 seconds or so while the window shows, and every 90 seconds while it is hidden (only
 * to raise the desktop notice), so it is a thin handler with no query of its own:
 *  - badgeForPerson (lib/services/agentRequests.ts) gives the badge and the newest request from ONE
 *    scan, so the two never disagree. It judges each request for this person with `atHost`, the same
 *    test an approval uses: a teammate's window does not count a host-only request it could not
 *    approve there.
 *  - agentCount and agentsBlockedFor (lib/services/agents.ts): one count of the agents that are not
 *    removed, one company setting.
 *  - mayPauseAllAgents (lib/services/agentPolicies.ts): the check "Pause all agents" itself makes,
 *    so the button shows exactly when it would work. It fails closed: an error is "no".
 *
 * The notice carries the app's own summary of the request, built from the operation, never the
 * agent's words: the four fields are copied one by one, so nothing else the service may hold (the
 * agent's reason above all) can reach the notice.
 *
 * A person only, never an agent (app/api/agent-requests/_guards.ts). Reading stays open to any of
 * a person's windows and sign-ins.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { badgeForPerson } from '@/lib/services/agentRequests';
import { agentCount, agentsBlockedFor } from '@/lib/services/agents';
import { mayPauseAllAgents } from '@/lib/services/agentPolicies';
import type { ServiceContext } from '@/lib/services/_base';
import type { AgentRequestCount, BadgeForPerson } from '@/lib/agent/contract';
import { NO_STORE, atHostWindow, refuseAgent, refuseAgentRequest, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

type Newest = Awaited<ReturnType<BadgeForPerson>>['newest'];

/** The notice's four fields and nothing else. */
function newestOf(n: Newest): AgentRequestCount['newest'] {
  if (!n) return null;
  return { id: n.id, agentName: n.agentName, summary: n.summary, createdAt: n.createdAt };
}

/** Only a plain yes shows the button; an error or anything else is no. */
async function canPauseAll(ctx: ServiceContext): Promise<boolean> {
  try {
    return (await mayPauseAllAgents(ctx)) === true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const badge = await badgeForPerson(ctx, { atHost: atHostWindow(req) });
    const answer: AgentRequestCount = {
      pending: badge.pending,
      newest: newestOf(badge.newest),
      agents: await agentCount(ctx.db, ctx.companyId),
      allPaused: await agentsBlockedFor(ctx.db, ctx.companyId),
      canPauseAll: await canPauseAll(ctx),
    };
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent-requests/count/route');
  }
}
