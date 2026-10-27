/**
 * QuickBooks' open windows, for a one-page-at-a-time app: the pages opened this session, in the
 * order they were first opened (QuickBooks' Window > Open Window List). Ctrl+Tab / Ctrl+F6 move to
 * the next one, Ctrl+Shift+Tab / Ctrl+Shift+F6 to the previous one, Ctrl+F4 closes the current
 * one (components/WindowList.tsx). Pure: the list lives in sessionStorage there.
 */

export interface OpenWindow {
  /** The page's path: one window per page. */
  path: string;
  /** Where to reopen it: the path with the query it was last shown with (never ?new=1). */
  href: string;
  /** What it is called (the window title). */
  label: string;
}

/** QuickBooks keeps a long list; this many is plenty and keeps the list readable. */
export const MAX_OPEN_WINDOWS = 15;

/** Query keys that open a blank form or a one-off view: reopening a window must not repeat them. */
const ONE_SHOT_PARAMS = ['new', 'prefill', 'mem'];

/** The href a window reopens at: `href` without the one-shot query keys. */
export function reopenHref(href: string): string {
  const [pathAndQuery, hash = ''] = href.split('#');
  const [path, query = ''] = pathAndQuery.split('?');
  const params = new URLSearchParams(query);
  for (const k of ONE_SHOT_PARAMS) params.delete(k);
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`;
}

/** The list after visiting `href` (labelled `label`): a new page is added at the end. */
export function visitWindow(list: OpenWindow[], href: string, label: string): OpenWindow[] {
  const path = href.split('?')[0].split('#')[0];
  const at = list.findIndex((w) => w.path === path);
  const entry: OpenWindow = { path, href: reopenHref(href), label: label || path };
  if (at >= 0) {
    const next = list.slice();
    next[at] = entry;
    return next;
  }
  const next = [...list, entry];
  return next.length > MAX_OPEN_WINDOWS ? next.slice(next.length - MAX_OPEN_WINDOWS) : next;
}

/** The window `step` places after (1) or before (-1) the current page, or null with one window. */
export function cycleWindow(list: OpenWindow[], currentPath: string, step: 1 | -1): OpenWindow | null {
  if (list.length < 2) return null;
  const i = list.findIndex((w) => w.path === currentPath);
  if (i < 0) return list[step === 1 ? 0 : list.length - 1];
  return list[(i + step + list.length) % list.length];
}

/**
 * Ctrl+F4 on a page: the list without it, and the window to show instead — the one opened before
 * it, else the next one, else Home.
 */
export function closeWindow(list: OpenWindow[], currentPath: string, home = '/dashboard'): { list: OpenWindow[]; show: string } {
  const i = list.findIndex((w) => w.path === currentPath);
  const rest = list.filter((w) => w.path !== currentPath);
  if (!rest.length) return { list: [], show: home };
  const show = i > 0 ? rest[i - 1] : rest[0];
  return { list: rest, show: show.href };
}

/** Read the stored list, dropping anything malformed. */
export function parseWindowList(raw: string | null): OpenWindow[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (w): w is OpenWindow =>
          !!w && typeof w === 'object' && typeof (w as OpenWindow).path === 'string' && typeof (w as OpenWindow).href === 'string' &&
          (w as OpenWindow).href.startsWith('/') && !(w as OpenWindow).href.startsWith('//'),
      )
      .map((w) => ({ path: w.path, href: w.href, label: typeof w.label === 'string' ? w.label : w.path }))
      .slice(-MAX_OPEN_WINDOWS);
  } catch {
    return [];
  }
}
