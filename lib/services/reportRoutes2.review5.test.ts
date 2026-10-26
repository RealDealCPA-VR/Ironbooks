/**
 * Review round 5 — more report API routes and their dates.
 *
 *  - Customer statement (JSON and PDF): ?from=garbage on the PDF route reached the statement
 *    query as an Invalid Date and answered HTTP 500; both routes rolled 2026-02-30 over to March 2.
 *  - Sales tax by agency: 2026-02-30 rolled over to March 2 as well.
 *  - Balance sheet: with no ?asOf the route ran with no date at all (post-dated entries counted)
 *    and, with ?compareTo, as of the UTC moment — tomorrow in US evenings. It now runs as of the
 *    end of today on this computer's calendar, like every other report.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const origTz = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

const { customerStatement, buildStatementPdf, salesTaxByAgency, balanceSheet, balanceSheetComparative } = vi.hoisted(() => ({
  customerStatement: vi.fn(async (..._a: unknown[]) => ({ customer: { displayName: 'Acme' } })),
  buildStatementPdf: vi.fn(async (..._a: unknown[]) => new Uint8Array([37, 80, 68, 70])),
  salesTaxByAgency: vi.fn(async (..._a: unknown[]) => ({ agencies: [] })),
  balanceSheet: vi.fn(async (..._a: unknown[]) => ({ assets: [] })),
  balanceSheetComparative: vi.fn(async (..._a: unknown[]) => ({ assets: [] })),
}));
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ({ db: null, companyId: 'c', userId: 'u' })) }));
vi.mock('@/lib/services/statements', async (orig) => ({ ...(await orig<object>()), customerStatement }));
vi.mock('@/lib/pdf/forms', async (orig) => ({ ...(await orig<object>()), buildStatementPdf }));
vi.mock('@/lib/services/combinedTax', async (orig) => ({ ...(await orig<object>()), salesTaxByAgency }));
vi.mock('@/lib/services/reports', async (orig) => ({ ...(await orig<object>()), balanceSheet }));
vi.mock('@/lib/services/reportsExtra', async (orig) => ({ ...(await orig<object>()), balanceSheetComparative }));
import { GET as statementGET } from '@/app/api/reports/customer-statement/route';
import { GET as statementPdfGET } from '@/app/api/reports/customer-statement/pdf/route';
import { GET as salesTaxGET } from '@/app/api/reports/sales-tax-by-agency/route';
import { GET as balanceSheetGET } from '@/app/api/reports/balance-sheet/route';

afterAll(() => {
  vi.useRealTimers();
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
});

const req = (path: string) => new NextRequest(`http://localhost${path}`);
const CUST = '11111111-1111-4111-8111-111111111111';

describe('customer statement routes', () => {
  it('garbage and impossible dates are a 400 (the PDF route answered 500)', async () => {
    for (const q of ['garbage', '2026-02-30', '2026-13-01']) {
      const pdf = await statementPdfGET(req(`/api/reports/customer-statement/pdf?customerId=${CUST}&from=${q}`));
      expect(pdf.status, `pdf ${q}`).toBe(400);
      const json = await statementGET(req(`/api/reports/customer-statement?customerId=${CUST}&to=${q}`));
      expect(json.status, `json ${q}`).toBe(400);
    }
    expect(customerStatement).not.toHaveBeenCalled();
  });

  it('a real date reaches the statement as that calendar day', async () => {
    const res = await statementPdfGET(req(`/api/reports/customer-statement/pdf?customerId=${CUST}&from=2026-02-01&to=2026-02-28`));
    expect(res.status).toBe(200);
    expect(customerStatement.mock.calls.at(-1)?.[2]).toEqual({ from: new Date('2026-02-01T00:00:00.000Z'), to: new Date('2026-02-28T00:00:00.000Z') });
    const json = await statementGET(req(`/api/reports/customer-statement?customerId=${CUST}&from=2026-02-01&to=2026-02-28`));
    expect(json.status).toBe(200);
    expect(customerStatement.mock.calls.at(-1)?.[2]).toEqual({ from: new Date('2026-02-01T00:00:00.000Z'), to: new Date('2026-02-28T00:00:00.000Z') });
  });
});

describe('sales tax by agency route', () => {
  it('refuses a day that does not exist', async () => {
    const res = await salesTaxGET(req('/api/reports/sales-tax-by-agency?from=2026-02-30'));
    expect(res.status).toBe(400);
    expect(salesTaxByAgency).not.toHaveBeenCalled();
  });
});

describe('balance sheet route default date', () => {
  it('no asOf = the end of today on this computer, not "all dates" or the UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T06:30:00.000Z') }); // Oct 31, 11:30 pm Pacific
    await balanceSheetGET(req('/api/reports/balance-sheet'));
    expect(balanceSheet.mock.calls.at(-1)?.[1]).toEqual(new Date('2026-10-31T23:59:59.999Z'));
    await balanceSheetGET(req('/api/reports/balance-sheet?compareTo=2025-10-31'));
    expect(balanceSheetComparative.mock.calls.at(-1)?.[1]).toEqual(new Date('2026-10-31T23:59:59.999Z'));
    vi.useRealTimers();
  });
});

const { getDashboardInsights } = vi.hoisted(() => ({ getDashboardInsights: vi.fn(async (..._a: unknown[]) => ({})) }));
vi.mock('@/lib/services/dashboard', async (orig) => ({ ...(await orig<object>()), getDashboardInsights }));
import { GET as dashboardGET } from '@/app/api/dashboard/route';

/**
 * GET /api/dashboard?asOf=YYYY-MM-DD parsed the day as UTC midnight, and the dashboard reads
 * "today" from that moment on this computer's calendar — the evening BEFORE west of UTC, so the
 * dashboard ran a day early. Impossible days rolled over (2026-02-30 → March 2).
 */
describe('dashboard route asOf', () => {
  it('a calendar day is that day on this computer; impossible days are a 400', async () => {
    await dashboardGET(req('/api/dashboard?asOf=2026-10-26'));
    const now = getDashboardInsights.mock.calls.at(-1)?.[1] as Date;
    expect([now.getFullYear(), now.getMonth() + 1, now.getDate()]).toEqual([2026, 10, 26]);
    const bad = await dashboardGET(req('/api/dashboard?asOf=2026-02-30'));
    expect(bad.status).toBe(400);
  });
});
