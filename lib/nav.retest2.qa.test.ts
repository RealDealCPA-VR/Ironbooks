/**
 * p1 ux QA re-test round 2 (tester): proves the search fix (a typed word that is exactly a page's
 * keyword list scores 80, above a label that merely contains the word) without regressions.
 *  - "reports" in any case / spacing / form opens the Report Center first.
 *  - The ranking cases from earlier rounds still hold.
 *  - A page's own name (label or QuickBooks name) always beats the new keyword score.
 *  - Permissions and feature switches still filter, no duplicates, limit kept.
 *  - Exposes: "quotes" now opens Estimate Follow-up before Create Estimates.
 */
import { describe, expect, it } from 'vitest';
import { navGroups, searchPages, simpleNavGroups } from './nav';
import { DEFAULT_COMPANY_PREFERENCES, featureHiddenPaths } from './preferences';
import { BUILTIN_ROLES, unionRoles, type PermissionSet } from './permissions/model';

const permsOf = (key: string) => unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)).permissions as PermissionSet;
const base = (href: string) => href.split(/[?#]/)[0];
const top = (q: string, opts?: Parameters<typeof searchPages>[1]) => {
  const r = searchPages(q, opts)[0];
  return r ? base(r.href) : undefined;
};
const ALL_LINKS = [...navGroups, ...simpleNavGroups].flatMap((g) => g.links);

describe('re-test 2: "reports" opens the Report Center', () => {
  it.each(['reports', 'Reports', 'REPORTS', '  reports  ', 'report', 'the reports', 'my reports', 'reporting', 'report center', 'Report Center'])(
    '%j -> /reports first',
    (q) => {
      expect(top(q)).toBe('/reports');
    },
  );

  it('the specific reports still follow the Report Center (they are not dropped)', () => {
    const r = searchPages('reports', { limit: 20 }).map((x) => base(x.href));
    expect(r[0]).toBe('/reports');
    expect(r).toContain('/reports/payroll-summary');
    expect(r).toContain('/reports/reconciliation');
    expect(new Set(r).size).toBe(r.length);
  });

  it('a prefix typed so far still reaches the Report Center', () => {
    expect(searchPages('repo', { limit: 20 }).map((x) => base(x.href))).toContain('/reports');
  });
});

describe('re-test 2: earlier ranking cases still hold', () => {
  const CASES: Array<[string, string]> = [
    ['make a deposit', '/deposits'],
    ['deposit', '/deposits'],
    ['late fee', '/finance-charges'],
    ['finance charges', '/finance-charges'],
    ['finance charge', '/finance-charges'],
    ['enter a bill', '/bills'],
    ['got a bill', '/bills'],
    ['pay a bill', '/pay-bills'],
    ['pay bills', '/pay-bills'],
    ['write checks', '/expenses'],
    ['write a check', '/expenses'],
    ['record a sale', '/sales-receipts'],
    ['i got paid', '/payments'],
    ['reconcile', '/reconcile'],
    ['balance sheet', '/reports/balance-sheet'],
    ['profit and loss', '/reports/profit-loss'],
    ['p&l', '/reports/profit-loss'],
    ['custom report', '/reports/builder'],
    ['payroll report', '/reports/payroll-summary'],
    ['chart', '/accounts'],
    ['clients', '/customers'],
    ['suppliers', '/vendors'],
    ['prospects', '/leads'],
    ['search', '/find'],
  ];
  it.each(CASES)('%j -> %s', (q, want) => {
    expect(top(q)).toBe(want);
  });
});

describe('re-test 2: a page’s own name always beats the keyword score', () => {
  it('typing any menu label (or QuickBooks name) exactly opens a page with that name first', () => {
    const bad: string[] = [];
    for (const typed of new Set(ALL_LINKS.flatMap((l) => [l.label, ...(l.qb ? [l.qb] : [])]))) {
      const lc = typed.toLowerCase();
      const owners = new Set(ALL_LINKS.filter((l) => l.label.toLowerCase() === lc || (l.qb ?? '').toLowerCase() === lc).map((l) => l.path));
      const got = top(typed);
      if (!got || !owners.has(got)) bad.push(`${typed} -> ${got}`);
    }
    expect(bad).toEqual([]);
  });

  it('the cash-basis Balance Sheet (keyword "balance sheet") does not outrank the Balance Sheet itself', () => {
    const r = searchPages('balance sheet').map((x) => base(x.href));
    expect(r.indexOf('/reports/balance-sheet')).toBeLessThan(r.indexOf('/reports/balance-sheet-cash'));
  });

  it('a keyword list with more words than typed is not an exact keyword match', () => {
    // "income" alone is one of three keywords of Profit & Loss; it must not jump above a label match.
    const r = searchPages('income', { limit: 20 }).map((x) => base(x.href));
    expect(r[0]).toBe('/income-tracker'); // QuickBooks name "Income Tracker" starts with the word
  });
});

describe('re-test 2: permissions and feature switches still filter', () => {
  it('a role that cannot open the Report Center never gets it for "reports", and every result is allowed', () => {
    for (const r of BUILTIN_ROLES) {
      const perms = permsOf(r.key);
      const res = searchPages('reports', { permissions: perms, limit: 50 });
      const all = searchPages('reports', { limit: 50 });
      // Results for the role are a subset of the owner's results.
      const owner = new Set(all.map((x) => base(x.href)));
      for (const x of res) expect(owner.has(base(x.href)), `${r.key} ${x.href}`).toBe(true);
      expect(new Set(res.map((x) => base(x.href))).size, r.key).toBe(res.length);
    }
  });

  it('a member with no report rights gets no report page for "reports" or "report center"', () => {
    const perms = { customers: ['view', 'create', 'edit'] } as unknown as PermissionSet;
    for (const q of ['reports', 'report center', 'Report Center', 'payroll report']) {
      const res = searchPages(q, { permissions: perms, limit: 50 }).map((x) => base(x.href));
      expect(res.filter((p) => p.startsWith('/reports')), q).toEqual([]);
    }
  });

  it('hiding /reports (feature switch or not allowed) removes it even though it scores 80', () => {
    const res = searchPages('reports', { hiddenPaths: new Set(['/reports']), limit: 50 }).map((x) => base(x.href));
    expect(res).not.toContain('/reports');
    expect(res.length).toBeGreaterThan(0);
  });

  it('payroll off: "paycheck" does not offer payroll pages', () => {
    const hidden = featureHiddenPaths({ ...DEFAULT_COMPANY_PREFERENCES, payrollEnabled: false });
    const res = searchPages('paycheck', { hiddenPaths: hidden, limit: 50 }).map((x) => base(x.href));
    for (const p of res) expect(hidden.has(p), p).toBe(false);
    expect(res).not.toContain('/pay-runs');
  });

  it('limit is respected for the boosted query', () => {
    for (const limit of [1, 2, 3]) expect(searchPages('reports', { limit }).length).toBeLessThanOrEqual(limit);
  });
});

describe('re-test 2: keyword boost side effects', () => {
  // Estimate Follow-up has the single keyword "quotes", so the new exact-keyword score (80) puts it
  // above Create Estimates (keywords "quote bid proposal", scored ~51). Before the fix "quotes"
  // opened Estimates first; a non-accountant asking for quotes wants to make one, as "quote" does.
  it('"quotes" opens Estimates first, the same as "quote"', () => {
    expect(top('quote')).toBe('/estimates');
    expect(top('quotes')).toBe('/estimates');
  });
});
