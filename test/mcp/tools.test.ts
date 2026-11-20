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
import { DATE_PRESETS, OTHER_LISTS, READ_TOOLS, TOOLS, TXN_TYPES, shapeReport } from '../../mcp/tools.mjs';
import { LIST_TYPES, TRANSACTION_TYPES, WRITE_READ_TOOLS, WRITE_TOOLS, camelize, shapeAnswer, shapeRecord } from '../../mcp/write-tools.mjs';
import { BANKING_READ_TOOLS, BANKING_WRITE_TOOLS } from '../../mcp/banking-tools.mjs';
import { OPERATION_TOOLS } from '../../mcp/operations-tools.mjs';
import { FILE_TOOLS } from '../../mcp/files-tools.mjs';
import { ALL_AGENT_ACTIONS as AGENT_ACTIONS, AGENT_LIST_TYPES, AGENT_TRANSACTION_TYPES } from '@/lib/agent/catalog';
import { AGENT_ACTION_ROUTE, agentRouteAllowed } from '@/lib/permissions/agentAccess';
import { operationForPath } from '@/lib/agent/operations/registry';
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

/**
 * The routes the named read tools call. It was the agent allow-list (AGENT_READ_ROUTES); with full
 * access, what an agent may read directly is decided by lib/permissions/agentAccess.ts
 * agentRouteAllowed and the operation registry, which every route here must pass.
 */
const NAMED_TOOL_READ_ROUTES = [
  '/api/agent/whoami', '/api/accounts', '/api/customers', '/api/vendors', '/api/items', '/api/classes', '/api/employees', '/api/lists/[list]',
  '/api/tax-rates', '/api/search', '/api/find', '/api/registers', '/api/registers/[accountId]', '/api/journal-entries/[id]', '/api/reports/std/[report]',
  '/api/invoices', '/api/invoices/[id]', '/api/sales-receipts/[id]', '/api/payments/[id]', '/api/bills', '/api/bills/[id]', '/api/bill-payments/[id]',
  '/api/expenses/[id]', '/api/deposits/[id]', '/api/deposits/undeposited', '/api/transfers/[id]', '/api/customers/[id]', '/api/vendors/[id]',
  '/api/accounts/[id]', '/api/items/[id]', '/api/bank-accounts', '/api/bank-transactions', '/api/bank-transactions/matches', '/api/reconciliations',
  '/api/reconciliations/[id]', '/api/reconciliations/[id]/clearable', '/api/reconciliations/info',
];
const registryLookup = (p: string) => operationForPath('GET', p)?.operation ?? null;

