/**
 * POST /api/agent-requests/batch-approve { ids } — approve several requests of the same operation
 * at once (plan 7.2, 11.2: enter and change requests only, checked by the service). At most
 * BATCH_APPROVE_MAX ids (lib/validation/agentAccess.ts), each id once. Each one is approved and
 * reported on its own. Answers { results: ApproveResult[] }, exactly as the service gave them: one
 * this call did not approve ('not_approved': this call ran nothing for it, request.error says why
 * and request.status where it stands now, usually still waiting) is reported as such, never folded
 * into 'failed' or left out.
 *
 * A person's window only (app/api/agent-requests/_guards.ts); whether it is the host computer's own
 * is passed on, as for a single approval.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { batchApprove } from '@/lib/services/agentRequests';
import { requireJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { batchApproveSchema } from '@/lib/validation/agentAccess';
import { NO_STORE, atHostWindow, refuseAgent, refuseAgentRequest, refuseOutsideWindow, routeErrorPlain } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const early = refuseAgentRequest(req);
    if (early) return early;
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req) ?? refuseOutsideWindow(req);
    if (refused) return refused;
    const parsed = batchApproveSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400, headers: NO_STORE });
    const results = await batchApprove(ctx, parsed.data.ids, { atHost: atHostWindow(req) });
    return NextResponse.json({ results }, { headers: NO_STORE });
  } catch (err) {
    return routeErrorPlain(err, 'agent-requests/batch-approve/route');
  }
}
