/**
 * Agent access: changing the books (lib/agent/actions.ts, lib/agent/catalog.ts,
 * app/api/agent/actions/route.ts).
 *
 * Every request goes the way an agent's would: the real route handler, the real getServerContext,
 * a token, the path and method middleware stamps. What is proved:
 *
 *  - Read only refuses every change. Propose queues it for a person and enters nothing. Post
 *    enters it, within the agent's role.
 *  - A dry run really runs the change and keeps nothing: the books are exactly as they were.
 *  - A change that is kept needs a request id; the same id again returns the first answer and
 *    enters nothing twice; the same id with other input is refused.
 *  - Entries an agent makes name the agent, and the person answerable for it.
 *  - The closing date is never open to an agent. The ledger's own rules still apply.
 *  - A person's approval enters a proposal under that person's permissions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-actions');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-actions-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;

import { getDb, closeDb, type DB } from '@/lib/db';
import { agentRequests, aiProposals, auditLogs, companies, invoices, journalEntries, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { builtinRole, fullAccess, unionRoles } from '@/lib/permissions/model';
import { resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { createAgent } from '@/lib/services/agents';
import { approveProposal, listProposals, rejectProposal } from '@/lib/services/aiAssistant';
import { listAuditLogs } from '@/lib/services/auditTrail';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { ALL_AGENT_ACTIONS as AGENT_ACTIONS, AGENT_TRANSACTION_TYPES } from './catalog';
import { READ_ONLY_AGENT_MESSAGE, agentActionNames, agentInputHash } from './actions';
import { API_ROUTE_PERMISSIONS, matchRoutePattern } from '@/lib/permissions/routes';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';

type Out = Record<string, any>;
let db: DB;
let rich: RichCompany;
let admin: ServiceContext;
let acct: Record<string, string>;
const tokens: Record<string, string> = {};
const agentIds: Record<string, string> = {};

/** Send one action as the agent holding `token`, the way the connector does. */
async function act(token: string, body: Out, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Out }> {
  h.cookies.clear();
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/agent/actions');
  h.headers.set(ROUTE_METHOD_HEADER, 'POST');
  h.headers.set('host', 'localhost:45123');
  h.headers.set('authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(extraHeaders)) h.headers.set(k, v);
  const res = await actionsPOST(
    new NextRequest('http://localhost:45123/api/agent/actions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Out };
}
async function ok(token: string, body: Out): Promise<Out> {
  const r = await act(token, body);
  expect(r.status, `${body.action}: ${JSON.stringify(r.json).slice(0, 400)}`).toBe(200);
  return r.json;
}

/** Row counts of every table, the ledger total, and the transaction log length. */
async function fingerprint(ignore: string[] = []) {
  const tables = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    if (ignore.includes(table_name)) continue;
    const r = (await db.execute(sql.raw(`select count(*)::int as n from "${table_name}"`))) as unknown as { rows: Array<{ n: number }> };
    counts[table_name] = r.rows[0].n;
  }
  const ledger = (await db.execute(sql`select coalesce(sum(debit),0)::text as d, count(*)::int as n from journal_entry_lines`)) as unknown as { rows: Array<Out> };
  const balances = (await db.execute(sql`select coalesce(sum(abs(balance)),0)::text as b from accounts`)) as unknown as { rows: Array<Out> };
  return { counts, ledger: ledger.rows[0], balances: balances.rows[0].b, log: readAllTransactionLog(TEST_DIR).records.length };
}

const journal = (date: string, amount: string, description = 'Office supplies bought with cash') => ({
  date,
  description,
  lines: [
    { accountId: acct['6300'], debit: amount },
    { accountId: acct['1000'], credit: amount },
  ],
});

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  db = await getDb(TEST_DIR);
  rich = await seedRichCompany(db, TEST_DIR, 'Actions Co');
  acct = rich.acct;
  admin = { ...rich.ctx, role: 'owner', access: fullAccess() };
  for (const [key, roleKeys, mode] of [
    ['reader', ['bookkeeper'], 'read_only'],
    ['proposer', ['bookkeeper'], 'propose'],
    ['poster', ['bookkeeper'], 'post'],
    ['apClerk', ['ap_clerk'], 'post'],
    ['reportsPoster', ['reports_only'], 'post'],
    ['fullPoster', ['full_access'], 'post'],
  ] as const) {
    const made = await createAgent(admin, { name: `Agent ${key}`, roleKeys: [...roleKeys], mode });
    tokens[key] = made.token;
    agentIds[key] = made.agent.id;
  }
  // A person signs in to the file: agents may work from here on.
  h.cookies.clear();
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, '/api/accounts');
  h.headers.set(ROUTE_METHOD_HEADER, 'GET');
  h.cookies.set(SESSION_COOKIE, createSessionToken(rich.ctx.userId!));
  h.cookies.set(COMPANY_COOKIE, rich.ctx.companyId);
  await getServerContext();
}, 240_000);

