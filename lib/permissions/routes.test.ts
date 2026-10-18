/**
 * Guards the central permission map (lib/permissions/routes.ts):
 *  - EVERY exported HTTP method of EVERY app/api/**\/route.ts is mapped (fails on a new route
 *    someone forgot to map — enforcement would otherwise deny it at runtime).
 *  - No stale entries for routes that no longer exist.
 *  - Every area/member-mapped route actually obtains its context via getServerContext (where
 *    enforcement happens), and maps FORBIDDEN to HTTP 403.
 *  - Route matching precedence and page-area lookup.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  API_ROUTE_PERMISSIONS,
  HTTP_METHODS,
  apiRuleFor,
  matchRoutePattern,
  pageAreasFor,
  routePatternFromFile,
} from './routes';
import { AREA_KEYS, ACTIONS } from './model';

const API_DIR = path.resolve(process.cwd(), 'app', 'api');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/^route\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Exported HTTP handlers: `export async function GET`, `export const POST =`, `export { GET }`. */
function exportedMethods(src: string): string[] {
  const found = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
  for (const m of src.matchAll(re)) found.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) found.add(name);
    }
  }
  return [...found];
}

const files = walk(API_DIR).map((abs) => ({
  abs,
  rel: path.relative(process.cwd(), abs),
  pattern: routePatternFromFile(path.relative(process.cwd(), abs)),
  src: fs.readFileSync(abs, 'utf8'),
}));

