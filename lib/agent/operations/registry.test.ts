/**
 * Agent full access: the operation registry's own rules (ids, defaults, lookups, search, the shell
 * operations). The completeness checks over every route live in test/agentRegistry.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { API_ROUTE_PERMISSIONS, type HttpMethod, type MethodRules } from '@/lib/permissions/routes';
import { activityForRoute } from '@/lib/permissions/routeActivities';
import type { ShellOperationDef } from '../contract';
import { OPERATION_CLASSES } from './classes';
import { bucketOfRoute } from './classes/buckets';
import { GENERATED_ROUTES, type GeneratedRoute } from './routes.generated';
import { SHELL_OPERATIONS } from './shell';
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

function sources(
  permissions: Record<string, MethodRules>,
  classes: ClassificationMap = {},
  shell?: readonly ShellOperationDef[],
): RegistrySources {
  const generated: Record<string, GeneratedRoute> = {};
  for (const p of Object.keys(permissions)) if (GENERATED_ROUTES[p]) generated[p] = GENERATED_ROUTES[p];
  return { permissions, generated, classes, ...(shell ? { shell } : {}) };
}

/** A shell operation definition as shell.ts would list it. */
function shellDef(over: Partial<ShellOperationDef> = {}): ShellOperationDef {
  return {
    id: 'shell.company.switch',
    runner: 'electron',
    flow: 'switchCompanyFlow',
    class: 'file',
    area: null,
    describe: 'Switch to company file {path}',
    why: 'Ironbooks closes this company file and opens another one.',
    input: { path: { type: 'path', required: true, describe: 'The company file to open' } },
    questions: [],
    needsSecret: ['file_password'],
    hostOnly: true,
    fileAdmin: true,
    restarts: true,
    ...over,
  };
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
      const built = buildOperations({ permissions, generated: GENERATED_ROUTES, classes, shell: SHELL_OPERATIONS });
      expect(built.collisions).toEqual([]);
      expect(named(built.operations)).toEqual(real);
    }
    // The full id list is pinned in operation-ids.txt (test/agentRegistry.test.ts).
    expect(operationById('invoices.email')?.route).toBe('/api/invoices/[id]/email');
    expect(operationById('bank-transactions.by-id.matches')?.route).toBe('/api/bank-transactions/[id]/matches');
    expect(operationById('bank-transactions.matches')?.route).toBe('/api/bank-transactions/matches');
  });

  it('never leave the neutral ".post" on a route a classification file names (admin.ts names its own)', () => {
    // "post" claims nothing: every such route gets a verb from its classification (id).
    const neutral = allOperations()
      .filter((o) => o.kind === 'route' && /\.post$/.test(o.id))
      .filter((o) => bucketOfRoute(o.route) !== 'admin')
      .map((o) => `${o.id} = POST ${o.route}`);
    expect(neutral).toEqual([]);
  });

  it('name what a route does where the rule would mislead', () => {
    const at = (method: HttpMethod, pattern: string) => operationForRoute(method, pattern)?.id;
    // A real list whose records live at another address: list and create.
    expect(at('GET', '/api/bank-accounts')).toBe('bank-accounts.list');
    expect(at('POST', '/api/bank-accounts')).toBe('bank-accounts.create');
    // A collection POST that does not create one: the scan of possible errors.
    expect(realId('POST', '/api/errors')).toBe('errors.create');
    expect(at('POST', '/api/errors')).toBe('errors.scan');
    // A GET whose last word is a verb only shows; the POST does it.
    expect(at('GET', '/api/sales-tax/pay')).toBe('sales-tax.due');
    // Not "sales-tax.pay": that was the GET's id, and an old read's id never comes to name a payment.
    expect(at('POST', '/api/sales-tax/pay')).toBe('sales-tax.payments.create');
    expect(operationById('sales-tax.pay')).toBeNull();
    expect(at('GET', '/api/pay-liabilities')).toBe('pay-liabilities.due');
    expect(at('POST', '/api/pay-liabilities')).toBe('pay-liabilities.pay');
    // The route's own word "post", next to the neutral one.
    expect(at('POST', '/api/invoices/[id]/post')).toBe('invoices.post-draft');
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
  it('ranks id matches first and, when some operation has every word, shows only those', () => {
    const hits = findOperations({ query: 'Invoices EMAIL' });
    expect(hits[0].id).toBe('invoices.email');
    // Plurals are taken off ("invoices" finds "invoice-reminder" too).
    for (const h of hits) {
      const text = `${h.id} ${h.method} ${h.route} ${h.describe} ${h.why ?? ''}`.toLowerCase();
      expect(text).toMatch(/invoice/);
      expect(text).toMatch(/email/);
    }
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

describe('shell operations', () => {
  const perms: Record<string, MethodRules> = {
    '/api/invoices': { GET: { area: 'customers', action: 'view' }, POST: { area: 'customers', action: 'create' } },
    '/api/invoices/[id]': { GET: { area: 'customers', action: 'view' } },
  };
  const save = shellDef({
    id: 'files.save',
    runner: 'server',
    flow: 'saveStagedFile',
    class: 'file',
    area: 'banking',
    describe: 'Save staged file {fileId} to {folder}',
    needsSecret: [],
    hostOnly: false,
    fileAdmin: false,
    restarts: false,
  });

  afterEach(() => {
    vi.doUnmock('./shell');
    vi.resetModules();
  });

  it('join the route operations as kind "shell", after them, with what the definition says', () => {
    const built = buildOperations(sources(perms, {}, [shellDef(), save]));
    expect(built.collisions).toEqual([]);
    expect(built.operations.map((o) => `${o.kind} ${o.id}`)).toEqual([
      'route invoices.list',
      'route invoices.create',
      'route invoices.get',
      'shell shell.company.switch',
      'shell files.save',
    ]);
    const op = built.operations.find((o) => o.id === 'shell.company.switch')!;
    expect(op).toEqual({
      id: 'shell.company.switch',
      kind: 'shell',
      route: 'switchCompanyFlow',
      method: 'POST',
      params: [],
      rule: null,
      area: null,
      action: null,
      activity: null,
      classified: true,
      class: 'file',
      describe: 'Switch to company file {path}',
      availability: 'agent',
      why: 'Ironbooks closes this company file and opens another one.',
      dryRun: 'none',
      body: 'json',
      output: 'json',
      confirmFlags: [],
      sensitiveFields: [],
      reveal: null,
      hostOnly: true,
      fileAdmin: true,
      needsSecret: ['file_password'],
      producesSecret: [],
      effects: [],
      countField: null,
      amountField: null,
      alwaysAsk: true,
      bodySchema: null,
    });
    // An Allow policy or a grant never runs one: it always asks.
    expect(built.operations.find((o) => o.id === 'files.save')).toMatchObject({
      kind: 'shell',
      route: 'saveStagedFile',
      area: 'banking',
      hostOnly: false,
      fileAdmin: false,
      needsSecret: [],
      alwaysAsk: true,
    });
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op.needsSecret)).toBe(true);
  });

  it('do not share the definition list (a later change to it changes no operation)', () => {
    const def = shellDef();
    const op = buildOperations(sources({}, {}, [def])).operations[0];
    (def.needsSecret as string[]).push('backup_password');
    expect(op.needsSecret).toEqual(['file_password']);
  });

  it('fail closed on a definition whose class is not a risk class', () => {
    const bad = shellDef({ class: 'whatever' as never });
    const op = buildOperations(sources({}, {}, [bad])).operations[0];
    expect(op).toMatchObject({ classified: false, class: 'admin', alwaysAsk: true });
  });

  it('report an id that is also a route\'s, or another shell operation\'s, as a collision', () => {
    const clash = buildOperations(sources(perms, {}, [shellDef({ id: 'invoices.create' })]));
    expect(clash.collisions).toEqual([{ id: 'invoices.create', keys: ['POST /api/invoices', 'POST switchCompanyFlow'] }]);
    const twice = buildOperations(sources(perms, {}, [shellDef(), shellDef({ flow: 'otherFlow' })]));
    expect(twice.collisions).toEqual([{ id: 'shell.company.switch', keys: ['POST switchCompanyFlow', 'POST otherFlow'] }]);
    // A clash with a route's derived id is never resolved by renaming the route ("by-<param>").
    const derived = buildOperations(sources(perms, {}, [shellDef({ id: 'invoices.get' })]));
    expect(derived.collisions.map((c) => c.id)).toEqual(['invoices.get']);
  });

  it('are found by id and by search, never by route, by path or as a handler', async () => {
    vi.resetModules();
    vi.doMock('./shell', () => ({ SHELL_OPERATIONS: [shellDef(), save] }));
    const reg = await import('./registry');
    const op = reg.operationById('shell.company.switch')!;
    expect(op).toMatchObject({ kind: 'shell', route: 'switchCompanyFlow' });
    expect(reg.allOperations().filter((o) => o.kind === 'shell').map((o) => o.id)).toEqual(['shell.company.switch', 'files.save']);
    expect(reg.findOperations({ query: 'shell.company.switch' })[0].id).toBe('shell.company.switch');
    expect(reg.findOperations({ query: 'staged file' }).map((o) => o.id)).toContain('files.save');
    expect(reg.findOperations({ class: 'file', limit: 200 }).map((o) => o.id)).toContain('files.save');
    // Its "route" is a flow name: no route lookup, no request path and no handler reaches it.
    expect(reg.operationForRoute('POST', 'switchCompanyFlow')).toBeNull();
    expect(reg.operationForPath('POST', 'switchCompanyFlow')).toBeNull();
    expect(reg.operationForPath('POST', '/api/switchCompanyFlow')).toBeNull();
    await expect(reg.loadRouteHandler(op)).rejects.toThrow(/not an API route/);
    await expect(reg.loadRouteHandler({ ...op, kind: 'route' })).rejects.toThrow(/not the registered operation/);
    // The routes are as before.
    expect(reg.operationById('invoices.email')?.kind).toBe('route');
    expect(reg.idCollisions()).toEqual([]);
  });

  it('stop the registry when a shell id clashes with a route', async () => {
    vi.resetModules();
    vi.doMock('./shell', () => ({ SHELL_OPERATIONS: [shellDef({ id: 'invoices.email' })] }));
    const reg = await import('./registry');
    expect(reg.idCollisions()).toEqual([
      { id: 'invoices.email', keys: ['POST /api/invoices/[id]/email', 'POST switchCompanyFlow'] },
    ]);
    expect(() => reg.operationById('invoices.email')).toThrow(/share an id/);
    expect(() => reg.allOperations()).toThrow(/share an id/);
  });

  it('in the real registry, are exactly the definitions of shell.ts', () => {
    const shell = allOperations().filter((o) => o.kind === 'shell');
    expect(shell.map((o) => o.id)).toEqual(SHELL_OPERATIONS.map((d) => d.id));
    for (const def of SHELL_OPERATIONS) {
      expect(operationById(def.id)).toMatchObject({ kind: 'shell', route: def.flow, rule: null, alwaysAsk: true, dryRun: 'none' });
      expect(operationForRoute('POST', def.flow)).toBeNull();
    }
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

describe('an operation whose route parses its body by hand', () => {
  it('lists the fields the route reads and the body its header documents, for describe_operation', async () => {
    const { operationById } = await import('./registry');
    const email = operationById('collections.email');
    expect(email?.bodySchema).toBeNull();
    expect(email?.bodyFields).toEqual(expect.arrayContaining(['customerId', 'what', 'to', 'invoiceIds']));
    expect(email?.bodyDoc).toMatch(/what: 'invoices' \| 'statement'/);
    // A header whose fields follow on the next lines.
    expect(operationById('finance-charges')?.bodyDoc).toMatch(/asOf .*customerIds .*settings/);
    // An operation with a schema gets neither.
    const bill = operationById('bills.create');
    expect(bill?.bodySchema).not.toBeNull();
    expect(bill?.bodyFields).toBeUndefined();
    expect(bill?.bodyDoc).toBeUndefined();
  });
});

describe('find_operations in a person\'s words', () => {
  it('finds an operation when not every word of the query names it, best match first', async () => {
    const { findOperations } = await import('./registry');
    // "memorized" is nowhere in recurring.create's id, route or description; the rest is.
    expect(findOperations({ query: 'memorized recurring invoice' }).map((o) => o.id)).toContain('recurring.create');
    // Plurals and common words do not stop a match.
    expect(findOperations({ query: 'set the closing dates' }).map((o) => o.id)).toContain('company.closing-date.update');
    // Every word matching still ranks first, and a word matching nothing still finds nothing.
    expect(findOperations({ query: 'invoices email' })[0].id).toBe('invoices.email');
    expect(findOperations({ query: 'zzz-nothing-matches' })).toEqual([]);
  });
});
