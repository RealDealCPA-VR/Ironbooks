/**
 * H16: every report page offers Fonts & Numbers — the standard-engine pages through the report
 * viewer, and the pages that are not on the engine (1099 summary, combined company reports,
 * reconciliation reports, Report Builder, the QuickZoom list, Commented Reports) through the
 * same remembered format (NumberFormatPanel: useReportNumbers / useNumberFormat).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPORTS = path.join(process.cwd(), 'app', 'reports');

/** Pages that show no amounts table of their own, with why. */
const NOT_A_TABLE: Record<string, string> = {
  memorized: 'a list of saved reports',
  schedules: 'a list of schedules',
  graphs: 'charts (bar heights, not printed amounts)',
  statements: 'customer statements are forms, printed with their form template',
  '1099-efile': 'the 1099 filing wizard (a form, not a report)',
  open: 'redirects to the source form',
  drilldown: 'renders DrilldownView (checked below)',
  std: 'renders StdReportView',
};

describe('Fonts & Numbers on every report page (H16)', () => {
  it('each report page formats its amounts with the report number format', () => {
    const dirs = fs.readdirSync(REPORTS, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(REPORTS, e.name, 'page.tsx')));
    const missing: string[] = [];
    for (const d of dirs) {
      if (NOT_A_TABLE[d.name]) continue;
      const src = fs.readFileSync(path.join(REPORTS, d.name, 'page.tsx'), 'utf8');
      const ok = /StdReportView|redirect\(|useReportNumbers\(|useNumberFormat\(|NumberFormatPanel/.test(src);
      if (!ok) missing.push(d.name);
    }
    expect(missing).toEqual([]);
  });

  it('the QuickZoom list and the legacy tables no longer print amounts with a fixed format', () => {
    for (const f of ['_components/DrilldownView.tsx', 'consolidated/page.tsx', 'reconciliation/page.tsx', 'builder/page.tsx']) {
      const src = fs.readFileSync(path.join(REPORTS, ...f.split('/')), 'utf8');
      expect(src, f).toMatch(/useReportNumbers\(\)/);
      expect(src, f).not.toMatch(/formatCurrency\(/);
    }
    const t1099 = fs.readFileSync(path.join(REPORTS, '1099', 'page.tsx'), 'utf8');
    expect(t1099).toMatch(/useMoney\(\)/);
  });
});
