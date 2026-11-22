/**
 * Agent full access: who may use the routes of lib/agent/contract.ts section 11 (plan 4.5, 4.6, 11.1).
 *
 *  - The PERSON routes (/api/agent-requests/**, /api/agent-grants/**, /api/agents/**) answer
 *    agents' requests and manage agents. An agent can never use them, with or without approval:
 *    an approval only ever comes from a signed-in person's window, and an agent never changes
 *    agents, policies, standing permissions or requests. Every handler starts with
 *    refuseAgentRequest, before it makes its context: a request carrying an agent's token (or a run
 *    inside an agent's service scope) is refused before anything is read, the token included. Right
 *    after getting its context it calls refuseAgent as well, for a context that has an agent some
 *    other way. The ones that change something also need a person's window (refuseOutsideWindow)
 *    or the host's own (agentsHostOnly).
 *  - The AGENT routes (/api/agent/requests/**) are an agent reading its own requests. A person
 *    sees requests on the Agent requests page instead: refuseNonAgentRequest before the context,
 *    agentOnly once it is made.
 *  - Every handler answers its errors through routeErrorPlain: the services' own words, and plain
 *    words instead of "Internal server error" for anything unexpected.
 *
 * The route map (lib/permissions/routes.ts) and the registry (hard floor, classes/admin.ts) already
 * keep agents away from the person routes; this is the last check, in the handler itself.
 * test/agentRequestsApi.test.ts reads every route file under these folders and fails when a handler
 * does not start this way.
 */
import { NextResponse } from 'next/server';
import { inServiceScope } from '@/lib/context';
import { translatePgError } from '@/lib/db/pgErrors';
import { hasAuthorization } from '@/lib/net/agentToken';
import { isRemoteRequest } from '@/lib/net/hostOnly';
import { UNVERIFIED_LOCAL_ADDR, originFromHeaders } from '@/lib/net/requestInfo';
import { routeError } from '@/lib/routeErrors';
import type { ServiceContext } from '@/lib/services/_base';
import { ServiceError } from '@/lib/services/errors';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const PERSON_ONLY_MESSAGE =
  'Only a person signed in to Ironbooks can do this. An agent cannot approve or deny requests, or change agents, their permissions or standing permissions. Ask a person to do it in Ironbooks.';

export const WINDOW_ONLY_MESSAGE =
  'This can only be done in the Ironbooks window, on this computer or on a teammate\'s computer connected to it. Open Ironbooks and do it there.';

export const AGENT_ONLY_MESSAGE =
  'This is where an agent reads its own requests. To see what agents asked for, open Agent requests in Ironbooks.';

/** For a teammate's window: where to go instead, and what still works from there. */
export const AGENTS_HOST_ONLY_MESSAGE =
  'Agents are made, changed and removed only on the computer that holds the company file. Do it there, in Users & Roles > Agents. Pausing an agent works from here.';

/**
 * For another program on the host computer itself: it is already on the right computer, but not in
 * the Ironbooks window, and pausing is refused to it as well (refuseOutsideWindow).
 */
export const AGENTS_WINDOW_ONLY_MESSAGE =
  'Agents are made, changed and removed only in the Ironbooks window on the computer that holds the company file. Open Ironbooks on this computer and do it there, in Users & Roles > Agents.';

/** Something unexpected went wrong in a person's window. Whether the work was done is on the page. */
export const UNEXPECTED_MESSAGE = 'Ironbooks could not finish this. Reload the page to see where things stand, then try again.';

/** Something unexpected went wrong while an agent read its requests. Reading never changes anything. */
export const AGENT_UNEXPECTED_MESSAGE = 'Ironbooks could not answer just now. Read the request again in a moment.';

type HeaderSource = { headers: { get(name: string): string | null } };

function personOnly(): NextResponse {
  return NextResponse.json({ error: PERSON_ONLY_MESSAGE, code: 'FORBIDDEN', details: { personOnly: true } }, { status: 403, headers: NO_STORE });
}

/**
 * The 403 answer, before the handler makes its context, when the request is an agent's: it carries
 * an Authorization header (only agents send one; lib/net/agentToken.ts, lib/context.ts) or it runs
 * inside an agent's service scope (the route bridge). Called first in every person handler, so such
 * a request is refused before anything is read: getServerContext would otherwise check the agent's
 * token, read its settings and note it as used. Null for a person's window, which never sends one.
 */
export function refuseAgentRequest(req: HeaderSource): NextResponse | null {
  if (!inServiceScope() && !hasAuthorization(req.headers)) return null;
  return personOnly();
}

/**
 * The 403 answer when the caller is an agent, not a person: a context with an agent, a run inside
 * an agent's service scope (the route bridge), or a request carrying an Authorization header.
 * Called right after the context is made (refuseAgentRequest came first), so a context that has an
 * agent however it got one is refused too. Null for a person, from any window or program; a change
 * also needs the window (refuseOutsideWindow, agentsHostOnly).
 */
export function refuseAgent(ctx: ServiceContext, req: HeaderSource): NextResponse | null {
  if (!ctx.agent && !inServiceScope() && !hasAuthorization(req.headers)) return null;
  return personOnly();
}

/**
 * The 403 answer when the caller of an agent route is not an agent: the handler gives it whenever
 * its context has no `agent`.
 */
export function agentOnly(): NextResponse {
  return NextResponse.json({ error: AGENT_ONLY_MESSAGE, code: 'FORBIDDEN', details: { agentOnly: true } }, { status: 403, headers: NO_STORE });
}

