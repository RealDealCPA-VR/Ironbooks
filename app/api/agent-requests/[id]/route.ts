/**
 * GET /api/agent-requests/[id] — one request for the approval card (plan 7.2): the agent's reason
 * (its own words, labelled so), the summary and preview built from the operation, what the approver
 * would need, and whether THIS person may approve it.
 *
 * Whether the window is the host computer's own is passed on (atHost, the same test an approval
 * uses, taken from where the request came from), so on a teammate's window a host-only request
 * shows as not approvable there, with why.
 *
 * A person only, never an agent (app/api/agent-requests/_guards.ts). Reading stays open to any of
 * a person's windows and sign-ins; answering it (./approve, ./deny) needs the window.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requestForPerson } from '@/lib/services/agentRequests';
import { NO_STORE, atHostWindow, badId, refuseAgent, refuseAgentRequest, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent request');
    if (bad) return bad;
    return NextResponse.json({ request: await requestForPerson(ctx, id, { atHost: atHostWindow(req) }) }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent-requests/[id]/route');
  }
}
