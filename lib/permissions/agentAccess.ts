/**
 * What an agent may reach (AGENT_ACCESS.md). Pure module: no Node or database imports.
 *
 * An agent is given the same roles people have, and every request it makes is checked against the
 * same route map (lib/permissions/routes.ts). On top of that, three things hold for every agent
 * whatever role it was given:
 *
 *  1. `clampForAgent`: never Admin; no Users & Roles and no File Utilities (backup, restore,
 *     condense); no full SSNs or account numbers; no closing-date override.
 *  2. `agentRouteAllowed`: an explicit list of API routes, fail closed. In this version it is a
 *     list of reads, GET only. "Any GET the role allows" is not enough here: several GET routes in
 *     the app save defaults, refresh caches or ask an AI service.
 *  3. The context it gets is read-only (lib/db/readOnly.ts) with the view-only role.
 *
 * Read only / Propose / Post is stored per agent; until tools that enter transactions exist, every
 * mode reads only (`agentMayWrite` is false for all of them).
 */
import { ADMIN_ROLE_KEY, withoutAreas, type Area, type EffectiveAccess } from './model';
import { matchRoutePattern } from './routes';

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

/** Whether an agent in this mode may change the books. Not in this version, for any mode. */
export function agentMayWrite(_mode: AgentMode): boolean {
  return false;
}

/** Areas no agent reaches, whatever its role. */
export const AGENT_DENIED_AREAS: readonly Area[] = ['users', 'file_utilities'];

/** True when these role keys would make an Admin (which an agent can never be). */
export function includesAdminRole(roleKeys: readonly string[]): boolean {
  return roleKeys.includes(ADMIN_ROLE_KEY);
}

/** The access of an agent: its roles' access with the agent limits applied. */
export function clampForAgent(access: EffectiveAccess): EffectiveAccess {
  const limited = withoutAreas(access, AGENT_DENIED_AREAS);
  return {
    ...limited,
    roleKeys: limited.roleKeys.filter((k) => k !== ADMIN_ROLE_KEY),
    isAdmin: false,
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
  };
}

/**
 * The API routes an agent may call, as route patterns (the keys of API_ROUTE_PERMISSIONS). Every
 * one is a GET that only reads; lib/agentTools.contract.test.ts runs each with a read-only handle.
 * The tools of the MCP server (mcp/tools.mjs) call exactly these.
 */
export const AGENT_READ_ROUTES: readonly string[] = [
  '/api/agent/whoami',
  '/api/accounts',
  '/api/customers',
  '/api/vendors',
  '/api/items',
  '/api/classes',
  '/api/employees',
  '/api/lists/[list]',
  '/api/tax-rates',
  '/api/search',
  '/api/find',
  '/api/registers',
  '/api/registers/[accountId]',
  '/api/journal-entries/[id]',
  '/api/reports/std/[report]',
];

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * May an agent make this request at all? `path` and `method` are the ones middleware stamped
 * (never the client's word). A missing path, a page, a route off the list or a method that is not
 * a read is refused before any permission is looked at.
 */
export function agentRouteAllowed(path: string | null | undefined, method: string | null | undefined): boolean {
  if (!path || !method) return false;
  if (!SAFE_METHODS.has(method.toUpperCase())) return false;
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  const pattern = matchRoutePattern(path);
  return pattern !== null && AGENT_READ_ROUTES.includes(pattern);
}
