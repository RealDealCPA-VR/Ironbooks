/**
 * Client-side "may this person open this page / use this activity?" (prefsperms). COSMETIC — the
 * server checks every page and API route (enforce.ts) — but it keeps the menus, the command bar
 * and the buttons honest about what a role allows.
 *
 * `permissions` is the map useMe() returns (lib/usePermissions.ts): area keys ('customers') and,
 * from servers with activities, activity keys ('customers.invoices'). Without activity keys the
 * checks fall back to the areas, exactly as before.
 */
import { ACTIVITY_KEYS, activityDef, type ActivityAction } from './activities';
import { pageAccessFor } from './routes';

export type PermissionMap = Partial<Record<string, readonly string[]>> | null | undefined;

/** True when the map carries per-activity rights (a server with activities). */
export function hasActivityRights(permissions: PermissionMap): boolean {
  if (!permissions) return false;
  return ACTIVITY_KEYS.some((k) => permissions[k] !== undefined);
}

/** Page visibility for one person (null permissions = not loaded yet → shown). */
export function canSeePage(path: string, permissions: PermissionMap): boolean {
  if (!permissions) return true;
  const need = pageAccessFor(path.split('?')[0].split('#')[0]);
  if (!need) return true;
  if (need.activities && hasActivityRights(permissions)) {
    return need.activities.some((k) => permissions[k]?.includes('view') ?? false);
  }
  const areas = need.areas.length ? need.areas : need.activities?.map((k) => activityDef(k)!.area) ?? [];
  return areas.some((a) => permissions[a]?.includes('view') ?? false);
}

/** One activity right for UI gating (unknown permissions → true; the server decides). */
export function canUseActivity(permissions: PermissionMap, activity: string, action: ActivityAction): boolean {
  if (!permissions) return true;
  const def = activityDef(activity);
  if (!def) return true;
  if (hasActivityRights(permissions)) return permissions[def.key]?.includes(action) ?? false;
  return permissions[def.area]?.includes(action === 'view_balance' ? 'view' : action) ?? false;
}
