/**
 * The agent limits (lib/permissions/agentAccess.ts), on their own: no database, no request.
 *
 * What is proved:
 *  - the ceiling (clampForAgent) is a copy of the roles' access that keeps Admin (D1), Users & Roles,
 *    File Utilities and the flags, and is never more Admin than the roles;
 *  - the masked access (maskedForAgent) is the same access with every View flag and the
 *    closed-period right off;
 *  - the access of an agent's own request (agentDirectAccess) is masked, has no Users & Roles and
 *    no File Utilities, and is never Admin, whatever the role;
 *  - an agent's own request (agentRouteAllowed) reaches only the door, its own reads (by the route
 *    map's pattern, not by the look of the path), and GETs the registry classes as plain reads open
 *    to agents outside Users & Roles and File Utilities. Every other method, class, availability
 *    and path is refused, also when the lookup is missing, wrong or throws;
 *  - the same rule over the real registry: every GET it allows is such a read, and every change
 *    route is refused;
 *  - through the door, an Admin-role agent on the widest preset is asked about every operation of
 *    Users & Roles and File Utilities, except a short list of GETs the registry classes 'read' on
 *    purpose, each with its reason (pinned here exactly), and every read of Users & Roles is among
 *    the asked ones; a person's own reads of the company file are not offered, the file's name is
 *    asked about, and the raw transaction log is refused.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * The real route map, plus any pattern listed in `routeProbe.extra`: the only way to see what the
 * own-route rule does with a route added beside the agent's own ones later.
 */
const routeProbe = vi.hoisted(() => ({ extra: [] as string[] }));
vi.mock('./routes', async (importOriginal) => {
  const real = await importOriginal<typeof import('./routes')>();
  return {
    ...real,
    matchRoutePattern: (pathname: string, patterns?: Iterable<string>) =>
      real.matchRoutePattern(pathname, patterns ?? [...Object.keys(real.API_ROUTE_PERMISSIONS), ...routeProbe.extra]),
  };
});

import * as agentAccessModule from './agentAccess';
import {
  AGENT_ACTION_ROUTE,
  AGENT_DOOR_ONLY_AREAS,
  AGENT_HARD_FLOOR_ROUTES,
  AGENT_OWN_ROUTES,
  agentDirectAccess,
  agentDirectReadAllowed,
  agentRouteAllowed,
  clampForAgent,
  maskedForAgent,
  type AgentRouteLookup,
  type AgentRouteOperation,
} from './agentAccess';
import { AREA_KEYS, FLAGS, builtinRole, can, canActivity, fullAccess, unionRoles, type EffectiveAccess } from './model';
import { activitiesOf } from './activities';
import { RISK_CLASSES, type Operation, type RequestFacts } from '@/lib/agent/operations/types';
import { allOperations, operationById, operationForPath } from '@/lib/agent/operations/registry';
import { decide, resolvePolicy } from '@/lib/agent/policy';

const ID = '11111111-2222-4333-8444-555555555555';

/** A plain read open to agents, in an ordinary area. */
const READ: AgentRouteOperation = { classified: true, class: 'read', availability: 'agent', area: 'banking', rule: { area: 'banking', action: 'view' } };

/** A lookup that answers `op` for every path. */
const always = (op: AgentRouteOperation | null): AgentRouteLookup => () => op;

function role(key: string): EffectiveAccess {
  const def = builtinRole(key);
  if (!def) throw new Error(`no built-in role ${key}`);
  return unionRoles([def]);
}

