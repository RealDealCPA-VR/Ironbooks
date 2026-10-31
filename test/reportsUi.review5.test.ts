/**
 * Review round 5 (team uib): reports UI.
 *
 *  - The report filters and Find (Ctrl+F) loaded their customer / vendor / account / class lists
 *    once per app session: a name added afterwards never appeared in them until a reload, and a
 *    QuickReport (Ctrl+Q) for it showed its filter as "All".
 *  - A memorized Report Builder report opened a blank builder from the Memorized Report List.
 *  - Deleting a scheduled report (and a state's payroll rates) took one click or one Ctrl+D.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { expectAllPassed, runDomFile } from './domHarness';

const get = vi.fn();
vi.mock('@/lib/client', () => ({
  api: { get: (...args: unknown[]) => get(...args) },
  ApiError: class extends Error {},
}));

const options = (customers: string[]) => ({
  accounts: [],
  customers: customers.map((name, i) => ({ id: `c${i}`, name })),
  vendors: [],
  classes: [],
  items: [],
  employees: [],
  jobs: [],
  budgets: [],
  vehicles: [],
});

describe('report filter lists stay current', () => {
  beforeEach(() => {
    vi.resetModules();
    get.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('a customer added after the first report run is in the lists the next time', async () => {
    const { loadFilterOptions } = await import('@/app/reports/_components/ReportFilters');
    get.mockResolvedValueOnce(options(['Acme'])).mockResolvedValueOnce(options(['Acme', 'Brand New Co']));
    const t0 = 1_000_000;
    expect((await loadFilterOptions(t0)).customers.map((c) => c.name)).toEqual(['Acme']);
    // A minute later (a customer was added in between): another report / Find opens.
    expect((await loadFilterOptions(t0 + 60_000)).customers.map((c) => c.name)).toEqual(['Acme', 'Brand New Co']);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('the filter rows of one screen still share one request', async () => {
    const { loadFilterOptions } = await import('@/app/reports/_components/ReportFilters');
    get.mockResolvedValue(options(['Acme']));
    const t0 = 2_000_000;
    await Promise.all([loadFilterOptions(t0), loadFilterOptions(t0 + 10), loadFilterOptions(t0 + 500)]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a failed load is retried next time', async () => {
    const { loadFilterOptions } = await import('@/app/reports/_components/ReportFilters');
    get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(options(['Acme']));
    await expect(loadFilterOptions(3_000_000)).rejects.toThrow('offline');
    expect((await loadFilterOptions(3_000_001)).customers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Memorized Report Builder reports
// ---------------------------------------------------------------------------
//
// Opening a memorized Report Builder report from the Memorized Report List (or "Open" after
// Process Multiple Reports) went to a blank builder: the link carried no report, so the saved
// dates / account types / grouping were never loaded.

describe('opening a memorized report', () => {
  it('a Report Builder report opens the builder with its id, and the builder finds it', async () => {
    const { memorizedReportHref, memorizedIdFrom } = await import('@/app/reports/_components/memorizedHref');
    const href = memorizedReportHref({ id: 'mr-1', reportType: 'custom', config: { params: {} } });
    expect(href).toBe('/reports/builder?mem=mr-1');
    expect(memorizedIdFrom(href.slice(href.indexOf('?')))).toBe('mr-1');
  });

  it('a standard report keeps its saved settings in the link', async () => {
    const { memorizedReportHref } = await import('@/app/reports/_components/memorizedHref');
    const href = memorizedReportHref({ id: 'mr-2', reportType: 'profit-loss', config: { params: { dates: 'this_month', basis: 'cash' } } });
    expect(href.startsWith('/reports/std/profit-loss?')).toBe(true);
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('dates')).toBe('this_month');
    expect(q.get('basis')).toBe('cash');
    expect(q.get('mem')).toBe('mr-2');
  });

  it('the list and the builder use it', () => {
    const list = fs.readFileSync('app/reports/memorized/page.tsx', 'utf8');
    expect(list).toContain('memorizedReportHref(');
    expect(list).not.toMatch(/return '\/reports\/builder';/);
    const builder = fs.readFileSync('app/reports/builder/page.tsx', 'utf8');
    expect(builder).toContain('memorizedIdFrom(window.location.search)');
  });
});

// ---------------------------------------------------------------------------
// One-keystroke deletes
// ---------------------------------------------------------------------------
//
// Ctrl+D (QuickBooks: delete the highlighted list row) presses the row's Delete / Remove button.
// A scheduled report's Delete and a state's payroll-rate Remove acted at once, with no question —
// with the list keys, one stray Ctrl+D deleted the schedule or the state's SUI / SDI rates. QB
// always asks first; they now do too.

describe('row deletes ask first', () => {
  // The real pages in a browser window (test/dom/rowDeletes.dom.tsx), against stubbed API answers:
  // the DELETE requests the page sends are counted before, after Cancel and after confirming.
  it('Scheduled Reports Delete and Payroll Setup > state taxes Remove: confirm first, then exactly one DELETE', async () => {
    expectAllPassed(await runDomFile('test/dom/rowDeletes.dom.tsx'), [
      'Scheduled Reports: Delete asks first; Cancel deletes nothing; confirming deletes once',
      'Payroll Setup > State payroll taxes: Remove asks first; Cancel removes nothing; confirming removes once',
    ]);
  }, 180_000);
});
