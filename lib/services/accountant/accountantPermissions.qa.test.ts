/**
 * Independent QA: permission mapping of the wave2 accountant routes and pages.
 * Every new page must resolve to an area (deny-by-default otherwise) and every mutating
 * accountant route must require a write action, never just 'view'.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';

function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  const abs = path.resolve(process.cwd(), 'app', dir);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...pagesUnder(path.join(dir, e.name)));
    else if (/^page\.tsx?$/.test(e.name)) out.push('/' + dir.split(path.sep).join('/'));
  }
  return out;
}

describe('accountant permissions (QA)', () => {
  it('every accountant / new report page resolves to a permission area', () => {
    const pages = [
      ...pagesUnder('accountant'),
      '/reports/sales-tax',
      '/reports/closing-date-exceptions',
      '/reports/voided-deleted',
    ];
    expect(pages.length).toBeGreaterThanOrEqual(10);
    for (const p of pages) expect(pageAreasFor(p), p).not.toBeNull();
    expect(pageAreasFor('/accountant/batch-void')).toEqual(['accounting']);
    expect(pageAreasFor('/accountant/fix-sales-tax')).toEqual(['sales_tax']);
    expect(pageAreasFor('/reports/closing-date-exceptions')).toEqual(['closing']);
  });

  it('mutating accountant routes require a write action', () => {
    const writes: Array<[string, string]> = [
      ['/api/accountant/reclassify', 'POST'],
      ['/api/accountant/write-off', 'POST'],
      ['/api/accountant/batch-enter', 'POST'],
      ['/api/accountant/batch-void', 'POST'],
      ['/api/accountant/working-trial-balance', 'PUT'],
      ['/api/accountant/working-trial-balance', 'POST'],
      ['/api/accountant/list-changes', 'POST'],
      ['/api/accountant/client-data-review', 'POST'],
      ['/api/accountant/sales-tax/adjustments', 'POST'],
      ['/api/accountant/sales-tax/fix', 'POST'],
    ];
    for (const [p, m] of writes) {
      const rule = apiRuleFor(p, m);
      expect(rule, `${m} ${p}`).not.toBeNull();
      expect(typeof rule, `${m} ${p}`).toBe('object');
      expect(['create', 'modify', 'delete'], `${m} ${p}`).toContain((rule as { action: string }).action);
    }
    expect(apiRuleFor('/api/accountant/batch-void', 'POST')).toEqual({ area: 'accounting', action: 'delete' });
    expect(apiRuleFor('/api/accountant/closing-date-exceptions', 'GET')).toEqual({ area: 'closing', action: 'view' });
    expect(apiRuleFor('/api/accountant/sales-tax/liability', 'GET')).toEqual({ area: 'sales_tax', action: 'view' });
    // No accountant route is public or self-service.
    for (const p of ['/api/accountant/center', '/api/accountant/voided-deleted', '/api/accountant/list-changes']) {
      expect(['public', 'self']).not.toContain(apiRuleFor(p, 'GET'));
    }
  });
});