describe('the ceiling (clampForAgent)', () => {
  it('keeps an Admin role as a ceiling (D1), with Users & Roles, File Utilities and the flags', () => {
    const access = clampForAgent(fullAccess());
    expect(access.isAdmin).toBe(true);
    expect(access.roleKeys).toEqual(['admin']);
    expect(access.permissions.users.length).toBeGreaterThan(0);
    expect(access.permissions.file_utilities.length).toBeGreaterThan(0);
    expect(access.flags).toEqual({ sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true });
    expect(access.activities).toEqual(fullAccess().activities);
  });

  it('gives nothing the roles do not hold', () => {
    const bookkeeper = role('bookkeeper');
    const access = clampForAgent(bookkeeper);
    expect(access).toEqual(bookkeeper);
    expect(access.isAdmin).toBe(false);
    // An access that claims Admin without the Admin role is not Admin for an agent.
    expect(clampForAgent({ ...bookkeeper, isAdmin: true }).isAdmin).toBe(false);
  });

  it('is a copy: changing it never changes the roles\' own access', () => {
    const original = fullAccess();
    const access = clampForAgent(original);
    access.permissions.banking.length = 0;
    const activities = access.activities!;
    for (const key of Object.keys(activities) as Array<keyof typeof activities>) activities[key].splice(0);
    access.flags.sensitivePayroll = false;
    access.roleKeys.push('x');
    expect(original).toEqual(fullAccess());
  });
});

