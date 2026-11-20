/**
 * GET  /api/agents — the company's agents (AGENT_ACCESS.md): name, roles, preset, last use.
 * POST /api/agents — make an agent: { name, roleKeys[], preset?, unattended? }. Answers the access
 *                    token ONCE, with the settings a connector needs on this computer. The preset
 *                    (plan 4.2) is what the agent may do without asking; left out it is "Ask for
 *                    every change" (D2). The older form with `mode` still works.
 *
 * For an Admin (checked in lib/services/agents.ts; the route map asks for Users & Roles). Making
 * an agent decides what may reach the books from outside the app's own window, so, like the
 * other settings of that kind (lib/net/hostOnly.ts), it is done only on the computer that holds
 * the company file. The list never contains a token or its digest. An agent never lists or makes
 * agents (plan 4.6, app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createAgent, listAgents } from '@/lib/services/agents';
import { agentConnection, forUnattended } from '@/lib/agent/connection';
import { hostOnlyResponse, isRemoteRequest, HOST_ONLY_ACTION_MESSAGE } from '@/lib/net/hostOnly';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAgentSchema } from '@/lib/validation/agents';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { isMarkedProtected } from '@/lib/services/fileProtection';
import { refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const hostOnly = isRemoteRequest(req);
    // A company file with passwords is opened only by a person's sign-in, so "may work while
    // nobody is signed in" can do nothing for it. The tab says so instead of offering it.
    const unattendedPossible = !isMarkedProtected() && !(await getFileLockStatus(ctx.db)).enabled;
    return NextResponse.json(
      // Where the connector lives on this computer is told only at this computer.
      { agents: await listAgents(ctx), hostOnly, connection: hostOnly ? null : agentConnection(), unattendedPossible },
      { headers: NO_STORE },
    );
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
