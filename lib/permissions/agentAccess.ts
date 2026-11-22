/**
 * What an agent may reach (AGENT_ACCESS.md; the full access plan, sections 4.6, 5.3 and 5.9).
 *
 * Pure module: no Node, database or registry imports. The Agents tab (a client component) and the
 * validation schemas import the modes from here, so the operation registry (a large generated
 * table) must stay out of it. The route check that needs the registry lives in lib/agentContext.ts,
 * which hands its lookup to `agentRouteAllowed` below. The route map (./routes) is plain data and
 * was imported here before full access too.
 *
 * An agent is given the same roles people have, Admin included (decision D1), and every request it
 * makes is checked against the same route map as a person's (lib/permissions/routes.ts). On top:
 *
 *  1. `clampForAgent`: the agent's ceiling, its roles' access with the agent limits applied. The
 *     policy (lib/agent/policy.ts) decides within it what runs, what asks a person and what is
 *     refused. Only the door (lib/agent/operate.ts, through agentCeiling) works with the ceiling.
 *  2. `maskedForAgent`: what a run with no approved reveal works with. The ceiling with the View
 *     flags and the closed-period right switched off, so a read never shows a full SSN or account
 *     number, whatever the agent's role holds.
 *  3. `agentRouteAllowed`: what an agent's own HTTP request may reach, fail closed. The one door for
 *     changes (POST /api/agent/actions), the agent's own reads, and the GETs the registry classes as
 *     plain reads open to agents. Everything else goes through the door, where the policy decides.
 *  4. `agentDirectAccess`: the access such a request works with. Masked, without Users & Roles and
 *     File Utilities, and never Admin, because nothing there asks a person. Its context can only
 *     read (lib/agentContext.ts). Changes only ever happen through the door.
 */
import type { Operation } from '@/lib/agent/operations/types';
import {
  ADMIN_ROLE_KEY,
  FLAGS,
  withoutAreas,
  type ActivityKey,
  type ActivitySet,
  type Area,
  type EffectiveAccess,
  type Flag,
} from './model';
import { matchRoutePattern } from './routes';
import { AGENT_ACTION_ROUTE, isAgentActionRequest } from '@/lib/net/agentToken';

export const AGENT_MODES = ['read_only', 'propose', 'post'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const AGENT_MODE_LABELS: Record<AgentMode, string> = {
  read_only: 'Read only',
  propose: 'Propose',
  post: 'Post',
};

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v);
}

/** Whether an agent in this mode enters changes itself (Post). */
export function agentMayWrite(mode: AgentMode): boolean {
  return mode === 'post';
}

/** Whether an agent in this mode may ask for changes at all: to post them, or to have them approved. */
export function agentMayPropose(mode: AgentMode): boolean {
  return mode === 'post' || mode === 'propose';
}

/** True when these role keys include the Admin role (an agent may hold it as its ceiling, D1). */
export function includesAdminRole(roleKeys: readonly string[]): boolean {
  return roleKeys.includes(ADMIN_ROLE_KEY);
}

// ---------------------------------------------------------------------------
// The ceiling and the masked access
// ---------------------------------------------------------------------------

function copyActivities(set: ActivitySet): ActivitySet {
  const out = { ...set };
  for (const key of Object.keys(out) as ActivityKey[]) out[key] = Array.isArray(out[key]) ? [...out[key]] : [];
  return out;
}

/** A copy that shares nothing with the original, so no caller can change the roles' own access. */
function copyAccess(access: EffectiveAccess): EffectiveAccess {
  const permissions = { ...access.permissions };
  for (const area of Object.keys(permissions) as Area[]) {
    permissions[area] = Array.isArray(permissions[area]) ? [...permissions[area]] : [];
  }
  const activities = access.activities ? copyActivities(access.activities) : undefined;
  return {
    ...access,
    roleKeys: [...access.roleKeys],
    permissions,
    ...(activities ? { activities } : {}),
    flags: { ...access.flags },
  };
}

