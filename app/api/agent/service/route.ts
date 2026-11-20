/**
 * /api/agent/service — the desktop shell's own calls when it was started for an agent with no
 * window showing (`--agent-service`, electron/agentService.js; AGENT_ACCESS.md).
 *
 * POST: "I opened the company file for agents. May any of them work with nobody signed in?" The
 *       answer is yes only when the file is open (not one protected with passwords, which only a
 *       person's sign-in opens), has no company-file password, and has an active agent an Admin
 *       allowed to work unattended. Then the agent endpoint is published so a connector can find
 *       the app. Otherwise the shell closes again at once.
 * GET:  when an agent last worked, and whether a person has signed in during this run, so the
 *       shell can close the file after a quiet while.
 *
 * Internal token only (the shell's per-launch token, as for closing the company file): nobody
 * else can ask the app to serve agents unattended, and an agent's own token is no use here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb, resolveDataDir, sealedMode } from '@/lib/db';
import { isInternalRequest } from '@/lib/net/internalToken';
import { noteServerPort, personSignedIn } from '@/lib/agent/endpointFile';
import { lastAgentUse, syncAgentEndpoint, unattendedAgentsReady } from '@/lib/services/agents';
import { isSandboxActive } from '@/lib/services/sandboxState';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

function refuse() {
  return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  if (!isInternalRequest(req)) return refuse();
  try {
    if (sealedMode() !== null) return NextResponse.json({ ok: false, reason: 'protected' }, { headers: NO_STORE });
    if (isSandboxActive()) return NextResponse.json({ ok: false, reason: 'sandbox' }, { headers: NO_STORE });
    const db = await getDb();
    const agents = await unattendedAgentsReady(db);
    if (agents === 0) return NextResponse.json({ ok: false, reason: 'no_agents' }, { headers: NO_STORE });
    noteServerPort(req.headers.get('host') ?? req.nextUrl.host);
    const published = await syncAgentEndpoint(db);
    return NextResponse.json({ ok: published, agents, ...(published ? {} : { reason: 'not_published' }) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: false, reason: 'error' }, { headers: NO_STORE });
  }
}

export async function GET(req: NextRequest) {
  if (!isInternalRequest(req)) return refuse();
  const last = lastAgentUse();
  return NextResponse.json({ lastAgentUse: last ? last.toISOString() : null, personSignedIn: personSignedIn(resolveDataDir()) }, { headers: NO_STORE });
}
