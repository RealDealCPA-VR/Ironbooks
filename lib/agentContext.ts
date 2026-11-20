/**
 * The context of a request made by an agent (AGENT_ACCESS.md).
 *
 * `getServerContext` (lib/context.ts) hands every request that carries an Authorization header to
 * this module and returns what it returns. Such a request never reaches the cookie session, the
 * company cookie or the first-run fallback, whatever else it carries: it is an agent, held to the
 * rules below, or it is refused.
 *
 * An agent request is never the app window. lib/net/requestInfo.ts classes any request with an
 * Authorization header as "this computer, outside Ironbooks" (remote-level trust), so every rule
 * for remote callers and every host-only setting (lib/net/hostOnly.ts) applies to it already. This
 * module adds the agent's own, tighter rules, in this order:
 *
 *  1. It must be a program on the computer that holds the company file: not through the
 *     multi-user proxy, not from a web page.
 *  2. The route must be on the agent list and the method a read (lib/permissions/agentAccess.ts),
 *     judged on the path and method middleware stamped. No stamp, no access.
 *  3. A person must have signed in to this company file during this run of the app, and the file
 *     must not be a practice copy. This is what makes the file password, a file protected with
 *     passwords and a plain file behave the same for agents: the books are open because a person
 *     opened them.
 *  4. The token must belong to an agent that still has access.
 *  5. The agent's company must be usable (not archived) and applications must be allowed
 *     (Preferences > Integrated Applications).
 *  6. Single-user mode keeps agents out, like everyone but its holder.
 *  7. The agent's access is its roles' access with the agent limits, checked against the same
 *     route map as a person's, then the feature and Accountant's Copy gates.
 *
 * The context it returns can only read: a read-only database handle (lib/db/readOnly.ts), the
 * view-only role, no user id, no closing-date override. It always carries both `role` and
 * `access`; their absence means "trusted" elsewhere.
 */
import { eq } from 'drizzle-orm';
import { getDb, resolveDataDir, sealedMode } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import { companies } from '@/lib/db/schema';
import { isArchivedSettings } from '@/lib/auth';
import { bearerAgentToken } from '@/lib/net/agentToken';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { agentMayWrite, agentRouteAllowed } from '@/lib/permissions/agentAccess';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { enforceFeatureGate } from '@/lib/featureGate';
import { enforceAccountantCopyGate } from '@/lib/services/accountantCopy/routeGate';
import { personSignedIn } from '@/lib/agent/endpointFile';
import { AGENTS_BLOCKED_MESSAGE, agentAccess, findAgentByToken, touchAgent } from '@/lib/services/agents';
import { assertSessionAllowed } from '@/lib/services/sessions';
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

function refuse(message: string, details?: Record<string, unknown>): never {
  throw new ServiceError('FORBIDDEN', message, { agent: true, ...details });
}

/** Build the context for an agent request, or throw FORBIDDEN. */
export async function getAgentContext(h: HeaderSource): Promise<ServiceContext> {
  const token = bearerAgentToken(h);
  if (!token) refuse(AGENT_AUTH_MESSAGE);

  // (1) A program on this computer only.
  if (h.get('x-bka-remote-addr') || h.get('sec-bka-proxy')) refuse(AGENT_HOST_ONLY_MESSAGE);
  if (h.get('sec-fetch-site') || h.get('origin')) refuse(AGENT_NOT_AVAILABLE_MESSAGE);

  // (2) The route list, on the stamped path and method.
  const path = h.get(ROUTE_PATH_HEADER);
  const method = h.get(ROUTE_METHOD_HEADER);
  if (!path || !method || !agentRouteAllowed(path, method)) refuse(AGENT_NOT_AVAILABLE_MESSAGE);

  // (3) The books are open because a person opened them.
  if (sealedMode() !== null) refuse(AGENT_NOT_READY_MESSAGE, { notReady: true });
  if (isSandboxActive()) refuse(AGENT_SANDBOX_MESSAGE);
  if (!personSignedIn(resolveDataDir())) refuse(AGENT_NOT_READY_MESSAGE, { notReady: true });

  // (4) The agent.
  const db = await getDb();
  const agent = await findAgentByToken(db, token);
  if (!agent) refuse(AGENT_AUTH_MESSAGE);

  // (5) Its company.
  const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, agent.companyId));
  if (!company || isArchivedSettings(company.settings)) refuse(AGENT_AUTH_MESSAGE);
  if ((company.settings as { integratedAppsBlocked?: unknown } | null)?.integratedAppsBlocked === true) {
    refuse(AGENTS_BLOCKED_MESSAGE);
  }

  // (6) Single-user mode: only its holder's session works in the company.
  await assertSessionAllowed(db, undefined, agent.companyId);

  // (7) The same route map as a person with these roles.
  const access = await agentAccess(db, agent);
  authorizeRequest({ path, method: method.toUpperCase() }, access);
  await enforceFeatureGate(db, agent.companyId);
  await enforceAccountantCopyGate(db, agent.companyId);

  await touchAgent(db, agent.id);

  const mayWrite = agentMayWrite(agent.mode);
  return {
    db: mayWrite ? db : readOnlyDb(db),
    companyId: agent.companyId,
    userId: null,
    role: mayWrite ? 'accountant' : 'viewer',
    closingDateOverride: false,
    access,
    agent: { id: agent.id, name: agent.name, mode: agent.mode },
    readOnly: !mayWrite,
  };
}
