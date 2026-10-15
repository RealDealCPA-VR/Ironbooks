/**
 * team home: the "Needs attention" inbox is reachable in both menu styles, explains itself, and
 * is where Simple mode lands (Home's first tab); All menus keeps the Overview as the default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_TAB_HREF, homeTabFor } from './homeTabs';
import { navGroups, simpleNavGroups, searchPages, visibleNavGroups } from './nav';
import { pageHelpFor } from './pageHelp';
import { pageAreasFor } from './permissions/routes';
import { BUILTIN_ROLES, unionRoles } from './permissions/model';
import { ATTENTION_KINDS, ATTENTION_KIND_LABELS } from './attentionKinds';

const links = (groups: typeof navGroups) => groups.flatMap((g) => g.links);

describe('Home tabs', () => {
  it('Simple mode lands on Needs attention; All menus on the Overview', () => {
    expect(homeTabFor(undefined, 'simple')).toBe('attention');
    expect(homeTabFor(undefined, 'advanced')).toBe('overview');
    expect(homeTabFor('overview', 'simple')).toBe('overview');
    expect(homeTabFor('attention', 'advanced')).toBe('attention');
    expect(homeTabFor(['attention', 'x'], 'advanced')).toBe('attention');
    expect(homeTabFor('bogus', 'advanced')).toBe('overview');
    expect(HOME_TAB_HREF.attention).toBe('/dashboard?tab=attention');
  });
});

describe('Needs attention in the menus', () => {
  it('is in both menu styles, right under Home, and opens a real page', () => {
    for (const groups of [navGroups, simpleNavGroups]) {
      const home = groups[0].links.map((l) => l.path);
      expect(home.indexOf('/attention')).toBe(home.indexOf('/dashboard') + 1);
    }
    expect(fs.existsSync(path.resolve(process.cwd(), 'app', 'attention', 'page.tsx'))).toBe(true);
    expect(links(simpleNavGroups).length).toBeLessThanOrEqual(20);
  });

  it('every member sees it (the list itself is filtered to what they can act on)', () => {
    expect(pageAreasFor('/attention')).toBeNull();
    for (const r of BUILTIN_ROLES) {
      const perms = unionRoles([r]).permissions;
      for (const mode of ['simple', 'advanced'] as const) {
        expect(links(visibleNavGroups(mode, perms, new Set())).some((l) => l.path === '/attention'), `${r.key}/${mode}`).toBe(true);
      }
    }
  });

  it('has "What is this page?" help and is found by plain words', () => {
    const h = pageHelpFor('/attention')!;
    expect(h.title).toBe('Needs attention');
    expect(h.what.length).toBeGreaterThan(20);
    expect(searchPages('needs attention')[0].href).toBe('/attention');
    expect(searchPages('inbox')[0].href).toBe('/attention');
  });

  it('every item kind has a plain-language name', () => {
    for (const k of ATTENTION_KINDS) expect(ATTENTION_KIND_LABELS[k]).toMatch(/^[A-Z][a-z -]+$/);
  });
});