/**
 * The same 403, before an agent route makes its context: an agent's request carries its token, or
 * runs inside its service scope (the route bridge). Anything else is a person or another program,
 * and is answered without reading its session. Null for what may be an agent; the handler still
 * checks the context it then gets (agentOnly).
 */
export function refuseNonAgentRequest(req: HeaderSource): NextResponse | null {
  if (inServiceScope() || hasAuthorization(req.headers)) return null;
  return agentOnly();
}

/** Most long polls (GET /api/agent/requests/[id]?wait=) one agent may hold open at the same time. */
export const WAITS_PER_AGENT = 4;

/** Seconds the 429 for one wait too many asks the agent to hold off before it tries again. */
const WAIT_BUSY_RETRY_SECONDS = 5;

export const TOO_MANY_WAITS_MESSAGE =
  `You are already waiting on ${WAITS_PER_AGENT} requests at once. Wait for one of those answers to come back before you wait on another, or read this request now without waiting.`;

/**
 * Long polls open per agent id (plan 11.3: a rate limit per agent). Kept on globalThis so a reload
 * of this module in development does not lose count of the waits still running.
 */
const waitState = globalThis as typeof globalThis & { __ironbooksAgentWaits?: Map<string, number> };
const openWaits: Map<string, number> = (waitState.__ironbooksAgentWaits ??= new Map());

/** The 429 answer when the agent already holds WAITS_PER_AGENT long polls open. */
export function tooManyWaits(): NextResponse {
  return NextResponse.json(
    { error: TOO_MANY_WAITS_MESSAGE, code: 'RATE_LIMITED', details: { waitsAtOnce: WAITS_PER_AGENT } },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(WAIT_BUSY_RETRY_SECONDS) } },
  );
}

/**
 * Runs one long poll for the agent, or answers null at once when it already holds the most it may.
 * The slot is given back however the wait ends, an error included.
 */
export async function withWaitSlot<T>(agentId: string, run: () => Promise<T>): Promise<T | null> {
  const open = openWaits.get(agentId) ?? 0;
  if (open >= WAITS_PER_AGENT) return null;
  openWaits.set(agentId, open + 1);
  try {
    return await run();
  } finally {
    const left = (openWaits.get(agentId) ?? 1) - 1;
    if (left > 0) openWaits.set(agentId, left);
    else openWaits.delete(agentId);
  }
}

/**
 * The 403 answer for a change (an approval, a denial, taking back standing permission, pausing)
 * that does not come from a person's window: the Ironbooks window on the host computer (it carries
 * the launch pass, lib/net/launchPass.ts) or a teammate's, through the multi-user proxy. Any other
 * program on this computer is neither, even with a person's sign-in cookie in hand: an agent
 * running on this computer must not be able to answer its own requests that way (plan 4.5).
 * Null for a person's window. Looking stays open, as it does for GET /api/agents.
 */
export function refuseOutsideWindow(req: HeaderSource): NextResponse | null {
  const origin = originFromHeaders(req.headers);
  if (!origin.remote || origin.addr !== UNVERIFIED_LOCAL_ADDR) return null;
  return NextResponse.json({ error: WINDOW_ONLY_MESSAGE, code: 'FORBIDDEN', details: { windowOnly: true } }, { status: 403, headers: NO_STORE });
}

/**
 * Making, changing or removing an agent: only the Ironbooks window on the host computer, by the
 * test the host-only settings use (lib/net/hostOnly.ts). A teammate's window and any other program
 * on this computer get the 403 with details { hostOnly: true } (contract section 11), each in its
 * own words: a teammate is told to go to the host computer and that pausing works where it is; a
 * program on the host computer, which is already there and may not pause either, is told to open
 * the Ironbooks window. Null at the host.
 */
export function agentsHostOnly(req: HeaderSource): NextResponse | null {
  if (!isRemoteRequest(req)) return null;
  const onThisComputer = originFromHeaders(req.headers).addr === UNVERIFIED_LOCAL_ADDR;
  const error = onThisComputer ? AGENTS_WINDOW_ONLY_MESSAGE : AGENTS_HOST_ONLY_MESSAGE;
  return NextResponse.json({ error, code: 'FORBIDDEN', details: { hostOnly: true } }, { status: 403, headers: NO_STORE });
}

/**
 * Whether the request comes from the Ironbooks window on the host computer, by the same test the
 * host-only settings use (lib/net/hostOnly.ts). An approval of a host-only operation needs it. The
 * only source of `atHost` in these routes: never the query, never the body.
 */
export function atHostWindow(req: HeaderSource): boolean {
  return !isRemoteRequest(req);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A 404 for a path id that cannot name a record (not an id at all). Null when it can. */
export function badId(id: string, what: string): NextResponse | null {
  if (typeof id === 'string' && UUID_RE.test(id)) return null;
  return NextResponse.json({ error: `${what} was not found. Check the link and try again.`, code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
}

/**
 * The answer for an error a handler caught: routeError (lib/routeErrors.ts) for the service's own
 * refusal as it is (FORBIDDEN stays 403), and for anything unexpected `unexpected` in plain words
 * instead of "Internal server error" (the details stay in the server's log). Never stored by the
 * browser. Its name keeps "routeError": lib/permissions/routes.test.ts reads each route file for a
 * helper that answers FORBIDDEN with 403.
 */
export function routeErrorPlain(err: unknown, tag: string, unexpected: string = UNEXPECTED_MESSAGE): NextResponse {
  const res = routeError(err, tag);
  if (res.status >= 500 && !(translatePgError(err) instanceof ServiceError)) {
    return NextResponse.json({ error: unexpected, code: 'INTERNAL' }, { status: res.status, headers: NO_STORE });
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
