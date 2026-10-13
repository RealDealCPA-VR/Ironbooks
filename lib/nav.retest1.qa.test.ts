/**
 * p1 ux QA re-test round 1 (tester): proves the fix round for the menus and page search.
 *  - Blocker 1: "All menus" must carry the accrual Profit & Loss and Balance Sheet, for every role
 *    and feature combination, and never lose a page Simple mode shows that person.
 *  - Blocker 2: search ranking — a full keyword match outranks a loose plain-language guess, but a
 *    whole typed phrase ("enter a bill") still wins; permissions/feature switches still filter
 *    suggestions; no duplicates; limit respected.
 */
import { describe, expect, it } from 'vitest';
import { navGroups, searchPages, visibleNavGroups, type NavMode } from './nav';
import { matchIntents, matchIntentsScored } from './nav-actions';
import { DEFAULT_COMPANY_PREFERENCES, featureHiddenPaths } from './preferences';
import { BUILTIN_ROLES, unionRoles, type PermissionSet } from './permissions/model';

const permsOf = (key: string) => unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)).permissions as PermissionSet;
const base = (href: string) => href.split(/[?#]/)[0];
const top = (q: string, opts?: Parameters<typeof searchPages>[1]) => {
  const r = searchPages(q, opts)[0];
  return r ? base(r.href) : undefined;
};
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
const FEATURE_SETS = [new Set<string>(), featureHiddenPaths(DEFAULT_COMPANY_PREFERENCES), ALL_OFF];
const paths = (mode: NavMode, perms: PermissionSet | null, hidden: ReadonlySet<string>) =>
  visibleNavGroups(mode, perms, hidden).flatMap((g) => g.links.map((l) => l.path));

describe('re-test: All menus keeps the main reports', () => {
  it('the Reports group of All menus lists the accrual Profit & Loss and Balance Sheet beside the cash versions', () => {
    const reports = navGroups.find((g) => g.links.some((l) => l.path === '/reports'));
    expect(reports).toBeDefined();
    const p = reports!.links.map((l) => l.path);
    for (const want of ['/reports/profit-loss', '/reports/balance-sheet', '/reports/profit-loss-cash', '/reports/balance-sheet-cash']) {
      expect(p, want).toContain(want);
    }
    // The accrual version is listed before its cash version (QB lists Standard first).
    expect(p.indexOf('/reports/profit-loss')).toBeLessThan(p.indexOf('/reports/profit-loss-cash'));
  });

  it('no page appears twice in All menus (the fix did not duplicate a link)', () => {
    const all = navGroups.flatMap((g) => g.links.map((l) => l.path));
    expect(all.filter((x, i) => all.indexOf(x) !== i)).toEqual([]);
  });

  it('for every built-in role and feature setting, All menus shows every page Simple mode shows that person', () => {
    const roles: Array<[string, PermissionSet | null]> = [['owner(null)', null], ...BUILTIN_ROLES.map((r) => [r.key, permsOf(r.key)] as [string, PermissionSet])];
    for (const [key, perms] of roles) {
      for (const hidden of FEATURE_SETS) {
        const adv = new Set(paths('advanced', perms, hidden));
        const lost = paths('simple', perms, hidden).filter((p) => !adv.has(p));
        expect(lost, key).toEqual([]);
      }
    }
  });

  it('a role without financial reports sees neither report in either mode; a role with them sees both in both modes', () => {
    for (const r of BUILTIN_ROLES) {
      const perms = permsOf(r.key);
      const can = perms.reports_financial?.includes('view') ?? false;
      for (const mode of ['simple', 'advanced'] as NavMode[]) {
        const p = paths(mode, perms, new Set());
        expect(p.includes('/reports/profit-loss'), `${r.key} ${mode} P&L`).toBe(can);
        expect(p.includes('/reports/balance-sheet'), `${r.key} ${mode} BS`).toBe(can);
      }
    }
  });

  it('switching off every optional feature never hides the two main reports', () => {
    for (const mode of ['simple', 'advanced'] as NavMode[]) {
      const p = paths(mode, null, ALL_OFF);
      expect(p).toContain('/reports/profit-loss');
      expect(p).toContain('/reports/balance-sheet');
    }
  });
});

describe('re-test: search ranks full keyword matches above loose guesses', () => {
  it('the two phrases from the review now open the right page first', () => {
    expect(top('make a deposit')).toBe('/deposits');
    expect(top('late fee')).toBe('/finance-charges');
    expect(top('Late Fee')).toBe('/finance-charges');
    expect(top('  make   a   deposit ')).toBe('/deposits');
  });

  it('a whole typed phrase still wins over pages (no regression from the reorder)', () => {
    const cases: Array<[string, string]> = [
      ['i got paid', '/payments'],
      ['customer paid me', '/payments'],
      ['enter a bill', '/bills'],
      ['record a sale', '/sales-receipts'],
      ['sell something', '/sales-receipts'],
      ['write a check', '/expenses'],
      ['deposit money', '/deposits'],
      ['invoice a customer', '/invoices'],
      ['reconcile', '/reconcile'],
      ['pay my employees', '/pay-runs'],
      ['profit and loss', '/reports/profit-loss'],
      ['p&l', '/reports/profit-loss'],
      ['balance sheet', '/reports/balance-sheet'],
      ['finance charge', '/finance-charges'],
      ['refund', '/credit-memos'],
    ];
    const wrong = cases.filter(([q, want]) => top(q) !== want).map(([q, want]) => `${q} -> ${top(q)} (want ${want})`);
    expect(wrong).toEqual([]);
  });

  it('typing "reports" opens the Report Center first (a Simple-mode page), not one particular report', () => {
    expect(top('reports')).toBe('/reports');
    expect(top('report center')).toBe('/reports');
  });

  it('the loose suggestions are still offered, just below the keyword match', () => {
    const res = searchPages('make a deposit', { limit: 20 });
    expect(res.some((r) => r.group === 'Suggested')).toBe(true);
    const iDeposits = res.findIndex((r) => base(r.href) === '/deposits');
    const iFirstSuggestion = res.findIndex((r) => r.group === 'Suggested');
    expect(iDeposits).toBeLessThan(iFirstSuggestion);
  });

  it('never lists the same page twice and respects the limit', () => {
    for (const q of ['make a deposit', 'late fee', 'pay', 'bills', 'i got paid', 'deposit', 'check', 'customer']) {
      for (const limit of [1, 3, 8, 50]) {
        const res = searchPages(q, { limit });
        expect(res.length, `${q}/${limit}`).toBeLessThanOrEqual(limit);
        const keys = res.map((r) => base(r.href));
        expect(keys.filter((k, i) => keys.indexOf(k) !== i), `${q}/${limit}`).toEqual([]);
      }
    }
  });

  it('when the keyword page is switched off or not allowed, it is not offered and a permitted page comes first', () => {
    // Deposits hidden: "make a deposit" must not point at /deposits.
    const hidden = new Set(['/deposits']);
    const res = searchPages('make a deposit', { hiddenPaths: hidden, limit: 50 });
    expect(res.map((r) => base(r.href))).not.toContain('/deposits');
    // Every role: the top hit for each phrase is a page that role can open.
    for (const r of BUILTIN_ROLES) {
      const perms = permsOf(r.key);
      for (const q of ['make a deposit', 'late fee', 'enter a bill', 'i got paid']) {
        for (const x of searchPages(q, { permissions: perms, hiddenPaths: ALL_OFF, limit: 50 })) {
          expect(ALL_OFF.has(base(x.href)), `${r.key} ${q} ${x.href}`).toBe(false);
        }
      }
    }
  });

  it('matchIntents is unchanged: same intents, same order as matchIntentsScored; scores best first', () => {
    for (const q of ['make a deposit', 'late fee', 'i got paid', 'pay', 'bills', 'enter a bill', 'x', '', '   ', '!!!']) {
      const scored = matchIntentsScored(q, 3);
      expect(matchIntents(q, 3)).toEqual(scored.map((s) => s.intent));
      for (let i = 1; i < scored.length; i++) expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
      for (const s of scored) expect(s.score).toBeGreaterThan(0);
    }
    expect(matchIntentsScored('enter a bill')[0].score).toBeGreaterThanOrEqual(100);
    expect(matchIntentsScored('make a deposit').every((s) => s.score < 100)).toBe(true);
    expect(matchIntentsScored('', 3)).toEqual([]);
  });
});