describe('the tools and the app agree on names', () => {
  it('every tool reads only routes an agent may read, and changes go to the one action route', async () => {
    const used = new Set<string>();
    const acted: string[] = [];
    const client = {
      async act(request: Any) {
        acted.push(request.action);
        return { action: request.action, outcome: request.dryRun ? 'dry_run' : 'posted', result: { proposals: [] } };
      },
      async get(p: string) {
        const pattern = matchRoutePattern(p);
        expect(pattern, p).not.toBeNull();
        expect(NAMED_TOOL_READ_ROUTES, p).toContain(pattern);
        expect(agentRouteAllowed(p, 'GET', registryLookup), `an agent may read ${p}`).toBe(true);
        used.add(pattern!);
        if (p === '/api/registers') return { accounts: [{ id: ID, code: '1000', name: 'Checking', type: 'asset' }] };
        if (p === '/api/bank-transactions') return [{ id: ID, date: '2026-01-05T00:00:00.000Z', description: 'x', amount: '-1.00', matched: false, excluded: false }];
        if (p === '/api/reconciliations') return [];
        if (p.startsWith('/api/journal-entries/')) return { entry: { id: ID, lines: [] } };
        return {};
      },
    };
    const args: Record<string, Any> = {
      list_other: { list: 'terms' }, search: { query: 'x' }, get_register: { account: '1000' }, get_journal_entry: { id: ID },
      get_bank_feed: { bank_account_id: ID }, reconcile_status: { bank_account_id: ID }, get_reconciliation: { reconciliation_id: ID },
    };
    for (const t of [...READ_TOOLS, ...WRITE_READ_TOOLS, ...BANKING_READ_TOOLS]) {
      if (t.name === 'get_transaction') continue;
      const r = await call(client, t.name, args[t.name] ?? {});
      expect(r.isError, `${t.name}: ${r.text}`).toBe(false);
    }
    await call(client, 'list_other', { list: 'sales-tax-items' });
    await call(client, 'report_ar_aging', { detail: true });
    await call(client, 'report_ap_aging', { detail: true });
    for (const type of [...TRANSACTION_TYPES, ...LIST_TYPES]) {
      const r = await call(client, 'get_transaction', { type, id: ID });
      expect(r.isError, `get_transaction ${type}: ${r.text}`).toBe(false);
    }
    expect([...used].sort()).toEqual([...NAMED_TOOL_READ_ROUTES].sort());
    // The generic door's own reads (wait_for_decision, the request resource) are the agent's own routes.
    for (const p of ['/api/agent/requests', `/api/agent/requests/${ID}`, '/api/agent/requests/my-own-key']) expect(agentRouteAllowed(p, 'GET', null), p).toBe(true);
    // The only read of the named tools that goes through the action route: bank feed suggestions
    // (the plain route for those may ask an AI service; the action never does). list_my_proposals
    // is now an alias of list_my_requests, a verb (mcp/operations-tools.mjs, test/mcp/operations.test.ts).
    expect(acted.sort()).toEqual(['bank_feed_suggestions']);
    // The tools are the reads, the tools that change the books, the generic door and files, each named once.
    expect(TOOLS.length).toBe(
      READ_TOOLS.length + WRITE_READ_TOOLS.length + BANKING_READ_TOOLS.length + WRITE_TOOLS.length + BANKING_WRITE_TOOLS.length + OPERATION_TOOLS.length + FILE_TOOLS.length,
    );
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    expect(AGENT_ACTION_ROUTE).toBe('/api/agent/actions');
  });

  it('every tool that changes the books sends an action the app has, and the kinds match', async () => {
    const known = new Set(AGENT_ACTIONS.map((a) => a.name));
    const sent: Any[] = [];
    const client = { async act(request: Any) { sent.push(request); return { action: request.action, outcome: 'dry_run' }; }, async get() { throw new Error('a change must not read here'); } };
    const line = { account_id: ID, debit: '1.00' };
    const samples: Record<string, Any> = {
      enter_journal_entry: { date: '2026-01-05', description: 'x', lines: [line, { account_id: ID2, credit: '1.00' }] },
      enter_invoice: { customer_id: ID, date: '2026-01-05', lines: [{ account_id: ID2, quantity: '1', rate: '5' }] },
      enter_sales_receipt: { date: '2026-01-05', lines: [{ account_id: ID2, quantity: '1', rate: '5' }] },
      receive_payment: { customer_id: ID, date: '2026-01-05', method: 'check', amount: '5.00' },
      enter_bill: { vendor_id: ID, date: '2026-01-05', lines: [{ account_id: ID2, amount: '5.00' }] },
      pay_bills: { vendor_id: ID, date: '2026-01-05', method: 'check', payment_account_id: ID2, applications: [{ bill_id: ID, amount_applied: '5.00' }] },
      write_check: { payee_name: 'x', date: '2026-01-05', method: 'check', payment_account_id: ID2, lines: [{ account_id: ID, amount: '5.00' }] },
      make_deposit: { deposit_account_id: ID, date: '2026-01-05', payment_ids: [ID2] },
      transfer_funds: { date: '2026-01-05', from_account_id: ID, to_account_id: ID2, amount: '5.00' },
      add_customer: { name: 'x' },
      add_vendor: { name: 'x' },
      add_account: { name: 'x', account_type: 'Expense' },
      add_item: { name: 'x' },
      add_class: { name: 'x' },
    };
    Object.assign(samples, {
      import_statement_lines: { bank_account_id: ID, statement_kind: 'bank', opening_balance: '0.00', closing_balance: '-1.00', lines: [{ date: '2026-01-05', description: 'x', amount: '-1.00' }] },
      categorize_bank_line: { bank_transaction_id: ID, account_id: ID2 },
      match_bank_line: { bank_transaction_id: ID, journal_entry_id: ID2 },
      unmatch_bank_line: { bank_transaction_id: ID },
      exclude_bank_line: { bank_transaction_id: ID },
      start_reconciliation: { bank_account_id: ID, statement_date: '2026-01-31', statement_balance: '10.00' },
      mark_cleared: { reconciliation_id: ID, line_ids: [ID2] },
      update_reconciliation_statement: { reconciliation_id: ID, statement_balance: '11.00' },
      add_statement_adjustments: { reconciliation_id: ID, service_charge: '1.00', service_charge_account_id: ID2 },
      finish_reconciliation: { reconciliation_id: ID },
      cancel_reconciliation: { reconciliation_id: ID },
      undo_last_reconciliation: { bank_account_id: ID },
    });
    for (const t of [...WRITE_TOOLS, ...BANKING_WRITE_TOOLS]) {
      expect(t.changes, t.name).toBe(true);
      if (samples[t.name]) {
        const r = await call(client, t.name, { ...samples[t.name], dry_run: true });
        expect(r.isError, `${t.name}: ${r.text}`).toBe(false);
      }
    }
    for (const type of TRANSACTION_TYPES) {
      await call(client, 'edit_transaction', { type, id: ID, changes: {}, dry_run: true });
      await call(client, 'void_transaction', { type, id: ID, dry_run: true });
    }
    for (const type of LIST_TYPES) await call(client, 'edit_list_entry', { type, id: ID, changes: {}, dry_run: true });
    for (const type of [...LIST_TYPES, 'class']) await call(client, 'deactivate_list_entry', { type, id: ID, dry_run: true });
    const actions = [...new Set(sent.map((s) => s.action))];
    for (const a of actions) expect(known.has(a), a).toBe(true);
    // Every change the app offers is reachable from a tool (list_my_proposals is a read).
    expect(actions.sort()).toEqual([...known].filter((n) => n !== 'list_my_proposals' && n !== 'bank_feed_suggestions').sort());
    expect([...TRANSACTION_TYPES].sort()).toEqual([...AGENT_TRANSACTION_TYPES].sort());
    expect([...LIST_TYPES, 'class'].sort()).toEqual([...AGENT_LIST_TYPES].sort());
    expect(sent.every((s) => s.dryRun === true && s.requestId === undefined)).toBe(true);
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

describe('tools that change the books', () => {
  function acting(answer: Any = { outcome: 'posted', result: { id: ID } }) {
    const sent: Any[] = [];
    return { sent, client: { async act(request: Any) { sent.push(request); return typeof answer === 'function' ? answer(request) : { action: request.action, ...answer }; }, async get() { throw new Error('unexpected read'); } } };
  }

  it('field names are turned into the app\'s on the way out, at every depth', async () => {
    expect(camelize({ customer_id: ID, due_date: '2026-01-31', lines: [{ account_id: ID2, unit_cost: '4', nothing: null }], is_1099: true })).toEqual({
      customerId: ID,
      dueDate: '2026-01-31',
      lines: [{ accountId: ID2, unitCost: '4' }],
      is1099: true,
    });
    const { client, sent } = acting();
    await call(client, 'enter_bill', {
      vendor_id: ID, bill_number: 'B-1', date: '2026-01-05', due_date: '2026-02-04', allow_duplicate_number: true,
      lines: [{ account_id: ID2, amount: '40.00', description: 'Paper', customer_id: ID }], request_id: 'bill-b1',
    });
    expect(sent[0]).toEqual({
      action: 'enter_bill',
      requestId: 'bill-b1',
      input: { vendorId: ID, billNumber: 'B-1', date: '2026-01-05', dueDate: '2026-02-04', allowDuplicateNumber: true, lines: [{ accountId: ID2, amount: '40.00', description: 'Paper', customerId: ID }] },
    });
    await call(client, 'add_customer', { name: 'Acme', company_name: 'Acme Inc', request_id: 'c-1' });
    expect(sent[1].input).toEqual({ displayName: 'Acme', companyName: 'Acme Inc' });
    await call(client, 'add_account', { name: 'Tools', account_type: 'Expense', number: '6350', request_id: 'a-1' });
    expect(sent[2].input).toEqual({ name: 'Tools', qbType: 'Expense', code: '6350' });
    await call(client, 'add_vendor', { name: 'Paper Co', is_1099: true, default_expense_account_id: ID, request_id: 'v-1' });
    expect(sent[3].input).toEqual({ displayName: 'Paper Co', is1099: true, defaultExpenseAccountId: ID });
    await call(client, 'receive_payment', { customer_id: ID, date: '2026-01-05', method: 'ach', amount: '10.00', applications: [{ invoice_id: ID2, amount_applied: '9.00', discount_amount: '1.00' }], request_id: 'p-1' });
    expect(sent[4].input.applications).toEqual([{ invoiceId: ID2, amountApplied: '9.00', discountAmount: '1.00' }]);
  });

  it('a dry run needs no request id; anything kept does, and is refused here without one', async () => {
    const { client, sent } = acting({ outcome: 'dry_run' });
    const args = { date: '2026-01-05', from_account_id: ID, to_account_id: ID2, amount: '5.00' };
    expect((await call(client, 'transfer_funds', { ...args, dry_run: true })).isError).toBe(false);
    expect(sent[0]).toEqual({ action: 'transfer_funds', dryRun: true, input: { date: '2026-01-05', fromAccountId: ID, toAccountId: ID2, amount: '5.00' } });
    const none = await call(client, 'transfer_funds', args);
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/Give a request_id/);
    const bad = await call(client, 'transfer_funds', { ...args, request_id: 'has spaces' });
    expect(bad.text).toMatch(/"request_id" must be 3 to 120 letters/);
    expect(sent).toHaveLength(1);
  });

  it('checks what it can before anything is sent', async () => {
    const { client, sent } = acting();
    const cases: Array<[string, Any, RegExp]> = [
      ['enter_journal_entry', { date: '2026-01-05', description: 'x', lines: [{ account_id: ID, debit: '1.00' }] }, /"lines" needs at least 2 entries/],
      ['enter_journal_entry', { date: '2026-01-05', description: 'x', lines: [{ debit: '1.00' }, { account_id: ID, credit: '1.00' }] }, /"lines"\[1\]\.account_id is required/],
      ['enter_journal_entry', { date: '2026-01-05', description: 'x', lines: [{ account_id: ID, debit: 1 }, { account_id: ID, credit: '1.00' }] }, /"lines"\[1\]\.debit must be text/],
      ['enter_journal_entry', { date: '2026-01-05', description: 'x', lines: [{ account_id: ID, debit: '1.005' }, { account_id: ID, credit: '1.00' }] }, /must be an amount like 1250\.00/],
      ['enter_journal_entry', { date: '2026-01-05', description: 'x', lines: [{ account_id: ID, debit: '1.00', company_id: ID }, { account_id: ID, credit: '1.00' }] }, /"lines"\[1\] has an unknown field "company_id"/],
      ['enter_invoice', { customer_id: ID, date: '01/05/2026', lines: [{ quantity: '1' }] }, /"date" must be a date as YYYY-MM-DD/],
      ['pay_bills', { vendor_id: ID, date: '2026-01-05', method: 'wire', payment_account_id: ID, applications: [{ bill_id: ID, amount_applied: '1.00' }] }, /"method" must be one of/],
      ['pay_bills', { vendor_id: ID, date: '2026-01-05', method: 'check', payment_account_id: ID, applications: [] }, /"applications" needs at least 1 entry/],
      ['void_transaction', { type: 'paycheck', id: ID }, /"type" must be one of/],
      ['edit_transaction', { type: 'invoice', id: ID }, /"changes" is required/],
      ['edit_transaction', { type: 'invoice', id: ID, changes: 'x' }, /"changes" must be an object/],
      ['add_customer', { name: 'x', is_admin: true }, /Unknown argument "is_admin"/],
    ];
    for (const [name, args, message] of cases) {
      const r = await call(client, name, { ...args, request_id: 'check-1' });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text, name).toMatch(message);
    }
    expect(sent).toEqual([]);
  });

  it('edit, void and make-inactive name the kind, the record and the version last read', async () => {
    const { client, sent } = acting();
    await call(client, 'edit_transaction', { type: 'check', id: ID, expected_updated_at: '2026-01-05T10:00:00.000Z', changes: { payee_name: 'x', payment_account_id: ID2, lines: [{ account_id: ID, amount: '1.00' }] }, request_id: 'e-1' });
    expect(sent[0]).toEqual({ action: 'edit_check', requestId: 'e-1', input: { id: ID, expectedUpdatedAt: '2026-01-05T10:00:00.000Z', changes: { payeeName: 'x', paymentAccountId: ID2, lines: [{ accountId: ID, amount: '1.00' }] } } });
    await call(client, 'void_transaction', { type: 'bill_payment', id: ID, request_id: 'v-1' });
    expect(sent[1]).toEqual({ action: 'void_bill_payment', requestId: 'v-1', input: { id: ID } });
    await call(client, 'edit_list_entry', { type: 'vendor', id: ID, changes: { name: 'New Name', is_1099: false }, request_id: 'l-1' });
    expect(sent[2].input).toEqual({ id: ID, changes: { displayName: 'New Name', is1099: false } });
    await call(client, 'edit_list_entry', { type: 'account', id: ID, changes: { name: 'Renamed', account_type: 'Other Expense' }, request_id: 'l-2' });
    expect(sent[3].input.changes).toEqual({ name: 'Renamed', qbType: 'Other Expense' });
    await call(client, 'deactivate_list_entry', { type: 'class', id: ID, request_id: 'd-1' });
    expect(sent[4]).toEqual({ action: 'deactivate_class', requestId: 'd-1', input: { id: ID } });
    await call(client, 'deactivate_list_entry', { type: 'customer', id: ID, expected_updated_at: '2026-01-05T10:00:00.000Z', request_id: 'd-2' });
    expect(sent[5].input).toEqual({ id: ID, expectedUpdatedAt: '2026-01-05T10:00:00.000Z' });
  });

  it('the answer says in plain words whether anything was entered', () => {
    const ledger = { entries: [{ journalEntryId: ID, date: '2026-01-05', description: 'Rent', lines: [{ accountCode: '6400', accountName: 'Rent', debit: '100.00', credit: null, memo: 'Jan' }, { accountCode: '1000', accountName: 'Checking', debit: null, credit: '100.00', memo: null }] }], changes: [] };
    const lines = [{ account: '6400 Rent', debit: '100.00', credit: null, memo: 'Jan' }, { account: '1000 Checking', debit: null, credit: '100.00' }];
    expect(shapeAnswer({ action: 'write_check', outcome: 'dry_run', summary: 'Check', result: { id: ID }, ledger, note: 'Nothing was entered.' })).toEqual({
      outcome: 'dry_run',
      said: 'Not entered. This is what it would do.',
      summary: 'Check',
      result: { id: ID },
      would_post: [{ journal_entry_id: ID, date: '2026-01-05', description: 'Rent', lines }],
      note: 'Nothing was entered.',
    });
    expect(shapeAnswer({ outcome: 'posted', result: { id: ID }, ledger })).toMatchObject({ outcome: 'posted', said: 'Entered.', ledger: [{ journal_entry_id: ID, lines }] });
    expect(shapeAnswer({ outcome: 'posted', result: { id: ID }, ledger: { entries: [], changes: [] } })).toEqual({ outcome: 'posted', said: 'Entered.', result: { id: ID } });
    expect(shapeAnswer({ outcome: 'proposed', proposalId: ID2, ledger })).toMatchObject({ outcome: 'proposed', said: 'Not entered. Waiting for a person to approve it in Ironbooks.', proposal_id: ID2 });
    expect(shapeAnswer({ outcome: 'posted', replayed: true, result: { id: ID } })).toMatchObject({ repeated: true, note_repeat: expect.stringMatching(/Nothing was entered again/) });
  });

  it('asked: nothing entered yet, who decides, and wait_for_decision with the request id', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: 'closedPeriod', flags: ['closedPeriod'], secrets: ['closing_password'], twoPerson: true, grantable: 'no' };
    const ledger = { entries: [{ journalEntryId: ID, date: '2026-01-05', description: 'x', lines: [{ accountCode: '6400', accountName: 'Rent', debit: '5.00', credit: null }] }], changes: [] };
    const { client } = acting({ outcome: 'asked', requestId: ID2, status: 'pending', needs, ledger, summary: 'Transfer $5.00' });
    const r = await call(client, 'transfer_funds', { date: '2026-01-05', from_account_id: ID, to_account_id: ID2, amount: '5.00', request_id: 't-ask' });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ outcome: 'asked', said: 'Not done yet. A person must approve it in Ironbooks first.', request_id: ID2, status: 'pending', summary: 'Transfer $5.00' });
    expect(r.data.would_post[0].lines).toEqual([{ account: '6400 Rent', debit: '5.00', credit: null }]);
    expect(r.data).not.toHaveProperty('ledger');
    expect(r.data.next).toMatch(new RegExp(`wait_for_decision with request_id "${ID2}"`));
    expect(r.data.next).toMatch(/Do not send this request again/);
    expect(r.data.who_decides).toMatch(/may work in the closed period must approve it/);
    expect(r.data.who_decides).toMatch(/Two different people/);
    expect(r.data.who_decides).toMatch(/type the closing-date password on their own screen; you never see it, and must not ask for it/);
  });

  it('needs_confirmation: the warning, the field that accepts it, and to resend with a new request id', async () => {
    const warnings = [{ flag: 'allowDuplicateNumber', message: 'Bill B-1 from Paper Co is already entered.' }, { flag: 'allowReconciledEdit', message: 'It is reconciled.' }];
    const { client } = acting({ operation: 'bills.create', outcome: 'needs_confirmation', warnings });
    const r = await call(client, 'enter_bill', { vendor_id: ID, bill_number: 'B-1', date: '2026-01-05', lines: [{ account_id: ID2, amount: '1.00' }], request_id: 'b-dup' });
    expect(r.isError).toBe(false);
    expect(r.data.said).toMatch(/Not done. Ironbooks raised a warning/);
    expect(r.data.warnings).toEqual([
      // enter_bill has a field for this one ...
      { flag: 'allowDuplicateNumber', message: 'Bill B-1 from Paper Co is already entered.', resend_with: 'allow_duplicate_number: true' },
      // ... and not for this one: the generic door takes it.
      { flag: 'allowReconciledEdit', message: 'It is reconciled.', resend_with: 'run_operation with operation "bills.create" and confirm: ["allowReconciledEdit"]' },
    ]);
    expect(r.data.next).toMatch(/Only if it is right to go ahead/);
    expect(r.data.next).toMatch(/NEW request_id/);
    expect(r.data.next).toMatch(/Otherwise stop/);
  });

  it('refused: a tool error that says nothing was done and not to send it again', async () => {
    const { client } = acting({ outcome: 'refused', note: 'An Admin has not allowed agents to enter bills' });
    const r = await call(client, 'enter_bill', { vendor_id: ID, date: '2026-01-05', lines: [{ account_id: ID2, amount: '1.00' }], request_id: 'b-no' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Refused: An Admin has not allowed agents to enter bills. Nothing was done. Do not send it again as it is. get_my_permissions shows what you may do; if the work still needs doing, tell the person what you wanted to do and why.',
    );
    // The banking tools answer the same way.
    const b = await call(client, 'match_bank_line', { bank_transaction_id: ID, journal_entry_id: ID2, request_id: 'm-no' });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/^Refused: An Admin has not allowed agents to enter bills\. Nothing was done\./);
  });

  it('a preview from the generic door: changes, what leaves the computer, what is lost, the file made', () => {
    const preview = {
      ledger: null,
      records: [{ action: 'update', kind: 'invoice', id: ID, fields: [{ field: 'memo', before: 'a', after: 'b' }] }],
      effects: [{ kind: 'email', summary: 'Email to billing@acme.test: Invoice 1042', detail: {} }],
      warnings: [],
      loss: 'Invoice 1042 is gone for good.',
      routePreview: null,
      truncated: false,
    };
    expect(shapeAnswer({ outcome: 'dry_run', preview }, { fields: 'confirm' })).toEqual({
      outcome: 'dry_run',
      said: 'Not entered. This is what it would do.',
      would_post: [],
      would_change: [{ kind: 'invoice', id: ID, action: 'update', fields: [{ field: 'memo', before: 'a', after: 'b' }] }],
      would_also: ['Email to billing@acme.test: Invoice 1042'],
      loss: 'Invoice 1042 is gone for good.',
    });
    const posted = shapeAnswer({
      outcome: 'posted',
      result: { ok: true },
      file: { fileId: 'f'.repeat(32), name: 'Invoice 1042.pdf', type: 'application/pdf', size: 1200 },
      effects: [{ effect: preview.effects[0], status: 'failed', error: 'The mail server refused it.', ranDuringOperation: false }],
      grantId: ID2,
    });
    expect(posted).toMatchObject({
      file: { file_id: 'f'.repeat(32), name: 'Invoice 1042.pdf', type: 'application/pdf', size: 1200 },
      also_done: [{ what: 'Email to billing@acme.test: Invoice 1042', status: 'failed', error: 'The mail server refused it.' }],
      under_standing_permission: ID2,
    });
    expect(posted.next).toMatch(/get_file with file_id "f{32}"/);
    expect(shapeAnswer({ outcome: 'needs_confirmation', warnings: [{ flag: 'allowZero', message: 'x' }] }, { fields: 'confirm' }).warnings[0].resend_with).toBe('confirm: ["allowZero"]');
    expect(shapeAnswer({ outcome: 'done' }).said).toBe('Done. Nothing was posted to the ledger.');
  });

  it('a refusal from Ironbooks reaches the agent as it was said', async () => {
    const client = { async act() { throw new IronbooksError('The books are closed through 2026-01-31. Transactions dated on or before the closing date require the closing-date password (or clear the closing date in Settings).', { status: 400, code: 'PERIOD_CLOSED' }); } };
    const r = await call(client, 'transfer_funds', { date: '2026-01-05', from_account_id: ID, to_account_id: ID2, amount: '5.00', request_id: 't-1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^The books are closed through 2026-01-31/);
  });

  it('a record is read back in the tools\' own words, without internal fields', async () => {
    expect(shapeRecord({ id: ID, companyId: 'c', refNumber: '1001', date: '2026-01-05T00:00:00.000Z', dueDate: '2026-02-04T00:00:00.000Z', updatedAt: '2026-01-05T15:04:05.123Z', postedEntryId: ID2, memo: '', customFields: {}, lines: [{ id: 'l1', accountId: ID, unitCost: '4.5', createdAt: 'x' }] })).toEqual({
      id: ID,
      ref_number: '1001',
      date: '2026-01-05',
      due_date: '2026-02-04',
      updated_at: '2026-01-05T15:04:05.123Z',
      journal_entry_id: ID2,
      lines: [{ id: 'l1', account_id: ID, unit_cost: '4.5' }],
    });
    const { client, calls } = recorder({ '/api/expenses/*': { id: ID, total: '25.00', updatedAt: '2026-01-05T15:04:05.123Z', lines: [{ accountId: ID2, amount: '25.00' }] }, '/api/items/*': { item: { id: ID, name: 'Widget', type: 'inventory', editedAt: '2026-01-05T15:04:05.123Z' } } });
    const check = await call(client, 'get_transaction', { type: 'check', id: ID });
    expect(calls[0].path).toBe(`/api/expenses/${ID}`);
    expect(check.data).toEqual({ kind: 'check', id: ID, total: '25.00', updated_at: '2026-01-05T15:04:05.123Z', lines: [{ account_id: ID2, amount: '25.00' }] });
    const item = await call(client, 'get_transaction', { type: 'item', id: ID });
    expect(item.data).toMatchObject({ kind: 'item', type: 'inventory', name: 'Widget', edited_at: '2026-01-05T15:04:05.123Z' });
    expect((await call(client, 'get_transaction', { type: 'paycheck', id: ID })).isError).toBe(true);
  });

  it('list_invoices and list_bills ask with the app\'s filters and can keep only what is unpaid', async () => {
    const { client, calls } = recorder({
      '/api/invoices': [
        { id: ID, refNumber: '1001', invoiceNumber: 7, customerId: ID2, date: '2026-01-05T00:00:00.000Z', dueDate: '2026-02-04T00:00:00.000Z', total: '100.00', balanceDue: '40.00', status: 'partial' },
        { id: ID2, refNumber: null, invoiceNumber: 8, customerId: ID2, date: '2026-01-06T00:00:00.000Z', dueDate: null, total: '50.00', balanceDue: '0.00', status: 'paid' },
      ],
      '/api/bills': [{ id: ID, billNumber: 'PS-1', vendorId: ID2, date: '2026-01-05T00:00:00.000Z', total: '10.00', balanceDue: '10.00', status: 'open' }, { id: ID2, billNumber: null, vendorId: ID2, date: '2026-01-05T00:00:00.000Z', total: '10.00', balanceDue: '10.00', status: 'void' }],
    });
    const all = await call(client, 'list_invoices', { customer_id: ID2, status: 'partial' });
    expect(calls[0]).toEqual({ path: '/api/invoices', query: { customerId: ID2, status: 'partial' } });
    expect(all.data.invoices[0]).toEqual({ id: ID, number: '1001', customer_id: ID2, date: '2026-01-05', due_date: '2026-02-04', total: '100.00', balance_due: '40.00', status: 'partial' });
    expect(all.data.invoices[1].number).toBe('8');
    expect((await call(client, 'list_invoices', { unpaid_only: true })).data.invoices.map((i: Any) => i.id)).toEqual([ID]);
    const bills = await call(client, 'list_bills', { vendor_id: ID2, unpaid_only: true });
    expect(calls[2]).toEqual({ path: '/api/bills', query: { vendorId: ID2 } });
    expect(bills.data.bills.map((b: Any) => b.number)).toEqual(['PS-1']);
  });
});

