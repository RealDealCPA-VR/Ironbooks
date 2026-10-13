/**
 * p1 ux QA re-test round 2 (tester): narrow windows (below lg) get page search and the Simple/All
 * menus switch in the top bar, the wide sidebar copies stay as they were, and the two search boxes
 * never share element ids (aria-controls / aria-activedescendant must point at their own list).
 * There is no DOM test environment, so this reads components/AppShell.tsx.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(__dirname, '../components/AppShell.tsx'), 'utf8');
const uses = (tag: string) => [...src.matchAll(new RegExp(`<${tag}\\b([^>]*?)/>`, 'gs'))].map((m) => m[1]);

describe('re-test 2: narrow-window search and menu switch', () => {
  it('there are exactly two page search boxes: the sidebar one (lg and up) and a top-bar one (below lg)', () => {
    const s = uses('SidebarSearch');
    expect(s).toHaveLength(2);
    // Sidebar copy uses the defaults (hidden below lg); the top-bar copy is lg:hidden.
    expect(src).toMatch(/idPrefix = 'ss',\s*className = '[^']*\bhidden lg:block\b[^']*'/);
    const narrow = s.find((a) => /idPrefix=/.test(a));
    expect(narrow).toBeDefined();
    expect(narrow).toMatch(/className="[^"]*\blg:hidden\b[^"]*"/);
    expect(narrow).not.toMatch(/\bhidden lg:block\b/);
    expect(narrow).toMatch(/permissions=\{me\?\.permissions\}/);
    expect(narrow).toMatch(/hiddenPaths=\{hiddenPaths\}/);
  });

  it('the two search boxes have different id prefixes and every id in the search box uses the prefix', () => {
    const prefixes = uses('SidebarSearch').map((a) => /idPrefix="([^"]+)"/.exec(a)?.[1] ?? 'ss');
    expect(new Set(prefixes).size).toBe(2);
    expect(src).not.toMatch(/id="sidebar-search-results"/);
    expect(src).not.toMatch(/aria-controls="sidebar-search-results"/);
    expect(src).not.toMatch(/`ss-opt-\$\{/);
    expect(src).toMatch(/aria-controls=\{`\$\{idPrefix\}-search-results`\}/);
    expect(src).toMatch(/id=\{`\$\{idPrefix\}-search-results`\}/);
    expect(src).toMatch(/id=\{`\$\{idPrefix\}-opt-\$\{i\}`\}/);
    expect(src).toMatch(/aria-activedescendant=\{[^}]*`\$\{idPrefix\}-opt-\$\{active\}`/);
  });

  it('the Simple/All menus switch appears in the sidebar (lg and up) and in the top bar (below lg), both wired to the same change handler', () => {
    const t = uses('MenuModeToggle');
    expect(t).toHaveLength(2);
    expect(src).toMatch(/className = 'hidden lg:flex[^']*'/);
    const narrow = t.find((a) => /className=/.test(a));
    expect(narrow).toMatch(/\blg:hidden\b/);
    expect(narrow).not.toMatch(/\bhidden lg:flex\b/);
    for (const a of t) {
      expect(a).toMatch(/mode=\{navMode\}/);
      expect(a).toMatch(/onChange=\{changeMode\}/);
    }
  });

  it('the top-bar copies live in the page header, not inside the sidebar', () => {
    const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
    expect(header).toMatch(/<SidebarSearch\b/);
    expect(header).toMatch(/<MenuModeToggle\b/);
    const aside = src.slice(src.indexOf('<aside'), src.indexOf('</aside>'));
    expect((aside.match(/<SidebarSearch\b/g) ?? []).length).toBe(1);
    expect((aside.match(/<MenuModeToggle\b/g) ?? []).length).toBe(1);
  });
});
