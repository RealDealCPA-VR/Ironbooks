/**
 * prefsperms (PARITY K): QB Enterprise activities — catalog, route/page mapping, and the upgrade
 * guarantee that every role stored before activities keeps EXACTLY the access it had.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITIES,
  ACTIVITY_KEYS,
  activitiesOf,
  activityDef,
  supportedActions,
  accessLevel,
} from './activities';
import {
  ACTIONS,
  AREA_KEYS,
  BUILTIN_ROLES,
  can,
  canActivity,
  canWholeArea,
  isSubset,
  normalizeActivities,
  normalizeGrant,
  unionRoles,
  type Action,
  type Area,
  type PermissionGrant,
  type RoleDefinition,
} from './model';
import { API_ROUTE_PERMISSIONS, PAGE_AREAS, apiActivityFor, pageAccessFor, pageAreasFor, type HttpMethod } from './routes';
import { authorizeRequest } from './enforce';
import { activityForRoute } from './routeActivities';
import { REPORT_CATALOG, reportActivity } from '@/lib/reports/catalog';

const UUID = '11111111-2222-4333-8444-555555555555';
const SAMPLE: Record<string, string> = {
  '[kind]': 'invoice',
  '[list]': 'terms',
  '[report]': 'profit-loss',
  '[accountId]': UUID,
  '[token]': 'abc',
};
/** A concrete request path for a route pattern. */
function concrete(pattern: string, kind?: string): string {
  return pattern
    .split('/')
    .map((seg) => (seg === '[kind]' && kind ? kind : seg.startsWith('[') ? (SAMPLE[seg] ?? UUID) : seg))
    .join('/');
}

const SALES_KINDS = ['invoice', 'estimate', 'sales_receipt', 'credit_memo', 'sales_order'];

function areaRoutes(): Array<{ pattern: string; method: HttpMethod; area: Area; action: Action; paths: string[] }> {
  const out: Array<{ pattern: string; method: HttpMethod; area: Area; action: Action; paths: string[] }> = [];
  for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
    for (const [m, rule] of Object.entries(rules)) {
      if (!rule || typeof rule !== 'object') continue;
      const paths = pattern.includes('/api/sales-forms/[kind]') ? SALES_KINDS.map((k) => concrete(pattern, k)) : [concrete(pattern)];
      out.push({ pattern, method: m as HttpMethod, area: rule.area, action: rule.action, paths });
    }
  }
  return out;
}

