/**
 * GET /api/agent/requests?status=&limit= — for the agent itself (its token; reads only): its own
 * permission requests, with each one's status, the person's note and, once run, the answer
 * (masked, secrets redacted). Answers { requests: AgentRequestView[] }.
 *
 * Only an agent's context gets here; a person sees requests on the Agent requests page
 * (app/api/agent-requests/_guards.ts). Only ever the agent's OWN requests: the service looks them
 * up for the agent of the context, and anything else that came back is dropped here as well.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listRequestsForAgent } from '@/lib/services/agentRequests';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentRequestListQuerySchema } from '@/lib/validation/agentAccess';
import { NO_STORE, agentOnly } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const agentId = ctx.agent?.id;
    if (!agentId) return agentOnly();
    const query = agentRequestListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const requests = (await listRequestsForAgent(ctx, query.data)).filter((r) => r.agentId === agentId);
    return NextResponse.json({ requests }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent/requests/route');
  }
}
