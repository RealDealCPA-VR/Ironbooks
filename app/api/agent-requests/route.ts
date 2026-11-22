/**
 * GET /api/agent-requests?status=&agentId=&limit= — the approval center's list (plan 7.2): what
 * agents asked people to approve, with whether THIS person may approve each one and, if not, why.
 * `status` is a request status or "all" (pending when left out, the service decides).
 *
 * Whether the window is the host computer's own is passed on (atHost, the same test an approval
 * uses), so a teammate's window shows a host-only request as one it cannot approve there, with
 * why, instead of offering a yes the approval would then refuse.
 *
 * A person's window only: an agent never sees or answers requests here (app/api/agent-requests/_guards.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listRequestsForPerson } from '@/lib/services/agentRequests';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { personRequestListQuerySchema } from '@/lib/validation/agentAccess';
import { NO_STORE, atHostWindow, refuseAgent } from '@/app/api/agent-requests/_guards';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const refused = refuseAgent(ctx, req);
    if (refused) return refused;
    const query = personRequestListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) return NextResponse.json(zodErrorBody(query.error), { status: 400, headers: NO_STORE });
    const requests = await listRequestsForPerson(ctx, { ...query.data, atHost: atHostWindow(req) });
    return NextResponse.json({ requests }, { headers: NO_STORE });
  } catch (err) {
    return routeError(err, 'agent-requests/route');
  }
}
