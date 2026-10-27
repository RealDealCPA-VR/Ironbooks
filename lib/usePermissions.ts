'use client';
/**
 * Client hook: the signed-in user's effective permissions from GET /api/auth/me.
 * COSMETIC (hide/disable UI) — the server enforces every API route regardless.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { Action, ActivityAction, ActivityKey, ActivitySet, Area, Flag, PermissionSet } from '@/lib/permissions/model';
import { canUseActivity } from '@/lib/permissions/pageAccess';

export interface Me {
  id: string;
  email: string;
  name: string | null;
  totpEnabled: boolean;
  companyId: string | null;
  roleKeys: string[] | null;
  /**
   * Area rights, plus (prefsperms) every ACTIVITY's rights merged in under its key
   * ('customers.invoices'), so the menus and pages can check activities with one map.
   */
  permissions: (PermissionSet & Partial<Record<ActivityKey, ActivityAction[]>>) | null;
  /** QB Enterprise per-activity rights (prefsperms). */
  activities?: ActivitySet | null;
  flags: Record<Flag, boolean> | null;
  isAdmin: boolean;
}

export function useMe(enabled = true): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<Me | null>('/api/auth/me')
      .then((m) => {
        if (cancelled) return;
        // prefsperms: one map with areas and activities (see Me.permissions).
        setMe(m && m.permissions && m.activities ? { ...m, permissions: { ...m.activities, ...m.permissions } } : m);
      })
      .catch(() => {
        /* treat as unknown — UI shows everything, server still enforces */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return { me, loading };
}

/** One activity right for UI gating (prefsperms); unknown permissions → true (server decides). */
export function canDoActivity(me: Me | null, activity: ActivityKey, action: ActivityAction): boolean {
  return canUseActivity(me?.permissions as Partial<Record<string, readonly string[]>> | null | undefined, activity, action);
}

/** can(me, area, action) for UI gating; unknown permissions → true (server decides). */
export function canDo(me: Me | null, area: Area, action: Action): boolean {
  if (!me?.permissions) return true;
  return me.permissions[area]?.includes(action) ?? false;
}