describe('statements and reconciliation', () => {
  function acting(answer: Any = { outcome: 'done', result: {} }) {
    const sent: Any[] = [];
    return { sent, client: { async act(request: Any) { sent.push(request); return { action: request.action, ...answer }; }, async get() { throw new Error('unexpected read'); } } };
  }

  it('import_statement_lines sends the statement as the app expects it', async () => {
    const { client, sent } = acting({ outcome: 'done', result: { added_to_feed: 2 } });
    const out = await call(client, 'import_statement_lines', {
      bank_account_id: ID, statement_kind: 'card', opening_balance: '-100.00', closing_balance: '-145.10', filename: 'Card 2026-01',
      lines: [{ date: '2026-01-05', description: 'COFFEE', amount: '-45.10', payee: 'Cafe' }], request_id: 'imp-1',
    });
    expect(sent[0]).toEqual({
      action: 'import_statement_lines',
      requestId: 'imp-1',
      input: { bankAccountId: ID, kind: 'card', openingBalance: '-100.00', closingBalance: '-145.10', filename: 'Card 2026-01', rows: [{ date: '2026-01-05', description: 'COFFEE', amount: '-45.10', payee: 'Cafe' }] },
    });
    expect(out.data).toMatchObject({ outcome: 'done', said: 'Done. Nothing was posted to the ledger.', result: { added_to_feed: 2 } });
    for (const [args, message] of [
      [{ lines: [] }, /"lines" needs at least 1 entry/],
      [{ lines: [{ date: '2026-01-05', description: 'x', amount: 45.1 }] }, /"lines"\[1\]\.amount must be text/],
      [{ lines: [{ date: '2026-01-05', description: 'x', amount: '$45.10' }] }, /must be an amount like -45\.10/],
      [{ statement_kind: 'savings' }, /"statement_kind" must be one of/],
    ] as Array<[Any, RegExp]>) {
      const r = await call(client, 'import_statement_lines', { bank_account_id: ID, statement_kind: 'bank', opening_balance: '0.00', closing_balance: '1.00', lines: [{ date: '2026-01-05', description: 'x', amount: '1.00' }], request_id: 'imp-2', ...args });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(message);
    }
    expect(sent).toHaveLength(1);
  });

  it('the reconcile tools name the session, the lines and the amounts', async () => {
    const { client, sent } = acting();
    await call(client, 'start_reconciliation', { bank_account_id: ID, statement_date: '2026-01-31', statement_balance: '-12.50', request_id: 'r-1' });
    expect(sent[0].input).toEqual({ bankAccountId: ID, statementDate: '2026-01-31', statementBalance: '-12.50' });
    await call(client, 'mark_cleared', { reconciliation_id: ID, line_ids: [ID2], request_id: 'r-2' });
    expect(sent[1]).toEqual({ action: 'set_cleared', requestId: 'r-2', input: { reconciliationId: ID, journalEntryLineIds: [ID2], isCleared: true } });
    await call(client, 'mark_cleared', { reconciliation_id: ID, line_ids: [ID2], cleared: false, dry_run: true });
    expect(sent[2]).toEqual({ action: 'set_cleared', dryRun: true, input: { reconciliationId: ID, journalEntryLineIds: [ID2], isCleared: false } });
    await call(client, 'add_statement_adjustments', { reconciliation_id: ID, service_charge: '12.00', service_charge_account_id: ID2, interest_earned: '1.00', interest_account_id: ID, request_id: 'r-3' });
    expect(sent[3].input).toEqual({ reconciliationId: ID, serviceCharge: { amount: '12.00', accountId: ID2 }, interestEarned: { amount: '1.00', accountId: ID } });
    expect((await call(client, 'add_statement_adjustments', { reconciliation_id: ID, service_charge: '12.00', request_id: 'r-4' })).text).toMatch(/Give the account each amount goes to/);
    expect((await call(client, 'add_statement_adjustments', { reconciliation_id: ID, request_id: 'r-5' })).text).toMatch(/Give a service charge, interest earned, or both/);
    await call(client, 'undo_last_reconciliation', { bank_account_id: ID, expect_statement_date: '2026-01-31', request_id: 'r-6' });
    expect(sent[4]).toEqual({ action: 'undo_last_reconciliation', requestId: 'r-6', input: { bankAccountId: ID, expectStatementDate: '2026-01-31' } });
    expect(sent).toHaveLength(5);
  });

  it('get_bank_feed joins each line with its suggestion and its possible matches', async () => {
    const acted: Any[] = [];
    const client = {
      async act(request: Any) {
        acted.push(request);
        return { result: { suggestions: [{ bank_transaction_id: ID, account_id: ID2, account: 'Office Supplies', payee: 'Depot', confidence: 80, reason: 'You used this account for this payee 4 times.', rule: null }] } };
      },
      async get(p: string, query: Any) {
        if (p === '/api/bank-transactions') {
          expect(query).toMatchObject({ bankAccountId: ID, filter: 'unreviewed' });
          return [
            { id: ID, date: '2026-01-05T00:00:00.000Z', description: 'OFFICE DEPOT', payee: null, amount: '-30.00', matched: false, excluded: false, matchedEntryId: null },
            { id: ID2, date: '2026-01-06T00:00:00.000Z', description: 'CHECK 1001', payee: 'City', amount: '-200.00', matched: false, excluded: false, matchedEntryId: null },
          ];
        }
        if (p === '/api/bank-transactions/matches') return { matches: { [ID2]: [{ entryId: ID, date: '2026-01-05T00:00:00.000Z', description: 'Check', reference: '1001', amount: '-200.00', confidence: 'high', score: 9 }] } };
        throw new Error(`unexpected ${p}`);
      },
    };
    const out = await call(client, 'get_bank_feed', { bank_account_id: ID });
    expect(acted).toEqual([{ action: 'bank_feed_suggestions', input: { bankAccountId: ID } }]);
    expect(out.data).toEqual({
      count: 2,
      lines: [
        { bank_transaction_id: ID, date: '2026-01-05', description: 'OFFICE DEPOT', payee: null, amount: '-30.00', status: 'to_review', suggested_account_id: ID2, suggested_account: 'Office Supplies', why: 'You used this account for this payee 4 times.', confidence: 80 },
        { bank_transaction_id: ID2, date: '2026-01-06', description: 'CHECK 1001', payee: 'City', amount: '-200.00', status: 'to_review', possible_matches: [{ journal_entry_id: ID, date: '2026-01-05', description: 'Check', number: '1001', amount: '-200.00', confidence: 'high' }] },
      ],
    });
  });

  it('get_reconciliation says whether it can be finished', async () => {
    const { client } = recorder({
      [`/api/reconciliations/${ID}`]: { reconciliationId: ID, statementBalance: '759.00', clearedBalance: '759.00', difference: '0.00' },
      '/api/reconciliations/*': [
        { journalEntryLineId: ID2, journalEntryId: ID, date: '2026-05-02T00:00:00.000Z', description: 'Transfer', reference: null, debit: '1000.00', credit: null, isCleared: true },
        { journalEntryLineId: ID, journalEntryId: ID2, date: '2026-05-05T00:00:00.000Z', description: 'Check', reference: '1001', debit: null, credit: '200.00', isCleared: false },
      ],
    });
    const out = await call(client, 'get_reconciliation', { reconciliation_id: ID });
    expect(out.data).toMatchObject({ statement_balance: '759.00', cleared_balance: '759.00', difference: '0.00', can_finish: true, line_count: 2 });
    expect(out.data.lines[1]).toEqual({ line_id: ID, journal_entry_id: ID2, date: '2026-05-05', number: '1001', description: 'Check', debit: null, credit: '200.00', cleared: false });
    expect((await call(client, 'get_reconciliation', { reconciliation_id: ID, only_uncleared: true })).data.lines).toHaveLength(1);
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