describe('the masked access (maskedForAgent)', () => {
  it('switches off every View flag and the closed-period right, and nothing else', () => {
    for (const source of [fullAccess(), role('bookkeeper'), clampForAgent(fullAccess())]) {
      const masked = maskedForAgent(source);
      for (const f of FLAGS) expect(masked.flags[f.key], f.key).toBe(false);
      expect(Object.keys(masked.flags).sort()).toEqual(FLAGS.map((f) => f.key).sort());
      expect({ ...masked, flags: source.flags }).toEqual(source);
    }
    // The original keeps its flags.
    const admin = fullAccess();
    maskedForAgent(admin);
    expect(admin.flags.sensitivePayroll).toBe(true);
  });

  it('of an Admin ceiling: still Admin (D1), still unable to see a full SSN or account number', () => {
    const masked = maskedForAgent(clampForAgent(fullAccess()));
    expect(masked.isAdmin).toBe(true);
    expect(masked.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
  });
});

describe("the access of an agent's own request (agentDirectAccess)", () => {
  const NO_FLAGS = { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false };

  it('of the Admin role: never Admin, no Users & Roles, no File Utilities, no flags; every other area kept', () => {
    const ceiling = clampForAgent(fullAccess());
    const access = agentDirectAccess(fullAccess());
    expect(access.isAdmin).toBe(false);
    // The agent is still told which roles it holds.
    expect(access.roleKeys).toEqual(['admin']);
    expect(access.flags).toEqual(NO_FLAGS);
    for (const area of AREA_KEYS) {
      if (AGENT_DOOR_ONLY_AREAS.includes(area)) {
        expect(access.permissions[area], area).toEqual([]);
        for (const def of activitiesOf(area)) {
          expect(access.activities?.[def.key as keyof NonNullable<typeof access.activities>], def.key).toEqual([]);
          expect(canActivity(access, def.key, 'view'), def.key).toBe(false);
        }
        expect(can(access, area, 'view'), area).toBe(false);
      } else {
        expect(access.permissions[area], area).toEqual(ceiling.permissions[area]);
        for (const def of activitiesOf(area)) {
          const k = def.key as keyof NonNullable<typeof access.activities>;
          expect(access.activities?.[k], def.key).toEqual(ceiling.activities?.[k]);
        }
      }
    }
    // The ceiling the door works with is untouched: Admin, with every area and flag.
    expect(ceiling.isAdmin).toBe(true);
    expect(ceiling.permissions.users.length).toBeGreaterThan(0);
  });

  it('of any other role: the role, masked, without the door-only areas', () => {
    for (const key of ['bookkeeper', 'full_access', 'view_only', 'reports_only']) {
      const source = role(key);
      const access = agentDirectAccess(source);
      expect(access.isAdmin, key).toBe(false);
      expect(access.flags, key).toEqual(NO_FLAGS);
      for (const area of AGENT_DOOR_ONLY_AREAS) expect(access.permissions[area], `${key} ${area}`).toEqual([]);
      for (const area of AREA_KEYS.filter((a) => !AGENT_DOOR_ONLY_AREAS.includes(a))) {
        expect(access.permissions[area], `${key} ${area}`).toEqual(source.permissions[area]);
      }
    }
    // An access that claims Admin without the Admin role is not Admin either.
    expect(agentDirectAccess({ ...role('bookkeeper'), isAdmin: true }).isAdmin).toBe(false);
  });

  it("is a copy: changing it never changes the roles' own access", () => {
    const original = fullAccess();
    const access = agentDirectAccess(original);
    access.permissions.banking.length = 0;
    const activities = access.activities!;
    for (const key of Object.keys(activities) as Array<keyof typeof activities>) activities[key].splice(0);
    access.flags.sensitivePayroll = true;
    access.roleKeys.push('x');
    expect(original).toEqual(fullAccess());
  });
});

describe("what an agent's own request reaches (agentRouteAllowed)", () => {
  it('a GET the registry classes as a plain read open to agents', () => {
    expect(agentRouteAllowed('/api/accounts', 'GET', always(READ))).toBe(true);
    expect(agentRouteAllowed('/api/accounts', 'get', always(READ))).toBe(true);
    expect(agentRouteAllowed(`/api/invoices/${ID}`, 'GET', always({ ...READ, rule: 'member', area: null }))).toBe(true);
  });

  it('refuses a GET of every other class', () => {
    for (const cls of RISK_CLASSES.filter((c) => c !== 'read')) {
      expect(agentRouteAllowed('/api/accounts', 'GET', always({ ...READ, class: cls })), cls).toBe(false);
    }
    // The ones the task names: file, outside, read_sensitive.
    for (const cls of ['file', 'outside', 'read_sensitive'] as const) {
      expect(agentDirectReadAllowed({ ...READ, class: cls }), cls).toBe(false);
    }
  });

  it('refuses person_only, hard_floor and unclassified reads', () => {
    expect(agentRouteAllowed('/api/accounts', 'GET', always({ ...READ, availability: 'person_only' }))).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET', always({ ...READ, availability: 'hard_floor' }))).toBe(false);
    // Unclassified: the registry says 'admin' at runtime, but even a 'read' it guessed is refused.
    expect(agentRouteAllowed('/api/accounts', 'GET', always({ ...READ, classified: false }))).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET', always({ ...READ, classified: false, class: 'admin' }))).toBe(false);
  });

  it("refuses Users & Roles and File Utilities, a person's own account and routes with no context", () => {
    expect(AGENT_DOOR_ONLY_AREAS).toEqual(['users', 'file_utilities']);
    for (const area of AGENT_DOOR_ONLY_AREAS) {
      expect(agentRouteAllowed('/api/users', 'GET', always({ ...READ, area, rule: { area, action: 'view' } })), area).toBe(false);
      // Either place the area is named is enough.
      expect(agentDirectReadAllowed({ ...READ, area: null, rule: { area, action: 'view' } }), area).toBe(false);
      expect(agentDirectReadAllowed({ ...READ, area, rule: 'member' }), area).toBe(false);
    }
    for (const rule of ['self', 'public', null] as const) {
      expect(agentDirectReadAllowed({ ...READ, area: null, rule }), String(rule)).toBe(false);
    }
  });

  it('refuses when the lookup finds nothing, is missing, answers junk or throws', () => {
    expect(agentRouteAllowed('/api/accounts', 'GET', always(null))).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET', () => undefined)).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET')).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET', null)).toBe(false);
    expect(agentRouteAllowed('/api/accounts', 'GET', () => 'read' as unknown as AgentRouteOperation)).toBe(false);
    expect(
      agentRouteAllowed('/api/accounts', 'GET', () => {
        throw new Error('Two or more agent operations share an id');
      }),
    ).toBe(false);
  });

  it('refuses every method but GET, except a POST to the one door', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', '', ' GET', 'GET ']) {
      expect(agentRouteAllowed('/api/accounts', method, always(READ)), method).toBe(false);
    }
    expect(agentRouteAllowed('/api/accounts', null, always(READ))).toBe(false);
    expect(agentRouteAllowed('/api/accounts', undefined, always(READ))).toBe(false);
    // The door: POST only, needs no lookup, and nothing that only looks like it.
    expect(agentRouteAllowed(AGENT_ACTION_ROUTE, 'POST')).toBe(true);
    expect(agentRouteAllowed(AGENT_ACTION_ROUTE, 'post')).toBe(true);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) expect(agentRouteAllowed(AGENT_ACTION_ROUTE, method), method).toBe(false);
    for (const p of ['/api/agent/actions/', '/api/agent/actions/x', '/api/agent/Actions', '/api/agent/actionsx', '/api/agents']) {
      expect(agentRouteAllowed(p, 'POST', always(READ)), p).toBe(false);
    }
  });

  it("the agent's own reads, GET only, with or without the registry", () => {
    expect(AGENT_OWN_ROUTES).toEqual(['/api/agent/whoami', '/api/agent/requests', '/api/agent/requests/[id]']);
    for (const p of ['/api/agent/whoami', '/api/agent/requests', `/api/agent/requests/${ID}`]) {
      expect(agentRouteAllowed(p, 'GET'), p).toBe(true);
      expect(agentRouteAllowed(p, 'GET', always(null)), p).toBe(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) expect(agentRouteAllowed(p, method, always(READ)), `${method} ${p}`).toBe(false);
    }
    for (const p of [`/api/agent/requests/${ID}/approve`, '/api/agent/whoamix', '/api/agent/hello', '/api/agent/service', '/api/Agent/whoami', '/api/agent/Requests']) {
      expect(agentRouteAllowed(p, 'GET'), p).toBe(false);
    }
  });

  it('an own route is one the route map matches to its pattern, not any path that looks like one', () => {
    // A route added later beside the agent's own (here, as if the route map had it): the route map
    // matches it to its own pattern, so it is not an own read and needs the registry like any other.
    routeProbe.extra.push('/api/agent/requests/export');
    try {
      expect(agentRouteAllowed('/api/agent/requests/export', 'GET')).toBe(false);
      expect(agentRouteAllowed('/api/agent/requests/export', 'GET', always(null))).toBe(false);
      expect(agentRouteAllowed('/api/agent/requests/export', 'GET', always({ ...READ, availability: 'person_only' }))).toBe(false);
      // A classified plain read there would pass on its own merits, as any other GET.
      expect(agentRouteAllowed('/api/agent/requests/export', 'GET', always(READ))).toBe(true);
      // The own routes themselves still pass.
      expect(agentRouteAllowed(`/api/agent/requests/${ID}`, 'GET')).toBe(true);
    } finally {
      routeProbe.extra.length = 0;
    }
  });

  it('no longer has the old names of the lists: nothing imports them', () => {
    // AGENT_READ_ROUTES (the fixed list of 38 reads) and AGENT_DENIED_AREAS (areas the clamp took
    // away) described rules that are gone; their last importers were rewritten, so they went too.
    expect('AGENT_READ_ROUTES' in agentAccessModule).toBe(false);
    expect('AGENT_DENIED_AREAS' in agentAccessModule).toBe(false);
  });

  it('refuses the agent, approval and grant routes outright, whatever the registry says', () => {
    expect(AGENT_HARD_FLOOR_ROUTES).toEqual(['/api/agents', '/api/agent-requests', '/api/agent-grants']);
    for (const p of [
      '/api/agents',
      `/api/agents/${ID}`,
      `/api/agents/${ID}/grants`,
      `/api/agents/${ID}/activity`,
      '/api/agents/pause-all',
      '/api/Agents',
      '/api/agent-requests',
      '/api/agent-requests/count',
      `/api/agent-requests/${ID}`,
      `/api/agent-grants/${ID}`,
    ]) {
      expect(agentRouteAllowed(p, 'GET', always(READ)), p).toBe(false);
      expect(agentRouteAllowed(p, 'POST', always(READ)), p).toBe(false);
    }
  });

  it('refuses pages and anything that is not a plain API path', () => {
    for (const p of [null, undefined, '', '/', '/dashboard', '/users', '/api', '/api/', '/apix/accounts', '/api/accounts/../users', '/api/./accounts', '/api//accounts', '/api/accounts/', '/api/accounts?x=1', '/api\\accounts']) {
      expect(agentRouteAllowed(p, 'GET', always(READ)), String(p)).toBe(false);
    }
  });
});

