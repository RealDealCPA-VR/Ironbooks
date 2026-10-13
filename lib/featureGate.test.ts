/**
 * P1 setup: feature switches hide menus AND block the pages and APIs (not cosmetic any more).
 *  - pure: which page / API path each switch covers, reads stay open, plain message;
 *  - integration: a save to a turned-off feature through the real route handler + getServerContext
 *    is refused with 403 and the plain message; reads still work; turning it back on works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_COMPANY_PREFERENCES,
  FEATURE_GATES,
  blockingFeatureGate,
  featureGateForApi,
  featureGateForPage,
  featureHiddenPaths,
  featureOffMessage,
} from './preferences';
import { API_ROUTE_PERMISSIONS } from './permissions/routes';
import { describeError } from './friendlyErrors';
import { ApiError } from './client';
import { NextRequest } from 'next/server';
import { getDb, closeDb } from '@/lib/db';
import { getServerContext } from '@/lib/context';
import { updateCompany } from '@/lib/services/company';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import * as classesRoute from '@/app/api/classes/route';

const off = (key: string) => ({ ...DEFAULT_COMPANY_PREFERENCES, [key]: false });

describe('feature gates (pure)', () => {
  it('every gated API prefix and page is a real route', () => {
    const apiPatterns = Object.keys(API_ROUTE_PERMISSIONS);
    for (const g of FEATURE_GATES) {
      for (const p of g.apis) {
        expect(apiPatterns.some((r) => r === p || r.startsWith(p + '/')), `${g.key} ${p}`).toBe(true);
      }
      for (const p of g.pages) {
        expect(fs.existsSync(path.join(process.cwd(), 'app', ...p.split('/').filter(Boolean), 'page.tsx')), `${g.key} ${p}`).toBe(true);
      }
    }
  });

  it('turned-off features hide their pages and block page + API saves; reads stay open', () => {
    const prefs = off('estimatesEnabled');
    expect(featureHiddenPaths(prefs).has('/estimates')).toBe(true);
    expect(blockingFeatureGate('/estimates', prefs)?.key).toBe('estimatesEnabled');
    expect(blockingFeatureGate('/api/estimates', prefs, 'POST')?.key).toBe('estimatesEnabled');
    expect(blockingFeatureGate('/api/estimates/abc', prefs, 'PUT')?.key).toBe('estimatesEnabled');
    expect(blockingFeatureGate('/api/estimates', prefs, 'GET')).toBeNull();
    expect(blockingFeatureGate('/api/invoices', prefs, 'POST')).toBeNull();
    // On by default: nothing blocked, nothing hidden.
    expect(featureHiddenPaths(DEFAULT_COMPANY_PREFERENCES).size).toBe(0);
    expect(blockingFeatureGate('/api/estimates', DEFAULT_COMPANY_PREFERENCES, 'POST')).toBeNull();
  });

  it('prefix matching respects path segments', () => {
    expect(featureGateForApi('/api/inventory-sites/1')?.key).toBe('inventoryEnabled');
    expect(featureGateForApi('/api/inventory/physical-count')?.key).toBe('inventoryEnabled');
    expect(featureGateForApi('/api/inventoryx')).toBeNull();
    expect(featureGateForApi('/api/items')).toBeNull();
    expect(featureGateForPage('/reports/inventory-valuation')?.key).toBe('inventoryEnabled');
    expect(featureGateForPage('/reports')).toBeNull();
  });

  it('each switch covers its QB feature', () => {
    expect(blockingFeatureGate('/api/tax-rates', off('salesTaxEnabled'), 'POST')?.key).toBe('salesTaxEnabled');
    expect(blockingFeatureGate('/sales-tax-components', off('salesTaxEnabled'))?.key).toBe('salesTaxEnabled');
    expect(blockingFeatureGate('/api/time-entries', off('timeTrackingEnabled'), 'POST')?.key).toBe('timeTrackingEnabled');
    expect(blockingFeatureGate('/api/purchase-orders', off('purchaseOrdersEnabled'), 'POST')?.key).toBe('purchaseOrdersEnabled');
    expect(blockingFeatureGate('/api/sales-orders/1', off('salesOrdersEnabled'), 'DELETE')?.key).toBe('salesOrdersEnabled');
    expect(blockingFeatureGate('/api/classes', off('classTrackingEnabled'), 'POST')?.key).toBe('classTrackingEnabled');
    expect(blockingFeatureGate('/api/pricing/levels', off('priceLevelsEnabled'), 'POST')?.key).toBe('priceLevelsEnabled');
    expect(blockingFeatureGate('/api/pricing/rules', off('priceLevelsEnabled'), 'POST')).toBeNull();
    expect(blockingFeatureGate('/api/uom-sets', off('unitsOfMeasureEnabled'), 'POST')?.key).toBe('unitsOfMeasureEnabled');
    expect(blockingFeatureGate('/lists/uom', off('unitsOfMeasureEnabled'))?.key).toBe('unitsOfMeasureEnabled');
  });

  it('the message is plain and names the setting; the friendly error says "turned off"', () => {
    const gate = FEATURE_GATES.find((g) => g.key === 'estimatesEnabled')!;
    const msg = featureOffMessage(gate);
    expect(msg).toBe(
      'Estimates are turned off for this company. To use them, an administrator can turn on "Use estimates" in Settings > Preferences > Jobs & Estimates.',
    );
    expect(featureOffMessage(FEATURE_GATES.find((g) => g.key === 'salesTaxEnabled')!)).toMatch(/^Sales tax is turned off/);
    const f = describeError(new ApiError(403, msg, 'FORBIDDEN'));
    expect(f.title).toBe('This feature is turned off');
    expect(f.message).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// Integration: real route handler + getServerContext (first-run context) + route stamp headers
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-gate');

describe('feature gate through the API (integration)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env.BKA_DATA_DIR = TEST_DIR;
    process.env.BKA_ALLOW_DEV_FALLBACK = '1'; // session-less owner context for every call
    await getDb(TEST_DIR);
  });
  afterAll(async () => {
    delete process.env.BKA_ALLOW_DEV_FALLBACK;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function stamp(method: string, route: string) {
    h.headers.clear();
    h.headers.set(ROUTE_PATH_HEADER, route);
    h.headers.set(ROUTE_METHOD_HEADER, method);
  }

  it('refuses a save while the feature is off, allows reads, and works again when on', async () => {
    // First-run context (no users yet) acts as the owner of the fallback company.
    stamp('PATCH', '/api/company');
    const ctx = await getServerContext();
    await updateCompany(ctx, { settings: { classTrackingEnabled: false } });

    stamp('POST', '/api/classes');
    const blocked = await classesRoute.POST(
      new NextRequest('http://localhost/api/classes', { method: 'POST', body: JSON.stringify({ name: 'East' }) }),
    );
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toMatch(/^Class tracking is turned off for this company/);

    stamp('GET', '/api/classes');
    expect((await classesRoute.GET()).status).toBe(200);

    stamp('PATCH', '/api/company');
    await updateCompany(await getServerContext(), { settings: { classTrackingEnabled: true } });
    stamp('POST', '/api/classes');
    const ok = await classesRoute.POST(
      new NextRequest('http://localhost/api/classes', { method: 'POST', body: JSON.stringify({ name: 'East' }) }),
    );
    expect(ok.status).toBeLessThan(300);
  });
});
