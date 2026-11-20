/**
 * The agent's tools (mcp/tools.mjs): what each one asks Ironbooks for, and the shape it hands the
 * agent. A recording stand-in answers in the shapes the real routes use; the same tools run
 * against the real routes in lib/agentTools.contract.test.ts.
 *
 * The last test runs the whole chain once: the MCP server over a stream, the real connector, and a
 * local HTTP server standing in for the app, to see the token arrive with the tool's request.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createServer, serve } from '../../mcp/protocol.mjs';
import { HOST, IronbooksClient, IronbooksError, expectedProof } from '../../mcp/client.mjs';
import { DATE_PRESETS, OTHER_LISTS, TOOLS, TXN_TYPES, shapeReport } from '../../mcp/tools.mjs';
import { AGENT_READ_ROUTES } from '@/lib/permissions/agentAccess';
import { matchRoutePattern } from '@/lib/permissions/routes';
import { SIMPLE_LIST_KEYS } from '@/lib/services/lists/simpleLists';
import { reportParamsSchema } from '@/lib/validation/reports';

type Any = Record<string, any>;
const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '99999999-2222-4333-8444-555555555555';

const REPORT = {
  key: 'x',
  title: 'Some Report',
  subtitle: 'Jan 2026',
  basis: 'accrual',
  range: { from: '2026-01-01', to: '2026-01-31', asOf: '2026-01-31' },
  balanced: true,
  columns: [{ key: 'label', header: 'Account' }, { key: 'amount', header: 'Amount', type: 'money' }],
  rows: [
    { id: 'a', depth: 0, kind: 'section', cells: { label: 'Income' } },
    { id: 'b', depth: 1, kind: 'data', cells: { label: 'Sales', amount: '100.00' }, entryId: ID },
    { id: 's', depth: 0, kind: 'spacer', cells: {} },
    { id: 'c', depth: 0, kind: 'total', cells: { label: 'Total', amount: '100.00' } },
  ],
  notes: ['A note.'],
};

/** Records each GET and answers by path. */
function recorder(answers: Record<string, unknown>) {
  const calls: Array<{ path: string; query: Any }> = [];
  return {
    calls,
    client: {
      async get(p: string, query: Any = {}) {
        const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        calls.push({ path: p, query: clean });
        const key = Object.keys(answers).find((k) => k === p) ?? Object.keys(answers).find((k) => k.endsWith('*') && p.startsWith(k.slice(0, -1)));
        if (!key) throw new IronbooksError(`no answer for ${p}`);
        const a = answers[key];
        if (a instanceof Error) throw a;
        return a;
      },
    },
  };
}
async function call(client: unknown, name: string, args: Any = {}): Promise<{ isError: boolean; text: string; data: Any }> {
  const server = createServer({ tools: TOOLS, client, serverInfo: { name: 't', version: '0' } });
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as Any;
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  const text: string = res.result.content[0].text;
  let data: Any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* a message */
  }
  return { isError: res.result.isError, text, data };
}

describe('the tools and the app agree on names', () => {
  it('every tool only reads routes on the agent list', async () => {
    const used = new Set<string>();
    const client = {
      async get(p: string) {
        const pattern = matchRoutePattern(p);
        expect(pattern, p).not.toBeNull();
        expect(AGENT_READ_ROUTES, p).toContain(pattern);
        used.add(pattern!);
        if (p === '/api/registers') return { accounts: [{ id: ID, code: '1000', name: 'Checking', type: 'asset' }] };
        if (p.startsWith('/api/journal-entries/')) return { entry: { id: ID, lines: [] } };
        return {};
      },
    };
    const args: Record<string, Any> = { list_other: { list: 'terms' }, search: { query: 'x' }, get_register: { account: '1000' }, get_journal_entry: { id: ID } };
    for (const t of TOOLS) {
      const r = await call(client, t.name, args[t.name] ?? {});
      expect(r.isError, `${t.name}: ${r.text}`).toBe(false);
    }
    await call(client, 'list_other', { list: 'sales-tax-items' });
    await call(client, 'report_ar_aging', { detail: true });
    await call(client, 'report_ap_aging', { detail: true });
    expect([...used].sort()).toEqual([...AGENT_READ_ROUTES].sort());
  });

  it('the choices offered are the ones the app accepts', () => {
    const shape = (reportParamsSchema as unknown as { _def: Any }) as Any;
    const ok = (params: Any) => reportParamsSchema.safeParse(params).success;
    expect(shape).toBeDefined();
    for (const d of DATE_PRESETS) expect(ok({ dates: d }), d).toBe(true);
    expect(ok({ dates: 'next_decade' })).toBe(false);
    for (const t of TXN_TYPES) expect(ok({ txnType: t }), t).toBe(true);
    expect(ok({ txnType: 'barter' })).toBe(false);
    for (const v of ['total', 'month', 'quarter', 'year']) expect(ok({ columns: v })).toBe(true);
    for (const v of ['none', 'prev_period', 'prev_year']) expect(ok({ compare: v })).toBe(true);
    for (const v of ['accrual', 'cash']) expect(ok({ basis: v })).toBe(true);
    for (const v of ['any', 'cleared', 'uncleared']) expect(ok({ cleared: v })).toBe(true);
    // Every "other list" is a simple list of the app, or the sales tax items route.
    for (const l of OTHER_LISTS) expect(l === 'sales-tax-items' || (SIMPLE_LIST_KEYS as readonly string[]).includes(l), l).toBe(true);
  });
});

