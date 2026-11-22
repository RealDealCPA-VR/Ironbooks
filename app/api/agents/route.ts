/**
 * GET  /api/agents — the Agents tab's list (plan 7.1; contract section 11): { agents, allPaused,
 *                    hostOnly, unattendedPossible }. Each agent carries its name, roles, preset,
 *                    how many of its settings were changed from the preset (overrideCount) and its
 *                    last use. allPaused: Integrated Applications is switched off, so every agent is
 *                    paused whatever its own state. hostOnly: this window is not the host computer's
 *                    own, so it cannot make, change or remove agents (pausing still works).
 *                    unattendedPossible: "may work while nobody is signed in" can do something in
 *                    this company file.
 * POST /api/agents — make an agent: { name, roleKeys[], preset?, unattended? }. Answers the access
 *                    token ONCE, with the settings a connector needs on this computer. The preset
 *                    (plan 4.2) is what the agent may do without asking; left out it is "Ask for
 *                    every change" (D2). The older form with `mode` still works.
 *
 * Who may: the list is for anyone who may view Users & Roles > Users (the service checks, before
 * anything else is read). Making an agent is for an Admin (the service checks), and only at the
 * computer that holds the company file: like the other settings of that kind (lib/net/hostOnly.ts),
 * it decides what may reach the books from outside the app's own window.
 *
 * What the list holds is picked here, field by field (listedAgent below), not passed through from the
 * service: someone who may only view gets this list, so a field added to AgentView later reaches
 * them only once it is added here on purpose. Never a token or its digest, and never the
 * connector's settings (paths of the host computer): the Admin who makes an agent gets those once,
 * with its token, in the answer to POST. An agent never lists or makes agents (plan 4.6,
 * app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { agentsBlockedFor, createAgent, listAgents, type AgentView } from '@/lib/services/agents';
import { agentConnection, forUnattended } from '@/lib/agent/connection';
import { hostOnlyResponse, isRemoteRequest, HOST_ONLY_ACTION_MESSAGE } from '@/lib/net/hostOnly';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAgentSchema } from '@/lib/validation/agents';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { isMarkedProtected } from '@/lib/services/fileProtection';
import { NO_STORE, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

/**
 * One agent as the list gives it: the AgentView of contract section 11, overrideCount included.
 * Every field is named here so that nothing new on AgentView slips into the list unseen. The tab
 * itself reads all of them but roleKeys and revokedAt, which the contract names and which hold
 * nothing a viewer of Users & Roles > Users does not already see (role keys, the time it was removed).
 */
type ListedAgent = Pick<
  AgentView,
  | 'id'
  | 'name'
  | 'roleKeys'
  | 'roleNames'
  | 'preset'
  | 'mode'
  | 'pausedAt'
  | 'tokenPrefix'
  | 'createdAt'
  | 'createdByName'
  | 'lastUsedAt'
  | 'revokedAt'
  | 'status'
  | 'unattended'
  | 'overrideCount'
>;

function listedAgent(a: AgentView): ListedAgent {
  return {
    id: a.id,
    name: a.name,
    roleKeys: a.roleKeys,
    roleNames: a.roleNames,
    preset: a.preset,
    mode: a.mode,
    pausedAt: a.pausedAt,
    tokenPrefix: a.tokenPrefix,
    createdAt: a.createdAt,
    createdByName: a.createdByName,
    lastUsedAt: a.lastUsedAt,
    revokedAt: a.revokedAt,
    status: a.status,
    unattended: a.unattended,
    overrideCount: a.overrideCount,
  };
}

/** GET /api/agents (lib/agent/contract.ts section 11, with what the tab needs to offer New agent). */
interface AgentsListAnswer {
  agents: ListedAgent[];
  allPaused: boolean;
  hostOnly: boolean;
  unattendedPossible: boolean;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    // First: the service refuses anyone who may not view Users & Roles > Users before anything
    // else here is read.
    const agents = await listAgents(ctx);
    // A company file with passwords is opened only by a person's sign-in, so "may work while
    // nobody is signed in" can do nothing for it. The tab says so instead of offering it.
    const unattendedPossible = !isMarkedProtected() && !(await getFileLockStatus(ctx.db)).enabled;
    const answer: AgentsListAnswer = {
      agents: agents.map(listedAgent),
      allPaused: await agentsBlockedFor(ctx.db, ctx.companyId),
      hostOnly: isRemoteRequest(req),
      unattendedPossible,
    };
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/route');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const parsed = createAgentSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    // The service stores the preset with the agent, in the same step (a mode that does not go
    // with the preset is refused there), so no agent ever exists with other permissions.
    const { agent, token } = await createAgent(ctx, parsed.data);
    const connection = agent.unattended ? forUnattended(agentConnection()) : agentConnection();
    return NextResponse.json({ agent, token, connection }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/route');
  }
}
