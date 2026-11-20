/**
 * The context of a request made by an agent (AGENT_ACCESS.md; the full access plan, 4.6 and 5.3).
 *
 * `getServerContext` (lib/context.ts) hands every request that carries an Authorization header to
 * this module and returns what it returns. Such a request never reaches the cookie session, the
 * company cookie or the first-run fallback, whatever else it carries: it is an agent, held to the
 * rules below, or it is refused. (An agent's operation the route bridge runs in-process never comes
 * here: it runs in a service scope with the context the door built, lib/serviceScope.ts.)
 *
 * An agent request is never the app window. lib/net/requestInfo.ts classes any request with an
 * Authorization header as "this computer, outside Ironbooks" (remote-level trust), so every rule
 * for remote callers and every host-only setting (lib/net/hostOnly.ts) applies to it already. This
 * module adds the agent's own, tighter rules, in this order:
 *
 *  1. It must be a program on the computer that holds the company file: not through the
 *     multi-user proxy, not from a web page.
 *  2. The route must be one an agent's own request may reach (agentRequestAllowed below, the rule
 *     of lib/permissions/agentAccess.ts with the operation registry): POST to the one door for
 *     changes (/api/agent/actions), a GET of the agent's own reads, or a GET the registry classes
 *     as a plain read open to agents. Everything else, a GET that is not a pure read included, goes
 *     through the door, where the policy decides. Judged on the path and method middleware
 *     stamped. No stamp, no access.
 *  3. A person must have signed in to this company file during this run of the app, and the file
 *     must not be a practice copy. This is what makes the file password, a file protected with
 *     passwords and a plain file behave the same for agents: the books are open because a person
 *     opened them. The one exception is an agent an Admin allowed to work unattended: it may work
 *     in a file that is open with nobody signed in, but never in one with a company-file password
 *     or one protected with passwords (those are only ever opened by a person).
 *  4. The token must belong to an agent that still has access and is not paused. A paused agent is
 *     refused everything until a person resumes it under Users & Roles > Agents.
 *  5. The agent's company must be usable (not archived) and applications must be allowed
 *     (Preferences > Integrated Applications).
 *  6. Single-user mode keeps agents out, like everyone but its holder.
 *  7. The agent's access is agentDirectAccess of its roles' access: the agent limits
 *     (clampForAgent), masked (maskedForAgent: no View flags, no closed-period right), without
 *     Users & Roles and File Utilities, and never Admin, because nothing behind a direct request
 *     asks a person. It is checked against the same route map as a person's, then the feature and
 *     Accountant's Copy gates.
 *
 * The context it returns can only read, whatever the agent's preset: a read-only database handle
 * (lib/db/readOnly.ts), the view-only role, no user id, no closing-date override, and that narrow
 * access, so a direct read never shows a full SSN or account number, nor the Users & Roles entries
 * of the audit trail, whatever the role. It always carries both `role` and `access`; their absence
 * means "trusted" elsewhere. Changes only ever happen through the door (POST /api/agent/actions),
 * which builds a context that can write for one approved or allowed run. The door needs the
 * agent's ceiling for the policy (Admin included, D1); it takes it from the policy store
 * (agentCeiling), never from this context's access.
 */
import { eq } from 'drizzle-orm';
import { getDb, resolveDataDir, sealedMode, type DB } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import { agents, companies } from '@/lib/db/schema';
import { isArchivedSettings } from '@/lib/auth';
import { bearerAgentToken } from '@/lib/net/agentToken';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import {
  agentDirectAccess,
  agentHardFloorRoute,
  agentRouteAllowed,
  plainApiPath,
  type AgentRouteOperation,
} from '@/lib/permissions/agentAccess';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { enforceFeatureGate } from '@/lib/featureGate';
import { enforceAccountantCopyGate } from '@/lib/services/accountantCopy/routeGate';
import { personSignedIn } from '@/lib/agent/endpointFile';
import { operationForPath } from '@/lib/agent/operations/registry';
import { DEFAULT_PRESET, isAgentPreset, isPaused } from '@/lib/agent/policy';
import type { AgentPreset } from '@/lib/agent/operations/types';
import { AGENTS_BLOCKED_MESSAGE, agentAccess, findAgentByToken, touchAgent } from '@/lib/services/agents';
import { assertSessionAllowed } from '@/lib/services/sessions';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { isSandboxActive } from '@/lib/services/sandboxState';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';