afterAll(async () => {
  resetAgentEndpointState();
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the catalog', () => {
  it('every action names a real route of the app, and no action is for anything an agent never does', () => {
    expect(agentActionNames().length).toBe(AGENT_ACTIONS.length);
    for (const a of AGENT_ACTIONS) {
      const pattern = matchRoutePattern(a.route.path.replace(/\[[^\]]+\]/g, '11111111-2222-4333-8444-555555555555'));
      expect(pattern, a.name).not.toBeNull();
      const rule = API_ROUTE_PERMISSIONS[pattern!]?.[a.route.method as 'GET'];
      expect(rule, `${a.name}: ${a.route.method} ${a.route.path}`).toBeDefined();
      expect(rule, a.name).not.toBe('public');
      expect(rule, a.name).not.toBe('self');
      // Never Users & Roles or File Utilities, and nothing is deleted for good.
      if (rule && typeof rule === 'object') expect(['users', 'file_utilities'], a.name).not.toContain(rule.area);
      expect(a.name).not.toMatch(/^delete_|password|backup|restore|user|role|setting|preference/);
    }
    for (const t of AGENT_TRANSACTION_TYPES) {
      expect(agentActionNames()).toContain(`edit_${t}`);
      expect(agentActionNames()).toContain(`void_${t}`);
    }
  });

  it('an unknown action, or input that is not what the screen would accept, is a plain refusal', async () => {
    const unknown = await act(tokens.poster, { action: 'drop_everything', input: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/Unknown action/);
    const bad = await act(tokens.poster, { action: 'enter_journal_entry', input: { date: 'someday', description: '', lines: [] }, dryRun: true });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('VALIDATION');
  });

  it('is for agents only', async () => {
    h.cookies.clear();
    h.headers.clear();
    h.headers.set(ROUTE_PATH_HEADER, '/api/agent/actions');
    h.headers.set(ROUTE_METHOD_HEADER, 'POST');
    h.cookies.set(SESSION_COOKIE, createSessionToken(rich.ctx.userId!));
    h.cookies.set(COMPANY_COOKIE, rich.ctx.companyId);
    const res = await actionsPOST(new NextRequest('http://localhost:45123/api/agent/actions', { method: 'POST', body: JSON.stringify({ action: 'enter_journal_entry', input: journal('2026-03-01', '10.00') }) }));
    expect(res.status).toBe(403);
  });
});

