'use client';
/**
 * QuickBooks Enterprise "Edit Role" Area and Activity tree (prefsperms, PARITY K).
 *
 * Every area (Banking, Customers & Receivables, …) opens to its activities (Invoices, Receive
 * Payments, Statements, …). Each activity has an access level — None, Full or Partial — and, for
 * Partial, the rights it has: View, Create, Modify, Delete, Print and View Balance (only the ones
 * the activity has are offered). An area row sets all of its activities at once.
 *
 * Keyboard: every control is a native button / select / checkbox (Tab, Space, Enter).
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Select } from '@/components/ui';

export type Right = 'view' | 'create' | 'modify' | 'delete' | 'print' | 'view_balance';
export const RIGHTS: Right[] = ['view', 'create', 'modify', 'delete', 'print', 'view_balance'];
export const RIGHT_LABEL: Record<Right, string> = {
  view: 'View',
  create: 'Create',
  modify: 'Modify',
  delete: 'Delete',
  print: 'Print',
  view_balance: 'View Balance',
};

export interface CatalogActivity {
  key: string;
  area: string;
  label: string;
  description: string;
  /** Every right the activity has (View first). */
  actions: Right[];
}
export interface CatalogArea {
  key: string;
  label: string;
  group: string;
  description: string;
}
export interface CatalogFlag {
  key: string;
  label: string;
}

/** Activity key → granted rights. */
export type ActivityGrant = Record<string, Right[]>;

type Level = 'none' | 'full' | 'partial';

function levelOf(supported: Right[], granted: Right[] | undefined): Level {
  const g = granted ?? [];
  if (!g.includes('view')) return 'none';
  return supported.every((r) => g.includes(r)) ? 'full' : 'partial';
}

const LEVEL_LABEL: Record<Level, string> = { none: 'None', full: 'Full', partial: 'Partial' };

