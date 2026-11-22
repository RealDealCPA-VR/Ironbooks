/**
 * GET /api/agent-requests/[id] — one request for the approval card (plan 7.2): the agent's reason
 * (its own words, labelled so), the summary and preview built from the operation, what the approver
 * would need, and whether THIS person may approve it.
 *
 * Whether the window is the host computer's own is passed on (atHost, the same test an approval
 * uses), so on a teammate's window a host-only request shows as not approvable there, with why.
 *
 * A person's window only (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requestForPerson } from '@/lib/services/agentRequests';
import { routeError } from '@/lib/routeErrors';
import { NO_STORE, atHostWindow, badId, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent request');
    if (bad) return bad;
    return NextResponse.json({ request: await requestForPerson(ctx, id, { atHost: atHostWindow(req) }) }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent-requests/[id]/route');
  }
}
