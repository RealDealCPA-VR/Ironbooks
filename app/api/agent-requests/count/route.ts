/**
 * GET /api/agent-requests/count — what the title bar polls (plan 7.1, 7.2): the badge (pending
 * requests this person could approve), the newest of them for the desktop notice, and whether to
 * show "Pause all agents" (AgentRequestCount, lib/agent/contract.ts).
 *
 * Polled every few seconds, so it reads the pending requests ONCE and takes both the badge and the
 * notice from that one list: the service's person listing (it settles expired requests, reads at
 * most a few hundred rows and judges each one this person may see), one company setting, one count
 * of agents, and one check of the person's own access. Taking both from one list also keeps them in
 * step: the badge never counts a request the notice cannot name. The notice carries the request's
 * own summary (built from the operation, never the agent's words).
 *
 * A person's window only (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { agents } from '@/lib/db/schema';
import { listRequestsForPerson } from '@/lib/services/agentRequests';
import { agentsBlockedFor } from '@/lib/services/agents';
import { mayPauseAllAgents } from '@/lib/services/agentPolicies';
import type { ServiceContext } from '@/lib/services/_base';
import type { AgentRequestCount } from '@/lib/agent/contract';
import { routeError } from '@/lib/routeErrors';
import { NO_STORE, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

/**
 * How many pending requests the badge looks through: the service's own upper bound for one listing,
 * and what pendingCountForPerson counts among. Nobody has this many waiting in practice.
 */
const BADGE_SCAN = 500;

type Approvable = Awaited<ReturnType<typeof listRequestsForPerson>>[number];

/**
 * Agents of this company that are not removed (paused ones count: the button can resume them).
 * Written here because lib/services/agents.ts has no count yet and its list is for an Admin only;
 * an agentCount(db, companyId) there is asked for in the unit's handoff, and this goes when it lands.
 */
async function activeAgentCount(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.companyId, ctx.companyId), isNull(agents.revokedAt)));
  return Number(row?.n ?? 0);
}

/**
 * The pending requests this person could approve, newest first. Nothing for a context without a
 * signed-in person, as pendingCountForPerson answers 0 there (the agent cases are refused before).
 */
async function approvablePending(ctx: ServiceContext): Promise<Approvable[]> {
  if (!ctx.userId) return [];
  const listed = await listRequestsForPerson(ctx, { status: 'pending', limit: BADGE_SCAN });
  return listed
    .filter((r) => r.status === 'pending' && r.canApprove)
    // The service lists newest first already; sorting again costs nothing and does not rely on it.
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const approvable = await approvablePending(ctx);
    const newest = approvable[0];
    const answer: AgentRequestCount = {
      pending: approvable.length,
      newest: newest ? { id: newest.id, agentName: newest.agentName, summary: newest.summary, createdAt: newest.createdAt } : null,
      agents: await activeAgentCount(ctx),
      allPaused: await agentsBlockedFor(ctx.db, ctx.companyId),
      // The same check "Pause all agents" itself makes (lib/services/agentPolicies.ts), so the
      // button shows exactly when the route would accept it.
      canPauseAll: await mayPauseAllAgents(ctx),
    };
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent-requests/count/route');
  }
}
