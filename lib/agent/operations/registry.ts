/**
 * Agent full access: the operation registry (plan §5.1). One OPERATION per API route + method,
 * built from four sources that each say one thing:
 *
 *  - lib/permissions/routes.ts (API_ROUTE_PERMISSIONS): which routes and methods exist and the rule
 *    a person's request meets. Only what is in this map is an operation (unmapped routes are denied
 *    to everyone, so an agent cannot reach them either).
 *  - lib/permissions/routeActivities.ts: the activity within the rule's area.
 *  - routes.generated.ts (scripts/agent-registry.mjs): what each handler reads and answers.
 *  - classes.ts: the hand-written risk class and wording. It has the last word.
 *
 * Then the operations that are not API routes (shell.ts, plan §5.5): what the desktop shell or the
 * server itself carries out once a person approves. They are kind 'shell', share the id space with
 * the routes and are found by id and by search only, never by a route or a request path.
 *
 * Fail closed: a route + method with no classification is `classified: false`, class 'admin'
 * (never Allow, only an Admin may approve) and described as "Use {method} {route}".
 * test/agentRegistry.test.ts fails while any exists.
 *
 * Cheap to import: pure data and functions. The handlers themselves are loaded only by
 * loadRouteHandler, through a lazy import of loaders.generated.ts. Client components must not import
 * this module: that lazy import would pull every route handler into the browser bundle.
 */
import type { Area } from '@/lib/permissions/model';
import {
  API_ROUTE_PERMISSIONS,
  HTTP_METHODS,
  matchRoutePattern,
  type HttpMethod,
  type MethodRules,
} from '@/lib/permissions/routes';
import { activityForRoute } from '@/lib/permissions/routeActivities';
import type { ShellOperationDef } from '../contract';
import { OPERATION_CLASSES } from './classes';
import { GENERATED_ROUTES, type GeneratedRoute } from './routes.generated';
import { SHELL_OPERATIONS } from './shell';
import {
  isRiskClass,
  operationKey,
  type Availability,
  type BodyKind,
  type ClassificationMap,
  type DryRunKind,
  type EffectKind,
  type Operation,
  type OperationClassification,
  type OperationKey,
  type RiskClass,
  type SecretKind,
} from './types';

// ---------------------------------------------------------------------------
// Operation ids
// ---------------------------------------------------------------------------

const isParam = (seg: string) => seg.startsWith('[') && seg.endsWith(']');
const paramName = (seg: string) => seg.replace(/^\[+(\.\.\.)?/, '').replace(/\]+$/, '');
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** The path segments after /api ("/api/invoices/[id]/email" -> ["invoices", "[id]", "email"]). */
function apiSegments(pattern: string): string[] {
  return pattern.split('/').filter(Boolean).slice(1);
}

/** Path parameter names in order ("/api/x/[id]/lines/[lineId]" -> ["id", "lineId"]). */
export function routeParamNames(pattern: string): string[] {
  return apiSegments(pattern).filter(isParam).map(paramName);
}

/** What the id rule needs to know about the rest of the route map, for one route. */
export interface IdContext {
  /** The methods the same route has (they decide "list"/"create", "post" and "replace"). */
  methods: readonly HttpMethod[];
  /**
   * Records of this route are addressed under it: some route of the map starts with
   * "<route>/[" ("/api/invoices" has "/api/invoices/[id]"). Only such a route is a list.
   */
  collection: boolean;
}

/**
 * THE id rule. An operation id is the route's words joined with dots, then a verb:
 *
 *  1. Words: the path segments after /api/, leaving out path parameters.
 *     "/api/invoices/[id]/email" -> "invoices.email".
 *  2. Verb, by method:
 *     - PATCH "update"; PUT "update", or "replace" when the same route also has PATCH; DELETE "delete".
 *     - A route that ends in a parameter (one record): GET "get", POST "action" (these POSTs do
 *       what the body's `action` names: convert, void, apply …).
 *     - A route that ends in a word, has both GET and POST and has records under it (a
 *       collection, IdContext.collection) is a list: GET "list", POST "create".
 *     - The same without records under it is not a list (GET /api/backup downloads a backup, its
 *       POST restores one): GET adds no verb and POST is "post", a word that claims nothing. The
 *       classification names a better id where one is wanted ("backup.restore").
 *     - Any other route ending in a word: GET and POST add no verb, since the last word already
 *       says what it is or does: "invoices.email", "month-end-close.scan", "reports.profit-loss".
 *  3. When two routes would still get the same id, each one with a path parameter keeps its
 *     parameters as "by-<name>": GET /api/bank-transactions/[id]/matches is
 *     "bank-transactions.by-id.matches" next to GET /api/bank-transactions/matches,
 *     "bank-transactions.matches".
 *
 * A classification can name the id itself (`id`), for a route the rule names badly.
 * Examples: invoices.list, invoices.create, invoices.get, invoices.update, invoices.delete,
 * invoices.email, reconciliations.undo, bank-rules.create, month-end-close.scan,
 * company.closing-date.update.
 *
 * Ids are STABLE: standing permissions (AgentGrant.operation), stored permission requests and MCP
 * clients name operations by id. Steps 2 and 3 look at the rest of the route map, so a route or
 * method added elsewhere can rename an operation that did not change (a GET added next to a POST,
 * a new route that clashes). That is a breaking change. Every id is pinned in
 * lib/agent/operations/operation-ids.txt and test/agentRegistry.test.ts fails on any difference: to
 * keep the old id, give the classification `id: '<old id>'`; to accept a new or renamed id, update
 * the pin (`npx vitest run test/agentRegistry.test.ts -u`) and say so in the release notes.
 */
