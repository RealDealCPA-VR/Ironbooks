/**
 * What an agent may reach (AGENT_ACCESS.md). Pure module: no Node or database imports.
 *
 * An agent is given the same roles people have, and every request it makes is checked against the
 * same route map (lib/permissions/routes.ts). On top of that, three things hold for every agent
 * whatever role it was given:
 *
 *  1. `clampForAgent`: never Admin; no Users & Roles and no File Utilities (backup, restore,
 *     condense); no full SSNs or account numbers; no closing-date override.
 *  2. `agentRouteAllowed`: an explicit list of API routes, fail closed: a list of reads (GET
 *     only), and ONE route that takes changes (POST /api/agent/actions). "Any GET the role allows"
 *     is not enough here: several GET routes in the app save defaults, refresh caches or ask an AI
 *     service. And an agent never calls the app's own save routes: every change it makes is one
 *     of the named actions behind that one route (lib/agent/actions.ts), where the dry run, the
 *     request id and the approval queue live.
 *  3. The context a request gets is read-only (lib/db/readOnly.ts) with the view-only role. Only
 *     the action runner makes a context that can write, for one action, when the mode allows it.
 *
 * The mode decides what happens to a change the agent asks for:
 *   - Read only: refused.
 *   - Propose:   checked, then put in the approval queue for a person. Nothing is entered.
 *   - Post:      entered, within the agent's role.
 */
import { ADMIN_ROLE_KEY, withoutAreas, type Area, type EffectiveAccess } from './model';
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
  // One document or list entry in full, and the lists a bookkeeper works from when entering
  // payments and deposits.
  '/api/invoices',
  '/api/invoices/[id]',
  '/api/sales-receipts/[id]',
  '/api/payments/[id]',
  '/api/bills',
  '/api/bills/[id]',
  '/api/bill-payments/[id]',
  '/api/expenses/[id]',
  '/api/deposits/[id]',
  '/api/deposits/undeposited',
  '/api/transfers/[id]',
  '/api/customers/[id]',
  '/api/vendors/[id]',
  '/api/accounts/[id]',
  '/api/items/[id]',
  // Banking: the linked bank accounts, the bank feed and its match candidates, reconciliations.
  '/api/bank-accounts',
  '/api/bank-transactions',
  '/api/bank-transactions/matches',
  '/api/reconciliations',
  '/api/reconciliations/[id]',
  '/api/reconciliations/[id]/clearable',
  '/api/reconciliations/info',
];

export { AGENT_ACTION_ROUTE, isAgentActionRequest };

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * May an agent make this request at all? `path` and `method` are the ones middleware stamped
 * (never the client's word). A missing path, a page, a route off the list or a method that is not
 * a read is refused before any permission is looked at. The one exception to "a read" is a POST to
 * the action route.
 */
export function agentRouteAllowed(path: string | null | undefined, method: string | null | undefined): boolean {
  if (!path || !method) return false;
  if (isAgentActionRequest(path, method)) return true;
  if (!SAFE_METHODS.has(method.toUpperCase())) return false;
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  const pattern = matchRoutePattern(path);
  return pattern !== null && AGENT_READ_ROUTES.includes(pattern);
}