export default function ActivityMatrix({
  areas,
  activities,
  flags,
  value,
  flagValues,
  readOnly,
  onChange,
  onFlagsChange,
}: {
  areas: CatalogArea[];
  activities: CatalogActivity[];
  flags: CatalogFlag[];
  value: ActivityGrant;
  flagValues: Record<string, boolean | undefined>;
  readOnly?: boolean;
  onChange?: (g: ActivityGrant) => void;
  onFlagsChange?: (f: Record<string, boolean>) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const byArea = useMemo(() => {
    const m = new Map<string, CatalogActivity[]>();
    for (const a of activities) m.set(a.area, [...(m.get(a.area) ?? []), a]);
    return m;
  }, [activities]);

  function setActivity(a: CatalogActivity, rights: Right[], next: ActivityGrant = { ...value }) {
    const set = new Set(rights.filter((r) => a.actions.includes(r)));
    if (set.size && !set.has('view')) set.add('view'); // any right needs View
    if (set.size) next[a.key] = a.actions.filter((r) => set.has(r));
    else delete next[a.key];
    return next;
  }
  function setLevel(a: CatalogActivity, level: Level) {
    const rights: Right[] = level === 'full' ? a.actions : level === 'partial' ? ['view'] : [];
    onChange?.(setActivity(a, rights));
  }
  function toggle(a: CatalogActivity, right: Right, on: boolean) {
    const cur = new Set(value[a.key] ?? []);
    if (on) cur.add(right);
    else if (right === 'view') cur.clear(); // no View, no access
    else cur.delete(right);
    onChange?.(setActivity(a, [...cur]));
  }
  function setArea(areaKey: string, level: Level) {
    let next: ActivityGrant = { ...value };
    for (const a of byArea.get(areaKey) ?? []) {
      next = setActivity(a, level === 'full' ? a.actions : level === 'partial' ? ['view'] : [], next);
    }
    onChange?.(next);
  }
  function areaLevel(areaKey: string): Level | 'mixed' {
    const levels = new Set((byArea.get(areaKey) ?? []).map((a) => levelOf(a.actions, value[a.key])));
    return levels.size === 1 ? [...levels][0] : 'mixed';
  }

  let lastGroup = '';
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-navy/50">
              <th className="px-3 py-2">Area and activity</th>
              <th className="px-2 py-2">Access</th>
              {RIGHTS.map((r) => (
                <th key={r} className="px-2 py-2 text-center">
                  {RIGHT_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {areas.flatMap((area) => {
              const rows = [];
              if (area.group !== lastGroup) {
                lastGroup = area.group;
                rows.push(
                  <tr key={`g-${area.group}`}>
                    <td colSpan={RIGHTS.length + 2} className="px-3 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">
                      {area.group}
                    </td>
                  </tr>,
                );
              }
              const acts = byArea.get(area.key) ?? [];
              const isOpen = open.has(area.key);
              const lvl = areaLevel(area.key);
              rows.push(
                <tr key={area.key} className="border-t border-slate-100 bg-white">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`acts-${area.key}`}
                      onClick={() =>
                        setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(area.key)) n.delete(area.key);
                          else n.add(area.key);
                          return n;
                        })
                      }
                      className="flex items-center gap-1.5 text-left font-semibold text-navy hover:text-electric focus:outline-none focus-visible:ring-2 focus-visible:ring-electric/40 rounded"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {area.label}
                      <span className="text-xs font-normal text-navy/40">({acts.length} activities)</span>
                    </button>
                    <span className="block pl-6 text-xs text-navy/40">{area.description}</span>
                  </td>
                  <td className="px-2 py-2" colSpan={RIGHTS.length + 1}>
                    {readOnly ? (
                      <span className="text-navy/70">{lvl === 'mixed' ? 'Partial (varies)' : LEVEL_LABEL[lvl]}</span>
                    ) : (
                      <Select
                        aria-label={`${area.label}: access for every activity`}
                        className="w-48"
                        value={lvl === 'mixed' ? 'mixed' : lvl}
                        onChange={(e) => {
                          if (e.target.value !== 'mixed') setArea(area.key, e.target.value as Level);
                        }}
                      >
                        {lvl === 'mixed' && <option value="mixed">Varies by activity</option>}
                        <option value="none">None (whole area)</option>
                        <option value="partial">View only (whole area)</option>
                        <option value="full">Full (whole area)</option>
                      </Select>
                    )}
                  </td>
                </tr>,
              );
              if (isOpen) {
                for (const a of acts) {
                  const granted = value[a.key] ?? [];
                  const level = levelOf(a.actions, granted);
                  rows.push(
                    <tr key={a.key} id={`acts-${area.key}`} className="border-t border-slate-50">
                      <td className="py-1.5 pl-10 pr-3">
                        <span className="text-navy">{a.label}</span>
                        <span className="block text-xs text-navy/40">{a.description}</span>
                      </td>
                      <td className="px-2 py-1.5">
                        {readOnly ? (
                          <span className="text-navy/70">{LEVEL_LABEL[level]}</span>
                        ) : (
                          <Select
                            aria-label={`${area.label} — ${a.label}: access level`}
                            className="w-28"
                            value={level}
                            onChange={(e) => setLevel(a, e.target.value as Level)}
                          >
                            <option value="none">None</option>
                            <option value="partial">Partial</option>
                            <option value="full">Full</option>
                          </Select>
                        )}
                      </td>
                      {RIGHTS.map((r) => (
                        <td key={r} className="px-2 py-1.5 text-center">
                          {a.actions.includes(r) ? (
                            <input
                              type="checkbox"
                              aria-label={`${a.label}: ${RIGHT_LABEL[r]}`}
                              checked={granted.includes(r)}
                              disabled={readOnly}
                              onChange={(e) => toggle(a, r, e.target.checked)}
                            />
                          ) : (
                            <span className="text-navy/20" aria-hidden="true">
                              –
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>,
                  );
                }
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-navy/50">
        Click an area to see its activities. View Balance shows account and customer / vendor balances; without it,
        balances read &quot;Hidden&quot;. Any right includes View.
      </p>
      <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40">Sensitive data</div>
        {flags.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-sm text-navy">
            <input
              type="checkbox"
              checked={Boolean(flagValues?.[f.key])}
              disabled={readOnly}
              onChange={(e) =>
                onFlagsChange?.({ ...(flagValues as Record<string, boolean>), [f.key]: e.target.checked })
              }
            />
            {f.label}
          </label>
        ))}
      </div>
    </div>
  );
}
