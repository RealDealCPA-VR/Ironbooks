'use client';
/**
 * Client hook: the signed-in user's effective permissions from GET /api/auth/me.
 * COSMETIC (hide/disable UI) — the server enforces every API route regardless.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { Action, Area, Flag, PermissionSet } from '@/lib/permissions/model';

export interface Me {
  id: string;
  email: string;
  name: string | null;
  totpEnabled: boolean;
  companyId: string | null;
  roleKeys: string[] | null;
  permissions: PermissionSet | null;
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
        if (!cancelled) setMe(m);
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

/** can(me, area, action) for UI gating; unknown permissions → true (server decides). */
export function canDo(me: Me | null, area: Area, action: Action): boolean {
  if (!me?.permissions) return true;
  return me.permissions[area]?.includes(action) ?? false;
}
