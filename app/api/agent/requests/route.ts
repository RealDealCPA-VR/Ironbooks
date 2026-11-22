/**
 * GET /api/agent/requests?status=&limit= — for the agent itself (its token; reads only): its own
 * permission requests, with each one's status, the person's note and, once run, the answer
 * (masked, secrets redacted; an approved reveal stays readable for the time the service allows).
 * Answers { requests: AgentRequestView[] }.
 *
 * Only an agent's context gets here; a person sees requests on the Agent requests page
 * (app/api/agent-requests/_guards.ts): a request with no agent token is answered before its
 * session is read. Only ever the agent's OWN requests: the service looks them up for the agent of
 * the context, and anything else that came back is dropped here as well.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listRequestsForAgent } from '@/lib/services/agentRequests';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentRequestListQuerySchema } from '@/lib/validation/agentAccess';
import { AGENT_UNEXPECTED_MESSAGE, NO_STORE, agentOnly, refuseNonAgentRequest, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const early = refuseNonAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const agentId = ctx.agent?.id;
    if (!agentId) return agentOnly();
    const query = agentRequestListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const requests = (await listRequestsForAgent(ctx, query.data)).filter((r) => r.agentId === agentId);
    return NextResponse.json({ requests }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent/requests/route', AGENT_UNEXPECTED_MESSAGE);
  }
}
