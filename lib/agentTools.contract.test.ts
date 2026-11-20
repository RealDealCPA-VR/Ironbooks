/**
 * Agent access, end to end without a network: every tool of the MCP server (mcp/tools.mjs) runs
 * against the REAL route handler it calls, as an agent would reach it: through getServerContext
 * with a token, the view-only role and the read-only database handle (lib/agentContext.ts).
 *
 * This is the test that proves two things at once:
 *  - the routes on the agent list really are reads: each one answers through a handle that
 *    refuses every write, and the books are byte-for-byte unchanged afterwards;
 *  - each tool and its route agree: the fields a tool reads are the fields the route returns.
 *
 * The client here stands in for mcp/client.mjs (tested on its own in test/mcp/client.test.ts): it
 * turns a tool's GET into a call of the route handler, stamped the way middleware stamps it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-tools');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-tools-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;

import { getDb, closeDb, type DB } from '@/lib/db';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER, matchRoutePattern } from '@/lib/permissions/routes';
import { AGENT_READ_ROUTES } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { createAgent } from '@/lib/services/agents';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import type { ServiceContext } from '@/lib/services/_base';
import { createServer } from '../mcp/protocol.mjs';
import { IronbooksError } from '../mcp/client.mjs';
import { TOOLS } from '../mcp/tools.mjs';

import { GET as whoami } from '@/app/api/agent/whoami/route';
import { GET as accounts } from '@/app/api/accounts/route';
import { GET as customers } from '@/app/api/customers/route';
import { GET as vendors } from '@/app/api/vendors/route';
import { GET as items } from '@/app/api/items/route';
import { GET as classes } from '@/app/api/classes/route';
import { GET as employees } from '@/app/api/employees/route';
import { GET as lists } from '@/app/api/lists/[list]/route';
import { GET as taxRates } from '@/app/api/tax-rates/route';
import { GET as search } from '@/app/api/search/route';
import { GET as find } from '@/app/api/find/route';
import { GET as registers } from '@/app/api/registers/route';
import { GET as register } from '@/app/api/registers/[accountId]/route';
import { GET as journalEntry } from '@/app/api/journal-entries/[id]/route';
import { GET as stdReport } from '@/app/api/reports/std/[report]/route';
import { GET as invoicesList } from '@/app/api/invoices/route';
import { GET as invoiceOne } from '@/app/api/invoices/[id]/route';
import { GET as salesReceiptOne } from '@/app/api/sales-receipts/[id]/route';
import { GET as paymentOne } from '@/app/api/payments/[id]/route';
import { GET as billsList } from '@/app/api/bills/route';
import { GET as billOne } from '@/app/api/bills/[id]/route';
import { GET as billPaymentOne } from '@/app/api/bill-payments/[id]/route';
import { GET as expenseOne } from '@/app/api/expenses/[id]/route';
import { GET as depositOne } from '@/app/api/deposits/[id]/route';
import { GET as undeposited } from '@/app/api/deposits/undeposited/route';
import { GET as transferOne } from '@/app/api/transfers/[id]/route';
import { GET as customerOne } from '@/app/api/customers/[id]/route';
import { GET as vendorOne } from '@/app/api/vendors/[id]/route';
import { GET as accountOne } from '@/app/api/accounts/[id]/route';
import { GET as itemOne } from '@/app/api/items/[id]/route';
import { GET as bankAccountsList } from '@/app/api/bank-accounts/route';
import { GET as bankFeed } from '@/app/api/bank-transactions/route';
import { GET as bankMatches } from '@/app/api/bank-transactions/matches/route';
import { GET as reconciliationsList } from '@/app/api/reconciliations/route';
import { GET as reconciliationOne } from '@/app/api/reconciliations/[id]/route';
import { GET as reconciliationClearable } from '@/app/api/reconciliations/[id]/clearable/route';
import { GET as reconciliationInfo } from '@/app/api/reconciliations/info/route';
import { createBankAccount } from '@/lib/services/bankAccounts';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';
import { AGENT_ACTION_ROUTE } from '@/lib/permissions/agentAccess';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  '/api/agent/whoami': whoami as unknown as Handler,
  '/api/accounts': accounts as unknown as Handler,
  '/api/customers': customers as unknown as Handler,
  '/api/vendors': vendors as unknown as Handler,
  '/api/items': items as unknown as Handler,
  '/api/classes': classes as unknown as Handler,
  '/api/employees': employees as unknown as Handler,
  '/api/lists/[list]': lists as unknown as Handler,
  '/api/tax-rates': taxRates as unknown as Handler,
  '/api/search': search as unknown as Handler,
  '/api/find': find as unknown as Handler,
  '/api/registers': registers as unknown as Handler,
  '/api/registers/[accountId]': register as unknown as Handler,
  '/api/journal-entries/[id]': journalEntry as unknown as Handler,
  '/api/reports/std/[report]': stdReport as unknown as Handler,
  '/api/invoices': invoicesList as unknown as Handler,
  '/api/invoices/[id]': invoiceOne as unknown as Handler,
  '/api/sales-receipts/[id]': salesReceiptOne as unknown as Handler,
  '/api/payments/[id]': paymentOne as unknown as Handler,
  '/api/bills': billsList as unknown as Handler,
  '/api/bills/[id]': billOne as unknown as Handler,
  '/api/bill-payments/[id]': billPaymentOne as unknown as Handler,
  '/api/expenses/[id]': expenseOne as unknown as Handler,
  '/api/deposits/[id]': depositOne as unknown as Handler,
  '/api/deposits/undeposited': undeposited as unknown as Handler,
  '/api/transfers/[id]': transferOne as unknown as Handler,
  '/api/customers/[id]': customerOne as unknown as Handler,
  '/api/vendors/[id]': vendorOne as unknown as Handler,
  '/api/accounts/[id]': accountOne as unknown as Handler,
  '/api/items/[id]': itemOne as unknown as Handler,
  '/api/bank-accounts': bankAccountsList as unknown as Handler,
  '/api/bank-transactions': bankFeed as unknown as Handler,
  '/api/bank-transactions/matches': bankMatches as unknown as Handler,
  '/api/reconciliations': reconciliationsList as unknown as Handler,
  '/api/reconciliations/[id]': reconciliationOne as unknown as Handler,
  '/api/reconciliations/[id]/clearable': reconciliationClearable as unknown as Handler,
  '/api/reconciliations/info': reconciliationInfo as unknown as Handler,
};

let db: DB;
let rich: RichCompany;
let admin: ServiceContext;
/** Every route pattern the tools reached. */
const reached = new Set<string>();