describe('Read only', () => {
  it('refuses every change, also as a dry run, and keeps nothing', async () => {
    const before = await fingerprint();
    for (const body of [
      { action: 'enter_journal_entry', input: journal('2026-03-01', '10.00'), requestId: 'ro-1' },
      { action: 'enter_journal_entry', input: journal('2026-03-01', '10.00'), dryRun: true },
      { action: 'add_customer', input: { displayName: 'Sneaky' }, requestId: 'ro-2' },
      { action: 'void_invoice', input: { id: '11111111-2222-4333-8444-555555555555' }, requestId: 'ro-3' },
    ]) {
      const r = await act(tokens.reader, body);
      expect(r.status, body.action).toBe(403);
      expect(r.json.error).toBe(READ_ONLY_AGENT_MESSAGE);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('can still see what it proposed (nothing)', async () => {
    const out = await ok(tokens.reader, { action: 'list_my_proposals', input: {} });
    expect(out).toMatchObject({ outcome: 'read', result: { proposals: [] } });
  });
});

describe('a dry run', () => {
  it('says what would be entered and leaves the books exactly as they were', async () => {
    const before = await fingerprint();
    const out = await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-02', '45.10'), dryRun: true });
    expect(out.outcome).toBe('dry_run');
    expect(out.summary).toBe('Journal entry 2026-03-02: Office supplies bought with cash ($45.10)');
    expect(out.ledger.entries).toHaveLength(1);
    expect(out.ledger.entries[0]).toMatchObject({ date: '2026-03-02', status: 'posted' });
    expect(out.ledger.entries[0].lines).toEqual([
      expect.objectContaining({ accountCode: '6300', accountName: 'Office Supplies', debit: '45.10', credit: null }),
      expect.objectContaining({ accountCode: '1000', accountName: 'Checking', debit: null, credit: '45.10' }),
    ]);
    expect(out.ledger.changes).toContainEqual(expect.objectContaining({ action: 'create', kind: 'journal_entry' }));
    expect(out.note).toMatch(/Nothing was kept/);
    expect(await fingerprint()).toEqual(before);
  });

  it('fails wherever the real change would', async () => {
    const before = await fingerprint();
    const unbalanced = await act(tokens.poster, {
      action: 'enter_journal_entry',
      dryRun: true,
      input: { date: '2026-03-02', description: 'Does not balance', lines: [{ accountId: acct['6300'], debit: '10.00' }, { accountId: acct['1000'], credit: '9.00' }] },
    });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.json.code).toBe('UNBALANCED');
    // An A/R line without a customer name: the ledger's own rule.
    const unnamed = await act(tokens.poster, {
      action: 'enter_journal_entry',
      dryRun: true,
      input: { date: '2026-03-02', description: 'A/R without a name', lines: [{ accountId: acct['1200'], debit: '10.00' }, { accountId: acct['4000'], credit: '10.00' }] },
    });
    expect(unnamed.status).toBe(400);
    const otherCompany = await act(tokens.poster, {
      action: 'enter_journal_entry',
      dryRun: true,
      input: { date: '2026-03-02', description: 'Unknown account', lines: [{ accountId: '11111111-2222-4333-8444-555555555555', debit: '10.00' }, { accountId: acct['1000'], credit: '10.00' }] },
    });
    expect(otherCompany.status).toBeGreaterThanOrEqual(400);
    expect(await fingerprint()).toEqual(before);
  });
});

describe('Post', () => {
  let entryId: string;
  let first: Out;

  it('needs a request id for anything that is kept', async () => {
    const before = await fingerprint();
    for (const requestId of [undefined, '', 'x', 'has spaces in it', 'a'.repeat(200)]) {
      const r = await act(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '12.00'), ...(requestId === undefined ? {} : { requestId }) });
      expect(r.status, String(requestId)).toBe(400);
      expect(r.json.error).toMatch(/request_id/);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('enters the change, under the agent\'s name', async () => {
    first = await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '12.00'), requestId: 'je-2026-03-03-supplies' });
    expect(first.outcome).toBe('posted');
    expect(first.result).toMatchObject({ type: 'journal_entry', date: '2026-03-03', status: 'posted' });
    entryId = first.result.id;
    expect(first.ledger.entries[0].journalEntryId).toBe(entryId);

    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    // The agent is recorded on the entry, next to the person answerable for it (the Admin who let it in).
    expect(row.agentId).toBe(agentIds.poster);
    expect(row.createdBy).toBe(rich.ctx.userId);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, entryId), eq(auditLogs.entityType, 'journal_entry')));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.userId === null && a.agentId === agentIds.poster)).toBe(true);
    const trail = await listAuditLogs(admin, { entityType: 'journal_entry', limit: 200 });
    expect(trail.rows.find((r) => r.entityId === entryId)).toMatchObject({ actorName: 'Agent poster (agent)', actorId: null });
    const logged = readAllTransactionLog(TEST_DIR).records.find((r) => r.entityId === entryId);
    expect(logged).toMatchObject({ userId: null, userName: 'Agent poster (agent)' });
  });

  it('the same request id again returns the first answer and enters nothing twice', async () => {
    const before = await fingerprint();
    const again = await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '12.00'), requestId: 'je-2026-03-03-supplies' });
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.outcome).toBe('posted');
    // Key order and spacing of the input do not matter.
    const reordered = { lines: journal('2026-03-03', '12.00').lines.map((l) => ({ ...l })), description: 'Office supplies bought with cash', date: '2026-03-03' };
    expect((await ok(tokens.poster, { action: 'enter_journal_entry', input: reordered, requestId: 'je-2026-03-03-supplies' })).replayed).toBe(true);
    expect(await fingerprint()).toEqual(before);
    expect(agentInputHash('x', { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(agentInputHash('x', { b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(agentInputHash('x', { a: 1 })).not.toBe(agentInputHash('x', { a: 2 }));
  });

  it('the same request id for a different change is refused', async () => {
    const before = await fingerprint();
    const other = await act(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '13.00'), requestId: 'je-2026-03-03-supplies' });
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/already used for a different change/);
    const otherAction = await act(tokens.poster, { action: 'add_customer', input: { displayName: 'Collision' }, requestId: 'je-2026-03-03-supplies' });
    expect(otherAction.status).toBe(409);
    expect(await fingerprint()).toEqual(before);
    // Another agent's ids are its own.
    const mine = await ok(tokens.apClerk, { action: 'add_vendor', input: { displayName: 'Shared Id Vendor' }, requestId: 'je-2026-03-03-supplies' });
    expect(mine.outcome).toBe('posted');
  });

  it('a change that is refused keeps nothing, and its request id is free to use again', async () => {
    const before = await fingerprint();
    const bad = await act(tokens.poster, {
      action: 'enter_journal_entry',
      requestId: 'je-retry-after-fix',
      input: { date: '2026-03-04', description: 'Off by a dollar', lines: [{ accountId: acct['6300'], debit: '20.00' }, { accountId: acct['1000'], credit: '19.00' }] },
    });
    expect(bad.status).toBe(400);
    expect(await fingerprint()).toEqual(before);
    const fixed = await ok(tokens.poster, { action: 'enter_journal_entry', requestId: 'je-retry-after-fix', input: journal('2026-03-04', '20.00', 'Fixed entry') });
    expect(fixed.outcome).toBe('posted');
  });

  it('enters each kind of transaction through its own service', async () => {
    const customer = (await ok(tokens.poster, { action: 'add_customer', input: { displayName: 'Agent Made Customer', email: 'ap@made.test' }, requestId: 'cust-1' })).result;
    expect(customer).toMatchObject({ type: 'customer', name: 'Agent Made Customer', active: true });
    const vendor = (await ok(tokens.poster, { action: 'add_vendor', input: { displayName: 'Agent Made Vendor' }, requestId: 'vend-1' })).result;
    const account = (await ok(tokens.poster, { action: 'add_account', input: { name: 'Software Subscriptions', qbType: 'Expense' }, requestId: 'acct-1' })).result;
    expect(account).toMatchObject({ type: 'account', name: 'Software Subscriptions' });
    const item = (await ok(tokens.poster, { action: 'add_item', input: { name: 'Agent Service', type: 'service', salesPrice: '90', incomeAccountId: acct['4100'] }, requestId: 'item-1' })).result;
    expect(item).toMatchObject({ type: 'item', name: 'Agent Service' });
    expect((await ok(tokens.poster, { action: 'add_class', input: { name: 'Agent Class' }, requestId: 'class-1' })).result).toMatchObject({ type: 'class', name: 'Agent Class' });

    const invoice = await ok(tokens.poster, {
      action: 'enter_invoice',
      requestId: 'inv-1',
      input: { customerId: customer.id, date: '2026-03-05', lines: [{ itemId: item.id, quantity: '2', rate: '90' }] },
    });
    expect(invoice.result).toMatchObject({ type: 'invoice', total: '180.00', balance_due: '180.00', date: '2026-03-05' });
    expect(invoice.ledger.entries[0].lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountCode: '1200', debit: '180.00' }), expect.objectContaining({ accountCode: '4100', credit: '180.00' })]),
    );
    expect(invoice.summary).toBe('Invoice to Agent Made Customer 2026-03-05 ($180.00 before tax)');

    const payment = await ok(tokens.poster, {
      action: 'receive_payment',
      requestId: 'pay-1',
      input: { customerId: customer.id, date: '2026-03-06', method: 'check', reference: '4411', amount: '180.00', applications: [{ invoiceId: invoice.result.id, amountApplied: '180.00' }] },
    });
    expect(payment.result).toMatchObject({ type: 'payment', amount: '180.00' });
    const [paid] = await db.select().from(invoices).where(eq(invoices.id, invoice.result.id));
    expect(paid.balanceDue).toBe('0.00');

    const deposit = await ok(tokens.poster, { action: 'make_deposit', requestId: 'dep-1', input: { depositAccountId: acct['1000'], date: '2026-03-07', paymentIds: [payment.result.id] } });
    expect(deposit.result.type).toBe('deposit');
    expect(deposit.ledger.entries[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: '1000', debit: '180.00' }), expect.objectContaining({ accountCode: '1050', credit: '180.00' })]));

    const receipt = await ok(tokens.poster, { action: 'enter_sales_receipt', requestId: 'sr-1', input: { date: '2026-03-07', depositAccountId: acct['1000'], lines: [{ accountId: acct['4000'], quantity: '1', rate: '55.25', taxable: false }] } });
    expect(receipt.result).toMatchObject({ type: 'sales_receipt', total: '55.25' });

    const bill = await ok(tokens.poster, { action: 'enter_bill', requestId: 'bill-1', input: { vendorId: vendor.id, billNumber: 'AMV-100', date: '2026-03-08', lines: [{ accountId: account.id, amount: '310.00', description: 'Annual plan' }] } });
    expect(bill.result).toMatchObject({ type: 'bill', number: 'AMV-100', total: '310.00', balance_due: '310.00' });
    const paidBill = await ok(tokens.poster, {
      action: 'pay_bills',
      requestId: 'bp-1',
      input: { vendorId: vendor.id, date: '2026-03-09', method: 'check', paymentAccountId: acct['1000'], applications: [{ billId: bill.result.id, amountApplied: '310.00' }] },
    });
    expect(paidBill.result.type).toBe('bill_payment');
    expect(paidBill.ledger.entries[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: '2000', debit: '310.00' }), expect.objectContaining({ accountCode: '1000', credit: '310.00' })]));

    const check = await ok(tokens.poster, { action: 'write_check', requestId: 'chk-1', input: { vendorId: vendor.id, date: '2026-03-10', method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6400'], amount: '1200.00', description: 'March rent' }] } });
    expect(check.result).toMatchObject({ type: 'check', total: '1200.00', status: 'posted' });
    expect(check.summary).toBe('Check to Agent Made Vendor 2026-03-10 from 1000 Checking ($1200.00)');

    const transfer = await ok(tokens.poster, { action: 'transfer_funds', requestId: 'xfer-1', input: { date: '2026-03-11', fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '500.00' } });
    expect(transfer.result).toMatchObject({ type: 'transfer', amount: '500.00' });

    // Every entry made here names the agent.
    const mine = await db.select({ agentId: journalEntries.agentId, createdBy: journalEntries.createdBy }).from(journalEntries).where(eq(journalEntries.agentId, agentIds.poster));
    expect(mine.length).toBeGreaterThanOrEqual(8);
    expect(mine.every((e) => e.createdBy === rich.ctx.userId)).toBe(true);
  });

  it('edits and voids, and will not overwrite a change made since it last looked', async () => {
    const made = await ok(tokens.poster, { action: 'enter_journal_entry', requestId: 'je-edit-1', input: journal('2026-03-12', '30.00', 'To be edited') });
    const stale = await act(tokens.poster, {
      action: 'edit_journal_entry',
      requestId: 'je-edit-1-stale',
      input: { id: made.result.id, expectedUpdatedAt: '2020-01-01T00:00:00.000Z', changes: journal('2026-03-12', '30.00', 'Edited by a stale agent') },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details).toMatchObject({ staleVersion: true });

    const edited = await ok(tokens.poster, {
      action: 'edit_journal_entry',
      requestId: 'je-edit-1-memo',
      input: { id: made.result.id, expectedUpdatedAt: made.result.updated_at, changes: journal('2026-03-12', '30.00', 'Edited description') },
    });
    expect(edited.outcome).toBe('posted');
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, edited.result.id));
    expect(row.description).toBe('Edited description');

    // Voiding a journal entry needs the Delete right there, which the Bookkeeper role does not have
    // (for a person either). An agent with Full Access may.
    const denied = await act(tokens.poster, { action: 'void_journal_entry', requestId: 'je-edit-1-void', input: { id: edited.result.id } });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatch(/You do not have permission to delete/);
    const voided = await ok(tokens.fullPoster, { action: 'void_journal_entry', requestId: 'je-edit-1-void', input: { id: edited.result.id } });
    expect(voided.result.status).toBe('void');
    // Full Access carries the closed-period flag for people; an agent never has it.
    const check = await ok(tokens.fullPoster, { action: 'write_check', requestId: 'chk-void-1', input: { payeeName: 'Petty Cash', date: '2026-03-12', method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '15.00' }] } });
    expect((await ok(tokens.fullPoster, { action: 'void_check', requestId: 'chk-void-1-void', input: { id: check.result.id, expectedUpdatedAt: check.result.updated_at } })).result.status).toBe('void');
    const gone = await act(tokens.fullPoster, { action: 'void_invoice', requestId: 'no-such-invoice', input: { id: '11111111-2222-4333-8444-555555555555' } });
    expect(gone.status).toBe(404);
  });

  it('never posts on or before the closing date, whatever it sends', async () => {
    await db.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || '{"closingDate":"2026-01-31"}'::jsonb` }).where(eq(companies.id, admin.companyId));
    try {
      const before = await fingerprint();
      for (const dryRun of [true, false]) {
        const r = await act(
          tokens.poster,
          { action: 'enter_journal_entry', input: journal('2026-01-15', '10.00', 'Into a closed period'), ...(dryRun ? { dryRun } : { requestId: 'closed-period-1' }) },
          { 'x-closing-password': 'anything' },
        );
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.json.code).toBe('PERIOD_CLOSED');
        expect(r.json.error).toMatch(/closed through 2026-01-31/);
      }
      expect(await fingerprint()).toEqual(before);
      // After the closing date it still works.
      expect((await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-02-01', '10.00', 'Open period'), dryRun: true })).outcome).toBe('dry_run');
    } finally {
      await db.update(companies).set({ settings: sql`${companies.settings} - 'closingDate'` }).where(eq(companies.id, admin.companyId));
    }
  });

  it('stays within its role: the same permission map as a person', async () => {
    const before = await fingerprint(['agent_requests']);
    // A/P Clerk: bills yes, invoices and journal entries no.
    const bill = await ok(tokens.apClerk, { action: 'enter_bill', dryRun: true, input: { vendorId: rich.vendorId, date: '2026-03-13', lines: [{ accountId: acct['6300'], amount: '40.00' }] } });
    expect(bill.outcome).toBe('dry_run');
    for (const body of [
      { action: 'enter_invoice', input: { customerId: rich.customerId, date: '2026-03-13', lines: [{ accountId: acct['4000'], quantity: '1', rate: '10' }] } },
      { action: 'enter_journal_entry', input: journal('2026-03-13', '10.00') },
      { action: 'add_account', input: { name: 'Not Mine', qbType: 'Expense' } },
    ]) {
      for (const how of [{ dryRun: true }, { requestId: `denied-${body.action}` }]) {
        const r = await act(tokens.apClerk, { ...body, ...how });
        expect(r.status, body.action).toBe(403);
        expect(r.json.error).toMatch(/You do not have permission/);
      }
    }
    // Reports Only in Post mode: the mode allows changes, the role allows none.
    for (const body of [
      { action: 'enter_journal_entry', input: journal('2026-03-13', '10.00') },
      { action: 'enter_bill', input: { vendorId: rich.vendorId, date: '2026-03-13', lines: [{ accountId: acct['6300'], amount: '40.00' }] } },
      { action: 'add_customer', input: { displayName: 'Nope' } },
      { action: 'void_invoice', input: { id: '11111111-2222-4333-8444-555555555555' } },
    ]) {
      const r = await act(tokens.reportsPoster, { ...body, requestId: `reports-${body.action}` });
      expect(r.status, body.action).toBe(403);
    }
    expect(await fingerprint(['agent_requests'])).toEqual(before);
  });

  it('opening stock is left to a person', async () => {
    const r = await act(tokens.poster, { action: 'add_item', dryRun: true, input: { name: 'Stocked Widget', type: 'inventory', openingQuantity: '5', openingValue: '50' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Opening stock is entered in Ironbooks/);
  });
});

describe('Propose', () => {
  let proposalId: string;
  const input = () => journal('2026-03-14', '77.00', 'Proposed supplies');

  it('checks the change, queues it for a person, and enters nothing', async () => {
    const before = await fingerprint(['ai_proposals', 'audit_logs', 'agent_requests']);
    const ledgerBefore = (await fingerprint()).ledger;
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: input(), requestId: 'prop-1' });
    expect(out.outcome).toBe('proposed');
    expect(out.note).toMatch(/Nothing was entered/);
    proposalId = out.proposalId;
    expect(out.ledger.entries[0].lines).toHaveLength(2);
    expect(await fingerprint(['ai_proposals', 'audit_logs', 'agent_requests'])).toEqual({ ...before, log: before.log + 1 });
    expect((await fingerprint()).ledger).toEqual(ledgerBefore);

    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    expect(row).toMatchObject({ kind: 'agent_action', status: 'pending', agentId: agentIds.proposer, createdBy: null, summary: 'Journal entry 2026-03-14: Proposed supplies ($77.00)' });
    // What the approval card shows: the date, the words, the ledger lines, the total.
    const payload = row.payload as Out;
    expect(payload).toMatchObject({ date: '2026-03-14', description: row.summary, totalDebit: '77.00', action: 'enter_journal_entry', agent: { id: agentIds.proposer, name: 'Agent proposer' } });
    expect(payload.lines.map((l: Out) => [l.accountCode, l.debit, l.credit])).toEqual([['6300', '77.00', null], ['1000', null, '77.00']]);
    // It shows in the app's own list of proposals waiting for approval.
    expect((await listProposals(admin, 'pending')).map((p) => p.id)).toContain(proposalId);
  });

  it('the same request again is the same proposal, not a second one', async () => {
    const again = await ok(tokens.proposer, { action: 'enter_journal_entry', input: input(), requestId: 'prop-1' });
    expect(again).toMatchObject({ replayed: true, outcome: 'proposed', proposalId });
    expect(await db.select().from(aiProposals).where(eq(aiProposals.agentId, agentIds.proposer))).toHaveLength(1);
  });

  it('something that would be refused is refused now, not queued', async () => {
    const r = await act(tokens.proposer, {
      action: 'enter_journal_entry',
      requestId: 'prop-bad',
      input: { date: '2026-03-14', description: 'Unbalanced proposal', lines: [{ accountId: acct['6300'], debit: '10.00' }, { accountId: acct['1000'], credit: '9.00' }] },
    });
    expect(r.status).toBe(400);
    expect(await db.select().from(aiProposals).where(eq(aiProposals.agentId, agentIds.proposer))).toHaveLength(1);
  });

  it('the agent can see its proposal waiting', async () => {
    const out = await ok(tokens.proposer, { action: 'list_my_proposals', input: {} });
    expect(out.result.proposals).toEqual([expect.objectContaining({ proposal_id: proposalId, action: 'enter_journal_entry', status: 'pending', decided_at: null })]);
    // Another agent sees none of it.
    expect((await ok(tokens.poster, { action: 'list_my_proposals', input: {} })).result.proposals).toEqual([]);
  });

  it('a person without the right cannot approve it', async () => {
    const [viewer] = await db.insert(users).values({ email: 'viewer@actions.test', name: 'Vera Viewer', passwordHash: 'x' }).returning();
    await db.insert(userCompanies).values({ userId: viewer.id, companyId: admin.companyId, role: 'viewer' });
    await db.insert(userRoleAssignments).values({ userId: viewer.id, companyId: admin.companyId, roleKey: 'ar_clerk' });
    // A/R Clerk: no journal entries. The approval runs under the approver's own permissions.
    const clerk: ServiceContext = { db, companyId: admin.companyId, userId: viewer.id, role: 'accountant', access: unionRoles([builtinRole('ar_clerk')!]) };
    await expect(approveProposal(clerk, proposalId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    expect(row.status).toBe('pending');
  });

  it('a person approves it: entered under their permissions, named as the agent\'s and approved by them', async () => {
    const approved = await approveProposal(admin, proposalId);
    expect(approved.status).toBe('approved');
    const [entry] = await db.select().from(journalEntries).where(and(eq(journalEntries.agentId, agentIds.proposer), eq(journalEntries.description, 'Proposed supplies')));
    expect(entry).toMatchObject({ createdBy: rich.ctx.userId, status: 'posted' });
    const trail = await listAuditLogs(admin, { entityType: 'journal_entry', limit: 300 });
    expect(trail.rows.find((r) => r.entityId === entry.id)?.actorName).toBe('Agent proposer (agent), approved by Owner Person');
    expect(readAllTransactionLog(TEST_DIR).records.find((r) => r.entityId === entry.id)?.userName).toBe('Agent proposer (agent), approved by Owner Person');
    // Approving twice does nothing more.
    await expect(approveProposal(admin, proposalId)).rejects.toBeInstanceOf(ServiceError);
    const out = await ok(tokens.proposer, { action: 'list_my_proposals', input: {} });
    expect(out.result.proposals[0]).toMatchObject({ status: 'approved' });
    expect(out.result.proposals[0].decided_at).toMatch(/^\d{4}-/);
  });

  it('a person rejects one: nothing is entered', async () => {
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: journal('2026-03-15', '5.00', 'To be rejected'), requestId: 'prop-2' });
    const before = (await fingerprint()).ledger;
    expect((await rejectProposal(admin, out.proposalId)).status).toBe('rejected');
    expect((await fingerprint()).ledger).toEqual(before);
    const mine = (await ok(tokens.proposer, { action: 'list_my_proposals', input: {} })).result.proposals;
    expect(mine.find((p: Out) => p.proposal_id === out.proposalId)).toMatchObject({ status: 'rejected' });
  });

  it('a dry run in Propose mode queues nothing', async () => {
    const count = (await db.select().from(aiProposals).where(eq(aiProposals.agentId, agentIds.proposer))).length;
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: journal('2026-03-16', '9.00'), dryRun: true });
    expect(out.outcome).toBe('dry_run');
    expect(out.note).toMatch(/approval queue/);
    expect(await db.select().from(aiProposals).where(eq(aiProposals.agentId, agentIds.proposer))).toHaveLength(count);
  });
});

describe('request ids are kept per agent and never travel', () => {
  it('each kept change has one row; refused and dry-run requests have none', async () => {
    const rows = await db.select().from(agentRequests);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => ['posted', 'proposed'].includes(r.outcome) && r.result !== null)).toBe(true);
    expect(rows.filter((r) => r.requestKey.startsWith('denied-') || r.requestKey.startsWith('reports-') || r.requestKey === 'closed-period-1')).toEqual([]);
    expect(new Set(rows.map((r) => `${r.agentId}:${r.requestKey}`)).size).toBe(rows.length);
  });
});