type HeaderSource = { get(name: string): string | null };

/** No valid agent stands behind the request (the same words as a missing sign-in). */
export const AGENT_AUTH_MESSAGE = 'Authentication required.';
/** Nobody has opened the books in this run of the app yet. */
export const AGENT_NOT_READY_MESSAGE = 'Open the company file in Ironbooks and sign in first.';
export const AGENT_NOT_AVAILABLE_MESSAGE = 'This is not available to agents.';
export const AGENT_HOST_ONLY_MESSAGE = 'An agent works only on the computer that holds the company file.';
export const AGENT_SANDBOX_MESSAGE = 'Agents do not work in a practice copy. Go back to your real books first.';
/** A person paused the agent (one agent, in the Agents tab). */
export const AGENT_PAUSED_MESSAGE =
  'This agent is paused, so it cannot do anything right now. A person can resume it in Ironbooks under Users & Roles > Agents.';

/**
 * An operation open to agents that its own request may not make directly (a change, or a GET that
 * is not a plain read): what to ask for instead, through the door.
 */
export function agentUseDoorMessage(operationId: string): string {
  return (
    `Ask for this through run_operation with operation "${operationId}". ` +
    "Ironbooks then runs it, asks a person to approve it, or refuses it, as this agent's settings say."
  );
}

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new ServiceError('FORBIDDEN', message, { agent: true, ...details });
}

/**
 * The registry's operation for a GET of this concrete path, or null. When the registry cannot
 * answer (two operations under one id) it throws, and agentRouteAllowed refuses the request.
 */
function registryOperation(path: string): AgentRouteOperation | null {
  return operationForPath('GET', path)?.operation ?? null;
}

/**
 * May an agent's own HTTP request with this stamped path and method go on? The rule of
 * lib/permissions/agentAccess.ts (agentRouteAllowed) with the operation registry as its lookup:
 * the door, the agent's own reads, and GETs the registry classes as plain reads open to agents.
 * The registry is a large generated table, so it is looked up here, on the server, and never from
 * agentAccess.ts, which the Agents tab's browser code imports.
 */
export function agentRequestAllowed(path: string | null | undefined, method: string | null | undefined): boolean {
  return agentRouteAllowed(path, method, registryOperation);
}

/**
 * Why a request agentRequestAllowed refused is refused, in words that say what to do next. An
 * operation open to agents is asked for through the door instead (its id is not a secret: the
 * agent finds it with find_operations). Anything else (no such route, a page, HEAD, a person's own
 * account, the hard floor) is simply not available.
 */
function routeRefusal(path: string, method: string): string {
  const m = method.toUpperCase();
  if (m === 'HEAD' || !plainApiPath(path) || agentHardFloorRoute(path)) return AGENT_NOT_AVAILABLE_MESSAGE;
  try {
    const operation = operationForPath(m, path)?.operation;
    if (operation && operation.kind === 'route' && operation.method === m && operation.availability === 'agent') {
      return agentUseDoorMessage(operation.id);
    }
  } catch {
    /* the registry cannot answer: say no more than "not available" */
  }
  return AGENT_NOT_AVAILABLE_MESSAGE;
}

/**
 * The agent's preset and whether it is paused. lib/services/agents.ts findAgentByToken returns
 * both; an older build of it that does not is covered by reading them from the agent's row here.
 * Any pause value that is set counts as paused (isPaused): the switch must never fail open. A
 * preset Ironbooks does not know is read as the default, as the policy engine reads it.
 */