describe('the same rule over the real registry', () => {
  const lookup: AgentRouteLookup = (p) => operationForPath('GET', p)?.operation ?? null;
  const concrete = (pattern: string) => pattern.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, ID);

  it('a GET passes only when it is a classified read open to agents, outside Users & Roles and File Utilities', () => {
    let allowed = 0;
    for (const op of allOperations()) {
      if (op.kind !== 'route' || op.method !== 'GET') continue;
      const p = concrete(op.route);
      const found = operationForPath('GET', p)?.operation;
      if (!found || found.route !== op.route) continue; // a more specific pattern answers this path
      const own = AGENT_OWN_ROUTES.includes(op.route);
      const ok = agentRouteAllowed(p, 'GET', lookup);
      if (ok) allowed++;
      if (own) {
        expect(ok, op.route).toBe(true);
        continue;
      }
      expect(ok, op.route).toBe(op.classified && op.class === 'read' && op.availability === 'agent' && agentDirectReadAllowed(op));
      if (op.availability !== 'agent' || op.class !== 'read' || !op.classified) expect(ok, op.route).toBe(false);
      if (op.area && AGENT_DOOR_ONLY_AREAS.includes(op.area)) expect(ok, op.route).toBe(false);
    }
    // Far more than the 38 routes of the old list, and far fewer than every GET.
    expect(allowed).toBeGreaterThan(100);
  });

  it('every route that changes something is refused, except the door', () => {
    for (const op of allOperations()) {
      if (op.kind !== 'route' || op.method === 'GET') continue;
      const ok = agentRouteAllowed(concrete(op.route), op.method, lookup);
      expect(ok, `${op.method} ${op.route}`).toBe(op.method === 'POST' && op.route === AGENT_ACTION_ROUTE);
    }
  });

  it('Users & Roles and agents stay closed to a direct request, even for an Admin ceiling', () => {
    for (const p of ['/api/users', `/api/users/${ID}`, '/api/users/password-policy', '/api/users/permissions-report', '/api/roles', `/api/roles/${ID}`, '/api/agents', `/api/agents/${ID}`, '/api/agent-requests', '/api/agent-requests/count', '/api/backups', '/api/sandbox']) {
      expect(agentRouteAllowed(p, 'GET', lookup), p).toBe(false);
    }
    // Reads a bookkeeper needs every day stay open.
    for (const p of ['/api/accounts', '/api/customers', `/api/invoices/${ID}`, '/api/reports/std/profit-loss', '/api/bank-transactions']) {
      expect(agentRouteAllowed(p, 'GET', lookup), p).toBe(true);
    }
  });
});

