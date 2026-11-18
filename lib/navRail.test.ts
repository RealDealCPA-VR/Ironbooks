/**
 * The left menu collapses to its icons at any window width (lib/navRail.ts, components/AppShell.tsx).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { railClasses, railKey } from './navRail';

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

describe('collapsible left menu', () => {
  it('collapsed drops the wide-window (lg:) classes, so the icon rail shows; expanded changes nothing', () => {
    const aside = 'w-20 lg:w-60 sticky px-2 lg:px-3';
    expect(railClasses(aside, false)).toBe(aside);
    expect(railClasses(aside, true)).toBe('w-20 sticky px-2');
    expect(railClasses('hidden lg:inline-block text-sm', true)).toBe('hidden text-sm'); // labels hidden
    expect(railClasses('lg:hidden mx-2 my-2', true)).toBe('mx-2 my-2'); // group dividers shown
    expect(railClasses('', true)).toBe('');
  });

  it('is remembered per user', () => {
    expect(railKey('u1')).toBe('bka.nav.rail.u1');
    expect(railKey(undefined)).toBe('bka.nav.rail.anon');
  });

  it('the shell has Collapse / Expand buttons and moves the menu switch and search to the top bar', () => {
    const src = read('components/AppShell.tsx');
    expect(src).toContain('aria-label="Collapse the menu"');
    expect(src).toContain('aria-label="Expand the menu"');
    expect(src).toContain("writeLocal(railKey(me?.id), prev ? '0' : '1')");
    expect(src).toContain("{!rail && <MenuModeToggle mode={navMode} onChange={changeMode} />}");
    expect(src).toContain("className={rc('flex lg:hidden w-40')}");
    expect(src).toContain('<BackupIndicator rail={rail} />');
  });
});
