/**
 * Review round 5 — the report API routes refuse dates that do not exist.
 *
 * `new Date('2026-02-30')` silently rolls over to March 2, so ?asOf=2026-02-30 ran a report as
 * of a different day than asked (and year-10000 dates reached the database). Such dates are a
 * 400 with a plain message, as on every other route (lib/validation/helpers.ts parseDateInput).
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { trialBalance, apAging, arAging, cashFlow } = vi.hoisted(() => ({
  cashFlow: vi.fn(async (..._a: unknown[]) => ({})),
  trialBalance: vi.fn(async (..._a: unknown[]) => ({ rows: [], totalDebit: '0.00', totalCredit: '0.00', balanced: true })),
  apAging: vi.fn(async (..._a: unknown[]) => ({ asOf: '', rows: [], totals: {} })),
  arAging: vi.fn(async (..._a: unknown[]) => ({ asOf: '', rows: [], totals: {} })),
}));
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ({ db: null, companyId: 'c', userId: 'u' })) }));
vi.mock('@/lib/services/reports', async (orig) => ({ ...(await orig<object>()), trialBalance }));
vi.mock('@/lib/services/reportsExtra', async (orig) => ({ ...(await orig<object>()), apAging, arAging, cashFlow }));
import { GET as trialBalanceGET } from '@/app/api/reports/trial-balance/route';
import { GET as apAgingGET } from '@/app/api/reports/ap-aging/route';
import { GET as arAgingGET } from '@/app/api/reports/ar-aging/route';
import { GET as cashFlowGET } from '@/app/api/reports/cash-flow/route';

const req = (path: string) => new NextRequest(`http://localhost${path}`);

describe('report routes and impossible dates', () => {
  it('Feb 30 / month 13 / year 10000 are refused with a 400', async () => {
    for (const q of ['2026-02-30', '2026-13-01', '10000-01-01']) {
      const tb = await trialBalanceGET(req(`/api/reports/trial-balance?asOf=${q}`));
      expect(tb.status, q).toBe(400);
      const ap = await apAgingGET(req(`/api/reports/ap-aging?asOf=${q}`));
      expect(ap.status, q).toBe(400);
      const ar = await arAgingGET(req(`/api/reports/ar-aging?asOf=${q}`));
      expect(ar.status, q).toBe(400);
      const cf = await cashFlowGET(req(`/api/reports/cash-flow?from=2026-01-01&to=${q}`));
      expect(cf.status, q).toBe(400);
    }
    expect(trialBalance).not.toHaveBeenCalled();
    expect(apAging).not.toHaveBeenCalled();
    expect(cashFlow).not.toHaveBeenCalled();
  });

  it('a real date runs the report for exactly that day', async () => {
    const res = await trialBalanceGET(req('/api/reports/trial-balance?asOf=2026-02-28'));
    expect(res.status).toBe(200);
    expect((trialBalance.mock.calls.at(-1) as unknown[])[1]).toEqual(new Date('2026-02-28T00:00:00.000Z'));
  });
});