describe('Users & Roles and File Utilities through the door (the policy, with an Admin ceiling)', () => {
  /**
   * Operations of these areas that the door runs WITHOUT asking anyone, on any preset (read is
   * Allow in all four), for an agent whose role holds the view right: the Admin role holds both
   * areas, and Full Access, Accountant and External Accountant hold File Utilities. The policy asks
   * by class, not by area, so these are the GETs the registry (lib/agent/operations/classes/*.ts)
   * classes 'read'. Plan 4.2 files the reads of Users & Roles under admin and the File Utilities
   * reads that show file names, folders or backups, or produce a file, under file; what is left
   * here is left on purpose, each with its reason. The list is exact both ways: a new operation of
   * these areas that runs unasked fails the test below, and so does an entry here that no longer
   * runs unasked (take it off).
   */
  const KNOWN_UNASKED: Readonly<Record<string, string>> = {
    // classes/admin.ts: pure checks of the books (plan 4.2 lets them stay read). They answer pass
    // or fail per check and show no file name, folder or backup.
    integrity: 'a pure check of the books',
    'integrity.books-in-balance': 'a pure check of the books',
    // classes/lists.ts: Clean Up Company Data's preview (GET /api/cleanup), classed read there with
    // its reason: it lists inactive, unused list entries of the books, never a file, folder or
    // backup, and produces no file.
    cleanup: 'lists unused list entries of the books, no file',
  };

  const PLAIN: RequestFacts = { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false };
  const doorOnly = (op: Operation) =>
    (op.area !== null && AGENT_DOOR_ONLY_AREAS.includes(op.area)) ||
    (typeof op.rule === 'object' && op.rule !== null && AGENT_DOOR_ONLY_AREAS.includes(op.rule.area));

  /** What the door does with this operation for an Admin-role agent on the widest preset. */
  function outcome(op: Operation): string {
    const d = decide({
      access: clampForAgent(fullAccess()),
      policy: resolvePolicy('full_with_asks', []),
      operation: op,
      facts: PLAIN,
      grants: [],
      now: '2026-11-20T12:00:00.000Z',
    });
    // The door never runs a desktop action on the agent's own say-so (lib/agent/operate.ts decideFor).
    return d.outcome === 'run' && op.kind === 'shell' ? 'ask' : d.outcome;
  }

  it('an Admin is asked about every one of their operations, except the known list', () => {
    const ops = allOperations().filter(doorOnly);
    expect(ops.length).toBeGreaterThan(20);
    const unasked = ops.filter((op) => outcome(op) === 'run').map((op) => op.id).sort();
    // Every one of them runs as a plain read (nothing that changes something runs unasked here).
    for (const op of ops.filter((o) => unasked.includes(o.id))) {
      expect(op.class, op.id).toBe('read');
      expect(op.kind === 'route' ? op.method : 'GET', op.id).toBe('GET');
    }
    expect(
      unasked.filter((id) => !(id in KNOWN_UNASKED)),
      'operations of Users & Roles or File Utilities that run without asking',
    ).toEqual([]);
    // What is deliberately left is still what happens: an entry asked about now, or gone, comes out.
    expect(Object.keys(KNOWN_UNASKED).filter((id) => !unasked.includes(id)), 'entries of KNOWN_UNASKED that no longer run unasked').toEqual([]);
    // What is classed admin, file or secret is always asked about (never Allow).
    for (const op of ops.filter((o) => o.classified && ['admin', 'file', 'secret'].includes(o.class))) {
      expect(['ask', 'refuse'], op.id).toContain(outcome(op));
    }
  });

  it('every read of Users & Roles asks an Admin, and so does every File Utilities read but the pure checks', () => {
    const reads = allOperations().filter((op) => op.kind === 'route' && op.method === 'GET' && doorOnly(op));
    expect(reads.length).toBeGreaterThan(10);
    for (const op of reads) {
      if (op.id in KNOWN_UNASKED) {
        // What is left read is a plain read of File Utilities, never of Users & Roles.
        expect(op.class, op.id).toBe('read');
        expect(op.area, op.id).toBe('file_utilities');
        continue;
      }
      const users = op.area === 'users' || (typeof op.rule === 'object' && op.rule?.area === 'users');
      expect(op.class, op.id).toBe(users ? 'admin' : 'file');
      expect(['ask', 'refuse'], op.id).toContain(outcome(op));
    }
    // The ones the old gap named, by id.
    for (const id of ['users.list', 'users.get', 'users.password-policy', 'users.permissions-report', 'roles.list', 'roles.get']) {
      expect(operationById(id)?.class, id).toBe('admin');
    }
    for (const id of ['backups', 'backups.status', 'condense.archives', 'export.get', 'import.rebuild', 'portable.shareable', 'qb-import.gl', 'qb-import.open-items', 'report-schedules.list', 'sandbox']) {
      expect(operationById(id)?.class, id).toBe('file');
    }
  });

  it("the company file's own reads: a person's own are not offered, the file's name asks an Admin, the raw log is refused", () => {
    // A person's own account ('self'): the route refuses every agent, so the door does not offer it.
    for (const id of ['companies.list', 'file-protection.status']) {
      const op = operationById(id)!;
      expect(op, id).toMatchObject({ method: 'GET', rule: 'self', availability: 'person_only' });
      expect(outcome(op), id).toBe('refuse');
    }
    // The sign-in screen's read of the company file's name (a 'public' route): class file, asked.
    const info = operationById('company-file.info')!;
    expect(info).toMatchObject({ method: 'GET', class: 'file', availability: 'agent', dryRun: 'none' });
    expect(outcome(info)).toBe('ask');
    // The raw transaction log cannot be masked: never for an agent, approval or not.
    const raw = operationById('transaction-log.download')!;
    expect(raw).toMatchObject({ method: 'GET', area: 'file_utilities', availability: 'hard_floor' });
    expect(outcome(raw)).toBe('refuse');
  });
});
