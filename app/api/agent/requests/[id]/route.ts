/**
 * GET /api/agent/requests/[id]?wait=<seconds> — for the agent itself (its token; reads only): one
 * of its own permission requests, by id or by the request id the agent sent with it. With `wait`
 * it is a long poll: the answer comes when a person has decided or the seconds are up, whichever
 * is first, and never later than WAIT_MAX_SECONDS (lib/agent/contract.ts) however many are asked
 * for. Answers { request: AgentRequestView }.
 *
 * Only an agent's context gets here; a person sees requests on the Agent requests page
 * (app/api/agent-requests/_guards.ts): a request with no agent token is answered before its
 * session is read. Another agent's request, or one that does not exist, is "not found" alike.
 *
 * The long-poll cap (plan 11.3: a rate limit per agent): one agent holds at most WAITS_PER_AGENT
 * (4) long polls open at once (app/api/agent-requests/_guards.ts). Each one re-reads the company
 * file every few seconds for up to WAIT_MAX_SECONDS, and the company file answers one query at a
 * time, so an agent (or a stolen token) opening dozens would slow the app down for the people
 * using it. One wait more is answered at once with 429, code RATE_LIMITED, and a Retry-After
 * header (5 seconds); nothing waits and nothing is counted for it. A slot is given back however a
 * wait ends, an error included. Reading a request without waiting is never limited here; the
 * hourly cap on new requests is the requests service's (ASKS_PER_HOUR_BEFORE_PAUSE).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext, inServiceScope } from '@/lib/context';
import { requestForAgent, waitForDecision } from '@/lib/services/agentRequests';
import { WAIT_MAX_SECONDS } from '@/lib/agent/contract';
import type { RequestStatus } from '@/lib/agent/operations/types';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentRequestWaitQuerySchema } from '@/lib/validation/agentAccess';
import {
  AGENT_UNEXPECTED_MESSAGE,
  NO_STORE,
  agentOnly,
  refuseNonAgentRequest,
  routeErrorPlain,
  tooManyWaits,
  withWaitSlot,
} from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

/** Decided for good: nothing more to wait for. */
const SETTLED: readonly RequestStatus[] = ['denied', 'expired', 'cancelled', 'failed', 'executed'];

const NOT_FOUND_MESSAGE = 'You have no request with that id. List your requests to see their ids.';

function notFound(): NextResponse {
  return NextResponse.json({ error: NOT_FOUND_MESSAGE, code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const early = refuseNonAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const agentId = ctx.agent?.id;
    if (!agentId) return agentOnly();
    const { id } = await params;
    const query = agentRequestWaitQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const own = await requestForAgent(ctx, id);
    if (!own || own.agentId !== agentId) return notFound();
    // Inside a run of the route bridge (an operation with a time limit of its own) it never waits.
    const wait = inServiceScope() ? 0 : Math.min(query.data.wait ?? 0, WAIT_MAX_SECONDS);
    if (wait <= 0 || SETTLED.includes(own.status)) return NextResponse.json({ request: own }, { headers: NO_STORE });
    const request = await withWaitSlot(agentId, () => waitForDecision(ctx, own.id, wait));
    if (!request) return tooManyWaits();
    if (request.agentId !== agentId) return notFound();
    return NextResponse.json({ request }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent/requests/[id]/route', AGENT_UNEXPECTED_MESSAGE);
  }
}
