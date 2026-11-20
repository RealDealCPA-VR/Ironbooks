/**
 * DELETE /api/agent-grants/[id] — take back a standing permission (plan 4.4, 7.1 "Live grants with
 * Revoke"). It stops covering the agent's next request at once. Answers { ok: true }.
 *
 * A person's window only (app/api/agent-requests/_guards.ts): an agent never changes its own or
 * another agent's standing permissions.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { revokeGrant } from '@/lib/services/agentGrants';
import { routeError } from '@/lib/routeErrors';
import { NO_STORE, badId, refuseAgent, refuseOutsideWindow } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That standing permission');
    if (bad) return bad;
    await revokeGrant(ctx, id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent-grants/[id]/route');
  }
}
