/**
 * Review loop 10 fixes (merges, fixed assets, forecast):
 *  - merging an account into its own grandchild never makes a parent loop;
 *  - a merge re-points memorized transactions and price rules (JSON) to the survivor;
 *  - depreciation is posted once per month, never before the asset was placed in service;
 *  - the Cash Flow Forecast leaves out items due after its window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accounts, recurringTemplates } from '@/lib/db/schema';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { mergeAccounts, mergeCustomers } from './merge';
import { createAsset, postDepreciation } from './fixedAssets';
import { createTemplate } from './recurring';
import { cashFlowForecast } from './reportsMore';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { renderSalesFormPdf } from '@/lib/pdf/salesForm';

let t: TestCompany;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  t = await makeTestCompany('review10');
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('merges', { timeout: 120_000 }, () => {
  it('an account merged into its grandchild leaves no parent loop', async () => {
    const a = await createAccount(t.ctx, { code: '6810', name: 'R10 A', type: 'expense', subtype: 'operating_expenses' });
    const x = await createAccount(t.ctx, { code: '6811', name: 'R10 X', type: 'expense', subtype: 'operating_expenses', parentId: a.id });
    const b = await createAccount(t.ctx, { code: '6812', name: 'R10 B', type: 'expense', subtype: 'operating_expenses', parentId: x.id });
    await mergeAccounts(t.ctx, { fromId: a.id, toId: b.id });
    const rows = await t.db.select({ id: accounts.id, parentId: accounts.parentId }).from(accounts).where(eq(accounts.companyId, t.ctx.companyId));
    const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
    // Walk up from B: it must reach the top without a cycle.
    let cur: string | null | undefined = b.id;
    const seen = new Set<string>();
    while (cur) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  });

  it('a customer merge re-points memorized transactions to the survivor', async () => {
    const from = await createCustomer(t.ctx, { displayName: 'R10 Old Co' });
    const to = await createCustomer(t.ctx, { displayName: 'R10 New Co' });
    const tpl = await createTemplate(t.ctx, {
      name: 'R10 retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: d('2027-01-01'),
      mode: 'remind',
      template: { customerId: from.id, lines: [{ description: 'Retainer', quantity: '1', rate: '100.00' }] },
    });
    await mergeCustomers(t.ctx, { fromId: from.id, toId: to.id });
    const [row] = await t.db.select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect((row.template as { customerId: string }).customerId).toBe(to.id);
  });
});

describe('depreciation', { timeout: 120_000 }, () => {
  it('once per month, and not before the asset was placed in service', async () => {
    const asset = await createAsset(t.ctx, { name: 'R10 Van', cost: '12000.00', usefulLifeMonths: 60, placedInService: d('2026-03-01') });
    await expect(postDepreciation(t.ctx, { assetId: asset.id, date: d('2026-02-28') })).rejects.toThrow(/placed in service/);
    await postDepreciation(t.ctx, { assetId: asset.id, date: d('2026-04-14') });
    await expect(postDepreciation(t.ctx, { assetId: asset.id, date: d('2026-04-21') })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('cash flow forecast', { timeout: 120_000 }, () => {
  it('an invoice due after the window is not counted at the start', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'R10 Forecast' });
    const before = await cashFlowForecast(t.ctx, { from: '2026-06-01', to: '2026-07-12' } as never);
    await createInvoice(t.ctx, { customerId: c.id, date: d('2026-05-20'), dueDate: d('2026-09-30'), lines: [{ accountId: t.acct['4000'], description: 'Later', quantity: 1, rate: 50000 }] } as never);
    const after = await cashFlowForecast(t.ctx, { from: '2026-06-01', to: '2026-07-12' } as never);
    const begin = (r: typeof before) => JSON.stringify(r.rows.find((x) => /begin/i.test(String(x.cells.label ?? '')))?.cells ?? {});
    expect(begin(after)).toBe(begin(before));
  });
});

describe('printed forms', () => {
  it('a currency symbol the PDF font lacks prints as its code (no crash)', async () => {
    const bytes = await renderSalesFormPdf({
      company: { name: 'R10 Co' },
      title: 'SALES RECEIPT',
      number: '1',
      date: '2026-11-14',
      customerName: 'Buyer',
      currency: 'INR',
      lines: [{ description: 'Item', quantity: 1, rate: 1234.5, amount: 1234.5 }],
      totals: [['Total', 1234.5]],
    } as never);
    expect(bytes.length).toBeGreaterThan(500);
  });
});
