/**
 * Agent full access: the operation registry's own rules (ids, defaults, lookups, search). The
 * completeness checks over every route live in test/agentRegistry.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { API_ROUTE_PERMISSIONS, type HttpMethod, type MethodRules } from '@/lib/permissions/routes';
import { activityForRoute } from '@/lib/permissions/routeActivities';
import { OPERATION_CLASSES } from './classes';
import { GENERATED_ROUTES, type GeneratedRoute } from './routes.generated';
import {
  FIND_DEFAULT_LIMIT,
  allOperations,
  buildOperations,
  collectionPatterns,
  findOperations,
  idContextFor,
  loadRouteHandler,
  operationById,
  operationForPath,
  operationForRoute,
  operationIdFor,
  paramsFromPath,
  routeParamNames,
  type RegistrySources,
} from './registry';
import { operationKey, type ClassificationMap } from './types';

/** The id the rule gives a real route (no classification override). */
const realId = (method: HttpMethod, pattern: string) =>
  operationIdFor(method, pattern, idContextFor(pattern, API_ROUTE_PERMISSIONS));

/** A fixed shuffle (a small LCG), so a failure can be run again. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sources(permissions: Record<string, MethodRules>, classes: ClassificationMap = {}): RegistrySources {
  const generated: Record<string, GeneratedRoute> = {};
  for (const p of Object.keys(permissions)) if (GENERATED_ROUTES[p]) generated[p] = GENERATED_ROUTES[p];
  return { permissions, generated, classes };
}

describe('operation ids', () => {
  it('follow the plan examples', () => {
    expect(realId('GET', '/api/invoices')).toBe('invoices.list');
    expect(realId('POST', '/api/invoices')).toBe('invoices.create');
    expect(realId('GET', '/api/invoices/[id]')).toBe('invoices.get');
    expect(realId('PATCH', '/api/invoices/[id]')).toBe('invoices.update');
    expect(realId('DELETE', '/api/invoices/[id]')).toBe('invoices.delete');
    expect(realId('POST', '/api/invoices/[id]/email')).toBe('invoices.email');
    expect(realId('POST', '/api/reconciliations/undo')).toBe('reconciliations.undo');
    expect(realId('POST', '/api/bank-rules')).toBe('bank-rules.create');
    expect(realId('POST', '/api/month-end-close/scan')).toBe('month-end-close.scan');
    expect(realId('PATCH', '/api/company/closing-date')).toBe('company.closing-date.update');
    expect(realId('POST', '/api/leads/[id]/convert')).toBe('leads.convert');
  });

  it('name a PUT "update", or "replace" when the route also has PATCH', () => {
    expect(operationIdFor('PUT', '/api/company/closing-date', { methods: ['GET', 'PUT'], collection: false })).toBe(
      'company.closing-date.update',
    );
    expect(realId('PUT', '/api/invoices/[id]')).toBe('invoices.replace');
  });

  it('call a GET + POST route a list only when it has records under it', () => {
    const built = buildOperations(
      sources({
        '/api/things': { GET: 'member', POST: 'member' },
        '/api/things/[id]': { GET: 'member' },
        '/api/widgets': { GET: 'member', POST: 'member' },
        '/api/widgets/[id]/parts': { GET: 'member' },
        '/api/backup': { GET: 'member', POST: 'member' },
        '/api/backup/company': { GET: 'member', POST: 'member' },
      }),
    );
    expect(built.operations.map((o) => `${o.id} = ${o.method} ${o.route}`)).toEqual([
      'backup = GET /api/backup',
      'backup.post = POST /api/backup',
      'backup.company = GET /api/backup/company',
      'backup.company.post = POST /api/backup/company',
      'things.list = GET /api/things',
      'things.create = POST /api/things',
      'things.get = GET /api/things/[id]',
      'widgets.list = GET /api/widgets',
      'widgets.create = POST /api/widgets',
      'widgets.parts = GET /api/widgets/[id]/parts',
    ]);
    expect([...collectionPatterns(['/api/a/[id]/b/[lineId]', '/api/c'])].sort()).toEqual(['/api/a', '/api/a/[id]/b']);
    // The real ones: downloading a backup is not "list", restoring one is not "create".
    expect(realId('GET', '/api/backup')).toBe('backup');
    expect(realId('POST', '/api/backup')).toBe('backup.post');
    expect(realId('POST', '/api/file-lock')).toBe('file-lock.post');
  });

  it('give list/create to a word route with no records under it only by a classification id', () => {
    // Every such name must be a deliberate choice, written in the classification.
    const collections = collectionPatterns(Object.keys(API_ROUTE_PERMISSIONS));
    const notLists = allOperations()
      .filter((o) => o.kind === 'route' && /\.(list|create)$/.test(o.id) && !collections.has(o.route))
      .filter((o) => !OPERATION_CLASSES[operationKey(o.method, o.route)]?.id)
      .map((o) => `${o.id} = ${o.method} ${o.route}`);
    expect(notLists).toEqual([]);
  });

  it('name a POST to one record "action" (the body names what it does)', () => {
    // Converting an estimate is POST /api/estimates/[id] with { action: 'convert' }, next to
    // 'progress' and 'void': one route, so one operation.
    expect(realId('POST', '/api/estimates/[id]')).toBe('estimates.action');
  });

  it('add no verb to a word route that is not a list', () => {
    expect(realId('GET', '/api/reports/profit-loss')).toBe('reports.profit-loss');
    expect(realId('GET', '/api/company/closing-date')).toBe('company.closing-date');
    expect(realId('GET', '/api/invoices/[id]/pdf')).toBe('invoices.pdf');
  });

  it('keep the parameters ("by-<name>") only when two routes would clash', () => {
    const built = buildOperations(
      sources({
        '/api/loans/what-if': { POST: { area: 'accounting', action: 'view' } },
        '/api/loans/[id]/what-if': { POST: { area: 'accounting', action: 'view' } },
        '/api/accounts/[accountId]/lines': { GET: { area: 'accounting', action: 'view' } },
      }),
    );
    expect(built.collisions).toEqual([]);
    expect(built.operations.map((o) => `${o.id} = ${o.method} ${o.route}`).sort()).toEqual([
      'accounts.lines = GET /api/accounts/[accountId]/lines',
      'loans.by-id.what-if = POST /api/loans/[id]/what-if',
      'loans.what-if = POST /api/loans/what-if',
    ]);
    expect(operationIdFor('GET', '/api/accounts/[accountId]/lines', { methods: ['GET'], collection: false }, { withParams: true })).toBe(
      'accounts.by-account-id.lines',
    );
  });

  it('let a classification name the id, and report a clash instead of guessing', () => {
    const perms = {
      '/api/invoices': { GET: 'member', POST: 'member' },
      '/api/invoices/[id]': { GET: 'member' },
    } satisfies Record<string, MethodRules>;
    const own = buildOperations(sources(perms, { 'POST /api/invoices': { class: 'enter', describe: 'Enter an invoice', id: 'invoices.enter' } }));
    expect(own.operations.map((o) => o.id)).toEqual(['invoices.list', 'invoices.enter', 'invoices.get']);
    expect(own.collisions).toEqual([]);

    const clash = buildOperations(sources(perms, { 'POST /api/invoices': { class: 'enter', describe: 'Enter an invoice', id: 'invoices.list' } }));
    expect(clash.collisions).toEqual([{ id: 'invoices.list', keys: ['GET /api/invoices', 'POST /api/invoices'] }]);
  });

  it('are unique in the real registry, and do not depend on the order of the maps', () => {
    const named = (ops: readonly { id: string; method: string; route: string }[]) =>
      ops.map((o) => `${o.method} ${o.route} -> ${o.id}`);
    const real = named(allOperations());
    const ids = allOperations().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The same maps with their keys in another order give the very same ids, route for route.
    for (const seed of [1, 7, 2026]) {
      const permissions = Object.fromEntries(shuffled(Object.entries(API_ROUTE_PERMISSIONS), seed));
      const classes = Object.fromEntries(shuffled(Object.entries(OPERATION_CLASSES), seed + 1));
      const built = buildOperations({ permissions, generated: GENERATED_ROUTES, classes });
      expect(built.collisions).toEqual([]);
      expect(named(built.operations)).toEqual(real);
    }
    // The full id list is pinned in operation-ids.txt (test/agentRegistry.test.ts).
    expect(operationById('invoices.email')?.route).toBe('/api/invoices/[id]/email');
    expect(operationById('bank-transactions.by-id.matches')?.route).toBe('/api/bank-transactions/[id]/matches');
    expect(operationById('bank-transactions.matches')?.route).toBe('/api/bank-transactions/matches');
  });
});

describe('defaults', () => {
  const perms: Record<string, MethodRules> = {
    '/api/estimates': { GET: { area: 'customers', action: 'view' }, POST: { area: 'customers', action: 'create' } },
    '/api/estimates/[id]': { DELETE: { area: 'customers', action: 'delete' } },
    '/api/company': { GET: 'member' },
  };

  it('fail closed for a route nobody classified', () => {
    const op = buildOperations(sources(perms)).operations.find((o) => o.id === 'estimates.create')!;
    expect(op).toMatchObject({
      kind: 'route',
      route: '/api/estimates',
      method: 'POST',
      params: [],
      rule: { area: 'customers', action: 'create' },
      area: 'customers',
      action: 'create',
      activity: 'customers.estimates',
      classified: false,
      class: 'admin',
      describe: 'Use POST /api/estimates',
      availability: 'agent',
      why: null,
      dryRun: 'transaction',
      body: 'json',
      output: 'json',
      confirmFlags: [],
      sensitiveFields: [],
      reveal: null,
      hostOnly: false,
      fileAdmin: false,
      needsSecret: [],
      producesSecret: [],
      effects: [],
      countField: null,
      amountField: null,
      alwaysAsk: false,
      // read from the handler by scripts/agent-registry.mjs
      bodySchema: '@/lib/validation/estimates#createEstimateSchema',
    });
  });

  it('take the classification first, then the handler, then the method', () => {
    const built = buildOperations(
      sources(perms, {
        'GET /api/estimates': { class: 'read', describe: 'List estimates', dryRun: 'transaction' },
        'DELETE /api/estimates/[id]': { class: 'remove', describe: 'Delete estimate {id}', body: 'json', confirmFlags: ['force'] },
        'GET /api/company': { class: 'read', describe: 'Read the company settings', output: 'pdf' },
      }),
    );
    const byId = new Map(built.operations.map((o) => [o.id, o]));
    // A read never has a dry run, whatever the entry says.
    expect(byId.get('estimates.list')).toMatchObject({ classified: true, class: 'read', dryRun: 'none', body: 'none' });
    expect(byId.get('estimates.delete')).toMatchObject({ class: 'remove', dryRun: 'transaction', body: 'json', confirmFlags: ['force'], params: ['id'] });
    expect(byId.get('company')).toMatchObject({ rule: 'member', area: null, action: null, activity: null, output: 'pdf' });
  });

  it('cannot be changed by a caller', () => {
    const op = allOperations()[0];
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op.params)).toBe(true);
    // The rule is a frozen copy: changing it must not change the route map a person is checked by.
    const withArea = operationForRoute('POST', '/api/invoices')!;
    expect(withArea.rule).toEqual(API_ROUTE_PERMISSIONS['/api/invoices'].POST);
    expect(Object.isFrozen(withArea.rule)).toBe(true);
    expect(withArea.rule).not.toBe(API_ROUTE_PERMISSIONS['/api/invoices'].POST);
    expect(() => {
      (withArea.rule as { area: string }).area = 'payroll';
    }).toThrow();
    expect(API_ROUTE_PERMISSIONS['/api/invoices'].POST).toEqual(withArea.rule);
  });
});

describe('lookups', () => {
  it('find an operation by route pattern and method', () => {
    expect(operationForRoute('get', '/api/invoices')?.id).toBe('invoices.list');
    expect(operationForRoute('HEAD', '/api/invoices')?.id).toBe('invoices.list');
    expect(operationForRoute('OPTIONS', '/api/invoices')).toBeNull();
    expect(operationForRoute('PUT', '/api/invoices')).toBeNull();
    expect(operationForRoute('GET', '/api/no-such-route')).toBeNull();
  });

  it('find an operation by concrete path, with its parameter values', () => {
    expect(operationForPath('POST', '/api/invoices/abc%20123/email?x=1')).toMatchObject({
      operation: { id: 'invoices.email' },
      params: { id: 'abc 123' },
    });
    // Static segments beat parameters, as in the route map.
    expect(operationForPath('POST', '/api/estimates/expire')?.operation.id).toBe('estimates.expire');
    expect(operationForPath('GET', '/api/invoices/')?.operation.id).toBe('invoices.list');
    expect(operationForPath('GET', '/api/invoices/%E0%A4%A')).toBeNull();
    expect(operationForPath('PUT', '/api/invoices')).toBeNull();
    expect(operationForPath('GET', '/invoices')).toBeNull();
    expect(operationForPath('GET', '/api/nothing/here')).toBeNull();
  });

  it('give a path the activity a person would need for it (routes addressed by kind)', () => {
    const pattern = '/api/sales-forms/[kind]/[id]/pdf';
    const registered = operationForRoute('GET', pattern)!;
    expect(registered.activity).toBeNull(); // the pattern alone cannot say which form
    const hit = operationForPath('GET', '/api/sales-forms/estimate/e1/pdf')!;
    expect(hit.operation.id).toBe(registered.id);
    expect(hit.operation.activity).toBe('customers.estimates');
    expect(hit.operation.activity).toBe(activityForRoute(pattern, 'GET', 'customers', '/api/sales-forms/estimate/e1/pdf'));
    expect(Object.isFrozen(hit.operation)).toBe(true);
    expect(operationForPath('GET', '/api/sales-forms/invoice/i1/pdf')!.operation.activity).toBe('customers.invoices');
    // An unknown kind keeps null: the policy then checks the whole area (fail closed).
    expect(operationForPath('GET', '/api/sales-forms/nonsense/x/pdf')!.operation.activity).toBeNull();
    // Everywhere else it is the registered operation itself.
    expect(operationForPath('POST', '/api/invoices/abc/email')!.operation).toBe(operationById('invoices.email'));
  });

  it('read parameters from a path', () => {
    expect(routeParamNames('/api/registers/[accountId]')).toEqual(['accountId']);
    expect(paramsFromPath('/api/registers/[accountId]', '/api/registers/a1')).toEqual({ accountId: 'a1' });
    expect(paramsFromPath('/api/x/[...rest]', '/api/x/a/b%2Fc')).toEqual({ rest: ['a', 'b/c'] });
    expect(paramsFromPath('/api/registers/[accountId]', '/api/registers/a1/more')).toBeNull();
  });
});

describe('findOperations', () => {
  it('ranks id matches first and needs every word', () => {
    const hits = findOperations({ query: 'Invoices EMAIL' });
    expect(hits[0].id).toBe('invoices.email');
    for (const h of hits) expect(`${h.id} ${h.method} ${h.route} ${h.describe}`.toLowerCase()).toMatch(/invoices/);
    expect(findOperations({ query: 'invoices.list' })[0].id).toBe('invoices.list');
    expect(findOperations({ query: 'zzz-nothing-matches' })).toEqual([]);
  });

  it('returns at most 30 by default, and filters', () => {
    expect(findOperations().length).toBe(FIND_DEFAULT_LIMIT);
    expect(findOperations({ limit: 5 }).length).toBe(5);
    expect(findOperations({ limit: 10_000 }).length).toBeLessThanOrEqual(200);
    expect(findOperations({ limit: Number.NaN }).length).toBe(FIND_DEFAULT_LIMIT);
    const payroll = findOperations({ area: 'payroll', limit: 200 });
    expect(payroll.length).toBeGreaterThan(0);
    for (const op of payroll) expect(op.area).toBe('payroll');
    for (const op of findOperations({ method: 'DELETE', limit: 200 })) expect(op.method).toBe('DELETE');
    const cls = allOperations()[0].class;
    for (const op of findOperations({ class: cls, limit: 200 })) expect(op.class).toBe(cls);
  });
});

describe('loading handlers', () => {
  it('does not import the handlers when the registry is imported', () => {
    const src = fs.readFileSync(path.join(__dirname, 'registry.ts'), 'utf8');
    expect(src).not.toMatch(/^import[^;]*from '\.\/loaders\.generated'/m);
    expect(src).toMatch(/await import\('\.\/loaders\.generated'\)/);
  });

  it("returns the route module's function for the method", async () => {
    const hello = await loadRouteHandler(operationForRoute('GET', '/api/agent/hello')!);
    expect(typeof hello).toBe('function');
    // PATCH /api/assemblies is the PUT handler under another name.
    const put = await loadRouteHandler(operationForRoute('PUT', '/api/assemblies')!);
    const patch = await loadRouteHandler(operationForRoute('PATCH', '/api/assemblies')!);
    expect(patch).toBe(put);
    expect(GENERATED_ROUTES['/api/assemblies'].methods.PATCH?.aliasOf).toBe('PUT');
  });

  it('loads the handler of the copy operationForPath gives', async () => {
    const hit = operationForPath('GET', '/api/sales-forms/estimate/e1/pdf')!;
    expect(hit.operation).not.toBe(operationForRoute('GET', '/api/sales-forms/[kind]/[id]/pdf'));
    expect(typeof (await loadRouteHandler(hit.operation))).toBe('function');
  });

  it('refuses an operation the registry did not hand out', async () => {
    const list = operationForRoute('GET', '/api/invoices')!;
    // Approved as one operation, edited into another: never runs.
    await expect(loadRouteHandler({ ...list, route: '/api/invoices/[id]' })).rejects.toThrow(/not the registered operation/);
    await expect(loadRouteHandler({ ...list, method: 'POST' })).rejects.toThrow(/not the registered operation/);
    await expect(loadRouteHandler({ ...list, id: 'invoices.create' })).rejects.toThrow(/not the registered operation/);
    await expect(loadRouteHandler({ ...list, route: '/api/no-such-route' })).rejects.toThrow(/not the registered operation/);
    await expect(loadRouteHandler({ ...list, kind: 'shell' })).rejects.toThrow(/not an API route/);
  });
});
