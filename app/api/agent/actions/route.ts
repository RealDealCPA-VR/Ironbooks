/**
 * POST /api/agent/actions — the one route through which an agent changes the books
 * (AGENT_ACCESS.md). Body: { action, input, dryRun?, requestId? }.
 *
 * An agent never calls the app's own save routes; it names one of the actions in
 * lib/agent/catalog.ts and the runner (lib/agent/actions.ts) applies the permission of the route
 * a person would use for the same thing, then, by the agent's mode: refuses (Read only), checks
 * and queues it for a person (Propose), or enters it (Post). `dryRun` runs it and rolls it back.
 * A change that is kept needs a `requestId`; the same id asked again returns the first answer.
 *
 * Mapped 'member' in the route map: the real permission is the action's own route, checked by
 * the runner. People do not use this route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runAgentAction } from '@/lib/agent/actions';
import '@/lib/agent/catalog';
import { ServiceError } from '@/lib/services/_base';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (!ctx.agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
    const body = await requireJsonObject(req);
    return NextResponse.json(await runAgentAction(ctx, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return routeError(err, 'agent/actions/route');
  }
}
