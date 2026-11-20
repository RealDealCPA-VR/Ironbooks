/**
 * GET  /api/agents — the company's agents (AGENT_ACCESS.md): name, roles, mode, last use.
 * POST /api/agents — make an agent: { name, roleKeys[], mode }. Answers the access token ONCE,
 *                    with the settings a connector needs on this computer.
 *
 * For an Admin (checked in lib/services/agents.ts; the route map asks for Users & Roles). Making
 * an agent decides what may reach the books from outside the app's own window, so, like the
 * other settings of that kind (lib/net/hostOnly.ts), it is done only on the computer that holds
 * the company file. The list never contains a token or its digest.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createAgent, listAgents } from '@/lib/services/agents';
import { agentConnection } from '@/lib/agent/connection';
import { hostOnlyResponse, isRemoteRequest, HOST_ONLY_ACTION_MESSAGE } from '@/lib/net/hostOnly';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAgentSchema } from '@/lib/validation/agents';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const hostOnly = isRemoteRequest(req);
    return NextResponse.json(
      // Where the connector lives on this computer is told only at this computer.
      { agents: await listAgents(ctx), hostOnly, connection: hostOnly ? null : agentConnection() },
      { headers: NO_STORE },
    );
  } catch (err) {
    return routeError(err, 'agents/route');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const parsed = createAgentSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { agent, token } = await createAgent(ctx, parsed.data);
    return NextResponse.json({ agent, token, connection: agentConnection() }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agents/route');
  }
}