/**
 * The agent's ceiling: its roles' access with the agent limits applied. Always a fresh copy, never
 * wider than the roles.
 *
 * What changed with full access, and why:
 *  - Admin is allowed as a ceiling (D1). It decides what the agent could ever be allowed, not what
 *    runs. The operations the registry classes admin, file or secret (adding users, changing
 *    roles, backups, restore, passwords) can never be set to Allow, so an Admin must say yes to
 *    each one.
 *  - Users & Roles and File Utilities are no longer taken away (plan 5.3), so the door can ask an
 *    Admin about their operations. The door asks by the operation's CLASS, not its area, so the
 *    registry classes their reads as plan 4.2 has it: every read of Users & Roles is 'admin', and
 *    every File Utilities read that shows file names, folders or backups, or produces a file, is
 *    'file'; an Admin is asked about each one. Only the pure checks of the books stay 'read' (data
 *    integrity, books in balance, and Clean Up's preview of unused list entries): through the
 *    door they run under the read setting, which is Allow in every preset, for an agent whose role
 *    holds the view right. agentAccess.test.ts pins that list exactly. An agent's own HTTP
 *    request never reaches these areas (AGENT_DOOR_ONLY_AREAS, agentRouteAllowed) and its access
 *    leaves them out (agentDirectAccess).
 *  - The View flags (full SSNs, full account numbers) and the closed-period right are no longer
 *    switched off here. They are what the policy checks before an agent may even ask to reveal
 *    protected data (read_sensitive) or to work in a closed period (period). They never unmask
 *    anything by themselves: a run without an approved reveal uses maskedForAgent.
 *
 * What stays, the hard floor (plan 4.6). It is not kept by taking rights out of the ceiling: the
 * Admin role holds Users & Roles, which is also the right to manage agents. It is kept by the
 * registry (availability 'hard_floor', refused with or without approval), by agentRouteAllowed
 * below (the agent, approval and grant routes are refused outright), by those routes' handlers
 * (they refuse any request from an agent) and by the agent's context (read-only, no user id, no
 * session, no closing-date override, and agentDirectAccess: no Users & Roles, never Admin). Here
 * it means the ceiling is never more than the roles: Admin only with the Admin role itself, never
 * because an access object built some other way says so.
 */
export function clampForAgent(access: EffectiveAccess): EffectiveAccess {
  const copy = copyAccess(access);
  return { ...copy, isAdmin: copy.isAdmin === true && includesAdminRole(copy.roleKeys) };
}

/** Every flag off: the View flags and the closed-period right (and any flag added later). */
function noFlags(): Record<Flag, boolean> {
  const flags = {} as Record<Flag, boolean>;
  for (const f of FLAGS) flags[f.key] = false;
  return flags;
}

/**
 * The same access with the View flags (full SSNs, full account numbers) and the closed-period right
 * switched off (plan 5.9, D6). Every run that has no approved reveal uses this, so an agent's own
 * read never returns a full SSN or account number, whatever its role holds; a reveal is asked for
 * through the door, one call at a time, and a person with the matching flag approves it.
 */
export function maskedForAgent(access: EffectiveAccess): EffectiveAccess {
  return { ...copyAccess(access), flags: noFlags() };
}

/**
 * The access an agent's own HTTP request works with (lib/agentContext.ts): no policy and no person
 * stands behind it, so it is narrower than the ceiling.
 *  - Masked (maskedForAgent): no full SSN or account number, no closed-period right.
 *  - Without Users & Roles and File Utilities (AGENT_DOOR_ONLY_AREAS). Their routes are refused to
 *    such a request anyway; leaving them out here also keeps them out of what other reads show
 *    across areas (the audit trail and the transaction log list the entries of every area the
 *    access may view).
 *  - Never Admin, even with the Admin role (D1 makes Admin a ceiling for the door, where the
 *    policy decides). An Admin's access sees the whole audit trail and passes the checks that
 *    stop at "is an Admin", and the curated actions (lib/agent/actions.ts) build the context they
 *    write with from this access, which would then carry the admin role, outside the policy. The
 *    role keys stay, so the agent is still told which roles it holds (whoami).
 * Always a fresh copy, never wider than the roles.
 */
export function agentDirectAccess(access: EffectiveAccess): EffectiveAccess {
  const masked = maskedForAgent(clampForAgent(access));
  return { ...withoutAreas(masked, AGENT_DOOR_ONLY_AREAS), isAdmin: false };
}

// ---------------------------------------------------------------------------
// What an agent's own HTTP request may reach
// ---------------------------------------------------------------------------

export { AGENT_ACTION_ROUTE, isAgentActionRequest };

/**
 * The agent's own reads, as route patterns of the route map: who it is, and its own permission
 * requests (one of them with a long poll for the answer). Allowed without the registry: they only
 * ever answer about the agent itself. A path counts only when the route map matches it to exactly
 * one of these patterns, so a route added beside them later (say /api/agent/requests/export) is
 * not one of them and needs the registry like any other.
 */
export const AGENT_OWN_ROUTES: readonly string[] = ['/api/agent/whoami', '/api/agent/requests', '/api/agent/requests/[id]'];

/** True for a path the route map matches to one of AGENT_OWN_ROUTES. */
function agentOwnRoute(path: string): boolean {
  const pattern = matchRoutePattern(path);
  return pattern !== null && AGENT_OWN_ROUTES.includes(pattern);
}