function decide(path: string, method: string, access: ReturnType<typeof unionRoles>): boolean {
  try {
    authorizeRequest({ path, method }, access);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic pseudo-random legacy grants (area → actions, sometimes 'full'). */
function legacyGrants(n: number): PermissionGrant[] {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: PermissionGrant[] = [];
  for (let i = 0; i < n; i++) {
    const g: PermissionGrant = {};
    for (const area of AREA_KEYS) {
      const r = rnd();
      if (r < 0.35) continue;
      if (r > 0.9) {
        g[area] = ['full'];
        continue;
      }
      const acts = ACTIONS.filter(() => rnd() < 0.5);
      if (acts.length) g[area] = acts;
    }
    out.push(g);
  }
  return out;
}

const role = (permissions: PermissionGrant, key = 'custom'): RoleDefinition => ({
  key,
  name: key,
  description: '',
  builtin: false,
  permissions,
  flags: {},
});

describe('activity catalog', () => {
  it('has the QuickBooks Enterprise depth (about 115 activities), every area split', () => {
    expect(ACTIVITIES.length).toBeGreaterThanOrEqual(110);
    expect(new Set(ACTIVITY_KEYS).size).toBe(ACTIVITY_KEYS.length);
    for (const a of ACTIVITIES) expect(a.key.startsWith(`${a.area}.`)).toBe(true);
    for (const area of AREA_KEYS) expect(activitiesOf(area).length).toBeGreaterThan(0);
    // Invoices, Receive Payments and Statements are separate activities (QB parity).
    expect(activityDef('customers.invoices')?.area).toBe('customers');
    expect(activityDef('customers.payments')?.area).toBe('customers');
    expect(activityDef('customers.statements')?.area).toBe('customers');
  });

  it('View Balance exists where QB has it (registers, bank accounts, chart of accounts, centers)', () => {
    for (const k of ['banking.registers', 'banking.bank_accounts', 'lists.chart_of_accounts', 'customers.center', 'vendors.center']) {
      expect(supportedActions(activityDef(k)!)).toContain('view_balance');
    }
  });
});

describe('route map: every area route names an activity of its area that has the right', () => {
  it('maps every route (fail closed otherwise)', () => {
    const problems: string[] = [];
    for (const r of areaRoutes()) {
      for (const path of r.paths) {
        const activity = apiActivityFor(path, r.method);
        if (!activity) {
          problems.push(`${r.method} ${r.pattern} (${r.area}): add it to lib/permissions/routeActivities.ts ROUTE_ACTIVITIES`);
          continue;
        }
        const def = activityDef(activity)!;
        if (def.area !== r.area) problems.push(`${r.method} ${r.pattern}: ${activity} is not in ${r.area}`);
        if (!supportedActions(def).includes(r.action)) problems.push(`${r.method} ${r.pattern}: ${activity} has no '${r.action}' right`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('sales forms addressed by kind need that form’s activity; an unknown kind checks the whole area', () => {
    expect(activityForRoute('/api/sales-forms/[kind]/[id]/pdf', 'GET', 'customers', '/api/sales-forms/estimate/x/pdf')).toBe('customers.estimates');
    expect(activityForRoute('/api/sales-forms/[kind]/[id]/pdf', 'GET', 'customers', '/api/sales-forms/bogus/x/pdf')).toBeNull();
  });

  it('pages: the activity a page needs is inside the areas it needed before', () => {
    const problems: string[] = [];
    for (const page of Object.keys(PAGE_AREAS)) {
      const need = pageAccessFor(page);
      const areas = pageAreasFor(page) ?? [];
      if (!need?.activities) continue;
      for (const k of need.activities) if (!areas.includes(activityDef(k)!.area)) problems.push(`${page}: ${k} not in ${areas.join('/')}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('upgrade: roles stored before activities keep exactly the same access', () => {
  const roles: RoleDefinition[] = [...BUILTIN_ROLES, ...legacyGrants(40).map((g, i) => role(g, `legacy${i}`))];

  it('every API route and method answers the same as the old area check', () => {
    const diffs: string[] = [];
    for (const r of roles) {
      const access = unionRoles([r]);
      const old = normalizeGrant(r.permissions); // the area check every route used before
      for (const route of areaRoutes()) {
        for (const path of route.paths) {
          const before = old[route.area].includes(route.action);
          const after = decide(path, route.method, access);
          if (before !== after) diffs.push(`${r.key}: ${route.method} ${path} was ${before} now ${after}`);
        }
      }
    }
    expect(diffs.slice(0, 20)).toEqual([]);
  });

  it('every page answers the same as the old area check', () => {
    const diffs: string[] = [];
    for (const r of roles) {
      const access = unionRoles([r]);
      const old = normalizeGrant(r.permissions);
      for (const page of Object.keys(PAGE_AREAS)) {
        const areas = pageAreasFor(page)!;
        const before = areas.some((a) => old[a].includes('view'));
        const after = decide(page, 'GET', access);
        if (before !== after) diffs.push(`${r.key}: ${page} was ${before} now ${after}`);
      }
    }
    expect(diffs.slice(0, 20)).toEqual([]);
  });

  it('area-level answers (used by services) are unchanged, and View Balance comes with View', () => {
    for (const r of roles) {
      const access = unionRoles([r]);
      expect(access.permissions).toEqual(normalizeGrant(r.permissions));
      // can() (requirePermission, member / self routes, undo, view filters) answers exactly as before.
      const old = normalizeGrant(r.permissions);
      for (const area of AREA_KEYS) {
        for (const action of ACTIONS) expect(can(access, area, action), `${r.key} ${area} ${action}`).toBe(old[area].includes(action));
      }
      for (const def of ACTIVITIES) {
        if (!def.viewBalance) continue;
        expect(canActivity(access, def.key, 'view_balance')).toBe(access.permissions[def.area].includes('view'));
      }
    }
  });
});

describe('per-activity rights', () => {
  it('Invoices without Receive Payments: may invoice, may not receive payments', () => {
    const access = unionRoles([role({ 'customers.invoices': ['view', 'create', 'modify', 'print'] })]);
    expect(decide('/api/invoices', 'POST', access)).toBe(true);
    expect(decide(`/api/invoices/${UUID}/pdf`, 'GET', access)).toBe(true);
    expect(decide(`/api/invoices/${UUID}`, 'DELETE', access)).toBe(false);
    expect(decide('/api/payments', 'POST', access)).toBe(false);
    expect(decide('/api/payments', 'GET', access)).toBe(false);
    expect(decide('/api/export/statements/batch', 'GET', access)).toBe(false);
    expect(decide('/invoices', 'GET', access)).toBe(true);
    expect(decide('/payments', 'GET', access)).toBe(false);
    // An area-level check (services, member routes) needs the action on the WHOLE area: Invoices
    // alone is not "Customers & Receivables".
    expect(can(access, 'customers', 'view')).toBe(false);
    expect(can(access, 'customers', 'create')).toBe(false);
    expect(canWholeArea(access, 'customers', 'create')).toBe(false);
  });

  it('activity-only roles never pass an area-level check through another activity (review P1)', () => {
    // Form Templates: Delete is not Delete on Company & Preferences (archive the company file).
    const templates = unionRoles([role({ 'company.templates': ['view', 'delete'] })]);
    expect(can(templates, 'company', 'delete')).toBe(false);
    expect(canActivity(templates, 'company.company_file', 'delete')).toBe(false);
    // Budgets: Modify does not rename the company.
    const budgets = unionRoles([role({ 'company.budgets': ['view', 'modify'] })]);
    expect(can(budgets, 'company', 'modify')).toBe(false);
    expect(canActivity(budgets, 'company.company_file', 'modify')).toBe(false);
    // Purchase Orders: Create is not Vendors & Payables: Create (save a receipt as a bill).
    const po = unionRoles([role({ 'vendors.purchase_orders': ['view', 'create'] })]);
    expect(can(po, 'vendors', 'create')).toBe(false);
    expect(can(po, 'vendors', 'view')).toBe(false);
    // Receive Payments without Delete, even with Invoices: Full.
    const pay = unionRoles([role({ 'customers.invoices': ['full'], 'customers.payments': ['view', 'create'] })]);
    expect(can(pay, 'customers', 'delete')).toBe(false);
    // Every activity of the area with the right: the area check passes.
    const allVendors: PermissionGrant = {};
    for (const d of activitiesOf('vendors')) (allVendors as Record<string, string[]>)[d.key] = ['view', 'create'];
    expect(can(unionRoles([role(allVendors)]), 'vendors', 'create')).toBe(true);
    // Mixed: an old-style area grant plus one activity is still only the area grant.
    const mixed = unionRoles([role({ vendors: ['view'] }), role({ 'vendors.bills': ['view', 'create'] })]);
    expect(can(mixed, 'vendors', 'view')).toBe(true);
    expect(can(mixed, 'vendors', 'create')).toBe(false);
    expect(canActivity(mixed, 'vendors.bills', 'create')).toBe(true);
  });

  it('report hub pages (QuickZoom, open source form, Report Center) open with ANY report activity (round 2 P1)', () => {
    for (const grant of [
      { 'reports_financial.company': ['view', 'print'] },
      { 'reports_sales.receivables': ['view'] },
      { 'reports_purchases.payables': ['view'] },
    ] as PermissionGrant[]) {
      const access = unionRoles([role(grant)]);
      for (const page of ['/reports', '/reports/std', '/reports/drilldown', '/reports/open', '/reports/memorized', '/reports/commented']) {
        expect(decide(page, 'GET', access), `${JSON.stringify(grant)} ${page}`).toBe(true);
      }
    }
    // No report right at all: still refused.
    expect(decide('/reports/drilldown', 'GET', unionRoles([role({ 'customers.invoices': ['view'] })]))).toBe(false);
    // System Accounts: an Accountant Center Tools role may call /api/account-roles, so it opens the page.
    expect(decide('/system-accounts', 'GET', unionRoles([role({ 'accounting.accountant_tools': ['view'] })]))).toBe(true);
  });

  it('My Preferences (send-from address, Bcc me) is open to every role; Company Preferences is not', () => {
    for (const key of ['ar_clerk', 'ap_clerk', 'banking', 'payroll_processor', 'reports_only']) {
      const access = unionRoles([BUILTIN_ROLES.find((r) => r.key === key)!]);
      expect(decide('/my-preferences', 'GET', access), key).toBe(true);
      expect(decide('/api/preferences/my', 'PATCH', access), key).toBe(true);
      expect(decide('/settings', 'GET', access), key).toBe(false);
    }
  });

  it('the company file itself (rename / archive) is its own activity, given to every old Company grant', () => {
    expect(supportedActions(activityDef('company.company_file')!)).toEqual(['view', 'modify', 'delete']);
    const accountant = unionRoles([BUILTIN_ROLES.find((r) => r.key === 'accountant')!]);
    expect(canActivity(accountant, 'company.company_file', 'modify')).toBe(true);
    expect(canActivity(accountant, 'company.company_file', 'delete')).toBe(false);
    const admin = unionRoles([BUILTIN_ROLES.find((r) => r.key === 'admin')!]);
    expect(canActivity(admin, 'company.company_file', 'delete')).toBe(true);
  });

  it('Statements alone: print statements, nothing else', () => {
    const access = unionRoles([role({ 'customers.statements': ['view', 'print'] })]);
    expect(decide('/api/export/statements/batch', 'GET', access)).toBe(true);
    expect(decide('/api/sales-forms/statement-email', 'POST', access)).toBe(true);
    expect(decide('/api/invoices', 'GET', access)).toBe(false);
  });

  it('sales form PDFs follow the form kind', () => {
    const access = unionRoles([role({ 'customers.estimates': ['view', 'print'] })]);
    expect(decide(`/api/sales-forms/estimate/${UUID}/pdf`, 'GET', access)).toBe(true);
    expect(decide(`/api/sales-forms/invoice/${UUID}/pdf`, 'GET', access)).toBe(false);
    expect(decide(`/api/sales-forms/whatever/${UUID}/pdf`, 'GET', access)).toBe(false);
  });

  it('View Balance is a separate right; an activity grant does not include it unless asked', () => {
    const a = unionRoles([role({ 'customers.center': ['view', 'create'] })]);
    expect(canActivity(a, 'customers.center', 'view')).toBe(true);
    expect(canActivity(a, 'customers.center', 'view_balance')).toBe(false);
    const b = unionRoles([role({ 'customers.center': ['view', 'view_balance'] })]);
    expect(canActivity(b, 'customers.center', 'view_balance')).toBe(true);
    const full = unionRoles([role({ 'customers.center': ['full'] })]);
    expect(canActivity(full, 'customers.center', 'view_balance')).toBe(true);
  });

  it('rights the activity does not have are dropped; any right implies View', () => {
    const n = normalizeActivities({ 'customers.statements': ['create', 'print'] });
    expect(n['customers.statements']).toEqual(['view', 'print']);
    expect(accessLevel(activityDef('customers.statements')!, n['customers.statements'])).toBe('Full');
    expect(accessLevel(activityDef('customers.invoices')!, ['view', 'create'])).toBe('Partial');
    expect(accessLevel(activityDef('customers.invoices')!, [])).toBe('None');
  });

  it('escalation check compares activities, not just areas', () => {
    const manager = unionRoles([role({ 'customers.invoices': ['full'], users: ['full'] })]);
    const wantsPayments = unionRoles([role({ 'customers.payments': ['view'] })]);
    const wantsInvoices = unionRoles([role({ 'customers.invoices': ['view', 'create'] })]);
    expect(isSubset(wantsInvoices, manager)).toBe(true);
    expect(isSubset(wantsPayments, manager)).toBe(false);
  });
});

describe('reports: every catalog report needs an activity of its own area', () => {
  it('reportActivity maps every REPORT_CATALOG entry (a new report area would otherwise be a 500)', () => {
    const problems: string[] = [];
    for (const e of REPORT_CATALOG) {
      let k: string | null = null;
      try {
        k = reportActivity(e);
      } catch (err) {
        problems.push(`${e.key}: ${(err as Error).message}`);
        continue;
      }
      if (activityDef(k)?.area !== e.area) problems.push(`${e.key}: ${k} is not in ${e.area}`);
    }
    expect(problems).toEqual([]);
  });

  it('a report needs the same activity in the catalog (standard viewer) as on its own page and route', () => {
    // Check Detail, Deposit Detail and Missing Checks are Banking Reports, not Company & Financial.
    for (const k of ['check-detail', 'deposit-detail', 'missing-checks']) {
      expect(reportActivity(REPORT_CATALOG.find((e) => e.key === k)!)).toBe('reports_financial.banking');
    }
    const problems: string[] = [];
    for (const e of REPORT_CATALOG) {
      const want = reportActivity(e);
      const route = apiActivityFor(`/api/reports/${e.key}`, 'GET');
      if (route && activityDef(route)?.area === e.area && route !== want) problems.push(`/api/reports/${e.key}: ${route} vs catalog ${want}`);
      const page = pageAccessFor(`/reports/${e.key}`)?.activities;
      if (page?.length === 1 && activityDef(page[0])?.area === e.area && page[0] !== want) problems.push(`/reports/${e.key}: ${page[0]} vs catalog ${want}`);
    }
    expect(problems).toEqual([]);
  });
});
