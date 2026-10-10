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
import { can, type EffectiveAccess } from './model';
import {
  ROUTE_METHOD_HEADER,
  ROUTE_PATH_HEADER,
  apiRuleFor,
  pageAreasFor,
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
export function assertRule(rule: RouteRule | null, access: EffectiveAccess, path: string): void {
  if (rule === null) {
    throw new ServiceError(
      'FORBIDDEN',
      `No permission mapping exists for ${path}. Access denied.`,
    );
  }
  if (rule === 'public' || rule === 'self' || rule === 'member') return;
  if (!can(access, rule.area, rule.action)) throw permissionDenied(rule.area, rule.action);
}

/** Authorize a concrete request against the declarative maps. */
export function authorizeRequest(info: RequestInfo, access: EffectiveAccess): void {
  const { path, method } = info;
  if (!path) {
    if (access.isAdmin) return;
    throw new ServiceError('FORBIDDEN', 'This request could not be authorized.');
  }
  if (path === '/api' || path.startsWith('/api/')) {
    assertRule(apiRuleFor(path, method), access, `${method} ${path}`);
    return;
  }
  const areas = pageAreasFor(path);
  if (areas && !areas.some((a) => can(access, a, 'view'))) throw permissionDenied(areas[0], 'view');
}

/** getServerContext hook: authorize the in-flight request (no-op outside a request). */
export async function enforceRequestPermission(access: EffectiveAccess): Promise<void> {
  const info = await currentRequestInfo();
  if (!info) return;
  authorizeRequest(info, access);
}