export function operationIdFor(
  method: HttpMethod,
  pattern: string,
  ctx: IdContext,
  opts: { withParams?: boolean } = {},
): string {
  const segs = apiSegments(pattern);
  const words = opts.withParams
    ? segs.map((s) => (isParam(s) ? `by-${kebab(paramName(s))}` : s))
    : segs.filter((s) => !isParam(s));
  const endsInParam = segs.length > 0 && isParam(segs[segs.length - 1]);
  const getAndPost = ctx.methods.includes('GET') && ctx.methods.includes('POST');
  let verb: string | null;
  if (method === 'PATCH') verb = 'update';
  else if (method === 'PUT') verb = ctx.methods.includes('PATCH') ? 'replace' : 'update';
  else if (method === 'DELETE') verb = 'delete';
  else if (endsInParam) verb = method === 'GET' ? 'get' : 'action';
  else if (getAndPost && ctx.collection) verb = method === 'GET' ? 'list' : 'create';
  else if (getAndPost) verb = method === 'GET' ? null : 'post';
  else verb = null;
  return [...words, ...(verb ? [verb] : [])].join('.');
}

/**
 * The patterns that have records under them: for every route, each prefix of it that is followed
 * by a parameter ("/api/invoices/[id]/email" -> "/api/invoices").
 */
export function collectionPatterns(patterns: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const segs = pattern.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      if (isParam(segs[i])) out.add('/' + segs.slice(0, i).join('/'));
    }
  }
  return out;
}

/** The id rule's context for one route of a route map. */
export function idContextFor(
  pattern: string,
  permissions: Record<string, MethodRules>,
  collections: Set<string> = collectionPatterns(Object.keys(permissions)),
): IdContext {
  const rules = permissions[pattern] ?? {};
  return { methods: HTTP_METHODS.filter((m) => rules[m] !== undefined), collection: collections.has(pattern) };
}

// ---------------------------------------------------------------------------
// Building the registry
// ---------------------------------------------------------------------------

/** Where the registry reads from. Tests pass their own; the app uses the real maps. */
export interface RegistrySources {
  permissions: Record<string, MethodRules>;
  generated: Record<string, GeneratedRoute>;
  classes: ClassificationMap;
  /** The operations that are not API routes (shell.ts). Left out: none. */
  shell?: readonly ShellOperationDef[];
}

/** Two or more operations that ended up with the same id (the registry refuses to run then). */
export interface IdCollision {
  id: string;
  keys: OperationKey[];
}

export interface BuiltRegistry {
  operations: Operation[];
  collisions: IdCollision[];
}

/** Body kind when neither the classification nor the generated reader says. */
const DEFAULT_BODY: Record<HttpMethod, BodyKind> = {
  GET: 'none',
  POST: 'json',
  PUT: 'json',
  PATCH: 'json',
  DELETE: 'none',
};

/** Classes that only read: no dry run (a dry run is for changes). */
const READ_CLASSES: readonly RiskClass[] = ['read', 'read_sensitive'];

function defaultDryRun(cls: RiskClass, c: OperationClassification | undefined): DryRunKind {
  if (cls === 'read') return 'none'; // types.ts: ignored for 'read'
  if (c?.dryRun) return c.dryRun;
  return READ_CLASSES.includes(cls) ? 'none' : 'transaction';
}

function frozen<T>(list: readonly T[] | undefined): T[] {
  return Object.freeze([...(list ?? [])]) as T[];
}

