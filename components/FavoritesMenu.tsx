'use client';
/**
 * QuickBooks' Favorites menu (Alt+A in the desktop app), mounted once by components/AppShell.tsx.
 * The pages a person put on it are their My Preferences `favorites`; this hands them to the
 * desktop menus (electron/main.js builds the Favorites menu from them) and shows Favorites >
 * Customize Favorites: pick pages from the list on the left, order them on the right.
 *
 * Keyboard: type to filter, Up / Down and Enter (or the Add button) add a page; in "On the
 * Favorites menu", the Move up / Move down / Remove buttons — or Alt+Up / Alt+Down / Delete on a
 * selected entry — order the menu. Save (Ctrl+S) keeps it.
 */
import * as React from 'react';
import { Button, Modal, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { canOpenHref, type PermissionMap } from '@/lib/commands/actions';
import { paletteDestinations } from '@/lib/nav';
import { MAX_FAVORITES } from '@/lib/preferences';
import { refreshPreferences, usePreferences } from '@/lib/usePreferences';
import { windowLabelFor } from './WindowList';

/** Favorites > Customize Favorites (the desktop menu sends it through components/DesktopBridge.tsx). */
export const CUSTOMIZE_FAVORITES_EVENT = 'ironbooks:customize-favorites';

interface FavoritesBridge {
  setFavorites?: (items: { label: string; route: string }[]) => Promise<unknown>;
}
function favoritesBridge(): FavoritesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: { chrome?: FavoritesBridge } }).bookkeeper?.chrome;
}

/** The menu entries for the stored favorites (each labelled as in the menus). */
export function favoriteMenuItems(paths: readonly string[]): { label: string; route: string }[] {
  return paths.map((route) => ({ label: windowLabelFor(route) ?? route, route }));
}

export default function FavoritesMenu({
  permissions,
  hiddenPaths,
}: {
  permissions?: PermissionMap;
  hiddenPaths?: ReadonlySet<string>;
}) {
  const prefs = usePreferences();
  const stored = prefs.my.favorites;
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState(0);
  const [filter, setFilter] = React.useState('');
  const [active, setActive] = React.useState(0);
  const [saving, setSaving] = React.useState(false);

  // The desktop's Favorites menu follows what is stored.
  const key = stored.join('|');
  React.useEffect(() => {
    if (!prefs.loaded) return;
    void favoritesBridge()?.setFavorites?.(favoriteMenuItems(stored))?.catch?.(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.loaded, key]);

  React.useEffect(() => {
    function onOpen() {
      setChosen(stored);
      setSelected(0);
      setFilter('');
      setActive(0);
      setOpen(true);
    }
    window.addEventListener(CUSTOMIZE_FAVORITES_EVENT, onOpen);
    return () => window.removeEventListener(CUSTOMIZE_FAVORITES_EVENT, onOpen);
  }, [stored]);

  const available = React.useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    return paletteDestinations.filter((d) => {
      const path = d.href.split('?')[0];
      if (seen.has(path)) return false;
      seen.add(path);
      if (chosen.includes(path) || hiddenPaths?.has(path) || !canOpenHref(path, permissions)) return false;
      return words.every((w) => d.label.toLowerCase().includes(w));
    });
  }, [filter, chosen, hiddenPaths, permissions]);

  function add(path: string) {
    setChosen((c) => (c.includes(path) || c.length >= MAX_FAVORITES ? c : [...c, path]));
    if (chosen.length >= MAX_FAVORITES) toast(`The Favorites menu holds at most ${MAX_FAVORITES} pages.`, 'info');
  }
  function move(i: number, by: -1 | 1) {
    setChosen((c) => {
      const j = i + by;
      if (j < 0 || j >= c.length) return c;
      const next = c.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setSelected((s) => Math.max(0, Math.min(chosen.length - 1, s + by)));
  }
  function remove(i: number) {
    setChosen((c) => c.filter((_, k) => k !== i));
    setSelected((s) => Math.max(0, Math.min(s, chosen.length - 2)));
  }

  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/preferences/my', { favorites: chosen });
      await refreshPreferences();
      toast('Favorites menu saved.', 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the Favorites menu.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Customize Favorites"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="fav-filter" className="mb-1 block text-[13px] font-medium text-navy/70">
            Available pages
          </label>
          <input
            id="fav-filter"
            type="search"
            value={filter}
            placeholder="Type to find a page"
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, Math.min(available.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if (e.key === 'Enter' && available[active]) {
                e.preventDefault();
                add(available[active].href.split('?')[0]);
              }
            }}
            aria-controls="fav-available"
            aria-activedescendant={available[active] ? `fav-av-${active}` : undefined}
            className="mb-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-4 focus:ring-electric/20"
          />
          <ul id="fav-available" role="listbox" aria-label="Available pages" className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            {available.map((d, i) => (
              <li
                key={d.href}
                id={`fav-av-${i}`}
                role="option"
                aria-selected={i === active}
                className={`flex items-center justify-between gap-2 px-3 py-1.5 text-sm ${i === active ? 'bg-electric/10' : ''}`}
              >
                <span className="truncate text-navy">{d.label}</span>
                <Button size="sm" variant="ghost" onClick={() => add(d.href.split('?')[0])} aria-label={`Add ${d.label}`}>
                  Add
                </Button>
              </li>
            ))}
            {available.length === 0 && <li className="px-3 py-3 text-sm text-navy/50">No other page matches.</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-[13px] font-medium text-navy/70" id="fav-chosen-label">
            On the Favorites menu ({chosen.length} of {MAX_FAVORITES})
          </div>
          <ul
            role="listbox"
            aria-labelledby="fav-chosen-label"
            tabIndex={chosen.length ? 0 : -1}
            aria-activedescendant={chosen[selected] ? `fav-ch-${selected}` : undefined}
            onKeyDown={(e) => {
              if (!chosen.length) return;
              if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                move(selected, e.key === 'ArrowUp' ? -1 : 1);
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => Math.max(0, Math.min(chosen.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if (e.key === 'Delete') {
                e.preventDefault();
                remove(selected);
              }
            }}
            className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            {chosen.map((path, i) => (
              <li
                key={path}
                id={`fav-ch-${i}`}
                role="option"
                aria-selected={i === selected}
                onClick={() => setSelected(i)}
                className={`flex items-center justify-between gap-1 px-3 py-1.5 text-sm ${i === selected ? 'bg-electric/10' : ''}`}
              >
                <span className="truncate text-navy">{windowLabelFor(path) ?? path}</span>
                <span className="flex shrink-0 gap-0.5">
                  <Button size="sm" variant="ghost" tabIndex={-1} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${path} up`}>
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" tabIndex={-1} onClick={() => move(i, 1)} disabled={i === chosen.length - 1} aria-label={`Move ${path} down`}>
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" tabIndex={-1} onClick={() => remove(i)} aria-label={`Remove ${path}`}>
                    Remove
                  </Button>
                </span>
              </li>
            ))}
            {chosen.length === 0 && <li className="px-3 py-3 text-sm text-navy/50">Nothing yet. Add the pages you open most.</li>}
          </ul>
          <p className="mt-2 text-xs text-navy/50">Alt+Up / Alt+Down move the selected page; Delete removes it.</p>
        </div>
      </div>
    </Modal>
  );
}
