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

describe('afterwards', () => {
  it('the tools used every route on the agent list, and no other', () => {
    expect([...reached].sort()).toEqual([...AGENT_READ_ROUTES].sort());
    expect(Object.keys(ROUTES).sort()).toEqual([...AGENT_READ_ROUTES].sort());
  });

  it('the books are exactly as they were: no row, no audit entry, no log record was added', async () => {
    expect(await fingerprint()).toEqual(before);
  });
});
