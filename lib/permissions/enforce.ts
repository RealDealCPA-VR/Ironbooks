/**
 * Central request authorization, called by `getServerContext` for every API route and
 * server-rendered page. The request's pathname + method come from headers stamped by
 * middleware.ts (always overwritten there, so a client can't forge them).
 *
 *  - API paths: looked up in API_ROUTE_PERMISSIONS. Unmapped path/method → DENY (fail closed).
 *  - Page paths: PAGE_AREAS prefix → needs 'view' of that area; unlisted pages are open.
 *  - No request scope (vitest, scripts, background jobs) → nothing to enforce.
 *  - Request scope but no stamp (middleware didn't run) → only an Admin passes.
 */
import { headers } from 'next/headers';
import { ServiceError } from '@/lib/services/_base';
import { permissionDenied } from '@/lib/services/access';
import { can, canActivity, canWholeArea, type EffectiveAccess } from './model';
import type { ActivityKey } from './activities';
import {
  ROUTE_METHOD_HEADER,
  ROUTE_PATH_HEADER,
  apiActivityFor,
  apiRuleFor,
  pageAccessFor,
  type RouteRule,
} from './routes';

export interface RequestInfo {
  path: string | null;
  method: string;
}

/** Path/method of the current request, or null outside a request scope. */
export async function currentRequestInfo(): Promise<RequestInfo | null> {
  let h: Headers;
  try {
    h = (await headers()) as unknown as Headers;
  } catch {
    return null; // not inside a request (tests, scripts)
  }
  return {
    path: h.get(ROUTE_PATH_HEADER),
    method: (h.get(ROUTE_METHOD_HEADER) || 'GET').toUpperCase(),
  };
}

/** Throw FORBIDDEN unless `access` satisfies the rule. */
export function assertRule(
  rule: RouteRule | null,
  access: EffectiveAccess,
  path: string,
  activity: ActivityKey | null = null,
): void {
  if (rule === null) {
    throw new ServiceError(
      'FORBIDDEN',
      `No permission mapping exists for ${path}. Access denied.`,
    );
  }
  if (rule === 'public' || rule === 'self' || rule === 'member') return;
  // prefsperms: the activity of the area (Invoices, Receive Payments, …) when the route has one;
  // otherwise every activity of the area must allow the action (fail closed).
  if (activity) {
    if (!canActivity(access, activity, rule.action)) throw permissionDenied(rule.area, rule.action, activity);
    return;
  }
  if (!canWholeArea(access, rule.area, rule.action)) throw permissionDenied(rule.area, rule.action);
}

/** Authorize a concrete request against the declarative maps. */
export function authorizeRequest(info: RequestInfo, access: EffectiveAccess): void {
  const { path, method } = info;
  if (!path) {
    if (access.isAdmin) return;
    throw new ServiceError('FORBIDDEN', 'This request could not be authorized.');
  }
  if (path === '/api' || path.startsWith('/api/')) {
    assertRule(apiRuleFor(path, method), access, `${method} ${path}`, apiActivityFor(path, method));
    return;
  }
  const need = pageAccessFor(path);
  if (!need) return;
  if (need.activities) {
    if (!need.activities.some((k) => canActivity(access, k, 'view'))) {
      throw permissionDenied(need.areas[0] ?? 'company', 'view', need.activities[0]);
    }
    return;
  }
  if (!need.areas.some((a) => can(access, a, 'view'))) throw permissionDenied(need.areas[0], 'view');
}

/** getServerContext hook: authorize the in-flight request (no-op outside a request). */
export async function enforceRequestPermission(access: EffectiveAccess): Promise<void> {
  const info = await currentRequestInfo();
  if (!info) return;
  authorizeRequest(info, access);
}

/**
 * getSessionGate hook (routes mapped 'self'): the in-flight API request must be mapped 'self'
 * or 'public'. Unmapped → denied; an area/member-mapped route calling the gate instead of
 * getServerContext is a programming error and is denied too (it would skip the area check).
 */
export async function enforceSelfRoute(): Promise<void> {
  const info = await currentRequestInfo();
  if (!info?.path) return; // outside a request scope (tests, scripts)
  const { path, method } = info;
  if (path !== '/api' && !path.startsWith('/api/')) return;
  const rule = apiRuleFor(path, method);
  if (rule === 'self' || rule === 'public') return;
  if (rule === null) {
    throw new ServiceError('FORBIDDEN', `No permission mapping exists for ${method} ${path}. Access denied.`);
  }
  throw new ServiceError('FORBIDDEN', `${method} ${path} must be authorized through getServerContext.`);
}