describe('API permission map coverage', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('maps every exported HTTP method of every route', () => {
    const unmapped: string[] = [];
    for (const f of files) {
      const rules = API_ROUTE_PERMISSIONS[f.pattern];
      for (const m of exportedMethods(f.src)) {
        if (!rules || !(m in rules)) unmapped.push(`${m} ${f.pattern}  (${f.rel})`);
      }
    }
    expect(unmapped, `Add these to API_ROUTE_PERMISSIONS in lib/permissions/routes.ts:\n${unmapped.join('\n')}`).toEqual([]);
  });

  it('has no stale entries (every mapped path+method exists)', () => {
    const byPattern = new Map(files.map((f) => [f.pattern, exportedMethods(f.src)]));
    const stale: string[] = [];
    for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
      const methods = byPattern.get(pattern);
      if (!methods) stale.push(pattern);
      else for (const m of Object.keys(rules)) if (!methods.includes(m)) stale.push(`${m} ${pattern}`);
    }
    expect(stale).toEqual([]);
  });

  it('uses only known areas, actions and methods', () => {
    for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
      for (const [m, rule] of Object.entries(rules)) {
        expect(HTTP_METHODS as readonly string[], pattern).toContain(m);
        if (typeof rule === 'object') {
          expect(AREA_KEYS, pattern).toContain(rule!.area);
          expect(ACTIONS as readonly string[], pattern).toContain(rule!.action);
        } else {
          expect(['public', 'self', 'member']).toContain(rule);
        }
      }
    }
  });

  it('every area/member-mapped route enforces through getServerContext and returns 403', () => {
    const problems: string[] = [];
    for (const f of files) {
      const rules = API_ROUTE_PERMISSIONS[f.pattern] ?? {};
      const enforced = Object.values(rules).some((r) => typeof r === 'object' || r === 'member');
      if (!enforced) continue;
      if (!/getServerContext\s*\(/.test(f.src)) problems.push(`${f.rel}: never calls getServerContext()`);
      // Shared helpers are accepted only because the test below proves each maps FORBIDDEN to 403.
      if (!/FORBIDDEN|reportError|routeError|aiErrorResponse/.test(f.src)) {
        problems.push(`${f.rel}: does not map FORBIDDEN to 403`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the shared route error helpers answer FORBIDDEN with HTTP 403', async () => {
    const { ServiceError } = await import('@/lib/services/_base');
    const { routeError } = await import('@/lib/routeErrors');
    const { aiErrorResponse } = await import('@/app/api/ai/_errors');
    const { reportError } = await import('@/app/api/reports/_lib');
    const denied = () => new ServiceError('FORBIDDEN', 'nope');
    expect(routeError(denied(), 't').status).toBe(403);
    expect(aiErrorResponse(denied(), 't').status).toBe(403);
    expect(reportError(denied(), 't').status).toBe(403);
  });

  it("every 'self' route passes the central session gate (file lock, file-bound session, deactivation)", () => {
    // The employee portal authenticates with its own portal-session cookie instead.
    const exempt = new Set(['/api/portal/me']);
    const problems: string[] = [];
    for (const f of files) {
      const rules = API_ROUTE_PERMISSIONS[f.pattern] ?? {};
      if (!Object.values(rules).some((r) => r === 'self') || exempt.has(f.pattern)) continue;
      if (!/getSessionGate\s*\(|getServerContext\s*\(/.test(f.src)) {
        problems.push(`${f.rel}: never calls getSessionGate() / getServerContext()`);
      }
      if (/getSessionUserId\s*\(/.test(f.src)) {
        problems.push(`${f.rel}: reads the session directly — use getSessionGate()`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps data routes out of the public/self allowlist', () => {
    const open = Object.entries(API_ROUTE_PERMISSIONS)
      .filter(([, rules]) => Object.values(rules).some((r) => r === 'public' || r === 'self'))
      .map(([p]) => p)
      .sort();
    expect(open).toEqual(
      [
        '/api/auth/2fa/disable',
        '/api/auth/2fa/enable',
        '/api/auth/2fa/setup',
        '/api/auth/change-password', // gapsb K: own password (also when expired)
        '/api/auth/login',
        '/api/auth/logout',
        '/api/auth/me',
        '/api/auth/password-policy', // gapsb K: the rules only, for the sign-up / reset forms
        '/api/auth/request-reset',
        '/api/auth/reset',
        '/api/auth/signup',
        '/api/companies',
        '/api/companies/[id]',
        '/api/companies/select',
        '/api/email/status',
        '/api/portal/login',
        '/api/portal/logout',
        '/api/portal/me',
        // Receipt capture phone link: token-scoped (one company, 15 min, limited uploads, add-only).
        '/api/receipts/mobile/[token]',
        '/api/sandbox/status', // banner flag only (sandbox mode)
        '/api/unlock',
      ].sort(),
    );
  });
});

describe('route matching', () => {
  it('prefers static segments over dynamic ones', () => {
    expect(matchRoutePattern('/api/estimates/expire')).toBe('/api/estimates/expire');
    expect(matchRoutePattern('/api/estimates/123')).toBe('/api/estimates/[id]');
    expect(matchRoutePattern('/api/estimates/123/pdf')).toBe('/api/estimates/[id]/pdf');
    expect(matchRoutePattern('/api/sales-reps/assign')).toBe('/api/sales-reps/assign');
    expect(matchRoutePattern('/api/payroll/w2')).toBe('/api/payroll/w2');
    expect(matchRoutePattern('/api/payroll/abc')).toBe('/api/payroll/[id]');
  });

  it('returns null for unknown paths and methods (callers deny)', () => {
    expect(matchRoutePattern('/api/nope')).toBeNull();
    expect(apiRuleFor('/api/nope', 'GET')).toBeNull();
    expect(apiRuleFor('/api/customers', 'DELETE')).toBeNull();
  });

  it('resolves rules with explicit actions', () => {
    expect(apiRuleFor('/api/invoices/abc/pdf', 'GET')).toEqual({ area: 'customers', action: 'print' });
    expect(apiRuleFor('/api/journal-entries', 'POST')).toEqual({ area: 'accounting', action: 'create' });
    expect(apiRuleFor('/api/reports/general-ledger', 'GET')).toEqual({ area: 'reports_financial', action: 'view' });
    expect(apiRuleFor('/api/accounts', 'GET')).toEqual({ area: 'lists', action: 'view' });
    expect(apiRuleFor('/api/accounts', 'POST')).toEqual({ area: 'accounting', action: 'create' });
    expect(apiRuleFor('/api/auth/login', 'POST')).toBe('public');
  });

  it('derives patterns from file paths (Windows and POSIX separators)', () => {
    expect(routePatternFromFile('app\\api\\invoices\\[id]\\route.ts')).toBe('/api/invoices/[id]');
    expect(routePatternFromFile('app/api/(grp)/x/route.ts')).toBe('/api/x');
  });
});

describe('page areas', () => {
  it('uses the longest matching prefix', () => {
    expect(pageAreasFor('/reports/profit-loss')).toEqual(['reports_financial']);
    expect(pageAreasFor('/reports/ar-aging')).toEqual(['reports_sales']);
    expect(pageAreasFor('/reports')?.length).toBe(5); // any report area opens the Report Center
    expect(pageAreasFor('/journal')).toEqual(['accounting']);
    expect(pageAreasFor('/users')).toEqual(['users']);
    expect(pageAreasFor('/dashboard')).toBeNull();
    expect(pageAreasFor('/invoicesX')).toBeNull();
  });
});
