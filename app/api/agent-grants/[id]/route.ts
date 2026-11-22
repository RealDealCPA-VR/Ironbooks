/**
 * DELETE /api/agent-grants/[id] — take back a standing permission (plan 4.4, 7.1 "Live grants with
 * Revoke"). It stops covering the agent's next request at once. Answers { ok: true }.
 *
 * Who may (the service checks): the person who gave it, or anyone who may manage agents in Users &
 * Roles. Taking one back is tightening, so no Admin is needed, and it works from any person's window.
 *
 * A person's window only (app/api/agent-requests/_guards.ts): an agent never changes its own or
 * another agent's standing permissions.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { revokeGrant } from '@/lib/services/agentGrants';
import { NO_STORE, badId, refuseAgent, refuseAgentRequest, refuseOutsideWindow, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That standing permission');
    if (bad) return bad;
    await revokeGrant(ctx, id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent-grants/[id]/route');
  }
}