/** Stands in for mcp/client.mjs: a tool's GET becomes a call of the real route handler. */
function clientFor(token: string) {
  return {
    async get(apiPath: string, query: Record<string, unknown> = {}) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      const pattern = matchRoutePattern(apiPath);
      const handler = pattern ? ROUTES[pattern] : undefined;
      if (!pattern || !handler) throw new Error(`a tool called ${apiPath}, which is not on the agent route list`);
      reached.add(pattern);
      const names = [...pattern.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      const psegs = pattern.split('/');
      const segs = apiPath.split('/');
      const params = Object.fromEntries(names.map((n) => [n, decodeURIComponent(segs[psegs.indexOf(`[${n}]`)])]));
      // What middleware does: stamp the path and method it observed.
      h.cookies.clear();
      h.headers.clear();
      h.headers.set(ROUTE_PATH_HEADER, apiPath);
      h.headers.set(ROUTE_METHOD_HEADER, 'GET');
      h.headers.set('host', 'localhost:45123');
      h.headers.set('authorization', `Bearer ${token}`);
      const url = `http://localhost:45123${apiPath}${qs.toString() ? `?${qs}` : ''}`;
      const res = await handler(new NextRequest(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve(params) });
      const body = await res.json().catch(() => null);
      if (res.status >= 200 && res.status < 300) return body;
      throw new IronbooksError(body?.error || `refused (${res.status})`, { status: res.status, code: body?.code });
    },
    /** A change, a dry run or a guarded read: the one POST, to the real action route. */
    async act(request: Record<string, unknown>) {
      h.cookies.clear();
      h.headers.clear();
      h.headers.set(ROUTE_PATH_HEADER, AGENT_ACTION_ROUTE);
      h.headers.set(ROUTE_METHOD_HEADER, 'POST');
      h.headers.set('host', 'localhost:45123');
      h.headers.set('authorization', `Bearer ${token}`);
      const res = await actionsPOST(
        new NextRequest(`http://localhost:45123${AGENT_ACTION_ROUTE}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) }),
      );
      const body = await res.json().catch(() => null);
      if (res.status >= 200 && res.status < 300) return body;
      throw new IronbooksError(body?.error || `refused (${res.status})`, { status: res.status, code: body?.code });
    },
  };
}

type Out = Record<string, any>;
async function run(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: Out; text: string }> {
  const server = createServer({ tools: TOOLS, client: clientFor(token), serverInfo: { name: 't', version: '0' } });
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as Out;
  expect(res.error, `${name}: ${JSON.stringify(res.error)}`).toBeUndefined();
  const text: string = res.result.content[0].text;
  let data: Out = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* an error message, not JSON */
  }
  return { ok: res.result.isError === false, data, text };
}
async function ok(token: string, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const r = await run(token, name, args);
  expect(r.ok, `${name} failed: ${r.text}`).toBe(true);
  return r.data;
}

/** A fingerprint of the books: every table's row count, the audit trail and the transaction log. */
async function fingerprint() {
  const tables = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const r = (await db.execute(sql.raw(`select count(*)::int as n from "${table_name}"`))) as unknown as { rows: Array<{ n: number }> };
    counts[table_name] = r.rows[0].n;
  }
  const journal = (await db.execute(sql`select coalesce(sum(debit),0)::text as d, count(*)::int as n from journal_entry_lines`)) as unknown as { rows: Array<{ d: string; n: number }> };
  return { counts, journal: journal.rows[0], log: readAllTransactionLog(TEST_DIR).records.length };
}

let bookkeeper: string;
let poster: string;
let proposer: string;
let reportsOnly: string;
let payroll: string;
let before: Awaited<ReturnType<typeof fingerprint>>;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  db = await getDb(TEST_DIR);
  rich = await seedRichCompany(db, TEST_DIR, 'Tools Co');
  admin = { ...rich.ctx, role: 'owner', access: fullAccess() };
  bookkeeper = (await createAgent(admin, { name: 'Bookkeeper agent', roleKeys: ['bookkeeper'], mode: 'read_only' })).token;
  reportsOnly = (await createAgent(admin, { name: 'Reports agent', roleKeys: ['reports_only'], mode: 'read_only' })).token;
  payroll = (await createAgent(admin, { name: 'Payroll agent', roleKeys: ['payroll_processor'], mode: 'read_only' })).token;
  poster = (await createAgent(admin, { name: 'Posting agent', roleKeys: ['full_access'], mode: 'post' })).token;
  proposer = (await createAgent(admin, { name: 'Proposing agent', roleKeys: ['bookkeeper'], mode: 'propose' })).token;
  // A person signs in to the file: agents may work from here on.
  h.cookies.clear();
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/accounts');
  h.headers.set(ROUTE_METHOD_HEADER, 'GET');
  h.cookies.set(SESSION_COOKIE, createSessionToken(rich.ctx.userId!));
  h.cookies.set(COMPANY_COOKIE, rich.ctx.companyId);
  await getServerContext();
  before = await fingerprint();
}, 180_000);

afterAll(async () => {
  resetAgentEndpointState();
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('every tool, against the real route, as an agent', () => {
  it('get_company_info', async () => {
    const info = await ok(bookkeeper, 'get_company_info');
    expect(info.agent).toMatchObject({ name: 'Bookkeeper agent', modeLabel: 'Read only', canChangeBooks: false, roles: ['Bookkeeper'] });
    expect(info.company).toMatchObject({ name: 'Tools Co', reportBasis: 'accrual' });
    expect(info.company.homeCurrency).toBe('USD');
  });

  it('list_accounts: the chart of accounts with balances, filtered', async () => {
    const all = await ok(bookkeeper, 'list_accounts');
    expect(all.count).toBeGreaterThan(20);
    const checking = all.accounts.find((a: Out) => a.number === '1000');
    expect(checking).toMatchObject({ name: expect.any(String), active: true });
    expect(checking.id).toMatch(/^[0-9a-f-]{36}$/);
    // The role sees balances, so they are not blanked for an agent.
    expect(checking.balance).toMatch(/^-?\d+\.\d{2}$/);
    const some = await ok(bookkeeper, 'list_accounts', { search: '1000' });
    expect(some.accounts.map((a: Out) => a.number)).toContain('1000');
    expect(some.count).toBeLessThan(all.count);
    const banks = await ok(bookkeeper, 'list_accounts', { type: 'bank' });
    expect(banks.count).toBeGreaterThan(0);
    expect(banks.count).toBeLessThan(all.count);
    const capped = await ok(bookkeeper, 'list_accounts', { max_rows: 3 });
    expect(capped.accounts).toHaveLength(3);
    expect(capped.truncated).toBe(true);
  });

  it('list_customers and list_vendors, with what is owed', async () => {
    const c = await ok(bookkeeper, 'list_customers');
    const acme = c.customers.find((x: Out) => x.name === 'Acme "Quoted" Corp');
    expect(acme).toMatchObject({ id: rich.customerId, email: 'ap@acme.test', active: true });
    expect(acme.balance).toMatch(/^-?\d+\.\d{2}$/);
    expect((await ok(bookkeeper, 'list_customers', { search: 'zeta' })).customers.map((x: Out) => x.name)).toEqual(['Zeta Ünïcode Ltd']);
    const v = await ok(bookkeeper, 'list_vendors');
    expect(v.vendors.find((x: Out) => x.id === rich.vendorId)).toMatchObject({ name: 'Paper Supply Co', eligible_1099: true });
    expect(v.vendors[0].balance).toMatch(/^-?\d+\.\d{2}$/);
    // Nothing a vendor row should keep private is passed on.
    expect(JSON.stringify(v)).not.toMatch(/taxId|accountNumber/);
  });

  it('list_items, list_classes, list_other', async () => {
    const i = await ok(bookkeeper, 'list_items');
    expect(i.items.find((x: Out) => x.name === 'Consulting')).toMatchObject({ type: 'service', sales_price: expect.stringMatching(/^125\.5/) });
    expect((await ok(bookkeeper, 'list_items', { type: 'inventory' })).items.every((x: Out) => x.type === 'inventory')).toBe(true);
    const cl = await ok(bookkeeper, 'list_classes');
    expect(cl.classes.map((x: Out) => x.name)).toContain('Retail');
    // The defaults were put in when the agent was made, so an agent's first read needs no write.
    const terms = await ok(bookkeeper, 'list_other', { list: 'terms' });
    expect(terms.count).toBeGreaterThan(0);
    expect(terms.entries[0]).toHaveProperty('name');
    expect(terms.entries[0]).not.toHaveProperty('companyId');
    for (const list of ['payment-methods', 'sales-tax-codes', 'other-names', 'ship-via', 'job-types', 'customer-messages', 'vehicles', 'sales-tax-items']) {
      const out = await ok(bookkeeper, 'list_other', { list });
      expect(out.list).toBe(list);
      expect(Array.isArray(out.entries)).toBe(true);
    }
  });

  it('search and find_transactions', async () => {
    const s = await ok(bookkeeper, 'search', { query: 'Acme' });
    expect(s.results).toContainEqual({ kind: 'Customer', label: expect.stringContaining('Acme'), id: rich.customerId });
    const invoices = await ok(bookkeeper, 'find_transactions', { type: 'invoice' });
    expect(invoices.row_count).toBeGreaterThan(0);
    expect(invoices.columns.map((c: Out) => c.name)).toEqual(expect.arrayContaining(['Date', 'Name', 'Amount']));
    const row = invoices.rows.find((r: Out) => r.journal_entry_id);
    expect(row.cells).toHaveLength(invoices.columns.length);
    const forCustomer = await ok(bookkeeper, 'find_transactions', { customer_id: rich.customerId, date_from: '2024-01-01', date_to: '2030-12-31' });
    expect(forCustomer.row_count).toBeGreaterThan(0);
    expect((await ok(bookkeeper, 'find_transactions', { amount_min: '99999999.00' })).rows.filter((r: Out) => r.kind === 'data')).toEqual([]);
  });

  it('get_register and get_journal_entry', async () => {
    const list = await ok(bookkeeper, 'get_register');
    expect(list.accounts.map((a: Out) => a.number)).toContain('1000');
    const byNumber = await ok(bookkeeper, 'get_register', { account: '1000' });
    expect(byNumber.account.number).toBe('1000');
    expect(byNumber.rows.length).toBeGreaterThan(0);
    const first = byNumber.rows[0];
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.balance).toMatch(/^-?\d+\.\d{2}$/);
    expect(['uncleared', 'cleared', 'reconciled']).toContain(first.status);
    expect(first.journal_entry_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(byNumber.closing_balance).toMatch(/^-?\d+\.\d{2}$/);
    const byId = await ok(bookkeeper, 'get_register', { account_id: rich.acct['1000'], date_from: '2025-01-01', date_to: '2025-01-31' });
    expect(byId.rows.every((r: Out) => r.date >= '2025-01-01' && r.date <= '2025-01-31')).toBe(true);
    expect(byId.rows.length).toBeGreaterThan(0);
    const newest = await ok(bookkeeper, 'get_register', { account: '1000', newest: 2 });
    expect(newest.rows).toHaveLength(2);

    const entry = await ok(bookkeeper, 'get_journal_entry', { id: first.journal_entry_id });
    expect(entry.status).toBe('posted');
    expect(entry.lines.length).toBeGreaterThanOrEqual(2);
    const sum = (k: string) => entry.lines.reduce((n: number, l: Out) => n + Number(l[k] ?? 0), 0);
    expect(sum('debit')).toBeCloseTo(sum('credit'), 2);
    expect(entry.lines[0].account).toMatch(/\S/);

    const missing = await run(bookkeeper, 'get_journal_entry', { id: '11111111-2222-4333-8444-555555555555' });
    expect(missing.ok).toBe(false);
    const noSuch = await run(bookkeeper, 'get_register', { account: 'No Such Account Anywhere' });
    expect(noSuch.ok).toBe(false);
    expect(noSuch.text).toMatch(/No account matches/);
  });

  it('the core reports, with date parameters', async () => {
    const pl = await ok(bookkeeper, 'report_profit_and_loss', { date_from: '2025-01-01', date_to: '2025-12-31' });
    expect(pl.report).toMatch(/Profit & Loss/);
    expect(pl.period).toMatchObject({ from: expect.stringContaining('2025-01-01') });
    expect(pl.rows.some((r: Out) => r.kind === 'total' || r.kind === 'grand')).toBe(true);
    expect(JSON.stringify(pl.rows)).toMatch(/Net Income/i);
    const byMonth = await ok(bookkeeper, 'report_profit_and_loss', { date_from: '2025-01-01', date_to: '2025-03-31', columns: 'month', basis: 'cash' });
    expect(byMonth.columns.length).toBeGreaterThan(pl.columns.length);
    expect(byMonth.basis).toBe('cash');
    expect((await ok(bookkeeper, 'report_profit_and_loss', { period: 'this_fiscal_year' })).report).toMatch(/Profit & Loss/);
    const both = await run(bookkeeper, 'report_profit_and_loss', { period: 'last_year', date_from: '2025-01-01' });
    expect(both.ok).toBe(false);
    expect(both.text).toMatch(/either "period" or date_from/);

    const bs = await ok(bookkeeper, 'report_balance_sheet', { as_of: '2025-12-31' });
    expect(bs.balanced).toBe(true);
    expect(JSON.stringify(bs.rows)).toMatch(/Total Assets/i);
    expect((await ok(bookkeeper, 'report_balance_sheet', { as_of: '2025-12-31', compare: 'prev_year' })).columns.length).toBeGreaterThan(bs.columns.length);

    const tb = await ok(bookkeeper, 'report_trial_balance', { as_of: '2025-12-31' });
    expect(tb.balanced).toBe(true);
    expect(tb.columns.map((c: Out) => c.name)).toEqual(expect.arrayContaining(['Debit', 'Credit']));

    const gl = await ok(bookkeeper, 'report_general_ledger', { date_from: '2025-01-01', date_to: '2025-12-31', account_id: rich.acct['1000'] });
    expect(gl.row_count).toBeGreaterThan(2);
    expect(gl.rows.some((r: Out) => r.journal_entry_id)).toBe(true);
    const cut = await ok(bookkeeper, 'report_general_ledger', { date_from: '2025-01-01', date_to: '2025-12-31', max_rows: 5 });
    expect(cut.rows).toHaveLength(5);
    expect(cut.truncated).toBe(true);
    expect(cut.notes.join(' ')).toMatch(/shorter date range/);

    const ar = await ok(bookkeeper, 'report_ar_aging', { as_of: '2025-12-31' });
    expect(ar.report).toMatch(/A\/R Aging Summary/);
    // The fixture's open receivable belongs to its second customer.
    expect(JSON.stringify(ar.rows)).toContain('Zeta');
    const total = ar.rows.find((r: Out) => r.kind === 'grand');
    expect(total.cells.at(-1)).toMatch(/^-?\d+\.\d{2}$/);
    const zeta = (await ok(bookkeeper, 'list_customers', { search: 'zeta' })).customers[0];
    // The aging total is what the customer list says that customer owes.
    expect(total.cells.at(-1)).toBe(zeta.balance);
    const arDetail = await ok(bookkeeper, 'report_ar_aging', { as_of: '2025-12-31', detail: true, customer_id: zeta.id });
    expect(arDetail.report).toMatch(/A\/R Aging Detail/);
    expect(arDetail.rows.filter((r: Out) => r.kind === 'data').length).toBeGreaterThan(0);
    const ap = await ok(bookkeeper, 'report_ap_aging', { as_of: '2025-12-31', days_per_column: 15 });
    expect(ap.report).toMatch(/A\/P Aging Summary/);
    expect(JSON.stringify(ap.rows)).toContain('Paper Supply Co');
    expect((await ok(bookkeeper, 'report_ap_aging', { detail: true, vendor_id: rich.vendorId })).report).toMatch(/A\/P Aging Detail/);

    const badDate = await run(bookkeeper, 'report_balance_sheet', { as_of: '2025-02-30' });
    expect(badDate.ok).toBe(false);
  });

  it('list_employees needs a role that sees payroll, and never shows a full SSN', async () => {
    const denied = await run(reportsOnly, 'list_employees');
    expect(denied.ok).toBe(false);
    expect(denied.text).toMatch(/You do not have permission/);
    const out = await ok(payroll, 'list_employees');
    expect(Array.isArray(out.employees)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/"ssn"\s*:/);
  });

  it('what a tool may read follows the agent\'s role', async () => {
    // Reports Only: the reports and Find, not the lists or the registers.
    expect((await ok(reportsOnly, 'report_trial_balance', { as_of: '2025-12-31' })).balanced).toBe(true);
    for (const [name, args] of [['list_customers', {}], ['list_vendors', {}], ['list_items', {}], ['get_register', {}], ['list_accounts', {}]] as Array<[string, Record<string, unknown>]>) {
      const r = await run(reportsOnly, name, args);
      expect(r.ok, name).toBe(false);
      expect(r.text, name).toMatch(/You do not have permission/);
    }
    // Payroll: no sales reports.
    const noAr = await run(payroll, 'report_ar_aging');
    expect(noAr.ok).toBe(false);
    expect(noAr.text).toMatch(/permission/i);
  });
});

describe('the reads that go with entering transactions', () => {
  it('list_invoices, list_bills and undeposited_funds', async () => {
    const inv = await ok(bookkeeper, 'list_invoices');
    expect(inv.count).toBeGreaterThan(0);
    expect(inv.invoices[0]).toMatchObject({ id: expect.any(String), total: expect.stringMatching(/^\d+\.\d{2}$/), balance_due: expect.any(String), status: expect.any(String) });
    expect(inv.invoices[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const open = await ok(bookkeeper, 'list_invoices', { unpaid_only: true });
    expect(open.invoices.every((i: Out) => Number(i.balance_due) > 0)).toBe(true);
    expect(open.count).toBeLessThan(inv.count);
    expect((await ok(bookkeeper, 'list_invoices', { customer_id: rich.customerId })).invoices.every((i: Out) => i.customer_id === rich.customerId)).toBe(true);
    const bills = await ok(bookkeeper, 'list_bills', { vendor_id: rich.vendorId });
    expect(bills.count).toBeGreaterThan(0);
    expect(bills.bills.map((b: Out) => b.number)).toEqual(expect.arrayContaining(['PS-77', 'PS-78']));
    expect((await ok(bookkeeper, 'list_bills', { unpaid_only: true })).bills.every((b: Out) => Number(b.balance_due) > 0)).toBe(true);
    const waiting = await ok(bookkeeper, 'undeposited_funds');
    expect(typeof waiting).toBe('object');
  });

  it('get_transaction reads each kind in full, with the version an edit sends back', async () => {
    const inv = (await ok(bookkeeper, 'list_invoices')).invoices[0];
    const invoice = await ok(bookkeeper, 'get_transaction', { type: 'invoice', id: inv.id });
    expect(invoice).toMatchObject({ kind: 'invoice', id: inv.id, total: inv.total });
    expect(invoice.lines.length).toBeGreaterThan(0);
    expect(invoice.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(invoice).not.toHaveProperty('company_id');
    const bill = (await ok(bookkeeper, 'list_bills')).bills[0];
    expect(await ok(bookkeeper, 'get_transaction', { type: 'bill', id: bill.id })).toMatchObject({ kind: 'bill', id: bill.id, lines: expect.any(Array) });
    expect(await ok(bookkeeper, 'get_transaction', { type: 'customer', id: rich.customerId })).toMatchObject({ kind: 'customer', display_name: 'Acme "Quoted" Corp' });
    expect(await ok(bookkeeper, 'get_transaction', { type: 'vendor', id: rich.vendorId })).toMatchObject({ kind: 'vendor', display_name: 'Paper Supply Co' });
    expect(await ok(bookkeeper, 'get_transaction', { type: 'account', id: rich.acct['1000'] })).toMatchObject({ kind: 'account', type: 'asset', code: '1000', name: 'Checking' });
    const item = (await ok(bookkeeper, 'list_items')).items[0];
    expect(await ok(bookkeeper, 'get_transaction', { type: 'item', id: item.id })).toMatchObject({ kind: 'item', name: item.name });
    // The other kinds are found through the ledger: each document's own journal entry names it.
    const sources: Record<string, string> = { sales_receipt: 'salesreceipt:', deposit: 'deposit:', transfer: 'transfer:', check: 'expense:' };
    for (const [type, prefix] of Object.entries(sources)) {
      const rows = (await db.execute(sql`select source_ref from journal_entries where source_ref like ${prefix + '%'} and status = 'posted' limit 1`)) as unknown as { rows: Array<{ source_ref: string }> };
      expect(rows.rows.length, type).toBe(1);
      const id = rows.rows[0].source_ref.slice(prefix.length);
      expect(await ok(bookkeeper, 'get_transaction', { type, id }), type).toMatchObject({ kind: type, id });
    }
    const pay = (await db.execute(sql`select id::text as id from payments_received limit 1`)) as unknown as { rows: Array<{ id: string }> };
    expect(await ok(bookkeeper, 'get_transaction', { type: 'payment', id: pay.rows[0].id })).toMatchObject({ kind: 'payment', applications: expect.any(Array) });
    const bp = (await db.execute(sql`select id::text as id from bill_payments limit 1`)) as unknown as { rows: Array<{ id: string }> };
    expect(await ok(bookkeeper, 'get_transaction', { type: 'bill_payment', id: bp.rows[0].id })).toMatchObject({ kind: 'bill_payment', applications: expect.any(Array) });
    const missing = await run(bookkeeper, 'get_transaction', { type: 'invoice', id: '11111111-2222-4333-8444-555555555555' });
    expect(missing.ok).toBe(false);
  });

  it('list_my_proposals answers for a reading agent too', async () => {
    expect(await ok(bookkeeper, 'list_my_proposals')).toEqual({ proposals: [] });
  });

  it('a reading agent is refused every tool that changes the books, in plain words', async () => {
    for (const [name, args] of [
      ['enter_journal_entry', { date: '2026-03-01', description: 'x', lines: [{ account_id: rich.acct['6300'], debit: '1.00' }, { account_id: rich.acct['1000'], credit: '1.00' }], request_id: 'ro-je-1' }],
      ['add_customer', { name: 'Nope', dry_run: true }],
      ['void_transaction', { type: 'invoice', id: '11111111-2222-4333-8444-555555555555', request_id: 'ro-void-1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await run(bookkeeper, name, args);
      expect(r.ok, name).toBe(false);
      expect(r.text, name).toMatch(/This agent can only read/);
    }
  });
});

describe('after all that reading', () => {
  it('the books are exactly as they were: no row, no audit entry, no log record was added', async () => {
    expect(await fingerprint()).toEqual(before);
  });
});

describe('the tools that change the books, against the real services', () => {
  const je = (amount: string, description: string) => ({
    date: '2026-04-02',
    description,
    lines: [
      { account_id: rich.acct['6300'], debit: amount, memo: 'Paper' },
      { account_id: rich.acct['1000'], credit: amount },
    ],
  });

  it('a dry run shows what would post and keeps nothing', async () => {
    const start = await fingerprint();
    const out = await ok(poster, 'enter_journal_entry', { ...je('64.20', 'Dry run entry'), dry_run: true });
    expect(out).toMatchObject({ outcome: 'dry_run', said: 'Not entered. This is what it would do.', summary: 'Journal entry 2026-04-02: Dry run entry ($64.20)' });
    expect(out.would_post).toEqual([
      expect.objectContaining({
        date: '2026-04-02',
        lines: [
          { account: '6300 Office Supplies', debit: '64.20', credit: null, memo: 'Paper' },
          { account: '1000 Checking', debit: null, credit: '64.20' },
        ],
      }),
    ]);
    expect(await fingerprint()).toEqual(start);
  });

  it('without a request_id nothing is sent', async () => {
    const start = await fingerprint();
    const r = await run(poster, 'enter_journal_entry', je('5.00', 'No id'));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Give a request_id/);
    expect(await fingerprint()).toEqual(start);
  });

  it('enters, repeats safely, edits and voids a journal entry', async () => {
    const first = await ok(poster, 'enter_journal_entry', { ...je('64.20', 'Supplies run'), request_id: 'mcp-je-1' });
    expect(first).toMatchObject({ outcome: 'posted', said: 'Entered.' });
    expect(first.result).toMatchObject({ type: 'journal_entry', date: '2026-04-02', status: 'posted' });
    expect(first.ledger[0].journal_entry_id).toBe(first.result.id);
    const again = await ok(poster, 'enter_journal_entry', { ...je('64.20', 'Supplies run'), request_id: 'mcp-je-1' });
    expect(again).toMatchObject({ repeated: true, outcome: 'posted' });
    expect(again.result).toEqual(first.result);
    const count = (await db.execute(sql`select count(*)::int as n from journal_entries where description = 'Supplies run'`)) as unknown as { rows: Array<{ n: number }> };
    expect(count.rows[0].n).toBe(1);

    // Read it, change the description, send the whole record back with the version read.
    const read = await ok(poster, 'get_transaction', { type: 'journal_entry', id: first.result.id });
    const edited = await ok(poster, 'edit_transaction', {
      type: 'journal_entry',
      id: read.id,
      expected_updated_at: read.updated_at,
      request_id: 'mcp-je-1-edit',
      changes: { date: '2026-04-02', description: 'Supplies run (corrected)', lines: read.lines.map((l: Out) => ({ account_id: l.account_id, debit: l.debit ?? undefined, credit: l.credit ?? undefined, memo: l.memo })) },
    });
    expect(edited.outcome).toBe('posted');
    expect((await ok(poster, 'get_transaction', { type: 'journal_entry', id: edited.result.id })).description).toBe('Supplies run (corrected)');
    const stale = await run(poster, 'edit_transaction', { type: 'journal_entry', id: edited.result.id, expected_updated_at: '2020-01-01T00:00:00.000Z', request_id: 'mcp-je-1-stale', changes: je('64.20', 'Stale') });
    expect(stale.ok).toBe(false);
    expect(stale.text).toMatch(/was changed by/);
    const voided = await ok(poster, 'void_transaction', { type: 'journal_entry', id: edited.result.id, request_id: 'mcp-je-1-void' });
    expect(voided.result.status).toBe('void');
  });

  it('adds list entries and enters the everyday documents with them', async () => {
    const customer = (await ok(poster, 'add_customer', { name: 'Tool Made Customer', email: 'billing@tool.test', terms: 'Net 30', request_id: 'mcp-cust-1' })).result;
    const vendor = (await ok(poster, 'add_vendor', { name: 'Tool Made Vendor', is_1099: true, request_id: 'mcp-vend-1' })).result;
    const account = (await ok(poster, 'add_account', { name: 'Tool Subscriptions', account_type: 'Expense', request_id: 'mcp-acct-1' })).result;
    const item = (await ok(poster, 'add_item', { name: 'Tool Hours', type: 'service', sales_price: '120', income_account_id: rich.acct['4100'], request_id: 'mcp-item-1' })).result;
    const cls = (await ok(poster, 'add_class', { name: 'Tool Class', request_id: 'mcp-class-1' })).result;
    expect([customer.name, vendor.name, account.name, item.name, cls.name]).toEqual(['Tool Made Customer', 'Tool Made Vendor', 'Tool Subscriptions', 'Tool Hours', 'Tool Class']);
    expect(await ok(poster, 'get_transaction', { type: 'vendor', id: vendor.id })).toMatchObject({ display_name: 'Tool Made Vendor', is1099: true });

    const invoice = await ok(poster, 'enter_invoice', { customer_id: customer.id, date: '2026-04-03', po_number: 'PO-9', lines: [{ item_id: item.id, quantity: '3', rate: '120', class_id: cls.id }], request_id: 'mcp-inv-1' });
    expect(invoice.result).toMatchObject({ type: 'invoice', total: '360.00', balance_due: '360.00' });
    expect(invoice.ledger[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ account: '1200 Accounts Receivable', debit: '360.00', credit: null }), expect.objectContaining({ account: '4100 Service Income', credit: '360.00' })]));
    expect((await ok(poster, 'list_invoices', { customer_id: customer.id, unpaid_only: true })).invoices.map((i: Out) => i.id)).toEqual([invoice.result.id]);

    const payment = await ok(poster, 'receive_payment', { customer_id: customer.id, date: '2026-04-04', method: 'check', reference: '2201', amount: '360.00', applications: [{ invoice_id: invoice.result.id, amount_applied: '360.00' }], request_id: 'mcp-pay-1' });
    expect(payment.result.type).toBe('payment');
    expect((await ok(poster, 'list_invoices', { customer_id: customer.id, unpaid_only: true })).count).toBe(0);
    const waiting = JSON.stringify(await ok(poster, 'undeposited_funds'));
    expect(waiting).toContain(payment.result.id);
    const deposit = await ok(poster, 'make_deposit', { deposit_account_id: rich.acct['1000'], date: '2026-04-05', payment_ids: [payment.result.id], request_id: 'mcp-dep-1' });
    expect(deposit.result.type).toBe('deposit');
    expect(JSON.stringify(await ok(poster, 'undeposited_funds'))).not.toContain(payment.result.id);

    const receipt = await ok(poster, 'enter_sales_receipt', { date: '2026-04-05', deposit_account_id: rich.acct['1000'], method: 'cash', lines: [{ account_id: rich.acct['4000'], quantity: '1', rate: '42.00', taxable: false }], request_id: 'mcp-sr-1' });
    expect(receipt.result).toMatchObject({ type: 'sales_receipt', total: '42.00' });

    const bill = await ok(poster, 'enter_bill', { vendor_id: vendor.id, bill_number: 'TMV-1', date: '2026-04-06', lines: [{ account_id: account.id, amount: '99.00', description: 'Monthly plan' }], request_id: 'mcp-bill-1' });
    expect(bill.result).toMatchObject({ type: 'bill', number: 'TMV-1', total: '99.00' });
    const dup = await run(poster, 'enter_bill', { vendor_id: vendor.id, bill_number: 'TMV-1', date: '2026-04-06', lines: [{ account_id: account.id, amount: '99.00' }], dry_run: true });
    expect(dup.ok).toBe(false);
    const paid = await ok(poster, 'pay_bills', { vendor_id: vendor.id, date: '2026-04-07', method: 'check', payment_account_id: rich.acct['1000'], applications: [{ bill_id: bill.result.id, amount_applied: '99.00' }], request_id: 'mcp-bp-1' });
    expect(paid.result.type).toBe('bill_payment');
    expect((await ok(poster, 'list_bills', { vendor_id: vendor.id, unpaid_only: true })).count).toBe(0);

    const check = await ok(poster, 'write_check', { payee_name: 'City Parking', date: '2026-04-08', method: 'check', payment_account_id: rich.acct['1000'], lines: [{ account_id: rich.acct['6700'], amount: '25.00', description: 'Permit' }], request_id: 'mcp-chk-1' });
    expect(check.result).toMatchObject({ type: 'check', total: '25.00' });
    const charge = await ok(poster, 'write_check', { vendor_id: vendor.id, date: '2026-04-08', method: 'credit_card', payment_account_id: rich.acct['2100'], lines: [{ account_id: account.id, amount: '12.00' }], request_id: 'mcp-cc-1' });
    expect(charge.summary).toMatch(/^Card charge to Tool Made Vendor/);
    const transfer = await ok(poster, 'transfer_funds', { date: '2026-04-09', from_account_id: rich.acct['1000'], to_account_id: rich.acct['1010'], amount: '250.00', memo: 'To savings', request_id: 'mcp-xfer-1' });
    expect(transfer.result).toMatchObject({ type: 'transfer', amount: '250.00' });

    // Edit a list entry by the tool's own field names, then make it inactive.
    const renamed = await ok(poster, 'edit_list_entry', { type: 'customer', id: customer.id, changes: { name: 'Tool Made Customer LLC', phone: '555-0100' }, request_id: 'mcp-cust-1-edit' });
    expect(renamed.result.name).toBe('Tool Made Customer LLC');
    expect((await ok(poster, 'deactivate_list_entry', { type: 'class', id: cls.id, request_id: 'mcp-class-1-off' })).result.active).toBe(false);
    expect((await ok(poster, 'deactivate_list_entry', { type: 'item', id: item.id, request_id: 'mcp-item-1-off' })).result.active).toBe(false);

    // Void the check, with the version it was entered with.
    expect((await ok(poster, 'void_transaction', { type: 'check', id: check.result.id, expected_updated_at: check.result.updated_at, request_id: 'mcp-chk-1-void' })).result.status).toBe('void');
  });

  it('the books still balance after everything the agent entered', async () => {
    expect((await ok(poster, 'report_trial_balance', { as_of: '2026-12-31' })).balanced).toBe(true);
    expect((await ok(poster, 'report_balance_sheet', { as_of: '2026-12-31' })).balanced).toBe(true);
  });

  it('in Propose mode the same tool queues the change and a person decides', async () => {
    const start = await fingerprint();
    const out = await ok(proposer, 'enter_journal_entry', { ...je('18.00', 'Proposed by tool'), request_id: 'mcp-prop-1' });
    expect(out).toMatchObject({ outcome: 'proposed', said: 'Not entered. Waiting for a person to approve it in Ironbooks.' });
    expect(out.proposal_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.ledger[0].lines).toHaveLength(2);
    expect((await fingerprint()).journal).toEqual(start.journal);
    const mine = await ok(proposer, 'list_my_proposals');
    expect(mine.proposals).toEqual([expect.objectContaining({ proposal_id: out.proposal_id, status: 'pending', action: 'enter_journal_entry' })]);
  });
});

describe('a bank statement, start to finish', () => {
  let bankAccountId: string;
  let ledgerAccountId: string;
  let reconciliationId: string;
  const lines = [
    { date: '2026-05-02', description: 'TRANSFER FROM CHECKING', amount: '1000.00' },
    { date: '2026-05-05', description: 'CHECK 1001 CITY PARKING', amount: '-200.00', payee: 'City Parking' },
    { date: '2026-05-06', description: 'OFFICE DEPOT 4411', amount: '-30.00' },
  ];
  const statement = () => ({ bank_account_id: bankAccountId, statement_kind: 'bank', opening_balance: '0.00', closing_balance: '770.00', lines });

  it('list_bank_accounts shows the account set up for statements', async () => {
    const account = (await ok(poster, 'add_account', { name: 'Recon Checking', account_type: 'Bank', request_id: 'recon-acct-1' })).result;
    ledgerAccountId = account.id;
    // Linking a ledger account to a bank is set up by a person, in the app.
    bankAccountId = (await createBankAccount(admin, { accountId: ledgerAccountId, bankName: 'First Test Bank', accountNumber: '000123456789' })).id;
    const out = await ok(bookkeeper, 'list_bank_accounts');
    const mine = out.bank_accounts.find((b: Out) => b.bank_account_id === bankAccountId);
    expect(mine).toMatchObject({ bank: 'First Test Bank', kind: 'bank', ledger_account_id: ledgerAccountId, last_reconciled_date: null });
    // Only the last four digits, for an agent as for anyone without the full-numbers right.
    expect(mine.account_number).toMatch(/6789$/);
    expect(mine.account_number).not.toContain('000123456789');
    // What is already in the books for this account before the statement arrives.
    await ok(poster, 'transfer_funds', { date: '2026-05-02', from_account_id: rich.acct['1000'], to_account_id: ledgerAccountId, amount: '1000.00', request_id: 'recon-xfer-1' });
    await ok(poster, 'write_check', { payee_name: 'City Parking', date: '2026-05-05', method: 'check', reference: '1001', payment_account_id: ledgerAccountId, lines: [{ account_id: rich.acct['6700'], amount: '200.00' }], request_id: 'recon-chk-1' });
  });

  it('the lines must add up to the statement, and a dry run keeps nothing', async () => {
    const start = await fingerprint();
    const off = await run(poster, 'import_statement_lines', { ...statement(), closing_balance: '780.00', dry_run: true });
    expect(off.ok).toBe(false);
    expect(off.text).toMatch(/off from the statement by/);
    const dry = await ok(poster, 'import_statement_lines', { ...statement(), dry_run: true });
    expect(dry).toMatchObject({ outcome: 'dry_run', result: { lines_read: 3, added_to_feed: 3, already_there: 0, tied_out: true } });
    expect(dry.would_post).toEqual([]);
    expect(await fingerprint()).toEqual(start);
    expect((await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId })).count).toBe(0);
  });

  it('import_statement_lines puts the lines in the feed, once, and posts nothing', async () => {
    const ledgerBefore = (await fingerprint()).journal;
    const out = await ok(poster, 'import_statement_lines', { ...statement(), filename: 'Recon Checking 2026-05', request_id: 'recon-import-1' });
    expect(out).toMatchObject({ outcome: 'done', said: 'Done. Nothing was posted to the ledger.', result: { added_to_feed: 3, already_there: 0, tied_out: true, difference: '0.00' } });
    expect((await fingerprint()).journal).toEqual(ledgerBefore);
    // The same statement again, under a new request id: every line is already there.
    const again = await ok(poster, 'import_statement_lines', { ...statement(), request_id: 'recon-import-2' });
    expect(again.result).toMatchObject({ added_to_feed: 0, already_there: 3 });
  });

  it('get_bank_feed shows each line with what it may belong to', async () => {
    const feed = await ok(bookkeeper, 'get_bank_feed', { bank_account_id: bankAccountId });
    expect(feed.count).toBe(3);
    const byAmount = (a: string) => feed.lines.find((l: Out) => Number(l.amount) === Number(a));
    expect(byAmount('1000.00')).toMatchObject({ date: '2026-05-02', description: 'TRANSFER FROM CHECKING', status: 'to_review' });
    // The transfer and the check are already in the books: the feed offers them as matches.
    expect(byAmount('1000.00').possible_matches?.length).toBeGreaterThan(0);
    expect(byAmount('-200.00').possible_matches?.[0]).toMatchObject({ date: '2026-05-05' });
    expect(byAmount('-30.00').possible_matches).toBeUndefined();
    expect(byAmount('-200.00').payee).toBe('City Parking');
  });

  it('each line is matched, entered or set aside', async () => {
    const feed = (await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId })).lines as Out[];
    const line = (a: string) => feed.find((l) => Number(l.amount) === Number(a))!;
    const ledgerBefore = (await fingerprint()).journal;
    for (const amount of ['1000.00', '-200.00']) {
      const l = line(amount);
      const out = await ok(poster, 'match_bank_line', { bank_transaction_id: l.bank_transaction_id, journal_entry_id: l.possible_matches[0].journal_entry_id, request_id: `recon-match-${amount}` });
      expect(out.result).toMatchObject({ matched: true });
    }
    // Matching posts nothing.
    expect((await fingerprint()).journal).toEqual(ledgerBefore);

    const supplies = line('-30.00');
    const own = await run(poster, 'categorize_bank_line', { bank_transaction_id: supplies.bank_transaction_id, account_id: ledgerAccountId, dry_run: true });
    expect(own.ok).toBe(false);
    expect(own.text).toMatch(/Choose a different account/);
    const dry = await ok(poster, 'categorize_bank_line', { bank_transaction_id: supplies.bank_transaction_id, account_id: rich.acct['6300'], dry_run: true });
    expect(dry.would_post[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ account: '6300 Office Supplies', debit: '30.00' }), expect.objectContaining({ credit: '30.00' })]));
    const entered = await ok(poster, 'categorize_bank_line', { bank_transaction_id: supplies.bank_transaction_id, account_id: rich.acct['6300'], payee: 'Office Depot', request_id: 'recon-cat-1' });
    expect(entered).toMatchObject({ outcome: 'posted', result: { matched: true } });
    expect(entered.result.journal_entry_id).toMatch(/^[0-9a-f-]{36}$/);

    expect((await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId })).count).toBe(0);
    const matched = await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId, show: 'matched' });
    expect(matched.count).toBe(3);
    expect(matched.lines.every((l: Out) => l.status === 'matched' && l.journal_entry_id)).toBe(true);

    // Undo and redo one, and set a stray line aside and put it back.
    await ok(poster, 'unmatch_bank_line', { bank_transaction_id: supplies.bank_transaction_id, request_id: 'recon-unmatch-1' });
    expect((await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId })).count).toBe(1);
    expect((await ok(poster, 'exclude_bank_line', { bank_transaction_id: supplies.bank_transaction_id, request_id: 'recon-excl-1' })).result.excluded).toBe(true);
    expect((await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId, show: 'excluded' })).count).toBe(1);
    expect((await ok(poster, 'exclude_bank_line', { bank_transaction_id: supplies.bank_transaction_id, restore: true, request_id: 'recon-excl-2' })).result.excluded).toBe(false);
    await ok(poster, 'categorize_bank_line', { bank_transaction_id: supplies.bank_transaction_id, account_id: rich.acct['6300'], request_id: 'recon-cat-2' });
    expect((await ok(poster, 'get_bank_feed', { bank_account_id: bankAccountId })).count).toBe(0);
  });

  it('reconciles to the statement: only a difference of 0.00 can be finished', async () => {
    const status = await ok(bookkeeper, 'reconcile_status', { bank_account_id: bankAccountId });
    expect(status).toMatchObject({ kind: 'bank', last_reconciled_date: null, in_progress: null, last_finished: null });
    expect(Number(status.beginning_balance)).toBe(0);

    // The statement also shows a $12.00 fee and $1.00 interest: ending balance 759.00.
    const started = await ok(poster, 'start_reconciliation', { bank_account_id: bankAccountId, statement_date: '2026-05-31', statement_balance: '759.00', request_id: 'recon-start-1' });
    expect(started).toMatchObject({ outcome: 'done', result: { statement_balance: '759.00', status: 'in_progress', statement_date: '2026-05-31' } });
    reconciliationId = started.result.reconciliation_id;
    expect((await ok(bookkeeper, 'reconcile_status', { bank_account_id: bankAccountId })).in_progress).toMatchObject({ reconciliation_id: reconciliationId });
    const second = await run(poster, 'start_reconciliation', { bank_account_id: bankAccountId, statement_date: '2026-05-31', statement_balance: '759.00', request_id: 'recon-start-2' });
    expect(second.ok).toBe(false);

    const sheet = await ok(poster, 'get_reconciliation', { reconciliation_id: reconciliationId });
    expect(sheet).toMatchObject({ statement_balance: '759.00', can_finish: false });
    expect(sheet.lines.filter((l: Out) => !l.cleared)).toHaveLength(sheet.line_count);
    const live = sheet.lines.filter((l: Out) => Number(l.debit ?? 0) + Number(l.credit ?? 0) > 0);
    const marked = await ok(poster, 'mark_cleared', { reconciliation_id: reconciliationId, line_ids: live.map((l: Out) => l.line_id), request_id: 'recon-mark-1' });
    expect(marked).toMatchObject({ outcome: 'done', result: { cleared_balance: '770.00' } });
    expect(Number(marked.result.difference)).not.toBe(0);

    // 11.00 apart: it cannot be finished, and an agent has no way to force it shut.
    const early = await run(poster, 'finish_reconciliation', { reconciliation_id: reconciliationId, dry_run: true });
    expect(early.ok).toBe(false);
    expect(early.text).toMatch(/Cannot complete: difference/);

    const adjusted = await ok(poster, 'add_statement_adjustments', {
      reconciliation_id: reconciliationId, service_charge: '12.00', service_charge_account_id: rich.acct['6100'], interest_earned: '1.00', interest_account_id: rich.acct['4900'], request_id: 'recon-adj-1',
    });
    expect(adjusted.outcome).toBe('posted');
    expect(adjusted.result).toMatchObject({ cleared_balance: '759.00' });
    expect(Number(adjusted.result.difference)).toBe(0);
    expect((await ok(poster, 'get_reconciliation', { reconciliation_id: reconciliationId, only_uncleared: true })).can_finish).toBe(true);

    const done = await ok(poster, 'finish_reconciliation', { reconciliation_id: reconciliationId, request_id: 'recon-finish-1' });
    expect(done).toMatchObject({ outcome: 'posted', result: { status: 'completed', statement_date: '2026-05-31', statement_balance: '759.00' } });
    const after = await ok(bookkeeper, 'reconcile_status', { bank_account_id: bankAccountId });
    expect(after).toMatchObject({ last_reconciled_date: '2026-05-31', in_progress: null, last_finished: { reconciliation_id: reconciliationId } });
    expect(Number(after.beginning_balance)).toBe(759);
    // The register shows those lines as reconciled now.
    const register = await ok(bookkeeper, 'get_register', { account_id: ledgerAccountId, date_from: '2026-05-01', date_to: '2026-05-31' });
    expect(register.rows.length).toBeGreaterThanOrEqual(5);
    expect(register.rows.every((r: Out) => r.status === 'reconciled')).toBe(true);
    expect(register.closing_balance).toBe('759.00');
    expect((await ok(poster, 'report_trial_balance', { as_of: '2026-12-31' })).balanced).toBe(true);
  });

  it('the last reconciliation can be undone, and only the last', async () => {
    const wrong = await run(poster, 'undo_last_reconciliation', { bank_account_id: bankAccountId, expect_statement_date: '2026-04-30', request_id: 'recon-undo-wrong' });
    expect(wrong.ok).toBe(false);
    const undone = await ok(poster, 'undo_last_reconciliation', { bank_account_id: bankAccountId, expect_statement_date: '2026-05-31', request_id: 'recon-undo-1' });
    expect(undone.result).toMatchObject({ status: 'undone', statement_date: '2026-05-31' });
    expect((await ok(bookkeeper, 'reconcile_status', { bank_account_id: bankAccountId })).last_reconciled_date).toBeNull();
  });

  it('in Propose mode the agent lays the work out, and a person finishes it', async () => {
    // Its own bank account, so it does not meet the other agent's work.
    const acct = (await ok(poster, 'add_account', { name: 'Proposer Checking', account_type: 'Bank', request_id: 'prop-acct-1' })).result;
    const bank = (await createBankAccount(admin, { accountId: acct.id, bankName: 'Second Test Bank', accountNumber: '9999' })).id;
    const ledgerBefore = (await fingerprint()).journal;

    // Statement lines and a reconciliation in progress: done directly, nothing posted.
    const imported = await ok(proposer, 'import_statement_lines', { bank_account_id: bank, statement_kind: 'bank', opening_balance: '0.00', closing_balance: '-18.00', lines: [{ date: '2026-06-03', description: 'MONTHLY FEE', amount: '-18.00' }], request_id: 'prop-import-1' });
    expect(imported).toMatchObject({ outcome: 'done', result: { added_to_feed: 1 } });
    const feed = (await ok(proposer, 'get_bank_feed', { bank_account_id: bank })).lines as Out[];
    expect(feed).toHaveLength(1);
    const started = await ok(proposer, 'start_reconciliation', { bank_account_id: bank, statement_date: '2026-06-30', statement_balance: '-18.00', request_id: 'prop-start-1' });
    expect(started.outcome).toBe('done');
    expect((await fingerprint()).journal).toEqual(ledgerBefore);

    // Entering the line would post to the ledger: that goes to a person.
    const proposed = await ok(proposer, 'categorize_bank_line', { bank_transaction_id: feed[0].bank_transaction_id, account_id: rich.acct['6100'], request_id: 'prop-cat-1' });
    expect(proposed).toMatchObject({ outcome: 'proposed', said: 'Not entered. Waiting for a person to approve it in Ironbooks.' });
    expect(proposed.ledger[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ account: '6100 Bank & Merchant Fees', debit: '18.00' })]));
    expect((await fingerprint()).journal).toEqual(ledgerBefore);
    expect((await ok(proposer, 'get_bank_feed', { bank_account_id: bank })).count).toBe(1);

    // A reconciliation someone else started is not its to work on.
    const other = await ok(poster, 'start_reconciliation', { bank_account_id: bankAccountId, statement_date: '2026-05-31', statement_balance: '759.00', request_id: 'recon-start-again' });
    const sheet = await ok(proposer, 'get_reconciliation', { reconciliation_id: other.result.reconciliation_id });
    const theirs = await run(proposer, 'mark_cleared', { reconciliation_id: other.result.reconciliation_id, line_ids: [sheet.lines[0].line_id], request_id: 'prop-mark-theirs' });
    expect(theirs.ok).toBe(false);
    expect(theirs.text).toMatch(/started by someone else/);
    // Cancelling one needs the Delete right on Reconcile, which the Bookkeeper role does not have,
    // for an agent as for a person.
    const cancel = await run(proposer, 'cancel_reconciliation', { reconciliation_id: started.result.reconciliation_id, request_id: 'prop-cancel-1' });
    expect(cancel.ok).toBe(false);
    expect(cancel.text).toMatch(/You do not have permission to delete Reconcile/);
    // Finishing its own reconciliation is a change a person approves (here it is not at 0.00 yet,
    // so it is refused now rather than queued).
    const finish = await run(proposer, 'finish_reconciliation', { reconciliation_id: started.result.reconciliation_id, request_id: 'prop-finish-1' });
    expect(finish.ok).toBe(false);
    expect(finish.text).toMatch(/Cannot complete: difference/);
    expect((await ok(poster, 'cancel_reconciliation', { reconciliation_id: other.result.reconciliation_id, request_id: 'recon-cancel-1' })).result).toMatchObject({ cancelled: true });
  });

  it('a reading agent can look at all of it and change none of it', async () => {
    expect((await ok(bookkeeper, 'get_bank_feed', { bank_account_id: bankAccountId, show: 'all' })).count).toBe(3);
    for (const [name, args] of [
      ['import_statement_lines', { ...statement(), request_id: 'ro-import' }],
      ['start_reconciliation', { bank_account_id: bankAccountId, statement_date: '2026-05-31', statement_balance: '759.00', request_id: 'ro-start' }],
      ['exclude_bank_line', { bank_transaction_id: '11111111-2222-4333-8444-555555555555', dry_run: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await run(bookkeeper, name, args);
      expect(r.ok, name).toBe(false);
      expect(r.text, name).toMatch(/This agent can only read/);
    }
    // A role without Banking sees no feed.
    const denied = await run(reportsOnly, 'get_bank_feed', { bank_account_id: bankAccountId });
    expect(denied.ok).toBe(false);
    expect(denied.text).toMatch(/You do not have permission/);
  });
});

describe('the routes the tools used', () => {
  it('every read route on the agent list, and no other', () => {
    expect([...reached].sort()).toEqual([...AGENT_READ_ROUTES].sort());
    expect(Object.keys(ROUTES).sort()).toEqual([...AGENT_READ_ROUTES].sort());
  });
});
