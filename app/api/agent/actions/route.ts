/**
 * POST /api/agent/actions — the one route through which an agent changes the books
 * (AGENT_ACCESS.md). Two kinds of body:
 *
 *  - `{ verb, ...args }`: the generic verbs (find_operations, run_operation, ask_for_permission,
 *    files …; AgentVerbs in lib/agent/contract.ts), handled by the agent's door
 *    (lib/agent/operate.ts): every operation of the registry, under the agent's policy, grants
 *    and permission requests. The door checks each verb's arguments itself.
 *  - `{ action, input, dryRun?, requestId? }`: the curated actions of lib/agent/catalog.ts, run by
 *    lib/agent/actions.ts as before: the permission of the route a person would use for the same
 *    thing, then, by the agent's mode: refuses (Read only), checks and queues it for a person
 *    (Propose), or enters it (Post). `dryRun` runs it and rolls it back.
 *
 * Either way a change that is kept needs a request id; the same id asked again returns the first
 * answer. An agent never calls the app's own save routes directly.
 *
 * Mapped 'member' in the route map: the real permission is the operation's or action's own route,
 * checked by the door or the runner. People do not use this route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runAgentAction } from '@/lib/agent/actions';
import { handleVerb, isAgentVerb, unknownVerb } from '@/lib/agent/operate';
import '@/lib/agent/catalog';
import { ServiceError } from '@/lib/services/_base';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (!ctx.agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
    const body = await requireJsonObject(req);
    if (typeof body.verb === 'string') {
      const { verb, ...args } = body;
      if (!isAgentVerb(verb)) throw unknownVerb(verb);
      return NextResponse.json(await handleVerb(ctx, verb, args), { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(await runAgentAction(ctx, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return routeError(err, 'agent/actions/route');
  }
}
