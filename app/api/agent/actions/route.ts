/**
 * POST /api/agent/actions — the one route through which an agent changes the books
 * (AGENT_ACCESS.md). Two kinds of body:
 *
 *  - `{ verb, ...args }`: the generic verbs (find_operations, run_operation, ask_for_permission,
 *    files …; AgentVerbs in lib/agent/contract.ts), handled by the agent's door
 *    (lib/agent/operate.ts): every operation of the registry, under the agent's policy, grants
 *    and permission requests. The door checks each verb's arguments itself.
 *  - `{ action, input, dryRun?, requestId?, reason? }`: the curated actions of lib/agent/catalog.ts,
 *    run by lib/agent/actions.ts. Most are sent through the agent's door as run_operation sends
 *    them, as the operation of their route, so the agent's policy, grants and permission requests
 *    decide them exactly as they decide run_operation; the few that run themselves are decided by
 *    the same policy for their route's operation. The answer is put in the action's own words.
 *    `dryRun` runs it and rolls it back.
 *
 * Either way a change that is kept needs a request id; the same id asked again returns the first
 * answer. An agent never calls the app's own save routes directly.
 *
 * Too much at once (plan §11.3): when the door says the agent sent too many calls in the last
 * minute, or has too many operations under way, it throws its AgentRateLimited, and the answer is
 * 429 with code RATE_LIMITED and a Retry-After header in seconds (as the long poll of GET
 * /api/agent/requests/[id] answers), so the connector waits instead of reading it as a refusal of
 * the work. That holds for a `{ verb }` body and for a curated action alike, as long as the action
 * reaches the door through handleVerb (or throws AgentRateLimited itself) and not through the bare
 * `operate`, whose answer can only say the wait in words (a 200 'refused' with it in the note).
 *
 * Mapped 'member' in the route map: the real permission is the operation's or action's own route,
 * checked by the door or the runner. People do not use this route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runAgentAction } from '@/lib/agent/actions';
import { agentRetryAfter, handleVerb, isAgentVerb, unknownVerb } from '@/lib/agent/operate';
import '@/lib/agent/catalog';
import { ServiceError } from '@/lib/services/_base';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** The door's "slow down" as 429 with Retry-After; null for any other error. */
function slowDown(err: unknown): NextResponse | null {
  const seconds = agentRetryAfter(err);
  if (seconds === null || !(err instanceof ServiceError)) return null;
  return NextResponse.json(
    { error: err.message, code: 'RATE_LIMITED', details: { retryAfterSeconds: seconds } },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(seconds) } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (!ctx.agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
    const body = await requireJsonObject(req);
    if (typeof body.verb === 'string') {
      const { verb, ...args } = body;
      if (!isAgentVerb(verb)) throw unknownVerb(verb);
      return NextResponse.json(await handleVerb(ctx, verb, args), { headers: NO_STORE });
    }
    return NextResponse.json(await runAgentAction(ctx, body), { headers: NO_STORE });
  } catch (err) {
    return slowDown(err) ?? routeError(err, 'agent/actions/route');
  }
}