describe('lists', () => {
  it('list_accounts asks for the chart and shapes each account', async () => {
    const { client, calls } = recorder({
      '/api/accounts': [
        { id: ID, code: '1000', name: 'Checking', type: 'asset', qbType: 'Bank', subtype: 'checking', balance: '250.00', isActive: true, companyId: 'c', createdAt: 'x' },
        { id: ID2, code: '6000', name: 'Rent', type: 'expense', qbType: 'Expense', subtype: null, balance: null, isActive: false },
      ],
    });
    const all = await call(client, 'list_accounts', { include_inactive: true });
    expect(calls[0]).toEqual({ path: '/api/accounts', query: { includeInactive: 'true' } });
    expect(all.data).toEqual({
      count: 2,
      accounts: [
        { id: ID, number: '1000', name: 'Checking', type: 'Bank', subtype: 'checking', balance: '250.00', active: true },
        { id: ID2, number: '6000', name: 'Rent', type: 'Expense', subtype: null, balance: null, active: false },
      ],
    });
    expect((await call(client, 'list_accounts', { search: 'rent' })).data.accounts.map((a: Any) => a.number)).toEqual(['6000']);
    expect((await call(client, 'list_accounts', { type: 'bank' })).data.accounts.map((a: Any) => a.number)).toEqual(['1000']);
    expect(calls[1].query).toEqual({});
  });

  it('list_customers and list_vendors ask for balances and cut long lists', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, displayName: `Customer ${i}`, companyName: null, email: `c${i}@x.test`, balance: '10.00', isActive: true, taxId: 'secret', notes: 'private' }));
    const { client, calls } = recorder({ '/api/customers': many, '/api/vendors': [{ id: ID, displayName: 'Paper Co', is1099: true, balance: '5.00', taxId: '***-**-1234', accountNumber: '••••1' }] });
    const c = await call(client, 'list_customers', { max_rows: 2 });
    expect(calls[0]).toEqual({ path: '/api/customers', query: { withBalances: 'true' } });
    expect(c.data).toMatchObject({ count: 5, truncated: true });
    expect(c.data.customers).toHaveLength(2);
    expect(c.data.customers[0]).toEqual({ id: '0', name: 'Customer 0', company: null, email: 'c0@x.test', phone: null, terms: null, balance: '10.00', active: true });
    expect(c.data.note).toMatch(/first 2 of 5/);
    const v = await call(client, 'list_vendors', { include_inactive: true });
    expect(calls[1]).toEqual({ path: '/api/vendors', query: { withBalances: 'true', includeInactive: 'true' } });
    expect(v.data.vendors).toEqual([{ id: ID, name: 'Paper Co', company: null, email: null, phone: null, terms: null, eligible_1099: true, balance: '5.00', active: true }]);
    expect(JSON.stringify(v.data)).not.toMatch(/taxId|accountNumber|1234/);
  });

  it('list_items, list_classes, list_employees', async () => {
    const { client, calls } = recorder({
      '/api/items': { items: [{ id: ID, name: 'Widget', type: 'inventory', salesPrice: '9.99', purchaseCost: '4.00', quantityOnHand: '12', isActive: true }, { id: ID2, name: 'Labor', type: 'service', salesPrice: '80.00', quantityOnHand: '0' }] },
      '/api/classes': [{ id: ID, name: 'Retail', parentId: null, companyId: 'c' }],
      '/api/employees': [{ id: ID, firstName: 'Pat', lastName: 'Lee', payType: 'hourly', ssnLast4: '6789', ssn: undefined, isActive: true, address: 'home', payRate: '30' }],
    });
    const items = await call(client, 'list_items', { type: 'inventory', search: 'wid' });
    expect(calls[0]).toEqual({ path: '/api/items', query: { type: 'inventory', search: 'wid' } });
    expect(items.data.items[0]).toEqual({ id: ID, name: 'Widget', type: 'inventory', description: null, sales_price: '9.99', cost: '4.00', quantity_on_hand: '12', active: true });
    expect(items.data.items[1]).not.toHaveProperty('quantity_on_hand');
    expect((await call(client, 'list_classes')).data).toEqual({ count: 1, classes: [{ id: ID, name: 'Retail' }] });
    const emp = await call(client, 'list_employees', { include_inactive: true });
    expect(calls[2]).toEqual({ path: '/api/employees', query: { includeInactive: 'true' } });
    expect(emp.data.employees).toEqual([{ id: ID, name: 'Pat Lee', email: null, pay_type: 'hourly', ssn_last4: '6789', active: true }]);
    expect(JSON.stringify(emp.data)).not.toMatch(/payRate|address|home/);
  });

  it('list_other reads the named list, and sales tax items from their own route', async () => {
    const { client, calls } = recorder({
      '/api/lists/*': { entries: [{ id: ID, name: 'Net 30', netDays: 30, isActive: true, companyId: 'c', createdAt: 'x', updatedAt: 'y' }] },
      '/api/tax-rates': [{ id: ID, name: 'State', rate: '0.082500', agencyId: ID2, isActive: true }],
    });
    const terms = await call(client, 'list_other', { list: 'terms', include_inactive: true });
    expect(calls[0]).toEqual({ path: '/api/lists/terms', query: { includeInactive: 'true' } });
    expect(terms.data).toEqual({ list: 'terms', count: 1, entries: [{ id: ID, name: 'Net 30', netDays: 30, active: true }] });
    const tax = await call(client, 'list_other', { list: 'sales-tax-items' });
    expect(calls[1].path).toBe('/api/tax-rates');
    expect(tax.data.entries).toEqual([{ id: ID, name: 'State', rate: '0.082500', agency_id: ID2, active: true }]);
    expect((await call(client, 'list_other', { list: 'secrets' })).isError).toBe(true);
    expect((await call(client, 'list_other', {})).text).toMatch(/"list" is required/);
    expect(calls).toHaveLength(2);
  });
});

