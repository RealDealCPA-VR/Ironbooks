/**
 * p1 ux QA re-test round 3 (tester): proves the ddede9c fix (Estimate Follow-up keywords changed
 * from 'quotes' to 'quotes follow up') without regressions.
 *  - "quotes" in any case / spacing / form opens Create Estimates first; Estimate Follow-up is
 *    still offered right after it and is still reachable by its own name and by "follow up".
 *  - "reports" still opens the Report Center (the round-2 fix is intact).
 *  - Guard against the class of bug: no page answers to a one-word keyword list that is also the
 *    QuickBooks meaning of another page, and every one-word keyword list opens its own page or a
 *    page whose own name contains the word.
 *  - Permissions and feature switches still filter the estimate pages.
 */
import { describe, expect, it } from 'vitest';
import { navGroups, searchPages, simpleNavGroups } from './nav';
import { BUILTIN_ROLES, unionRoles, type PermissionSet } from './permissions/model';

const permsOf = (key: string) => unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)).permissions as PermissionSet;
const base = (href: string) => href.split(/[?#]/)[0];
const list = (q: string, opts?: Parameters<typeof searchPages>[1]) => searchPages(q, { limit: 20, ...opts }).map((x) => base(x.href));
const top = (q: string, opts?: Parameters<typeof searchPages>[1]) => list(q, opts)[0];
const ALL_LINKS = [...navGroups, ...simpleNavGroups].flatMap((g) => g.links);

describe('re-test 3: "quotes" opens Create Estimates', () => {
  it.each(['quotes', 'Quotes', 'QUOTES', '  quotes  ', 'quote', 'a quote', 'the quotes', 'my quotes', 'estimate', 'estimates', 'bid', 'proposal', 'create estimates'])(
    '%j -> /estimates first',
    (q) => {
      expect(top(q)).toBe('/estimates');
    },
  );

  it('Estimate Follow-up is still offered for "quotes", right after Create Estimates', () => {
    const r = list('quotes');
    expect(r[0]).toBe('/estimates');
    expect(r[1]).toBe('/estimates-followup');
    expect(new Set(r).size).toBe(r.length);
  });

  it.each(['Estimate Follow-up', 'estimate follow up', 'Estimates follow-up', 'quotes follow up', 'follow-up on quotes', 'estimate follow'])(
    '%j -> /estimates-followup first',
    (q) => {
      expect(top(q)).toBe('/estimates-followup');
    },
  );

  it('"follow up" still reaches Estimate Follow-up', () => {
    expect(list('follow up')).toContain('/estimates-followup');
  });

  it('Estimate Follow-up no longer answers to the single word "quotes" (its keyword list has more words)', () => {
    const link = ALL_LINKS.find((l) => l.path === '/estimates-followup');
    expect(link).toBeDefined();
    expect(link!.keywords!.trim().split(/\s+/).length).toBeGreaterThan(1);
    expect(link!.keywords).toMatch(/quotes/);
  });
});

describe('re-test 3: round-2 "reports" fix is intact', () => {
  it.each(['reports', 'Reports', 'report', 'reporting', 'report center'])('%j -> /reports first', (q) => {
    expect(top(q)).toBe('/reports');
  });
});

describe('re-test 3: one-word keyword lists cannot hijack another page', () => {
  const stem = (w: string) => (w.length <= 3 ? w : w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, ''));
  const singles = ALL_LINKS.filter((l) => l.keywords && l.keywords.trim().split(/\s+/).length === 1);

  it('no two different pages share the same one-word keyword list', () => {
    const owners = new Map<string, Set<string>>();
    for (const l of singles) {
      const k = stem(l.keywords!.trim().toLowerCase());
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k)!.add(l.path);
    }
    const clashes = [...owners].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}: ${[...s].join(', ')}`);
    expect(clashes).toEqual([]);
  });

  it('every one-word keyword opens its own page, or a page whose own name contains that word', () => {
    const bad: string[] = [];
    for (const l of singles) {
      const word = l.keywords!.trim().toLowerCase();
      const got = top(word);
      if (got === l.path) continue;
      const winner = ALL_LINKS.find((x) => x.path === got);
      const names = `${winner?.label ?? ''} ${winner?.qb ?? ''}`.toLowerCase();
      if (!winner || !names.includes(stem(word))) bad.push(`${word} -> ${got} (expected ${l.path})`);
    }
    expect(bad).toEqual([]);
  });

  it('a one-word keyword never outranks a page whose own name starts with the word typed', () => {
    // "chart" is the keyword of Graphs, but Chart of Accounts is the page named "Chart ...".
    expect(top('chart')).toBe('/accounts');
    expect(list('chart')).toContain('/reports/graphs');
  });
});

describe('re-test 3: earlier QB meanings still hold', () => {
  const CASES: Array<[string, string]> = [
    ['make a deposit', '/deposits'],
    ['late fee', '/finance-charges'],
    ['enter a bill', '/bills'],
    ['pay a bill', '/pay-bills'],
    ['write checks', '/expenses'],
    ['record a sale', '/sales-receipts'],
    ['i got paid', '/payments'],
    ['balance sheet', '/reports/balance-sheet'],
    ['p&l', '/reports/profit-loss'],
    ['clients', '/customers'],
    ['suppliers', '/vendors'],
    ['bulk', '/lists/multiple'],
    ['stock', '/inventory-center'],
    ['schedule', '/calendar'],
  ];
  it.each(CASES)('%j -> %s', (q, want) => {
    expect(top(q)).toBe(want);
  });
});

describe('re-test 3: permissions and feature switches still filter the estimate pages', () => {
  it('hiding /estimates moves Estimate Follow-up to the top for "quotes" (no hidden page leaks)', () => {
    const r = list('quotes', { hiddenPaths: new Set(['/estimates']) });
    expect(r).not.toContain('/estimates');
    expect(r[0]).toBe('/estimates-followup');
  });

  it('hiding both estimate pages leaves nothing estimate-related for "quotes"', () => {
    const r = list('quotes', { hiddenPaths: new Set(['/estimates', '/estimates-followup']) });
    expect(r).not.toContain('/estimates');
    expect(r).not.toContain('/estimates-followup');
  });

  it('for every built-in role, "quotes" results are a deduplicated subset of the owner results', () => {
    const owner = new Set(list('quotes', { limit: 50 }));
    for (const r of BUILTIN_ROLES) {
      const res = list('quotes', { permissions: permsOf(r.key), limit: 50 });
      for (const p of res) expect(owner.has(p), `${r.key} ${p}`).toBe(true);
      expect(new Set(res).size, r.key).toBe(res.length);
    }
  });

  it('a member with no sales rights gets no estimate page for "quotes"', () => {
    const perms = { vendors: ['view'] } as unknown as PermissionSet;
    const r = list('quotes', { permissions: perms, limit: 50 });
    expect(r).not.toContain('/estimates');
    expect(r).not.toContain('/estimates-followup');
  });

  it('limit is respected', () => {
    for (const limit of [1, 2]) expect(searchPages('quotes', { limit }).length).toBeLessThanOrEqual(limit);
  });
});
