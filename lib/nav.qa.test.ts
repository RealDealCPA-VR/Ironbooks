/**
 * p1 ux QA (tester): adversarial tests for Simple / Advanced menus and the page search box.
 * Every role x both modes x feature switches: nothing a person can't open is ever offered, and
 * nothing in Simple mode disappears when someone switches to "All menus". Search must answer the
 * plain phrases and QuickBooks names a non-accountant would type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRA_DESTINATIONS, navGroups, searchPages, simpleNavGroups, visibleNavGroups, linkHref, type NavMode } from './nav';
import { pageHelpFor } from './pageHelp';
import { DEFAULT_COMPANY_PREFERENCES, featureHiddenPaths } from './preferences';
import { BUILTIN_ROLES, unionRoles, type PermissionSet } from './permissions/model';
import { pageAreasFor } from './permissions/routes';

const APP_DIR = path.resolve(process.cwd(), 'app');
function pageExists(href: string): boolean {
  const p = href.split(/[?#]/)[0];
  return fs.existsSync(path.join(APP_DIR, ...p.split('/').filter(Boolean), 'page.tsx'));
}
const permsOf = (key: string) => unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)).permissions as PermissionSet;
function canOpen(href: string, perms: PermissionSet): boolean {
  const areas = pageAreasFor(href.split(/[?#]/)[0]);
  return !areas || areas.some((a) => perms[a]?.includes('view') ?? false);
}
const ALL_OFF = featureHiddenPaths({
  ...DEFAULT_COMPANY_PREFERENCES,
  estimatesEnabled: false,
  salesOrdersEnabled: false,
  purchaseOrdersEnabled: false,
  inventoryEnabled: false,
  timeTrackingEnabled: false,
  salesTaxEnabled: false,
  payrollEnabled: false,
});
const MODES: NavMode[] = ['simple', 'advanced'];
const top = (q: string) => searchPages(q)[0]?.href.split(/[?#]/)[0];

describe('Simple and Advanced menus', () => {
  it('switching to "All menus" never loses a Simple-mode page', () => {
    const advanced = new Set(navGroups.flatMap((g) => g.links.map((l) => l.path)));
    const missing = simpleNavGroups.flatMap((g) => g.links.map((l) => l.path)).filter((p) => !advanced.has(p));
    // e.g. Simple mode has Profit & Loss / Balance Sheet; All menus must have them too.
    expect(missing).toEqual([]);
  });

  it('every menu link (both modes) and every extra destination opens a real page', () => {
    for (const g of [...navGroups, ...simpleNavGroups]) for (const l of g.links) expect(pageExists(linkHref(l)), linkHref(l)).toBe(true);
    for (const d of EXTRA_DESTINATIONS) expect(pageExists(d.href), d.href).toBe(true);
    expect(pageExists('/home')).toBe(true);
    expect(pageExists('/lists/todos')).toBe(true); // old address still answers (redirect)
  });

  it('no link label is used twice in one menu (labels are the React keys and what people read)', () => {
    for (const groups of [navGroups, simpleNavGroups]) {
      const labels = groups.flatMap((g) => g.links.map((l) => l.label));
      const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
      expect(dupes).toEqual([]);
    }
  });

  it('for every built-in role, in both modes, with features on or off: only pages the role can open, never a switched-off page', () => {
    for (const r of BUILTIN_ROLES) {
      const perms = permsOf(r.key);
      for (const mode of MODES) {
        for (const hidden of [new Set<string>(), ALL_OFF]) {
          const groups = visibleNavGroups(mode, perms, hidden);
          for (const g of groups) {
            expect(g.links.length, `${r.key}/${mode}/${g.heading}`).toBeGreaterThan(0);
            for (const l of g.links) {
              expect(canOpen(l.path, perms), `${r.key} ${mode} ${l.path}`).toBe(true);
              expect(hidden.has(l.path), `${r.key} ${mode} ${l.path}`).toBe(false);
            }
          }
          if (mode === 'simple') expect(groups.flatMap((g) => g.links).length).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it('payroll off removes the Employees group from Simple mode but keeps Items and the employee list', () => {
    const simple = visibleNavGroups('simple', null, ALL_OFF);
    expect(simple.map((g) => g.heading)).not.toContain('Employees');
    expect(simple.flatMap((g) => g.links.map((l) => l.path))).toContain('/items');
    const adv = visibleNavGroups('advanced', null, ALL_OFF).flatMap((g) => g.links.map((l) => l.path));
    expect(adv).toContain('/employees');
    expect(adv).not.toContain('/pay-runs');
    // payroll on (default): Run Payroll is there
    expect(visibleNavGroups('simple', null, featureHiddenPaths(DEFAULT_COMPANY_PREFERENCES)).map((g) => g.heading)).toContain('Employees');
  });

  it('Simple-mode labels avoid accounting jargon; Advanced labels drop the jargon the audit named', () => {
    const jargon = /\b(A\/R|A\/P|JE|SO|PO|COGS|GL|accrual|liabilit(y|ies))\b/i;
    for (const l of simpleNavGroups.flatMap((g) => g.links)) expect(jargon.test(l.label), l.label).toBe(false);
    const adv = navGroups.flatMap((g) => g.links);
    expect(adv.some((l) => l.label === 'SO Fulfillment')).toBe(false);
    expect(adv.some((l) => l.label === 'Finance Charges')).toBe(false);
    const fc = adv.find((l) => l.path === '/finance-charges')!;
    expect(`${fc.label} ${fc.qb}`).toMatch(/finance charge/i);
    const so = adv.find((l) => l.path === '/so-fulfillment')!;
    expect(so.label.toLowerCase()).toContain('sales order');
  });

  it('every page in Simple mode has "What is this page?" help with a first step', () => {
    for (const l of simpleNavGroups.flatMap((g) => g.links)) {
      const h = pageHelpFor(l.path);
      expect(h, l.path).not.toBeNull();
      expect(h!.what.trim().length, l.path).toBeGreaterThan(20);
      expect(h!.first.trim().length, l.path).toBeGreaterThan(10);
    }
    expect(pageHelpFor('/todos')).not.toBeNull();
    expect(pageHelpFor('/calendar')).not.toBeNull();
  });
});

describe('page search', () => {
  it('answers plain phrases a non-accountant types', () => {
    const cases: Array<[string, string]> = [
      ['pay a bill', '/pay-bills'],
      ['pay bills', '/pay-bills'],
      ['Write checks', '/expenses'],
      ['write a check', '/expenses'],
      ['record a sale', '/sales-receipts'],
      ['enter a bill', '/bills'],
      ['make a deposit', '/deposits'],
      ['deposit', '/deposits'],
      ['reconcile my bank', '/reconcile'],
      ['receive payment', '/payments'],
      ['create invoice', '/invoices'],
      ['chart of accounts', '/accounts'],
      ['balance sheet', '/reports/balance-sheet'],
      ['profit & loss', '/reports/profit-loss'],
      ['late fee', '/finance-charges'],
      ['customers', '/customers'],
      ['vendors', '/vendors'],
      ['run payroll', '/pay-runs'],
      ['to do list', '/todos'],
      ['transfer money', '/transfers'],
    ];
    const wrong = cases.filter(([q, want]) => top(q) !== want).map(([q, want]) => `${q} -> ${top(q)} (want ${want})`);
    expect(wrong).toEqual([]);
  });

  it('finds pages by their QuickBooks names', () => {
    const cases: Array<[string, string]> = [
      ['Enter Sales Receipts', '/sales-receipts'],
      ['Make General Journal Entries', '/journal'],
      ['Customer Center', '/customers'],
      ['Vendor Center', '/vendors'],
      ['Item List', '/items'],
      ['Make Deposits', '/deposits'],
      ['Assess Finance Charges', '/finance-charges'],
      ['Memorized Transactions', '/recurring'],
      ['Sales Order Fulfillment Worksheet', '/so-fulfillment'],
      ['Lead Center', '/leads'],
      ['Report Center', '/reports'],
      ['Set Closing Date', '/year-end'],
      ['Pay Payroll Liabilities', '/pay-liabilities'],
    ];
    const wrong = cases.filter(([q, want]) => top(q) !== want).map(([q, want]) => `${q} -> ${top(q)} (want ${want})`);
    expect(wrong).toEqual([]);
  });

  it('ignores case and extra spaces, and odd characters never throw', () => {
    expect(top('  PAY    BILLS  ')).toBe('/pay-bills');
    for (const q of ['(', '*', '[a-', '\\', '?', '%', '&&', "'; drop table", '👍']) expect(() => searchPages(q)).not.toThrow();
  });

  it('for every built-in role, results only include pages the role can open and that exist', () => {
    const queries = ['pay', 'bill', 'check', 'payroll', 'report', 'invoice', 'bank', 'customer', 'vendor', 'tax', 'inventory', 'journal', 'users', 'i got paid', 'record a sale'];
    for (const r of BUILTIN_ROLES) {
      const perms = permsOf(r.key);
      for (const q of queries) {
        for (const res of searchPages(q, { permissions: perms, hiddenPaths: ALL_OFF, limit: 50 })) {
          expect(canOpen(res.href, perms), `${r.key} "${q}" -> ${res.href}`).toBe(true);
          expect(ALL_OFF.has(res.href.split(/[?#]/)[0]), `${r.key} "${q}" -> ${res.href}`).toBe(false);
          expect(pageExists(res.href), res.href).toBe(true);
        }
      }
    }
  });

  it('search reaches Advanced-only pages even for someone in Simple mode', () => {
    expect(top('journal entry')).toBe('/journal');
    expect(top('audit trail')).toBe('/audit-trail');
  });
});
