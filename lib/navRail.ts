/**
 * The left menu can be collapsed to its icon rail at any window width (office feedback). The
 * sidebar's wide layout is written with `lg:` classes over its narrow-window rail layout; when
 * the person collapses it, those `lg:` classes are dropped, so the rail shows on a wide window too.
 */

/** Class list for the sidebar: unchanged when expanded, without its `lg:` classes when collapsed. */
export function railClasses(classes: string, collapsed: boolean): string {
  if (!collapsed) return classes;
  return classes
    .split(/\s+/)
    .filter((c) => c && !c.startsWith('lg:'))
    .join(' ');
}

/** Where the choice is remembered (this computer, per user). */
export const railKey = (userId: string | undefined) => `bka.nav.rail.${userId ?? 'anon'}`;