describe('search, find, register, journal entry', () => {
  it('search passes the words on and returns kind, label and id', async () => {
    const { client, calls } = recorder({ '/api/search': { results: [{ type: 'Customer', label: 'Acme', href: '/customers?focus=1', id: ID }] } });
    const out = await call(client, 'search', { query: 'acme' });
    expect(calls[0]).toEqual({ path: '/api/search', query: { q: 'acme' } });
    expect(out.data).toEqual({ count: 1, results: [{ kind: 'Customer', label: 'Acme', id: ID }] });
  });

  it('find_transactions maps every filter to the app\'s parameter', async () => {
    const { client, calls } = recorder({ '/api/find': REPORT });
    const out = await call(client, 'find_transactions', {
      type: 'check', customer_id: ID, vendor_id: ID2, account_id: ID, class_id: ID2, date_from: '2026-01-01', date_to: '2026-01-31',
      amount_min: '10', amount_max: '10.50', number: '1042', memo: 'rent', cleared: 'uncleared', max_rows: 50,
    });
    expect(calls[0]).toEqual({
      path: '/api/find',
      query: { txnType: 'check', customerId: ID, vendorId: ID2, accountId: ID, classId: ID2, from: '2026-01-01', to: '2026-01-31', amountMin: '10', amountMax: '10.50', number: '1042', memo: 'rent', cleared: 'uncleared' },
    });
    expect(out.data.rows[1]).toEqual({ kind: 'data', level: 1, cells: ['Sales', '100.00'], journal_entry_id: ID });
    // Arguments that are not what they should be never reach the app.
    for (const bad of [{ date_from: 'yesterday' }, { amount_min: '-5' }, { amount_min: 'ten' }, { customer_id: 'acme' }, { type: 'barter' }, { max_rows: 0 }, { max_rows: 5000 }]) {
      expect((await call(client, 'find_transactions', bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  const REGISTERS = { accounts: [{ id: ID, code: '1000', name: 'Checking', type: 'asset', subtype: 'bank', balance: '900.00', isActive: true }, { id: ID2, code: '1010', name: 'Savings Checking Reserve', type: 'asset', balance: '5.00', isActive: true }] };
  const REGISTER = {
    register: {
      account: REGISTERS.accounts[0], openingBalance: '0.00', closingBalance: '900.00', totalRows: 2, offset: 0, currency: null, homeCurrency: 'USD',
      rows: [
        { lineId: 'l1', journalEntryId: ID, date: '2026-01-05T00:00:00.000Z', entryNumber: 7, reference: '1042', description: 'Rent', memo: 'Jan', sourceRef: 'expense:x', debit: null, credit: '100.00', runningBalance: '-100.00', otherAccount: { id: ID2, label: 'Rent Expense' }, cleared: 'reconciled' },
        { lineId: 'l2', journalEntryId: ID2, date: '2026-01-09T00:00:00.000Z', reference: '', description: 'Deposit', memo: '', debit: '1000.00', credit: null, runningBalance: '900.00', otherAccount: { id: null, label: '-split-' }, cleared: null },
      ],
    },
  };

  it('get_register lists the registers, then opens one by number, name or id', async () => {
    const { client, calls } = recorder({ '/api/registers': REGISTERS, '/api/registers/*': REGISTER });
    const list = await call(client, 'get_register');
    expect(list.data.accounts.map((a: Any) => a.number)).toEqual(['1000', '1010']);
    expect(calls.map((c) => c.path)).toEqual(['/api/registers']);

    const byNumber = await call(client, 'get_register', { account: '1000', date_from: '2026-01-01', date_to: '2026-01-31', search: 'rent', max_rows: 40 });
    expect(calls.at(-1)).toEqual({ path: `/api/registers/${ID}`, query: { from: '2026-01-01', to: '2026-01-31', search: 'rent', limit: 40 } });
    expect(byNumber.data).toMatchObject({ account: { id: ID, number: '1000', name: 'Checking' }, opening_balance: '0.00', closing_balance: '900.00', total_rows: 2 });
    expect(byNumber.data.rows).toEqual([
      { date: '2026-01-05', number: '1042', description: 'Rent', memo: 'Jan', other_account: 'Rent Expense', increase_or_debit: null, decrease_or_credit: '100.00', balance: '-100.00', status: 'reconciled', journal_entry_id: ID },
      { date: '2026-01-09', number: null, description: 'Deposit', memo: null, other_account: '-split-', increase_or_debit: '1000.00', decrease_or_credit: null, balance: '900.00', status: 'uncleared', journal_entry_id: ID2 },
    ]);

    // No dates: the newest 100. An exact name wins over a name that merely contains it.
    await call(client, 'get_register', { account: 'checking' });
    expect(calls.at(-1)).toEqual({ path: `/api/registers/${ID}`, query: { last: 100 } });
    await call(client, 'get_register', { account_id: ID2, newest: 5 });
    expect(calls.at(-1)).toEqual({ path: `/api/registers/${ID2}`, query: { last: 5 } });
  });

  it('get_register asks which account when the name fits several, or none', async () => {
    const { client, calls } = recorder({ '/api/registers': REGISTERS, '/api/registers/*': REGISTER });
    const two = await call(client, 'get_register', { account: 'check' });
    expect(two.isError).toBe(true);
    expect(two.text).toMatch(/matches more than one account: 1000 Checking; 1010 Savings Checking Reserve/);
    const none = await call(client, 'get_register', { account: 'payroll' });
    expect(none.text).toMatch(/No account matches "payroll"/);
    const both = await call(client, 'get_register', { account: '1000', account_id: ID });
    expect(both.text).toMatch(/either account_id or account/);
    const unknown = await call(client, 'get_register', { account_id: '00000000-2222-4333-8444-555555555555' });
    expect(unknown.text).toMatch(/no register you can open/);
    expect(calls.every((c) => c.path === '/api/registers')).toBe(true);
  });

  it('get_journal_entry returns the lines behind a transaction', async () => {
    const { client, calls } = recorder({
      '/api/journal-entries/*': {
        entry: {
          id: ID, entryNumber: 12, date: '2026-01-05T00:00:00.000Z', description: 'Rent', reference: '1042', status: 'posted', sourceRef: 'expense:abc', isAdjusting: false,
          lines: [
            { id: 'a', accountId: ID, accountCode: '6000', accountName: 'Rent', debit: '100.00', credit: null, memo: 'Jan', classId: null, className: 'Retail', entityType: 'vendor', entityId: ID2, entityName: 'Landlord LLC' },
            { id: 'b', accountId: ID2, accountCode: '1000', accountName: 'Checking', debit: null, credit: '100.00', memo: null },
          ],
        },
      },
    });
    const out = await call(client, 'get_journal_entry', { id: ID });
    expect(calls[0]).toEqual({ path: `/api/journal-entries/${ID}`, query: {} });
    expect(out.data).toEqual({
      id: ID, number: 12, date: '2026-01-05', description: 'Rent', reference: '1042', status: 'posted', source: 'expense:abc', adjusting: false,
      lines: [
        { account_id: ID, account: '6000 Rent', debit: '100.00', credit: null, memo: 'Jan', class: 'Retail', name: 'Landlord LLC', name_kind: 'vendor' },
        { account_id: ID2, account: '1000 Checking', debit: null, credit: '100.00', memo: null },
      ],
    });
    expect((await call(client, 'get_journal_entry', { id: 'not-an-id' })).isError).toBe(true);
    expect((await call(client, 'get_journal_entry', {})).text).toMatch(/"id" is required/);
  });
});

describe('reports', () => {
  it('each report asks for its own report with the app\'s parameter names', async () => {
    const { client, calls } = recorder({ '/api/reports/std/*': REPORT });
    await call(client, 'report_profit_and_loss', { date_from: '2026-01-01', date_to: '2026-03-31', basis: 'cash', columns: 'month', compare: 'prev_year', class_id: ID });
    await call(client, 'report_profit_and_loss', { period: 'last_month' });
    await call(client, 'report_balance_sheet', { as_of: '2026-03-31', basis: 'accrual', compare: 'prev_period', class_id: ID });
    await call(client, 'report_trial_balance', { as_of: '2026-03-31', basis: 'cash' });
    await call(client, 'report_general_ledger', { period: 'this_month', account_id: ID, customer_id: ID2, vendor_id: ID, class_id: ID2, basis: 'accrual' });
    await call(client, 'report_ar_aging', { as_of: '2026-03-31', customer_id: ID, days_per_column: 15 });
    await call(client, 'report_ar_aging', { detail: true });
    await call(client, 'report_ap_aging', { as_of: '2026-03-31', vendor_id: ID });
    await call(client, 'report_ap_aging', { detail: true, days_per_column: 45 });
    expect(calls).toEqual([
      { path: '/api/reports/std/profit-loss', query: { from: '2026-01-01', to: '2026-03-31', basis: 'cash', columns: 'month', compare: 'prev_year', classId: ID } },
      { path: '/api/reports/std/profit-loss', query: { dates: 'last_month' } },
      { path: '/api/reports/std/balance-sheet', query: { asOf: '2026-03-31', basis: 'accrual', compare: 'prev_period', classId: ID } },
      { path: '/api/reports/std/trial-balance', query: { asOf: '2026-03-31', basis: 'cash' } },
      { path: '/api/reports/std/general-ledger', query: { dates: 'this_month', accountId: ID, customerId: ID2, vendorId: ID, classId: ID2, basis: 'accrual' } },
      { path: '/api/reports/std/ar-aging-summary', query: { asOf: '2026-03-31', customerId: ID, interval: 15 } },
      { path: '/api/reports/std/ar-aging-detail', query: {} },
      { path: '/api/reports/std/ap-aging-summary', query: { asOf: '2026-03-31', vendorId: ID } },
      { path: '/api/reports/std/ap-aging-detail', query: { interval: 45 } },
    ]);
  });

  it('a period is a name or dates, never both; dates must be dates', async () => {
    const { client, calls } = recorder({ '/api/reports/std/*': REPORT });
    expect((await call(client, 'report_profit_and_loss', { period: 'this_year', date_to: '2026-01-31' })).text).toMatch(/either "period" or date_from/);
    expect((await call(client, 'report_general_ledger', { period: 'sometime' })).isError).toBe(true);
    expect((await call(client, 'report_balance_sheet', { as_of: '31/03/2026' })).text).toMatch(/must be a date as YYYY-MM-DD/);
    expect((await call(client, 'report_trial_balance', { basis: 'modified' })).isError).toBe(true);
    expect((await call(client, 'report_ar_aging', { days_per_column: 0 })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a report comes back compact: headers once, rows as cells, spacers dropped', () => {
    expect(shapeReport(REPORT, undefined)).toEqual({
      report: 'Some Report',
      subtitle: 'Jan 2026',
      basis: 'accrual',
      period: { from: '2026-01-01', to: '2026-01-31', asOf: '2026-01-31' },
      balanced: true,
      columns: [{ name: 'Account' }, { name: 'Amount', type: 'money' }],
      row_count: 3,
      rows: [
        { kind: 'section', level: 0, cells: ['Income', null] },
        { kind: 'data', level: 1, cells: ['Sales', '100.00'], journal_entry_id: ID },
        { kind: 'total', level: 0, cells: ['Total', '100.00'] },
      ],
      notes: ['A note.'],
    });
    const cut = shapeReport({ ...REPORT, truncated: true }, 1);
    expect(cut.rows).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.notes.join(' ')).toMatch(/cut this report short/);
    expect(cut.notes.join(' ')).toMatch(/first 1 of 3 rows/);
    expect(shapeReport({}, undefined)).toMatchObject({ report: 'Report', columns: [], row_count: 0, rows: [] });
  });

  it('a refusal from Ironbooks reaches the agent in plain words', async () => {
    const { client } = recorder({ '/api/reports/std/*': new IronbooksError('You do not have permission to view Reports — Sales. Ask your administrator for access.', { status: 403 }) });
    const out = await call(client, 'report_ar_aging');
    expect(out.isError).toBe(true);
    expect(out.text).toBe('You do not have permission to view Reports — Sales. Ask your administrator for access.');
  });
});

describe('the whole chain', () => {
  it('a tool call over stdio reaches the app with the token, after the proof', async () => {
    const TAG = 'feedc0de';
    const TOKEN = `ibka_${TAG}_${'z'.repeat(43)}`;
    const CHECK = '5a'.repeat(32);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ironbooks-mcp-chain-'));
    const seen: Array<{ url: string; auth?: string; method?: string }> = [];
    let port = 0;
    const app = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, method: req.method });
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/agent/hello') return void res.end(JSON.stringify({ proof: expectedProof(CHECK, url.searchParams.get('nonce'), port, url.searchParams.get('tag')) }));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(403).end(JSON.stringify({ error: 'Authentication required.' }));
      if (url.pathname === '/api/reports/std/trial-balance') return void res.end(JSON.stringify({ ...REPORT, title: 'Trial Balance' }));
      res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>((r) => app.listen(0, HOST, r));
    port = (app.address() as AddressInfo).port;
    fs.writeFileSync(path.join(dir, `${TAG}.json`), JSON.stringify({ tag: TAG, port, pid: 1, check: CHECK }));

    const client = new IronbooksClient({ env: { IRONBOOKS_AGENT_TOKEN: TOKEN }, endpointDir: dir, timeoutMs: 5000 });
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => (out += d.toString('utf8')));
    const done = serve(createServer({ tools: TOOLS, client, serverInfo: { name: 'ironbooks', version: '1' } }), { input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'report_trial_balance', arguments: { as_of: '2026-01-31' } } })}\n`);
    input.end();
    await done;
    client.close();
    await new Promise<void>((r) => {
      app.closeAllConnections();
      app.close(() => r());
    });
    fs.rmSync(dir, { recursive: true, force: true });

    const replies = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    const result = replies[1].result;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ report: 'Trial Balance', balanced: true, row_count: 3 });
    // The app saw the question first (no token), then one GET with the token.
    expect(seen.map((s) => [s.method, s.url.split('?')[0], s.auth ? 'token' : 'none'])).toEqual([
      ['GET', '/api/agent/hello', 'none'],
      ['GET', '/api/reports/std/trial-balance', 'token'],
    ]);
    expect(seen[1].url).toBe('/api/reports/std/trial-balance?asOf=2026-01-31');
    // Nothing the agent reads back contains the token.
    expect(out).not.toContain(TOKEN);
  });
});
