/**
 * Agent full access: who may use the routes of lib/agent/contract.ts section 11 (plan 4.5, 4.6, 11.1).
 *
 *  - The PERSON routes (/api/agent-requests/**, /api/agent-grants/**, /api/agents/**) answer
 *    agents' requests and manage agents. An agent can never use them, with or without approval:
 *    an approval only ever comes from a signed-in person's window, and an agent never changes
 *    agents, policies, standing permissions or requests. Every handler calls refuseAgent first,
 *    right after getting its context, before it reads anything else. The ones that change
 *    something also need a person's window (refuseOutsideWindow) or the host's own (host-only).
 *  - The AGENT routes (/api/agent/requests/**) are an agent reading its own requests. A person
 *    sees requests on the Agent requests page instead (agentOnly).
 *
 * The route map (lib/permissions/routes.ts) and the registry (hard floor, classes/admin.ts) already
 * keep agents away from the person routes; this is the last check, in the handler itself.
 */
import { NextResponse } from 'next/server';
import { inServiceScope } from '@/lib/context';
import { hasAuthorization } from '@/lib/net/agentToken';
import { isRemoteRequest } from '@/lib/net/hostOnly';
import { UNVERIFIED_LOCAL_ADDR, originFromHeaders } from '@/lib/net/requestInfo';
import type { ServiceContext } from '@/lib/services/_base';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const PERSON_ONLY_MESSAGE =
  'Only a person signed in to Ironbooks can do this. An agent cannot approve or deny requests, or change agents, their permissions or standing permissions. Ask a person to do it in Ironbooks.';

export const WINDOW_ONLY_MESSAGE =
  'This can only be done in the Ironbooks window, on this computer or on a teammate\'s computer connected to it. Open Ironbooks and do it there.';

export const AGENT_ONLY_MESSAGE =
  'This is where an agent reads its own requests. To see what agents asked for, open Agent requests in Ironbooks.';

type HeaderSource = { headers: { get(name: string): string | null } };

/**
 * The 403 answer when the caller is not a person in their own window: a context with an agent,
 * a run inside an agent's service scope (the route bridge), or a request carrying an
 * Authorization header (only agents send one; lib/net/agentToken.ts). Null for a person.
 */
export function refuseAgent(ctx: ServiceContext, req: HeaderSource): NextResponse | null {
  if (!ctx.agent && !inServiceScope() && !hasAuthorization(req.headers)) return null;
  return NextResponse.json({ error: PERSON_ONLY_MESSAGE, code: 'FORBIDDEN', details: { personOnly: true } }, { status: 403, headers: NO_STORE });
}

/**
 * The 403 answer when the caller of an agent route is not an agent: the handler gives it whenever
 * its context has no `agent`.
 */
export function agentOnly(): NextResponse {
  return NextResponse.json({ error: AGENT_ONLY_MESSAGE, code: 'FORBIDDEN', details: { agentOnly: true } }, { status: 403, headers: NO_STORE });
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
 * Whether the request comes from the Ironbooks window on the host computer, by the same test the
 * host-only settings use (lib/net/hostOnly.ts). An approval of a host-only operation needs it.
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
