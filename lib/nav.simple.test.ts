/**
 * p1 ux (GOAL 8, simple UX): Simple vs. Advanced menus, the page search box, "What is this
 * page?" help coverage, plain labels, and the Home workflow following permissions + features.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  navGroups,
  simpleNavGroups,
  navGroupsFor,
  visibleNavGroups,
  searchPages,
  linkHref,
} from './nav';
import { PAGE_HELP, pageHelpFor } from './pageHelp';
import {
  DEFAULT_COMPANY_PREFERENCES,
  DEFAULT_MY_PREFERENCES,
  featureHiddenPaths,
  resolveMyPreferences,
  PREFERENCE_CATEGORIES,
} from './preferences';
import { myPreferencesSchema } from './validation/prefs';
import { companySettingsSchema } from './validation/company';
import { FIELD_META as PREFERENCE_FIELDS } from './preferenceFields';
import { HOME_WORKFLOW, filterWorkflow } from './homeWorkflow';
import { BUILTIN_ROLES, unionRoles, type PermissionSet } from './permissions/model';

const APP_DIR = path.resolve(process.cwd(), 'app');
function pageExists(href: string): boolean {
  const p = href.split(/[?#]/)[0];
  return fs.existsSync(path.join(APP_DIR, ...p.split('/').filter(Boolean), 'page.tsx'));
}
function perms(roleKey: string): PermissionSet {
  return unionRoles(BUILTIN_ROLES.filter((r) => r.key === roleKey)).permissions as PermissionSet;
}
const links = (groups: typeof navGroups) => groups.flatMap((g) => g.links);
const NONE = new Set<string>();

describe('Simple mode menu', () => {
  it('is the default for new users and lives in My Preferences (General)', () => {
    expect(DEFAULT_MY_PREFERENCES.navMode).toBe('simple');
    expect(resolveMyPreferences({}).navMode).toBe('simple');
    expect(resolveMyPreferences({ navMode: 'advanced' }).navMode).toBe('advanced');
    expect(resolveMyPreferences({ navMode: 'weird' }).navMode).toBe('simple');
    expect(PREFERENCE_CATEGORIES.find((c) => c.id === 'general')!.my).toContain('navMode');
    expect(myPreferencesSchema.safeParse({ navMode: 'advanced' }).success).toBe(true);
    expect(myPreferencesSchema.safeParse({ navMode: 'expert' }).success).toBe(false);
    expect((PREFERENCE_FIELDS as Record<string, unknown>).navMode).toBeTruthy();
  });

  it('shows 15-20 everyday tasks grouped like the QuickBooks Home page', () => {
    const all = links(simpleNavGroups);
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.length).toBeLessThanOrEqual(20);
    const byGroup = Object.fromEntries(simpleNavGroups.map((g) => [g.heading, g.links.map((l) => l.label)]));
    expect(byGroup.Customers).toEqual(['Create Invoice', 'Receive Payment', 'Customers']);
    expect(byGroup.Vendors).toEqual(['Enter Bill', 'Pay Bills', 'Vendors']);
    expect(byGroup.Banking).toEqual(['Write Check', 'Bank Feeds / Import', 'Reconcile', 'Make Deposit']);
    expect(byGroup.Employees).toEqual(['Run Payroll']);
    expect(byGroup.Reports).toEqual(['Profit & Loss', 'Balance Sheet', 'Report Center']);
    expect(byGroup.Company).toEqual(['Chart of Accounts', 'Items']);
    expect(byGroup['']).toContain('Home');
    for (const l of all) expect(pageExists(linkHref(l)), linkHref(l)).toBe(true);
    // Simple mode is a strict subset of the full menu's pages (search reaches the rest).
    const advancedPaths = new Set(links(navGroups).map((l) => l.path));
    for (const l of all) {
      if (l.path.startsWith('/reports/')) continue; // the standard P&L / Balance Sheet live in Report Center
      expect(advancedPaths.has(l.path), l.path).toBe(true);
    }
  });

  it('Advanced mode has every screen; every menu link opens a real page', () => {
    expect(navGroupsFor('advanced')).toBe(navGroups);
    expect(navGroupsFor('simple')).toBe(simpleNavGroups);
    expect(links(navGroups).length).toBeGreaterThan(100);
    for (const l of links(navGroups)) expect(pageExists(l.path), l.path).toBe(true);
  });

  it('respects feature switches in both modes (payroll off hides Employees)', () => {
    const off = featureHiddenPaths({ ...DEFAULT_COMPANY_PREFERENCES, payrollEnabled: false, salesOrdersEnabled: false });
    const simple = visibleNavGroups('simple', null, off);
    expect(simple.map((g) => g.heading)).not.toContain('Employees');
    const advanced = links(visibleNavGroups('advanced', null, off)).map((l) => l.path);
    expect(advanced).not.toContain('/pay-runs');
    expect(advanced).not.toContain('/so-fulfillment');
    expect(advanced).toContain('/employees'); // the employee list itself stays
    // Payroll on (the default): Run Payroll shows.
    expect(links(visibleNavGroups('simple', null, featureHiddenPaths(DEFAULT_COMPANY_PREFERENCES))).map((l) => l.label)).toContain('Run Payroll');
    // The switch is a real company preference with a control.
    expect(DEFAULT_COMPANY_PREFERENCES.payrollEnabled).toBe(true);
    expect(companySettingsSchema.safeParse({ payrollEnabled: false }).success).toBe(true);
    expect((PREFERENCE_FIELDS as Record<string, unknown>).payrollEnabled).toBeTruthy();
  });

  it('respects permissions in both modes', () => {
    const sales = perms('sales');
    const simpleSales = visibleNavGroups('simple', sales, NONE);
    expect(simpleSales.map((g) => g.heading)).not.toContain('Vendors');
    expect(simpleSales.map((g) => g.heading)).toContain('Customers');
    const advSales = links(visibleNavGroups('advanced', sales, NONE)).map((l) => l.path);
    expect(advSales).not.toContain('/pay-bills');
    expect(advSales).toContain('/invoices');
  });

  it('uses plain labels and keeps the QuickBooks name in the tooltip', () => {
    const labels = links(navGroups).map((l) => l.label);
    for (const jargon of ['SO Fulfillment', 'Finance Charges', 'Income Tracker', 'Memorized Transactions', 'Doc Center']) {
      expect(labels, jargon).not.toContain(jargon);
    }
    const fc = links(navGroups).find((l) => l.path === '/finance-charges')!;
    expect(fc.label).toBe('Late-payment charges');
    expect(fc.qb).toMatch(/Finance Charges/);
    const so = links(navGroups).find((l) => l.path === '/so-fulfillment')!;
    expect(so.label).toBe('Sales order fulfillment');
  });
});

describe('page search box', () => {
  const top = (q: string, opts = {}) => searchPages(q, opts)[0]?.href.split('?')[0];

  it('finds pages by name, QuickBooks name and plain words', () => {
    expect(top('Write checks')).toBe('/expenses');
    expect(top('write check')).toBe('/expenses');
    expect(top('pay bills')).toBe('/pay-bills');
    expect(top('pay a bill')).toBe('/pay-bills');
    expect(top('record a sale')).toBe('/sales-receipts');
    expect(top('finance charges')).toBe('/finance-charges');
    expect(top('income tracker')).toBe('/income-tracker');
    expect(top('memorized transactions')).toBe('/recurring');
    expect(top('reconcile')).toBe('/reconcile');
    expect(top('to do')).toBe('/todos');
    expect(top('profit and loss')).toMatch(/^\/reports\//);
    expect(top('i got paid')).toBe('/payments');
    expect(searchPages('')).toEqual([]);
    expect(searchPages('zzzz-nothing')).toEqual([]);
  });

  it('never lists the same page twice and caps the list', () => {
    const r = searchPages('pay', { limit: 5 });
    expect(r.length).toBeLessThanOrEqual(5);
    const bases = r.map((x) => x.href.split('?')[0]);
    expect(new Set(bases).size).toBe(bases.length);
  });

  it('only offers pages this person can open', () => {
    const sales = perms('sales');
    expect(searchPages('pay bills', { permissions: sales }).some((r) => r.href.startsWith('/pay-bills'))).toBe(false);
    const off = featureHiddenPaths({ ...DEFAULT_COMPANY_PREFERENCES, payrollEnabled: false });
    expect(searchPages('run payroll', { hiddenPaths: off }).some((r) => r.href.startsWith('/pay-runs'))).toBe(false);
  });
});

describe('"What is this page?" help', () => {
  it('covers every page reachable from Simple mode and every Sales / Purchases / Banking screen', () => {
    const required = [
      ...links(simpleNavGroups).map((l) => l.path),
      ...navGroups.filter((g) => ['Sales', 'Purchases', 'Banking'].includes(g.heading)).flatMap((g) => g.links.map((l) => l.path)),
    ];
    for (const p of required) expect(pageHelpFor(p), p).not.toBeNull();
  });

  it('is short and plain: one or two sentences plus what to do first', () => {
    for (const [p, h] of Object.entries(PAGE_HELP)) {
      expect(h.what.length, p).toBeLessThanOrEqual(200);
      expect(h.first.length, p).toBeLessThanOrEqual(130);
      expect((h.what.match(/[.!?](\s|$)/g) ?? []).length, p).toBeLessThanOrEqual(2);
      expect(pageExists(p), p).toBe(true);
    }
  });

  it('matches sub-pages to their parent page help', () => {
    expect(pageHelpFor('/registers/123')?.title).toBe('Registers');
    expect(pageHelpFor('/invoices/batch')?.title).toBe('Invoice many customers');
    expect(pageHelpFor('/no-such-page')).toBeNull();
  });
});

describe('Home workflow follows permissions and feature switches', () => {
  it('drops steps a person cannot open and empty sections', () => {
    const allowed = new Set(['/invoices', '/payments', '/customers', '/deposits']);
    const s = filterWorkflow(HOME_WORKFLOW, (h) => allowed.has(h));
    const ids = s.map((x) => x.id);
    expect(ids).toContain('customers');
    expect(ids).not.toContain('vendors');
    expect(ids).not.toContain('employees');
    const steps = s.flatMap((x) => [...x.flows.flat(), ...(x.extras ?? [])]).map((st) => st.href);
    for (const h of steps) expect(h.startsWith('#') || allowed.has(h), h).toBe(true);
  });
});
