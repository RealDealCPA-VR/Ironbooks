/**
 * POST /api/agent-requests/[id]/approve — a person says yes on the approval card (plan 4.5, 7.2).
 * Body: ApproveInput (lib/agent/contract.ts), all optional: the secrets typed on the card (used for
 * this one run, never stored), standing permission ("Approve similar…"), a second yes after the
 * books changed (acceptStale), answers to a desktop flow's questions, a note. Answers ApproveResult.
 *
 * An approval only ever comes from a signed-in person's window (the host's, or a teammate's through
 * the multi-user proxy), never from an agent or another program on this computer
 * (app/api/agent-requests/_guards.ts). Whether the window is the host computer's own is passed on:
 * a host-only operation can be approved only there. The answer can hold secrets the run produced
 * (shown once to this person), so it is never stored by the browser.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { approveAgentRequest } from '@/lib/services/agentRequests';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { approveRequestSchema } from '@/lib/validation/agentAccess';
import { NO_STORE, atHostWindow, badId, refuseAgent, refuseOutsideWindow } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const { id } = await params;
    const bad = badId(id, 'That agent request');
    if (bad) return bad;
    const parsed = approveRequestSchema.safeParse(await requireJsonObject(req, { optional: true }));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    const result = await approveAgentRequest(ctx, id, parsed.data, { atHost: atHostWindow(req) });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent-requests/[id]/approve/route');
  }
}
