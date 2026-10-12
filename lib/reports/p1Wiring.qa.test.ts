/**
 * Independent QA (tester) for the P1 reports round: UI / API wiring of the migrated pages.
 *  - every legacy report page that now renders StdReportView names a real catalog key, and the
 *    page's permission area (PAGE_AREAS) is the report's own catalog area;
 *  - every catalog area is a real permission area;
 *  - the Report Center links only to pages that exist, and lists the reports added this round;
 *  - the std view forwards the aging options (Interval / Through / Age from) in its URL params,
 *    and the filters panel renders them for reports with the 'aging' control;
 *  - the legacy Sales Tax page links to the std Sales Tax Liability with its dates and basis.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG_BY_KEY, REPORT_CATALOG } from './catalog';
import { pageAreasFor } from '@/lib/permissions/routes';
import { AREA_KEYS } from '@/lib/permissions/model';

const ROOT = process.cwd();
const REPORTS = path.join(ROOT, 'app', 'reports');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

function pageDirs(): string[] {
  return fs
    .readdirSync(REPORTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(REPORTS, e.name, 'page.tsx')))
    .map((e) => e.name);
}

describe('P1 report page wiring', () => {
  it('every catalog area is a permission area', () => {
    for (const e of REPORT_CATALOG) expect(AREA_KEYS, e.key).toContain(e.area);
  });

  it('std-engine wrapper pages name a catalog key and guard with that report area', () => {
    let checked = 0;
    for (const dir of pageDirs()) {
      const src = read(REPORTS, dir, 'page.tsx');
      const key = /reportKey="([a-z0-9-]+)"/.exec(src)?.[1];
      if (!key) continue;
      checked++;
      const entry = CATALOG_BY_KEY[key];
      expect(entry, `${dir} -> ${key}`).toBeDefined();
      const guarded = /getPageContext\('([^']+)'\)/.exec(src)?.[1];
      expect(guarded, `${dir} guards its own path`).toBe(`/reports/${dir}`);
      const areas = pageAreasFor(`/reports/${dir}`);
      expect(areas, `/reports/${dir} in PAGE_AREAS`).toBeTruthy();
      expect(areas, `/reports/${dir} area vs catalog ${entry.area}`).toContain(entry.area);
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('the migrated legacy pages render the std engine (no legacy fetch left)', () => {
    const migrated: Record<string, string> = {
      'ar-aging': 'ar-aging-summary',
      'ar-aging-detail': 'ar-aging-detail',
      'ap-aging': 'ap-aging-summary',
      'ap-aging-detail': 'ap-aging-detail',
      'open-invoices': 'open-invoices',
      collections: 'collections-report',
      'general-ledger': 'general-ledger',
      'cash-flow': 'statement-of-cash-flows',
      'sales-by-customer': 'sales-by-customer-summary',
      'sales-by-item': 'sales-by-item-summary',
      'purchases-by-vendor': 'purchases-by-vendor-summary',
      'purchases-by-item': 'purchases-by-item-summary',
      'transaction-detail': 'transaction-detail-by-account',
    };
    for (const [dir, key] of Object.entries(migrated)) {
      const src = read(REPORTS, dir, 'page.tsx');
      expect(src, dir).toContain(`reportKey="${key}"`);
      expect(src, dir).not.toMatch(/\/api\/reports\//);
    }
  });

  it('Report Center links resolve to existing pages or catalog keys and include the new reports', () => {
    const src = read(REPORTS, 'page.tsx');
    const hrefs = [...src.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) {
      const std = /^\/reports\/std\/([a-z0-9-]+)$/.exec(h);
      if (std) {
        expect(CATALOG_BY_KEY[std[1]], h).toBeDefined();
        expect(CATALOG_BY_KEY[std[1]].hidden, h).toBeFalsy();
      } else if (h.startsWith('/reports/')) {
        expect(fs.existsSync(path.join(ROOT, 'app', ...h.split('/').filter(Boolean), 'page.tsx')), h).toBe(true);
      }
    }
    for (const k of ['adjusting-journal-entries', 'income-tax-preparation', 'income-tax-summary', 'income-tax-detail']) {
      expect(hrefs, k).toContain(`/reports/std/${k}`);
    }
  });

  it('StdReportView keeps the aging options in the URL; ReportFilters shows them for the aging control', () => {
    const view = read(REPORTS, '_components', 'StdReportView.tsx');
    const keys = /const PARAM_KEYS = \[([\s\S]*?)\];/.exec(view)?.[1] ?? '';
    for (const k of ['interval', 'through', 'agingFrom', 'basis', 'classId', 'customerId', 'vendorId', 'asOf']) expect(keys, k).toContain(`'${k}'`);
    const filters = read(REPORTS, '_components', 'ReportFilters.tsx');
    expect(filters).toMatch(/has\('aging'\)/);
    for (const k of ["'interval'", "'through'", "'agingFrom'", 'transaction_date', 'due_date']) expect(filters, k).toContain(k);
    for (const k of ['ar-aging-summary', 'ar-aging-detail', 'ap-aging-summary', 'ap-aging-detail']) expect(CATALOG_BY_KEY[k].controls, k).toContain('aging');
  });

  it('the legacy Sales Tax page links to the std Sales Tax Liability with its dates and basis', () => {
    const src = read(REPORTS, 'sales-tax', 'page.tsx');
    expect(src).toContain('/reports/std/sales-tax-liability?from=${fromStr}&to=${toStr}&basis=${basis}');
  });
});
