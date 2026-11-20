/**
 * DELETE /api/agents/[id] — take an agent's access away (AGENT_ACCESS.md). Its token stops
 * working with the next request. The agent stays in the list as removed, and what it did stays
 * in the audit trail under its name.
 *
 * For an Admin, on the computer that holds the company file (see app/api/agents/route.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { revokeAgent } from '@/lib/services/agents';
import { hostOnlyResponse, isRemoteRequest, HOST_ONLY_ACTION_MESSAGE } from '@/lib/net/hostOnly';
import { routeError } from '@/lib/routeErrors';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const { id } = await params;
    return NextResponse.json({ agent: await revokeAgent(ctx, id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return routeError(err, 'agents/[id]/route');
  }
}
