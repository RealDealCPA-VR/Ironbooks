/**
 * POST /api/agent/actions — the one route through which an agent changes the books
 * (AGENT_ACCESS.md). What an agent may do here is set per agent, per kind of work, in Users & Roles
 * > Agents: each kind is allowed, asked about (a person approves it in their own window) or never
 * done (lib/agent/policy.ts). Two kinds of body:
 *
 *  - `{ verb, ...args }`: the generic verbs (find_operations, run_operation, ask_for_permission,
 *    files …; AgentVerbs in lib/agent/contract.ts), handled by the agent's door
 *    (lib/agent/operate.ts): every operation of the registry, under the agent's policy, grants
 *    and permission requests. The door checks each verb's arguments itself.
 *  - `{ action, input, dryRun?, requestId?, reason? }`: the curated actions of lib/agent/catalog.ts,
 *    run by lib/agent/actions.ts. Most are sent through the agent's door as run_operation sends
 *    them, as the operation of their route, so the agent's policy, grants and permission requests
 *    decide them exactly as they decide run_operation; the few that run themselves are decided by
 *    the door's own first look (doorDecision) and counted as the door counts (doorRun). The answer
 *    is put in the action's own words. `dryRun` runs it and rolls it back.
 *
 * Either way a change that is kept needs a request id; the same id asked again returns the first
 * answer. An agent never calls the app's own save routes directly.
 *
 * Too much at once (plan §11.3): when the door says the agent sent too many calls in the last
 * minute, or has too many operations under way, the answer is 429 with code RATE_LIMITED and a
 * Retry-After header in seconds (as the long poll of GET /api/agent/requests/[id] answers), so the
 * connector waits instead of reading it as a refusal of the work. That holds for both kinds of
 * body, whether the door threw its AgentRateLimited or answered a 'refused' that carries
 * retryAfterSeconds (the door's `operate`, called directly).
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
const SLOW_DOWN_WORDS = 'Ironbooks is busy with this agent\'s other requests. Wait a little, then send this again.';
/** Longest wait a Retry-After here ever says (the door's own waits are at most a minute). */
const RETRY_AFTER_MAX = 3600;

function tooMany(message: string, seconds: number): NextResponse {
  const wait = Math.min(RETRY_AFTER_MAX, Math.max(1, Math.ceil(seconds)));
  return NextResponse.json(
    { error: message || SLOW_DOWN_WORDS, code: 'RATE_LIMITED', details: { retryAfterSeconds: wait } },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(wait) } },
  );
}

/** The door's "slow down" thrown (AgentRateLimited) as 429 with Retry-After; null for any other error. */
function slowDown(err: unknown): NextResponse | null {
  const seconds = agentRetryAfter(err);
  if (seconds === null || !(err instanceof ServiceError)) return null;
  return tooMany(err.message, seconds);
}

/**
 * The door's "slow down" answered as a refusal (AgentOperationAnswer.retryAfterSeconds, or a
 * curated answer that carries it) as 429 with Retry-After; null for any other answer.
 */
function slowDownAnswer(answer: unknown): NextResponse | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const a = answer as { outcome?: unknown; retryAfterSeconds?: unknown; note?: unknown };
  if (a.outcome !== 'refused' || typeof a.retryAfterSeconds !== 'number') return null;
  if (!Number.isFinite(a.retryAfterSeconds) || a.retryAfterSeconds <= 0) return null;
  return tooMany(typeof a.note === 'string' ? a.note : '', a.retryAfterSeconds);
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (!ctx.agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
    const body = await requireJsonObject(req);
    let answer: unknown;
    if (typeof body.verb === 'string') {
      const { verb, ...args } = body;
      if (!isAgentVerb(verb)) throw unknownVerb(verb);
      answer = await handleVerb(ctx, verb, args);
    } else {
      answer = await runAgentAction(ctx, body);
    }
    return slowDownAnswer(answer) ?? NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    return slowDown(err) ?? routeError(err, 'agent/actions/route');
  }
}