async function presetAndPause(db: DB, agent: { id: string }): Promise<{ preset: AgentPreset; paused: boolean }> {
  const found = agent as { preset?: unknown; pausedAt?: unknown };
  let preset: unknown = found.preset;
  let pausedAt: unknown = found.pausedAt;
  if (!('preset' in found) || !('pausedAt' in found)) {
    const [row] = await db.select({ preset: agents.preset, pausedAt: agents.pausedAt }).from(agents).where(eq(agents.id, agent.id));
    if (!row) refuse(AGENT_AUTH_MESSAGE);
    preset = row.preset;
    pausedAt = row.pausedAt;
  }
  return { preset: isAgentPreset(preset) ? preset : DEFAULT_PRESET, paused: isPaused(pausedAt) };
}

/** Build the context for an agent request, or throw FORBIDDEN. */
export async function getAgentContext(h: HeaderSource): Promise<ServiceContext> {
  const token = bearerAgentToken(h);
  if (!token) refuse(AGENT_AUTH_MESSAGE);

  // (1) A program on this computer only.
  if (h.get('x-bka-remote-addr') || h.get('sec-bka-proxy')) refuse(AGENT_HOST_ONLY_MESSAGE);
  if (h.get('sec-fetch-site') || h.get('origin')) refuse(AGENT_NOT_AVAILABLE_MESSAGE);

  // (2) The route, on the stamped path and method: the door, the agent's own reads, or a plain read.
  const path = h.get(ROUTE_PATH_HEADER);
  const method = h.get(ROUTE_METHOD_HEADER);
  if (!path || !method) refuse(AGENT_NOT_AVAILABLE_MESSAGE);
  if (!agentRequestAllowed(path, method)) refuse(routeRefusal(path, method));

  // (3) The books are open because a person opened them. A file protected with passwords is not
  // open at all until someone signs in, and the database is not touched before that.
  if (sealedMode() !== null) refuse(AGENT_NOT_READY_MESSAGE, { notReady: true });
  if (isSandboxActive()) refuse(AGENT_SANDBOX_MESSAGE);
  const signedIn = personSignedIn(resolveDataDir());

  // (4) The agent: a token that still has access, and not paused.
  const db = await getDb();
  const agent = await findAgentByToken(db, token);
  if (!agent) refuse(signedIn ? AGENT_AUTH_MESSAGE : AGENT_NOT_READY_MESSAGE, signedIn ? undefined : { notReady: true });
  const { preset, paused } = await presetAndPause(db, agent);
  if (paused) refuse(AGENT_PAUSED_MESSAGE, { paused: true });
  // Nobody has signed in during this run: only an agent an Admin allowed to work unattended goes
  // on, and never past a company-file password, which only a person can enter.
  if (!signedIn) {
    if (!agent.unattended || (await getFileLockStatus(db)).enabled) refuse(AGENT_NOT_READY_MESSAGE, { notReady: true });
  }

  // (5) Its company.
  const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, agent.companyId));
  if (!company || isArchivedSettings(company.settings)) refuse(AGENT_AUTH_MESSAGE);
  if ((company.settings as { integratedAppsBlocked?: unknown } | null)?.integratedAppsBlocked === true) {
    refuse(AGENTS_BLOCKED_MESSAGE);
  }

  // (6) Single-user mode: only its holder's session works in the company.
  await assertSessionAllowed(db, undefined, agent.companyId);

  // (7) The same route map as a person with these roles. agentDirectAccess clamps again (cheap, and
  // it changes nothing that was already clamped), masks, leaves out Users & Roles and File
  // Utilities and is never Admin: a direct read never unmasks and never sees as an Admin, whatever
  // the role holds. A reveal, or anything an Admin must approve, is asked for through the door.
  const access = agentDirectAccess(await agentAccess(db, agent));
  authorizeRequest({ path, method: method.toUpperCase() }, access);
  await enforceFeatureGate(db, agent.companyId);
  await enforceAccountantCopyGate(db, agent.companyId);

  await touchAgent(db, agent.id);

  // Always read-only, whatever the preset. A change happens only through the door
  // (POST /api/agent/actions), which builds a context that can write for that one run.
  return {
    db: readOnlyDb(db),
    companyId: agent.companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access,
    agent: { id: agent.id, name: agent.name, mode: agent.mode, preset, onBehalfOf: agent.createdBy },
    readOnly: true,
  };
}
