'use client';
/**
 * usePreferences() — the resolved company + My Preferences for client pages and forms.
 *
 * Loads GET /api/preferences once per page load (shared across components) and falls back to the
 * defaults from lib/preferences.ts until it arrives (or if it fails), so forms never block on it.
 * Call refreshPreferences() after saving Preferences.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import {
  DEFAULT_COMPANY_PREFERENCES,
  DEFAULT_MY_PREFERENCES,
  resolveCompanyPreferences,
  resolveMyPreferences,
  todayInTimeZone,
  type CompanyPreferences,
  type MyPreferences,
} from '@/lib/preferences';

export interface PreferencesState {
  company: CompanyPreferences;
  my: MyPreferences;
  loaded: boolean;
  /** Today's date ('YYYY-MM-DD') in the company time zone. */
  today: string;
}

let cache: { company: CompanyPreferences; my: MyPreferences } | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  inflight = api
    .get<{ company: unknown; my: unknown }>('/api/preferences')
    .then((data) => {
      cache = { company: resolveCompanyPreferences(data.company), my: resolveMyPreferences(data.my) };
    })
    .catch(() => {
      cache = cache ?? { company: DEFAULT_COMPANY_PREFERENCES, my: DEFAULT_MY_PREFERENCES };
    })
    .finally(() => {
      listeners.forEach((l) => l());
    });
  return inflight;
}

/** Re-fetch preferences (e.g. after the Preferences page saves). */
export function refreshPreferences(): Promise<void> {
  return load(true);
}

/** `enabled=false` skips loading (e.g. the app shell on the sign-in pages); defaults are returned. */
export function usePreferences(enabled = true): PreferencesState {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    if (!cache) void load();
    return () => {
      listeners.delete(l);
    };
  }, [enabled]);
  const company = cache?.company ?? DEFAULT_COMPANY_PREFERENCES;
  return {
    company,
    my: cache?.my ?? DEFAULT_MY_PREFERENCES,
    loaded: cache !== null,
    today: todayInTimeZone(company.timezone),
  };
}