function makeOperation(
  id: string,
  method: HttpMethod,
  pattern: string,
  src: RegistrySources,
): Operation {
  const rule = src.permissions[pattern]?.[method] ?? null;
  const gen = src.generated[pattern]?.methods[method];
  const c: OperationClassification | undefined = src.classes[operationKey(method, pattern)];
  const area = rule && typeof rule === 'object' ? rule.area : null;
  const cls: RiskClass = c ? c.class : 'admin';
  return Object.freeze({
    id,
    kind: 'route' as const,
    route: pattern,
    method,
    params: frozen(routeParamNames(pattern)),
    // A frozen copy: the route map's own entry is what a person's requests are checked against,
    // and a caller holding the operation must not be able to change it.
    rule: rule && typeof rule === 'object' ? Object.freeze({ ...rule }) : rule,
    area,
    action: rule && typeof rule === 'object' ? rule.action : null,
    activity: area ? activityForRoute(pattern, method, area) : null,
    classified: !!c,
    class: cls,
    describe: c?.describe ?? `Use ${method} ${pattern}`,
    availability: c?.availability ?? 'agent',
    why: c?.why ?? null,
    dryRun: defaultDryRun(cls, c),
    // The reader's "none" only means it saw no read; the method's default is the safer guess then.
    body: c?.body ?? (gen && gen.body !== 'none' ? gen.body : DEFAULT_BODY[method]),
    output: c?.output ?? gen?.output ?? 'json',
    confirmFlags: frozen(c?.confirmFlags),
    sensitiveFields: frozen(c?.sensitiveFields),
    reveal: c?.reveal ?? null,
    hostOnly: c?.hostOnly ?? false,
    fileAdmin: c?.fileAdmin ?? false,
    needsSecret: frozen(c?.needsSecret),
    producesSecret: frozen(c?.producesSecret),
    effects: frozen(c?.effects),
    countField: c?.countField ?? null,
    amountField: c?.amountField ?? null,
    alwaysAsk: c?.alwaysAsk ?? false,
    bodySchema: c?.bodySchema ?? gen?.bodySchema ?? null,
  });
}

/**
 * An operation that is not an API route (shell.ts, plan §5.5). The desktop shell or the server
 * carries it out, and only with a person's approval ticket, so it always asks (even where the policy
 * says Allow, and a grant never covers it) and has no dry run (it acts outside the database). It has
 * no route rule: its "route" is the flow's name, which no request path can reach, so
 * operationForRoute, operationForPath and loadRouteHandler never hand one out.
 */
function makeShellOperation(def: ShellOperationDef): Operation {
  // Fail closed on a definition whose class is not one we know: treat it as unclassified (admin).
  const known = isRiskClass(def.class);
  return Object.freeze({
    id: def.id,
    kind: 'shell' as const,
    route: def.flow,
    method: 'POST' as const,
    params: frozen<string>([]),
    rule: null,
    area: def.area ?? null,
    action: null,
    activity: null,
    classified: known,
    class: known ? def.class : 'admin',
    describe: def.describe,
    availability: 'agent' as const,
    why: def.why || null,
    dryRun: 'none' as const,
    body: 'json' as const,
    output: 'json' as const,
    confirmFlags: frozen<string>([]),
    sensitiveFields: frozen<string>([]),
    reveal: null,
    hostOnly: def.hostOnly === true,
    fileAdmin: def.fileAdmin === true,
    needsSecret: frozen<SecretKind>(def.needsSecret),
    producesSecret: frozen<SecretKind>([]),
    effects: frozen<EffectKind>([]),
    countField: null,
    amountField: null,
    alwaysAsk: true,
    bodySchema: null,
  });
}

/**
 * Every route + method of the route map as an operation, in route then method order, with the id
 * rule applied (operationIdFor) and the classification's own ids last; then the shell operations
 * with the ids their definitions give. Pure: same input, same out.
 *
 * A shell id that is also a route's id (or another shell operation's) is reported as a collision,
 * never resolved: the registry refuses to run until one of them is renamed.
 */