/**
 * Routes refused to an agent's own request outright, whatever the registry says: making, changing
 * or pausing agents, their policies and grants, and approving or denying requests (plan 4.6, D9).
 * The registry marks them 'hard_floor' too; this keeps them closed even if an entry there is wrong.
 */
export const AGENT_HARD_FLOOR_ROUTES: readonly string[] = ['/api/agents', '/api/agent-requests', '/api/agent-grants'];

/**
 * Areas an agent's own request never reaches, even for a plain read, and that its access leaves
 * out (agentDirectAccess). The ceiling keeps them now, so the door can ask an Admin about their
 * operations (D1), but a direct read runs with no policy and no person. Through the door an
 * operation is asked about by its class: the reads of Users & Roles are 'admin' and the File
 * Utilities reads that show the files on disk are 'file', so an Admin is asked about each; only
 * the pure checks of the books stay 'read' and run without asking (see clampForAgent). The audit
 * trail is read with an agent's access less these areas too (lib/services/auditTrail.ts).
 */
export const AGENT_DOOR_ONLY_AREAS: readonly Area[] = ['users', 'file_utilities'];

/** What agentRouteAllowed needs to know about the operation a GET names (from the registry). */
export type AgentRouteOperation = Pick<Operation, 'classified' | 'class' | 'availability' | 'area' | 'rule'>;

/** The registry operation for GET on this concrete path, or null when there is none. */
export type AgentRouteLookup = (path: string) => AgentRouteOperation | null | undefined;

function underRoute(path: string, route: string): boolean {
  const p = path.toLowerCase();
  return p === route || p.startsWith(`${route}/`);
}

/** True for a path under one of AGENT_HARD_FLOOR_ROUTES (letter case aside). */
export function agentHardFloorRoute(path: string): boolean {
  return AGENT_HARD_FLOOR_ROUTES.some((route) => underRoute(path, route));
}

/** An API path as middleware stamps it: no empty, "." or ".." segments, no backslash, no query. */
export function plainApiPath(path: string): boolean {
  if (!/^\/api(?:\/[^/\\?#]+)+$/.test(path)) return false;
  return !path.split('/').some((seg) => seg === '.' || seg === '..');
}

/**
 * Whether a GET of this registry operation is a read an agent may make directly: hand-classified
 * (an unclassified route is class 'admin' at runtime and asks), class 'read', open to agents (not
 * person_only, not hard_floor), not a person's own account ('self') or a route with no context
 * ('public'), and outside AGENT_DOOR_ONLY_AREAS. read_sensitive, and every GET classed anything else
 * (it saves, refreshes, asks an AI service or calls out), goes through the door.
 */
export function agentDirectReadAllowed(operation: AgentRouteOperation | null | undefined): boolean {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.classified !== true) return false;
  if (operation.class !== 'read') return false;
  if (operation.availability !== 'agent') return false;
  const rule = operation.rule;
  if (rule === null || rule === undefined || rule === 'self' || rule === 'public') return false;
  const areas = [operation.area, typeof rule === 'object' ? rule.area : null];
  return !areas.some((a) => a !== null && a !== undefined && AGENT_DOOR_ONLY_AREAS.includes(a));
}

/**
 * May an agent's own HTTP request go on at all? `path` and `method` are the ones middleware stamped
 * (never the client's word). Fail closed; allowed are only:
 *  - POST /api/agent/actions, the one door for changes;
 *  - GET of the agent's own reads (a path the route map matches to one of AGENT_OWN_ROUTES);
 *  - a GET whose registry operation (`lookup`) is a plain read open to agents
 *    (agentDirectReadAllowed).
 * Refused: every other method (HEAD too: it runs the GET handler and no agent needs it), pages,
 * the hard-floor routes, and any GET the lookup does not find, cannot classify or throws on.
 * Without a lookup only the door and the agent's own reads pass.
 */
export function agentRouteAllowed(
  path: string | null | undefined,
  method: string | null | undefined,
  lookup?: AgentRouteLookup | null,
): boolean {
  if (typeof path !== 'string' || typeof method !== 'string' || !path || !method) return false;
  if (isAgentActionRequest(path, method)) return true;
  if (method.toUpperCase() !== 'GET') return false;
  if (!plainApiPath(path)) return false;
  if (agentHardFloorRoute(path)) return false;
  if (agentOwnRoute(path)) return true;
  if (!lookup) return false;
  let operation: AgentRouteOperation | null | undefined;
  try {
    operation = lookup(path);
  } catch {
    return false; // a registry that cannot answer lets nothing through
  }
  return agentDirectReadAllowed(operation);
}
