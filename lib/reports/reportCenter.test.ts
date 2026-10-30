/**
 * The Report Center lists every report: every report page under app/reports, every standard
 * catalog report (the "All reports" list) and the report pages that live elsewhere (audit trail,
 * transaction log, budgets, Find).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_CATALOG, REPORT_GROUPS } from './catalog';
import { REPORT_CENTER_SECTIONS } from '@/app/reports/_components/reportCenterSections';

const REPORTS = path.join(process.cwd(), 'app', 'reports');

/** Pages that are not reports of their own (the std viewer, drill-down list, the QuickZoom-to-form redirect). */
const NOT_A_REPORT = new Set(['std', 'drilldown', 'open']);

describe('Report Center', () => {
  const hrefs = REPORT_CENTER_SECTIONS.flatMap((s) => s.cards.map((c) => c.href));

  it('links every report page under app/reports', () => {
    const dirs = fs
      .readdirSync(REPORTS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !NOT_A_REPORT.has(e.name) && fs.existsSync(path.join(REPORTS, e.name, 'page.tsx')))
      .map((e) => `/reports/${e.name}`);
    expect(dirs.length).toBeGreaterThan(30);
    expect(dirs.filter((d) => !hrefs.includes(d))).toEqual([]);
  });

  it('every card opens an existing page or a listed catalog report', () => {
    for (const h of hrefs) {
      const std = /^\/reports\/std\/([a-z0-9-]+)$/.exec(h);
      if (std) {
        const e = REPORT_CATALOG.find((r) => r.key === std[1]);
        expect(e, h).toBeDefined();
        expect(e!.hidden, h).toBeFalsy();
      } else {
        expect(fs.existsSync(path.join(process.cwd(), 'app', ...h.split('/').filter(Boolean), 'page.tsx')), h).toBe(true);
      }
    }
    for (const outside of ['/audit-trail', '/transaction-log', '/budgets', '/find', '/reports/commented']) expect(hrefs, outside).toContain(outside);
  });

  it('"All reports" lists every catalog report under a known group (only permission / feature / hidden filter it)', () => {
    for (const e of REPORT_CATALOG) {
      expect(REPORT_GROUPS, e.key).toContain(e.group);
      expect(e.hidden, e.key).toBeFalsy();
    }
    const src = fs.readFileSync(path.join(REPORTS, 'page.tsx'), 'utf8');
    expect(src).toMatch(/REPORT_CATALOG\.filter\(\(r\) => !r\.hidden && canDo\(me, r\.area, 'view'\) && !hidden\(r\.key\)\)/);
  });
});