export function buildOperations(src: RegistrySources): BuiltRegistry {
  const entries: Array<{ method: HttpMethod; pattern: string; ctx: IdContext; override?: string }> = [];
  const collections = collectionPatterns(Object.keys(src.permissions));
  for (const pattern of Object.keys(src.permissions).sort()) {
    const ctx = idContextFor(pattern, src.permissions, collections);
    for (const method of ctx.methods) {
      entries.push({ method, pattern, ctx, override: src.classes[operationKey(method, pattern)]?.id });
    }
  }

  // Rule steps 1-2, then step 3 among the ids that clash (classification ids take no part).
  const ids = entries.map((e) => e.override ?? operationIdFor(e.method, e.pattern, e.ctx));
  const derivedCount = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!e.override) derivedCount.set(ids[i], (derivedCount.get(ids[i]) ?? 0) + 1);
  });
  entries.forEach((e, i) => {
    if (!e.override && derivedCount.get(ids[i])! > 1 && routeParamNames(e.pattern).length > 0) {
      ids[i] = operationIdFor(e.method, e.pattern, e.ctx, { withParams: true });
    }
  });

  // Shell ids take no part in step 3: they are written by hand, and a clash is reported below.
  const operations = [
    ...entries.map((e, i) => makeOperation(ids[i], e.method, e.pattern, src)),
    ...(src.shell ?? []).map(makeShellOperation),
  ];

  const byId = new Map<string, OperationKey[]>();
  for (const op of operations) {
    const keys = byId.get(op.id) ?? [];
    keys.push(operationKey(op.method, op.route));
    byId.set(op.id, keys);
  }
  const collisions = [...byId]
    .filter(([, keys]) => keys.length > 1)
    .map(([id, keys]) => ({ id, keys }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { operations, collisions };
}

interface Registry {
  operations: Operation[];
  collisions: IdCollision[];
  byId: Map<string, Operation>;
  byKey: Map<string, Operation>;
}

let registry: Registry | null = null;

function load(): Registry {
  if (registry) return registry;
  const built = buildOperations({
    permissions: API_ROUTE_PERMISSIONS,
    generated: GENERATED_ROUTES,
    classes: OPERATION_CLASSES,
    shell: SHELL_OPERATIONS,
  });
  const byId = new Map<string, Operation>();
  // Routes only: a shell operation's "route" is a flow name, which must never match a request.
  const byKey = new Map<string, Operation>();
  for (const op of built.operations) {
    if (!byId.has(op.id)) byId.set(op.id, op);
    if (op.kind === 'route') byKey.set(operationKey(op.method, op.route), op);
  }
  registry = { ...built, operations: Object.freeze(built.operations) as Operation[], byId, byKey };
  return registry;
}

function assertNoCollisions(r: Registry): void {
  if (r.collisions.length === 0) return;
  // Fail closed: with two operations under one id, a request could run the wrong one.
  throw new Error(
    'Two or more agent operations share an id: ' +
      r.collisions.map((c) => `${c.id} (${c.keys.join(', ')})`).join('; ') +
      '. Give one of them its own "id" in lib/agent/operations/classes.',
  );
}

/** Ids shared by more than one operation. Empty in a healthy build (test/agentRegistry.test.ts). */
export function idCollisions(): IdCollision[] {
  return load().collisions.map((c) => ({ id: c.id, keys: [...c.keys] }));
}

/** Every operation. Throws when two share an id. */
export function allOperations(): readonly Operation[] {
  const r = load();
  assertNoCollisions(r);
  return r.operations;
}

export function operationById(id: string): Operation | null {
  const r = load();
  assertNoCollisions(r);
  return r.byId.get(id) ?? null;
}

function normalizeMethod(method: string): HttpMethod | null {
  const m = method.toUpperCase();
  if (m === 'HEAD') return 'GET'; // answered by the GET handler, as apiRuleFor does
  return (HTTP_METHODS as readonly string[]).includes(m) ? (m as HttpMethod) : null;
}

/** The operation for a route pattern ("/api/invoices/[id]") and method, or null. */
export function operationForRoute(method: string, pattern: string): Operation | null {
  const m = normalizeMethod(method);
  if (!m) return null;
  const r = load();
  assertNoCollisions(r);
  return r.byKey.get(operationKey(m, pattern)) ?? null;
}

/** Path parameter values as Next passes them: one string each, a list for a catch-all. */
export type RouteParams = Record<string, string | string[]>;

/** The values of a pattern's parameters in a concrete path, decoded; null when they do not fit. */
export function paramsFromPath(pattern: string, pathname: string): RouteParams | null {
  const psegs = pattern.split('/').filter(Boolean);
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const out: RouteParams = {};
  try {
    for (let i = 0; i < psegs.length; i++) {
      const p = psegs[i];
      if (p.startsWith('[...') || p.startsWith('[[...')) {
        out[paramName(p)] = segs.slice(i).map(decodeURIComponent);
        return out;
      }
      if (i >= segs.length) return null;
      if (isParam(p)) out[paramName(p)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) return null;
    }
  } catch {
    return null; // a malformed %-escape: Next refuses the request too
  }
  return segs.length === psegs.length ? out : null;
}

/**
 * The operation a concrete request path names ("/api/invoices/0b3…/email"), with its parameter
 * values. Matching is the route map's own (matchRoutePattern), so an agent's path reaches exactly
 * the route a person's would. A query string or fragment is ignored.
 *
 * The activity is the one this path needs, as apiActivityFor works it out for a person: a route
 * addressed by kind (/api/sales-forms/[kind]/[id]/pdf) needs the activity of that kind, which the
 * pattern alone cannot say (the registry's own entry has null there, and the policy would check the
 * whole area). The operation is then a frozen copy with that activity and the same id;
 * loadRouteHandler accepts it.
 */
export function operationForPath(
  method: string,
  pathname: string,
): { operation: Operation; params: RouteParams } | null {
  const path = pathname.split(/[?#]/)[0];
  if (!path.startsWith('/api/')) return null;
  const pattern = matchRoutePattern(path);
  if (!pattern) return null;
  const registered = operationForRoute(method, pattern);
  if (!registered) return null;
  const params = paramsFromPath(pattern, path);
  if (!params) return null;
  const activity = registered.area ? activityForRoute(pattern, registered.method, registered.area, path) : null;
  const operation = activity === registered.activity ? registered : Object.freeze({ ...registered, activity });
  return { operation, params };
}

/** A Next route handler as the bridge calls it. */
export type RouteHandler = (req: Request, ctx: { params: Promise<RouteParams> }) => Promise<Response>;

/**
 * The route module's function for this operation's method. Server only: the first call loads the
 * import map (loaders.generated.ts), and each call loads just that one route module.
 *
 * The operation must be one the registry handed out (or operationForPath's copy of one): its id,
 * route and method must name the same registered operation. A caller that checked the policy on one
 * operation and then passed an edited object would otherwise run a handler nobody approved.
 */
export async function loadRouteHandler(operation: Operation): Promise<RouteHandler> {
  if (operation.kind !== 'route') throw new Error(`${operation.id} is not an API route.`);
  const r = load();
  assertNoCollisions(r);
  const registered = r.byKey.get(operationKey(operation.method, operation.route));
  if (!registered || registered.id !== operation.id) {
    throw new Error(
      `${operation.method} ${operation.route} is not the registered operation "${operation.id}". ` +
        'Look the operation up again (operationById or operationForPath) and use what it returns.',
    );
  }
  const { ROUTE_LOADERS } = await import('./loaders.generated');
  const loader = ROUTE_LOADERS[registered.route];
  if (!loader) {
    throw new Error(`No handler is listed for ${registered.route}. Run \`npm run agent:registry\`.`);
  }
  const mod = (await loader()) as Record<string, unknown>;
  const handler = mod[registered.method];
  if (typeof handler !== 'function') {
    throw new Error(`${registered.route} has no ${registered.method} handler.`);
  }
  return handler as RouteHandler;
}

export interface FindOperationsOptions {
  /** Words to look for in the id, the description and the route (all must appear). */
  query?: string;
  area?: Area;
  class?: RiskClass;
  method?: HttpMethod;
  availability?: Availability;
  /** Default 30, at most 200. */
  limit?: number;
}

export const FIND_DEFAULT_LIMIT = 30;
export const FIND_MAX_LIMIT = 200;

/**
 * Search the operations, best match first. Case-insensitive; every word of the query must appear
 * in the id, the description or the route. An exact id, then id matches, rank above route and
 * description matches; ties are in id order.
 */
export function findOperations(opts: FindOperationsOptions = {}): Operation[] {
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const whole = (opts.query ?? '').trim().toLowerCase();
  const asked = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : FIND_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(asked, FIND_MAX_LIMIT));
  const scored: Array<{ op: Operation; score: number }> = [];
  for (const op of allOperations()) {
    if (opts.area && op.area !== opts.area) continue;
    if (opts.class && op.class !== opts.class) continue;
    if (opts.method && op.method !== opts.method) continue;
    if (opts.availability && op.availability !== opts.availability) continue;
    const id = op.id.toLowerCase();
    const route = `${op.method} ${op.route}`.toLowerCase();
    const describe = op.describe.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (id.includes(w) ? 4 : 0) + (route.includes(w) ? 2 : 0) + (describe.includes(w) ? 1 : 0);
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (!all) continue;
    if (whole && id === whole) score += 100;
    else if (whole && id.startsWith(whole)) score += 10;
    scored.push({ op, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.op);
}

/** Operations with no hand-written classification (class 'admin' until someone classifies them). */
export function unclassifiedOperations(): Operation[] {
  return allOperations().filter((op) => !op.classified);
}
