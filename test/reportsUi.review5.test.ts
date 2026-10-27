/**
 * Review round 5 (team uib): reports UI.
 *
 *  - The report filters and Find (Ctrl+F) loaded their customer / vendor / account / class lists
 *    once per app session: a name added afterwards never appeared in them until a reload, and a
 *    QuickReport (Ctrl+Q) for it showed its filter as "All".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
