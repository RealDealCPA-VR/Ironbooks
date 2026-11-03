/**
 * Report gaps round — review-round-5 leftovers on report routes (failing tests first).
 *
 *  - Open-item statement routes (JSON and PDF) parsed ?asOf with new Date(x + 'T00:00:00Z'), so a
 *    day that does not exist (2026-02-30) rolled over to March 2 instead of being refused.
 *  - Report export: a download name with characters outside Latin-1 ("O’Brien P&L") must not make
 *    the Content-Disposition header throw (verify: ASCII fallback + RFC 5987 filename*).
 *  - Scheduled exports of a single company file go next to the company FILE (BKA_COMPANY_FILE),
 *    never into the hidden per-PC working copy (verify).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { NextRequest } from 'next/server';

const { openItemStatement, buildOpenItemPdf, graphData, current } = vi.hoisted(() => ({
  graphData: vi.fn(async (..._a: unknown[]) => ({ series: [] })),
  current: { ctx: { db: null, companyId: 'c', userId: 'u' } as Record<string, unknown> },
  openItemStatement: vi.fn(async (..._a: unknown[]) => ({ customer: { displayName: 'Acme' }, lines: [], totalDue: '0.00', aging: {} })),
  buildOpenItemPdf: vi.fn(async (..._a: unknown[]) => new Uint8Array([37, 80, 68, 70])),
}));
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => current.ctx) }));
vi.mock('@/lib/services/reportsAnalysis', async (orig) => ({ ...(await orig<object>()), graphData }));
vi.mock('@/lib/services/statements', async (orig) => ({ ...(await orig<object>()), openItemStatement }));
vi.mock('@/app/api/export/statements/openItemPdf', async (orig) => ({ ...(await orig<object>()), renderOpenItemStatementPdf: buildOpenItemPdf }));
vi.mock('@/lib/services/company', async (orig) => ({ ...(await orig<object>()), getCompany: vi.fn(async () => ({ name: 'Acme' })) }));
import { GET as openItemGET } from '@/app/api/export/statements/open-item/route';
import { GET as openItemPdfGET } from '@/app/api/export/statements/open-item/pdf/route';
import { POST as exportPOST } from '@/app/api/export/reports/route';
import { GET as graphsGET } from '@/app/api/reports/graphs/route';
import { unionRoles, type PermissionGrant } from '@/lib/permissions/model';

const saved = { file: process.env.BKA_COMPANY_FILE, out: process.env.BKA_REPORT_EXPORT_DIR };
afterAll(() => {
  if (saved.file === undefined) delete process.env.BKA_COMPANY_FILE;
  else process.env.BKA_COMPANY_FILE = saved.file;
  if (saved.out === undefined) delete process.env.BKA_REPORT_EXPORT_DIR;
  else process.env.BKA_REPORT_EXPORT_DIR = saved.out;
});

const req = (p: string) => new NextRequest(`http://localhost${p}`);
const CUST = '11111111-1111-4111-8111-111111111111';

describe('open-item statement routes: asOf', () => {
  it('a day that does not exist is a 400 on both routes (it rolled over to the next month)', async () => {
    for (const q of ['2026-02-30', '2026-13-01', 'garbage']) {
      const json = await openItemGET(req(`/api/export/statements/open-item?customerId=${CUST}&asOf=${q}`));
      expect(json.status, `json ${q}`).toBe(400);
      const pdf = await openItemPdfGET(req(`/api/export/statements/open-item/pdf?customerId=${CUST}&asOf=${q}`));
      expect(pdf.status, `pdf ${q}`).toBe(400);
    }
    expect(openItemStatement).not.toHaveBeenCalled();
  });

  it('a real day reaches the statement as that calendar day; no day = the company today', async () => {
    const res = await openItemGET(req(`/api/export/statements/open-item?customerId=${CUST}&asOf=2026-02-28`));
    expect(res.status).toBe(200);
    expect(openItemStatement.mock.calls.at(-1)?.[2]).toEqual(new Date('2026-02-28T00:00:00.000Z'));
    await openItemGET(req(`/api/export/statements/open-item?customerId=${CUST}`));
    expect(openItemStatement.mock.calls.at(-1)?.[2]).toBeUndefined();
  });
});

describe('report export download names', () => {
  it('a name outside Latin-1 downloads (ASCII fallback + UTF-8 filename*), never a 500', async () => {
    const body = { format: 'xlsx', filename: 'O’Brien P&L — 利润', title: 'P&L', columns: [{ header: 'A' }], rows: [['x']] };
    const res = await exportPOST(new NextRequest('http://localhost/api/export/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment; filename="O_Brien P&L _ __\.xlsx"; filename\*=UTF-8''/);
    expect([...cd].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('scheduled export folder of a single company file', () => {
  it('is next to the company file, not inside the working copy', async () => {
    const { reportExportRoot } = await import('./memorizedReports');
    delete process.env.BKA_REPORT_EXPORT_DIR;
    process.env.BKA_COMPANY_FILE = path.join(path.sep, 'Shared', 'Books', 'Acme Inc.ironbooks');
    expect(reportExportRoot()).toBe(path.resolve(path.sep, 'Shared', 'Books', 'Report Exports', 'Acme Inc'));
  });
});

describe('report graphs check the report activity, not the whole area (post-merge review)', () => {
  const role = (grant: PermissionGrant) =>
    unionRoles([{ key: 'custom-activities', name: 'Custom', description: '', builtin: false, permissions: grant, flags: {} }]);
  afterAll(() => {
    current.ctx = { db: null, companyId: 'c', userId: 'u' };
  });

  it('the A/R graph needs the A/R reports activity; Sales reports alone are refused', async () => {
    current.ctx = { db: null, companyId: 'c', userId: 'u', access: role({ 'reports_sales.sales': ['view'] }) };
    expect((await graphsGET(req('/api/reports/graphs?kind=ar'))).status).toBe(403);
    current.ctx = { db: null, companyId: 'c', userId: 'u', access: role({ 'reports_sales.receivables': ['view'] }) };
    expect((await graphsGET(req('/api/reports/graphs?kind=ar'))).status).toBe(200);
  });

  it('the A/P graph needs Vendors & Payables reports; the others need Company & Financial', async () => {
    current.ctx = { db: null, companyId: 'c', userId: 'u', access: role({ 'reports_purchases.purchases': ['view'], 'reports_financial.accountant': ['view'] }) };
    expect((await graphsGET(req('/api/reports/graphs?kind=ap'))).status).toBe(403);
    expect((await graphsGET(req('/api/reports/graphs?kind=income-expense'))).status).toBe(403);
    current.ctx = { db: null, companyId: 'c', userId: 'u', access: role({ 'reports_purchases.payables': ['view'], 'reports_financial.company': ['view'] }) };
    expect((await graphsGET(req('/api/reports/graphs?kind=ap'))).status).toBe(200);
    expect((await graphsGET(req('/api/reports/graphs?kind=net-worth'))).status).toBe(200);
  });
});
