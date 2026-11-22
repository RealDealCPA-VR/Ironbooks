/**
 * POST /api/agent-requests/[id]/approve — a person says yes on the approval card (plan 4.5, 7.2).
 * Body: ApproveInput (lib/agent/contract.ts), all optional: the secrets typed on the card (used for
 * this one run, never stored), standing permission ("Approve similar…"), a second yes after the
 * books changed (acceptStale), answers to a desktop flow's questions, a note. Answers ApproveResult.
 *
 * A secret box the person left empty is the same as one not sent (approveRequestSchema drops it),
 * so a secret the request marks optional (ApprovalNeeds.optionalSecrets, wave 4) may be left empty.
 * Which ones the run cannot do without is the service's to judge (lib/services/agentRequests.ts
 * checkTypedSecrets): a secret the operation always needs (Operation.needsSecret), and every secret
 * of a desktop flow, is sent back to the card with what to type, and nothing runs. A secret the
 * policy adds for this one request (closing_password for work in a closed period,
 * lib/agent/policy.ts) is sent back to the card the same way, and nothing runs.
 *
 * An approval only ever comes from a signed-in person's window (the host's, or a teammate's through
 * the multi-user proxy), never from an agent or another program on this computer
 * (app/api/agent-requests/_guards.ts). Whether the window is the host computer's own is passed on,
 * from where the request came from (never from the body): a host-only operation can be approved
 * only there. The answer can hold secrets the run produced (shown once to this person), so it is
 * never stored by the browser.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { approveAgentRequest } from '@/lib/services/agentRequests';
import { requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { approveRequestSchema } from '@/lib/validation/agentAccess';
import {
  NO_STORE,
  atHostWindow,
  badId,
  refuseAgent,
  refuseAgentRequest,
  refuseOutsideWindow,
  routeErrorPlain,
} from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
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
    return routeErrorPlain(err, 'agent-requests/[id]/approve/route');
  }
}
