/**
 * Agent access: the curated actions (lib/agent/actions.ts, lib/agent/catalog.ts, banking.ts,
 * app/api/agent/actions/route.ts), on the one path through the agent's door (lib/agent/operate.ts).
 *
 * Every request goes the way an agent's would: the real route handler, the real getServerContext,
 * a token, the path and method middleware stamps. What is proved:
 *
 *  - Each action is its route's registry operation: the policy decides it exactly as it decides
 *    run_operation. Read only is refused every change; "Ask for every change" asks a person, and a
 *    person's approval in the approval center enters it, named "agent, approved by person";
 *    "Trusted bookkeeper" enters it, within the agent's role.
 *  - A dry run really runs the change and keeps nothing: the books are exactly as they were.
 *  - A change that is kept needs a request id; the same id again returns the first answer and
 *    enters nothing twice; the same id with other input is refused.
 *  - Entries an agent makes name the agent, and the person answerable for it.
 *  - The closing date is never open to an agent's own run. The ledger's own rules still apply.
 *  - Nothing new goes to the old approval queue (ai_proposals); a request copied from it is still
 *    entered the old way.
 *  - An agent with the Admin role gets nothing through a curated action that run_operation would
 *    not give it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>(), quickCheckOff: false }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));
// The action's own quick version check (lib/agent/catalog.ts versionCheck, the one caller of
// assertCurrentVersion from outside lib/services/concurrency.ts besides a batch void) can be
// switched off for one test, to show that what stops a stale edit is the route's own compare
// inside the run. The route's withVersionCheck calls the module's own assertCurrentVersion, which
// this leaves as it is. Off only while h.quickCheckOff is set.
vi.mock('@/lib/services/concurrency', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/concurrency')>();
  return {
    ...actual,
    assertCurrentVersion: (...args: Parameters<typeof actual.assertCurrentVersion>) => (h.quickCheckOff ? Promise.resolve() : actual.assertCurrentVersion(...args)),
  };
});

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-actions');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-actions-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;

import { getDb, closeDb, type DB } from '@/lib/db';
import {
  agentPermissionRequests,
  agentRequests,
  aiProposals,
  auditLogs,
  classes,
  companies,
  customers,
  invoices,
  journalEntries,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { builtinRole, fullAccess, unionRoles } from '@/lib/permissions/model';
import { resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { createAgent } from '@/lib/services/agents';
import { createBankAccount } from '@/lib/services/bankAccounts';
import { createAccount } from '@/lib/services/accounts';
import { createCustomer, updateCustomer } from '@/lib/services/customers';
import { createVendor } from '@/lib/services/vendors';
import { approveAgentRequest, denyAgentRequest } from '@/lib/services/agentRequests';
import { listAuditLogs } from '@/lib/services/auditTrail';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import type { ServiceContext } from '@/lib/services/_base';
import type { AgentPreset } from '@/lib/agent/operations/types';
import { createManualEntry } from '@/lib/services/journal';
import { AGENT_CALLS_PER_MINUTE, AGENT_RUNS_AT_ONCE, NO_REASON_NOTE, resetAgentRateLimits } from './operate';
import { ALL_AGENT_ACTIONS as AGENT_ACTIONS, AGENT_TRANSACTION_TYPES } from './catalog';
import { AGENT_PROPOSAL_KIND, actionOperation, agentActionNames, agentInputHash, changesInTransaction, type ChangePreview } from './actions';
import { API_ROUTE_PERMISSIONS, matchRoutePattern } from '@/lib/permissions/routes';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';

type Out = Record<string, any>;
let db: DB;
let rich: RichCompany;
let admin: ServiceContext;
let acct: Record<string, string>;
const tokens: Record<string, string> = {};
const agentIds: Record<string, string> = {};

/** Send one request as the agent holding `token`, the way the connector does. */
async function act(token: string, body: Out, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Out; retryAfter: string | null }> {
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
  return { status: res.status, json: (await res.json()) as Out, retryAfter: res.headers.get('retry-after') };
}
async function ok(token: string, body: Out): Promise<Out> {
  const r = await act(token, body);
  expect(r.status, `${body.action ?? body.verb}: ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
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

/** Just the books: the ledger, the balances and the journal entries. */
async function books() {
  const f = await fingerprint();
  return { ledger: f.ledger, balances: f.balances, entries: f.counts.journal_entries };
}

const journal = (date: string, amount: string, description = 'Office supplies bought with cash') => ({
  date,
  description,
  lines: [
    { accountId: acct['6300'], debit: amount },
    { accountId: acct['1000'], credit: amount },
  ],
});

/** A new ledger bank account linked to a bank, as a person sets it up in the app. */
async function newBank(name: string): Promise<string> {
  const account = await createAccount(admin, { name, qbType: 'Bank' } as Parameters<typeof createAccount>[1]);
  return (await createBankAccount(admin, { accountId: (account as { id: string }).id, bankName: `${name} Bank`, accountNumber: '000444555' })).id;
}

/** The refusal of a class the agent's preset sets to Never (lib/agent/policy.ts). */
const NEVER = /An Admin has not allowed agents to/;
/** The refusal of a right the agent's role lacks. */
const ROLE = /Your role does not allow this/;
/** A version older than any record: the record was changed since the agent "read" it. */
const STALE = '2020-01-01T00:00:00.000Z';
/** What a stale-version answer says about the record (lib/services/concurrency.ts assertCurrentVersion). */
const RECORD_FACTS = /changedBy|changedAt|currentUpdatedAt|staleVersion|was changed by/;

/** An invoice of the fixture company, to edit or void. */
async function someInvoice(): Promise<string> {
  const [row] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, admin.companyId)).limit(1);
  expect(row?.id).toBeTruthy();
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  resetAgentRateLimits();
  db = await getDb(TEST_DIR);
  rich = await seedRichCompany(db, TEST_DIR, 'Actions Co');
  acct = rich.acct;
  admin = { ...rich.ctx, role: 'owner', access: fullAccess() };
  for (const [key, roleKeys, preset] of [
    ['reader', ['bookkeeper'], 'read_only'],
    ['proposer', ['bookkeeper'], 'ask_every_change'],
    ['poster', ['bookkeeper'], 'trusted_bookkeeper'],
    ['apClerk', ['ap_clerk'], 'trusted_bookkeeper'],
    ['reportsPoster', ['reports_only'], 'trusted_bookkeeper'],
    ['fullPoster', ['full_access'], 'trusted_bookkeeper'],
    ['adminReader', ['admin'], 'read_only'],
    ['adminAsks', ['admin'], 'ask_every_change'],
    ['adminTrusted', ['admin'], 'trusted_bookkeeper'],
    ['adminFull', ['admin'], 'full_with_asks'],
  ] as Array<[string, string[], AgentPreset]>) {
    const made = await createAgent(admin, { name: `Agent ${key}`, roleKeys, preset });
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
  resetAgentRateLimits();
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the catalog', () => {
  it('every action names a real route of the app, which is one registry operation, and none is for anything an agent never does', () => {
    expect(agentActionNames().length).toBe(AGENT_ACTIONS.length);
    expect(AGENT_ACTIONS.length).toBe(55);
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
      // The policy decides each by its route's operation: one that is open to agents, classified.
      const op = actionOperation(a);
      expect(op.route, a.name).toBe(a.route.path);
      expect(op.method, a.name).toBe(a.route.method);
      expect(op.classified, a.name).toBe(true);
      expect(op.availability, a.name).toBe('agent');
    }
    for (const t of AGENT_TRANSACTION_TYPES) {
      expect(agentActionNames()).toContain(`edit_${t}`);
      expect(agentActionNames()).toContain(`void_${t}`);
    }
    // Only the agent's own requests, the rules-only suggestions and the staging-only import run
    // themselves; every other action is its route's operation through the door.
    expect(AGENT_ACTIONS.filter((a) => a.runs && a.runs !== 'door').map((a) => a.name).sort()).toEqual(['bank_feed_suggestions', 'import_statement_lines', 'list_my_proposals']);
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
      { action: 'start_reconciliation', input: { bankAccountId: '11111111-2222-4333-8444-555555555555', statementDate: '2026-03-31', statementBalance: '10.00' }, requestId: 'ro-4' },
    ]) {
      const out = await ok(tokens.reader, body);
      expect(out.outcome, body.action).toBe('refused');
      // The role is looked at first: a right the Bookkeeper role lacks is said as that.
      expect(out.note, body.action).toMatch(body.action === 'void_invoice' ? ROLE : NEVER);
      expect(out.action).toBe(body.action);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('is refused an edit or a void before the record is looked at: nothing says who changed it last, or whether it exists', async () => {
    const invoiceId = await someInvoice();
    const before = await fingerprint();
    const invoiceBody = { customerId: rich.customerId, date: '2026-03-13', lines: [{ accountId: acct['4000'], quantity: '1', rate: '10' }] };
    for (const body of [
      { action: 'edit_invoice', input: { id: invoiceId, expectedUpdatedAt: STALE, changes: invoiceBody }, requestId: 'ro-stale-1' },
      { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0101' } }, requestId: 'ro-stale-2' },
      { action: 'void_invoice', input: { id: invoiceId, expectedUpdatedAt: STALE }, requestId: 'ro-stale-3' },
      { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0101' } }, dryRun: true },
      // A record that does not exist is refused the same way: not a "not found".
      { action: 'deactivate_customer', input: { id: '11111111-2222-4333-8444-555555555555', expectedUpdatedAt: STALE }, requestId: 'ro-stale-4' },
      // The action's own check on a new item comes after the policy too.
      { action: 'add_item', input: { name: 'Stocked Widget', type: 'inventory', openingQuantity: '5', openingValue: '50' }, requestId: 'ro-stock' },
    ]) {
      const r = await act(tokens.reader, body);
      const label = `${body.action}: ${JSON.stringify(r.json).slice(0, 400)}`;
      expect(r.status, label).toBe(200);
      expect(r.json.outcome, label).toBe('refused');
      expect(r.json.note, label).toMatch(body.action === 'void_invoice' || body.action === 'deactivate_customer' ? ROLE : NEVER);
      expect(JSON.stringify(r.json), label).not.toMatch(RECORD_FACTS);
      expect(JSON.stringify(r.json), label).not.toMatch(/Opening stock/);
      expect(r.json.summary, label).toBeUndefined();
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('can still see what it asked for (nothing), as list_my_requests answers', async () => {
    const out = await ok(tokens.reader, { action: 'list_my_proposals', input: {} });
    expect(out).toMatchObject({ outcome: 'read', result: { count: 0, requests: [] } });
    expect((await ok(tokens.reader, { verb: 'list_my_requests' })).requests).toEqual([]);
  });
});

describe('a dry run', () => {
  it('says what would be entered and leaves the books exactly as they were', async () => {
    const before = await fingerprint();
    const out = await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-02', '45.10'), dryRun: true });
    expect(out.outcome).toBe('dry_run');
    expect(out.operation).toBe('journal-entries.create');
    expect(out.summary).toBe('Journal entry 2026-03-02: Office supplies bought with cash ($45.10)');
    expect(out.ledger.entries).toHaveLength(1);
    expect(out.ledger.entries[0]).toMatchObject({ date: '2026-03-02', status: 'posted' });
    expect(out.ledger.entries[0].lines).toEqual([
      expect.objectContaining({ accountCode: '6300', accountName: 'Office Supplies', debit: '45.10', credit: null }),
      expect.objectContaining({ accountCode: '1000', accountName: 'Checking', debit: null, credit: '45.10' }),
    ]);
    expect(out.ledger.changes).toContainEqual(expect.objectContaining({ action: 'create', kind: 'journal_entry' }));
    expect(out.result).toMatchObject({ type: 'journal_entry', date: '2026-03-02', status: 'posted' });
    expect(out.note).toMatch(/Nothing was kept/);
    expect(out.note).toMatch(/done straight away/);
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

describe('Trusted bookkeeper', () => {
  let entryId: string;
  let first: Out;

  it('needs a request id for anything that is kept', async () => {
    const before = await fingerprint();
    for (const requestId of [undefined, '', 'x', 'has spaces in it', 'a'.repeat(200), 'a'.repeat(400), 42]) {
      const r = await act(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '12.00'), ...(requestId === undefined ? {} : { requestId }) });
      expect(r.status, String(requestId)).toBe(400);
      expect(r.json.error).toMatch(/request_id/);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it("enters the change, under the agent's name", async () => {
    first = await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '12.00'), requestId: 'je-2026-03-03-supplies' });
    expect(first.outcome).toBe('posted');
    expect(first.operation).toBe('journal-entries.create');
    expect(first.result).toMatchObject({ type: 'journal_entry', date: '2026-03-03', status: 'posted' });
    entryId = first.result.id;
    expect(first.ledger.entries[0].journalEntryId).toBe(entryId);

    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    // The agent is recorded on the entry, next to the person answerable for it (the Admin who let it in).
    expect(row.agentId).toBe(agentIds.poster);
    expect(row.createdBy).toBe(rich.ctx.userId);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, entryId), eq(auditLogs.entityType, 'journal_entry')));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.userId === null && a.agentId === agentIds.poster && a.approvedBy === null)).toBe(true);
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
    // The id is the operation's: run_operation cannot use it for a request of its own either.
    const generic = await act(tokens.poster, { verb: 'run_operation', operation: 'journal-entries.create', body: journal('2026-03-03', '19.00'), requestId: 'je-2026-03-03-supplies' });
    expect(generic.status).toBe(409);
    expect(await fingerprint()).toEqual(before);
    expect(agentInputHash('x', { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(agentInputHash('x', { b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(agentInputHash('x', { a: 1 })).not.toBe(agentInputHash('x', { a: 2 }));
  });

  it('the same request id for a different change is refused', async () => {
    const before = await fingerprint();
    const other = await act(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '13.00'), requestId: 'je-2026-03-03-supplies' });
    expect(other.status).toBe(409);
    expect(other.json.error).toMatch(/already used for a different/);
    const otherAction = await act(tokens.poster, { action: 'add_customer', input: { displayName: 'Collision' }, requestId: 'je-2026-03-03-supplies' });
    expect(otherAction.status).toBe(409);
    expect(await fingerprint()).toEqual(before);
    // Another agent's ids are its own.
    const mine = await ok(tokens.apClerk, { action: 'add_vendor', input: { displayName: 'Shared Id Vendor' }, requestId: 'je-2026-03-03-supplies' });
    expect(mine.outcome).toBe('done');
  });

  it('an answer kept under a request id before the one path is given again as it was', async () => {
    const input = journal('2026-03-03', '14.00', 'Entered by the old runner');
    const stored = { action: 'enter_journal_entry', outcome: 'posted', summary: 'old', result: { type: 'journal_entry', id: 'old-id' } };
    // The old runner hashed the input as its schema read it.
    const parsed = AGENT_ACTIONS.find((a) => a.name === 'enter_journal_entry')!.schema.parse(input);
    await db.insert(agentRequests).values({ companyId: admin.companyId, agentId: agentIds.poster, requestKey: 'old-runner-1', action: 'enter_journal_entry', inputHash: agentInputHash('enter_journal_entry', parsed), outcome: 'posted', result: stored });
    const before = await fingerprint();
    expect(await ok(tokens.poster, { action: 'enter_journal_entry', input, requestId: 'old-runner-1' })).toEqual({ ...stored, replayed: true });
    const other = await act(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-03-03', '15.00'), requestId: 'old-runner-1' });
    expect(other.status).toBe(409);
    expect(await fingerprint()).toEqual(before);
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

  it('enters each kind of transaction through its own route', async () => {
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
    expect(paidBill.summary).toBe('Pay 1 bill(s) of Agent Made Vendor 2026-03-09 ($310.00)');
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

  it('a duplicate bill number is a warning the agent may accept, not an error', async () => {
    const vendorId = rich.vendorId;
    const input = { vendorId, billNumber: 'DUP-1', date: '2026-03-08', lines: [{ accountId: acct['6300'], amount: '10.00' }] };
    expect((await ok(tokens.poster, { action: 'enter_bill', requestId: 'dup-bill-1', input })).outcome).toBe('posted');
    const warned = await ok(tokens.poster, { action: 'enter_bill', requestId: 'dup-bill-2', input });
    expect(warned.outcome).toBe('needs_confirmation');
    expect(warned.warnings.map((w: Out) => w.flag)).toContain('allowDuplicateNumber');
    const accepted = await ok(tokens.poster, { action: 'enter_bill', requestId: 'dup-bill-2', input: { ...input, allowDuplicateNumber: true } });
    expect(accepted.outcome).toBe('posted');
  });

  it('edits and voids, and will not overwrite a change made since it last looked', async () => {
    const made = await ok(tokens.poster, { action: 'enter_journal_entry', requestId: 'je-edit-1', input: journal('2026-03-12', '30.00', 'To be edited') });
    const before = await fingerprint();
    const stale = await act(tokens.poster, {
      action: 'edit_journal_entry',
      requestId: 'je-edit-1-stale',
      input: { id: made.result.id, expectedUpdatedAt: '2020-01-01T00:00:00.000Z', changes: journal('2026-03-12', '30.00', 'Edited by a stale agent') },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.details).toMatchObject({ staleVersion: true });
    expect(await fingerprint()).toEqual(before);

    const edited = await ok(tokens.poster, {
      action: 'edit_journal_entry',
      requestId: 'je-edit-1-memo',
      input: { id: made.result.id, expectedUpdatedAt: made.result.updated_at, changes: journal('2026-03-12', '30.00', 'Edited description') },
    });
    expect(edited.operation).toBe('journal-entries.update');
    // Only its description changed: whether that counts as posting is the door's to say. The
    // measure is run_operation's answer to the very same edit of a twin entry.
    const twin = await ok(tokens.poster, { action: 'enter_journal_entry', requestId: 'je-edit-1-twin', input: journal('2026-03-12', '30.00', 'To be edited') });
    const generic = await ok(tokens.poster, {
      verb: 'run_operation',
      operation: 'journal-entries.update',
      params: { id: twin.result.id },
      body: journal('2026-03-12', '30.00', 'Edited description'),
      expectedUpdatedAt: twin.result.updated_at,
      requestId: 'je-edit-1-twin-memo',
    });
    expect(['posted', 'done'], JSON.stringify(generic).slice(0, 300)).toContain(generic.outcome);
    expect(edited.outcome).toBe(generic.outcome);
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, edited.result.id));
    expect(row.description).toBe('Edited description');

    // Voiding a journal entry needs the Delete right there, which the Bookkeeper role does not have
    // (for a person either). An agent with Full Access may.
    const denied = await ok(tokens.poster, { action: 'void_journal_entry', requestId: 'je-edit-1-void', input: { id: edited.result.id } });
    expect(denied.outcome).toBe('refused');
    expect(denied.note).toMatch(ROLE);
    const voided = await ok(tokens.fullPoster, { action: 'void_journal_entry', requestId: 'je-edit-1-void', input: { id: edited.result.id } });
    expect(voided.result.status).toBe('void');
    // Full Access carries the closed-period flag for people; an agent's own run never has it.
    const check = await ok(tokens.fullPoster, { action: 'write_check', requestId: 'chk-void-1', input: { payeeName: 'Petty Cash', date: '2026-03-12', method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '15.00' }] } });
    expect((await ok(tokens.fullPoster, { action: 'void_check', requestId: 'chk-void-1-void', input: { id: check.result.id, expectedUpdatedAt: check.result.updated_at } })).result.status).toBe('void');
    const gone = await act(tokens.fullPoster, { action: 'void_invoice', requestId: 'no-such-invoice', input: { id: '11111111-2222-4333-8444-555555555555' } });
    expect(gone.status).toBe(404);
  });

  it('never posts on or before the closing date on its own: it asks a person, and a closing password it sends is ignored', async () => {
    await db.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || '{"closingDate":"2026-01-31"}'::jsonb` }).where(eq(companies.id, admin.companyId));
    try {
      const before = await books();
      const closed = journal('2026-01-15', '10.00', 'Into a closed period');
      // The Bookkeeper role has no closed-period right, so it cannot even ask.
      for (const how of [{ dryRun: true }, { requestId: 'closed-period-0' }]) {
        const out = await ok(tokens.poster, { action: 'enter_journal_entry', input: closed, ...how });
        expect(out.outcome).toBe('refused');
        expect(out.note).toMatch(ROLE);
      }
      // Full Access has it: the agent asks, and a person (who types any closing password) decides.
      const dry = await ok(tokens.fullPoster, { action: 'enter_journal_entry', input: closed, dryRun: true });
      expect(dry.outcome).toBe('dry_run');
      expect(dry.note).toMatch(/ask a person first/);
      const real = await act(
        tokens.fullPoster,
        { action: 'enter_journal_entry', input: closed, requestId: 'closed-period-1', reason: 'The January supplies were missed.' },
        { 'x-closing-password': 'anything' },
      );
      expect(real.status).toBe(200);
      expect(real.json.outcome).toBe('asked');
      expect(real.json.needs.flags ?? [real.json.needs.flag]).toContain('closedPeriod');
      expect(await books()).toEqual(before);
      const [asked] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, real.json.requestId));
      expect(asked).toMatchObject({ status: 'pending', reason: 'The January supplies were missed.', agentId: agentIds.fullPoster });
      // After the closing date it is the agent's own work again.
      expect((await ok(tokens.poster, { action: 'enter_journal_entry', input: journal('2026-02-01', '10.00', 'Open period'), dryRun: true })).note).toMatch(/done straight away/);
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
        const out = await ok(tokens.apClerk, { ...body, ...how });
        expect(out.outcome, body.action).toBe('refused');
        expect(out.note, body.action).toMatch(ROLE);
        // The refusal says nothing it read from the books: not the name of the customer the
        // invoice was for (A/P Clerk has no Customers), nor an account's.
        expect(JSON.stringify(out), body.action).not.toMatch(/Acme|Checking|Office Supplies/);
        expect(out.summary, body.action).toBeUndefined();
      }
    }
    // Editing or voiding an invoice is outside the role: refused before the version it names is
    // compared, so the answer never says who changed the invoice last, or when.
    const invoiceId = await someInvoice();
    for (const body of [
      { action: 'void_invoice', input: { id: invoiceId, expectedUpdatedAt: STALE } },
      { action: 'edit_invoice', input: { id: invoiceId, expectedUpdatedAt: STALE, changes: { customerId: rich.customerId, date: '2026-03-13', lines: [{ accountId: acct['4000'], quantity: '1', rate: '10' }] } } },
      { action: 'void_invoice', input: { id: '11111111-2222-4333-8444-555555555555', expectedUpdatedAt: STALE } },
    ]) {
      for (const how of [{ dryRun: true }, { requestId: `denied-stale-${body.action}` }]) {
        const r = await act(tokens.apClerk, { ...body, ...how });
        const label = `${body.action}: ${JSON.stringify(r.json).slice(0, 400)}`;
        expect(r.status, label).toBe(200);
        expect(r.json.outcome, label).toBe('refused');
        expect(r.json.note, label).toMatch(ROLE);
        expect(JSON.stringify(r.json), label).not.toMatch(RECORD_FACTS);
      }
    }
    // Reports Only on Trusted bookkeeper: the policy allows changes, the role allows none.
    for (const body of [
      { action: 'enter_journal_entry', input: journal('2026-03-13', '10.00') },
      { action: 'enter_bill', input: { vendorId: rich.vendorId, date: '2026-03-13', lines: [{ accountId: acct['6300'], amount: '40.00' }] } },
      { action: 'add_customer', input: { displayName: 'Nope' } },
      { action: 'void_invoice', input: { id: '11111111-2222-4333-8444-555555555555' } },
    ]) {
      const out = await ok(tokens.reportsPoster, { ...body, requestId: `reports-${body.action}` });
      expect(out.outcome, body.action).toBe('refused');
      expect(out.note, body.action).toMatch(ROLE);
    }
    expect(await fingerprint(['agent_requests'])).toEqual(before);
  });

  it('opening stock is left to a person', async () => {
    const r = await act(tokens.poster, { action: 'add_item', dryRun: true, input: { name: 'Stocked Widget', type: 'inventory', openingQuantity: '5', openingValue: '50' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Opening stock is entered in Ironbooks/);
  });

  it('making a customer inactive is treated like a delete: it always asks a person', async () => {
    const out = await ok(tokens.fullPoster, { action: 'deactivate_customer', input: { id: rich.customerId }, requestId: 'cust-off-1' });
    expect(out).toMatchObject({ outcome: 'asked', operation: 'customers.delete', status: 'pending' });
    // A request with no reason field at all (a connector older than the field) is said as such
    // on the card, never made up.
    const [asked] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, out.requestId));
    expect(asked.reason).toMatch(/No reason given: the agent used the "deactivate_customer" tool/);
  });

  it("the agent's own reason goes to the card; a reason sent empty is not made up", async () => {
    const said = await ok(tokens.fullPoster, { action: 'deactivate_vendor', input: { id: rich.vendorId }, requestId: 'vend-off-reason', reason: '  The vendor closed its doors in March.  ' });
    expect(said).toMatchObject({ outcome: 'asked', operation: 'vendors.delete', status: 'pending' });
    const [asked] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, said.requestId));
    expect(asked.reason).toBe('The vendor closed its doors in March.');
    // Sent, but empty: the client knows the field, so the door's own rule answers (operate.ts
    // NO_REASON_NOTE) and nobody is asked.
    const count = (await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.fullPoster))).length;
    for (const reason of ['', '   ']) {
      const empty = await ok(tokens.fullPoster, { action: 'deactivate_vendor', input: { id: rich.vendorId }, requestId: `vend-off-empty-${reason.length}`, reason });
      expect(empty.outcome).toBe('refused');
      expect(empty.note).toBe(NO_REASON_NOTE);
    }
    expect(await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.fullPoster))).toHaveLength(count);
    // Text that is not text is refused before anything is looked at.
    const bad = await act(tokens.fullPoster, { action: 'deactivate_vendor', input: { id: rich.vendorId }, requestId: 'vend-off-bad', reason: 42 });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('VALIDATION');
  });

  it("the ledger it would post names each line's customer or vendor and class, and shows a memo's account number masked", async () => {
    const [retail] = await db.select({ id: classes.id }).from(classes).where(and(eq(classes.companyId, admin.companyId), eq(classes.name, 'Retail')));
    expect(retail?.id).toBeTruthy();
    const out = await ok(tokens.poster, {
      action: 'enter_journal_entry',
      dryRun: true,
      input: {
        date: '2026-03-12',
        description: 'Fee for acct # 000999888777',
        lines: [
          { accountId: acct['1200'], debit: '25.00', entityType: 'customer', entityId: rich.customerId, classId: retail.id, memo: 'Acct # 000123456789' },
          { accountId: acct['4000'], credit: '25.00' },
        ],
      },
    });
    expect(out.outcome).toBe('dry_run');
    const [entry] = out.ledger.entries;
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountCode: '1200', debit: '25.00', entityName: 'Acme "Quoted" Corp', className: 'Retail' }),
      expect.objectContaining({ accountCode: '4000', credit: '25.00', entityName: null, className: null }),
    ]);
    // The agent's own run never has the full-numbers right: in the ledger it is shown, the numbers
    // come back masked (the action's own one-line summary repeats its input as it was sent).
    expect(JSON.stringify({ ledger: out.ledger, preview: out.preview })).not.toMatch(/000123456789|000999888777/);
    expect(entry.lines[0].memo).toMatch(/^Acct # ••••/);
    expect(entry.description).toMatch(/^Fee for acct # ••••/);
  });
});

describe('what a change did, as the caller may see it (changesInTransaction)', () => {
  /** Enter one entry in a transaction that is rolled back, and read what it did as `access` may see it. */
  async function previewAs(access: ServiceContext['access']): Promise<ChangePreview> {
    const [retail] = await db.select({ id: classes.id }).from(classes).where(and(eq(classes.companyId, admin.companyId), eq(classes.name, 'Retail')));
    let seen: ChangePreview | null = null;
    const back = new Error('rolled back');
    await db
      .transaction(async (tx) => {
        const ctx: ServiceContext = { ...admin, db: tx as unknown as DB, access };
        await createManualEntry(ctx, {
          date: new Date('2026-03-19T00:00:00.000Z'),
          description: 'Sales tax paid, acct # 000999888777',
          lines: [
            { accountId: acct['2000'], debit: '40.00', entityType: 'vendor', entityId: rich.vendorId, classId: retail.id, memo: 'Acct # 000123456789' },
            { accountId: acct['1000'], credit: '40.00', memo: 'Paper' },
          ],
        });
        seen = await changesInTransaction(ctx);
        throw back;
      })
      .catch((err) => {
        if (err !== back) throw err;
      });
    return seen!;
  }

  it('masks account numbers in memos and descriptions unless the caller may see them in full; each line names its vendor and class', async () => {
    const before = await fingerprint();
    const masked = await previewAs(unionRoles([builtinRole('bookkeeper')!]));
    expect(masked.entries).toHaveLength(1);
    expect(masked.entries[0].description).toBe('Sales tax paid, acct # ••••8777');
    expect(masked.entries[0].lines).toEqual([
      expect.objectContaining({ accountCode: '2000', debit: '40.00', memo: 'Acct # ••••6789', entityName: 'Paper Supply Co', className: 'Retail' }),
      expect.objectContaining({ accountCode: '1000', credit: '40.00', memo: 'Paper', entityName: null, className: null }),
    ]);
    expect(masked.changes).toContainEqual(expect.objectContaining({ action: 'create', kind: 'journal_entry' }));
    // A caller with the right sees them as they were typed.
    const full = await previewAs(fullAccess());
    expect(full.entries[0].description).toBe('Sales tax paid, acct # 000999888777');
    expect(full.entries[0].lines[0]).toMatchObject({ memo: 'Acct # 000123456789', entityName: 'Paper Supply Co', className: 'Retail' });
    expect(await fingerprint()).toEqual(before);
  });

  it('a vendor or class name typed with an account number is shown by the same rule as a memo', async () => {
    const before = await fingerprint();
    /** The first line of an entry for a vendor and a class named with account numbers, as `access` may see it. */
    async function lineAs(access: ServiceContext['access']) {
      const seen: { preview: ChangePreview | null } = { preview: null };
      const back = new Error('rolled back');
      await db
        .transaction(async (tx) => {
          const ctx: ServiceContext = { ...admin, db: tx as unknown as DB, access };
          const vendor = await createVendor({ ...ctx, access: fullAccess() }, { displayName: 'Trust acct # 000111222333' } as Parameters<typeof createVendor>[1]);
          const [cls] = await tx.insert(classes).values({ companyId: admin.companyId, name: 'Escrow acct # 000555444333' }).returning();
          await createManualEntry(ctx, {
            date: new Date('2026-03-19T00:00:00.000Z'),
            description: 'Escrow deposit',
            lines: [
              { accountId: acct['2000'], debit: '25.00', entityType: 'vendor', entityId: vendor.id, classId: cls.id },
              { accountId: acct['1000'], credit: '25.00' },
            ],
          });
          seen.preview = await changesInTransaction(ctx);
          throw back;
        })
        .catch((err) => {
          if (err !== back) throw err;
        });
      expect(seen.preview?.entries).toHaveLength(1);
      return seen.preview!.entries[0].lines[0];
    }
    expect(await lineAs(unionRoles([builtinRole('bookkeeper')!]))).toMatchObject({ entityName: 'Trust acct # ••••2333', className: 'Escrow acct # ••••4333' });
    expect(await lineAs(fullAccess())).toMatchObject({ entityName: 'Trust acct # 000111222333', className: 'Escrow acct # 000555444333' });
    expect(await fingerprint()).toEqual(before);
  });
});

describe('Ask for every change', () => {
  let requestId: string;
  let proposalsBefore: number;
  const input = () => journal('2026-03-14', '77.00', 'Proposed supplies');

  it('checks the change, asks a person, and enters nothing', async () => {
    proposalsBefore = (await db.select().from(aiProposals)).length;
    const before = await books();
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: input(), requestId: 'prop-1', reason: 'Supplies bought on the 14th.' });
    expect(out).toMatchObject({ action: 'enter_journal_entry', operation: 'journal-entries.create', outcome: 'asked', status: 'pending' });
    expect(out.summary).toBe('Journal entry 2026-03-14: Proposed supplies ($77.00)');
    expect(out.note).toMatch(/Nothing is done yet/);
    requestId = out.requestId;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // What the approval card shows: the ledger lines of the preview.
    expect(out.ledger.entries[0].lines.map((l: Out) => [l.accountCode, l.debit, l.credit])).toEqual([['6300', '77.00', null], ['1000', null, '77.00']]);
    expect(await books()).toEqual(before);

    const [row] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, requestId));
    expect(row).toMatchObject({ status: 'pending', agentId: agentIds.proposer, operation: 'journal-entries.create', reason: 'Supplies bought on the 14th.' });
    // Nothing goes to the old approval queue any more.
    expect((await db.select().from(aiProposals)).length).toBe(proposalsBefore);
  });

  it('the same request again is the same request, not a second one', async () => {
    const again = await ok(tokens.proposer, { action: 'enter_journal_entry', input: input(), requestId: 'prop-1' });
    expect(again).toMatchObject({ replayed: true, outcome: 'asked', requestId });
    expect(await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.proposer))).toHaveLength(1);
  });

  it('something that would be refused is refused now, not asked', async () => {
    const r = await act(tokens.proposer, {
      action: 'enter_journal_entry',
      requestId: 'prop-bad',
      input: { date: '2026-03-14', description: 'Unbalanced proposal', lines: [{ accountId: acct['6300'], debit: '10.00' }, { accountId: acct['1000'], credit: '9.00' }] },
    });
    expect(r.status).toBe(400);
    expect(await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.proposer))).toHaveLength(1);
  });

  it('the agent can see its request waiting', async () => {
    const out = await ok(tokens.proposer, { action: 'list_my_proposals', input: {} });
    expect(out.result.count).toBe(1);
    expect(out.result.requests).toEqual([expect.objectContaining({ id: requestId, operation: 'journal-entries.create', status: 'pending', decidedAt: null })]);
    // Another agent sees none of it.
    expect((await ok(tokens.poster, { action: 'list_my_proposals', input: {} })).result.requests.map((r: Out) => r.id)).not.toContain(requestId);
  });

  it('a person without the right cannot approve it', async () => {
    const [viewer] = await db.insert(users).values({ email: 'viewer@actions.test', name: 'Vera Viewer', passwordHash: 'x' }).returning();
    await db.insert(userCompanies).values({ userId: viewer.id, companyId: admin.companyId, role: 'viewer' });
    await db.insert(userRoleAssignments).values({ userId: viewer.id, companyId: admin.companyId, roleKey: 'ar_clerk' });
    // A/R Clerk: no journal entries. The approval runs under the approver's own permissions.
    const clerk: ServiceContext = { db, companyId: admin.companyId, userId: viewer.id, role: 'accountant', access: unionRoles([builtinRole('ar_clerk')!]) };
    // Refused (or not even shown to them): either way nothing is approved.
    await expect(approveAgentRequest(clerk, requestId, {}, { atHost: true })).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
    const [row] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, requestId));
    expect(row.status).toBe('pending');
  });

  it("a person approves it: entered, named as the agent's and approved by them", async () => {
    const approved = await approveAgentRequest(admin, requestId, {}, { atHost: true });
    expect(approved.status).toBe('executed');
    const [entry] = await db.select().from(journalEntries).where(and(eq(journalEntries.agentId, agentIds.proposer), eq(journalEntries.description, 'Proposed supplies')));
    expect(entry).toMatchObject({ status: 'posted' });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, entry.id), eq(auditLogs.entityType, 'journal_entry')));
    expect(audit.every((a) => a.agentId === agentIds.proposer && a.approvedBy === rich.ctx.userId && a.agentRequestId === requestId)).toBe(true);
    const trail = await listAuditLogs(admin, { entityType: 'journal_entry', limit: 300 });
    expect(trail.rows.find((r) => r.entityId === entry.id)?.actorName).toBe('Agent proposer (agent), approved by Owner Person');
    expect(readAllTransactionLog(TEST_DIR).records.find((r) => r.entityId === entry.id)?.userName).toBe('Agent proposer (agent), approved by Owner Person');
    // Approving twice does nothing more.
    await expect(approveAgentRequest(admin, requestId, {}, { atHost: true })).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|VALIDATION/) });
    const out = await ok(tokens.proposer, { action: 'list_my_proposals', input: {} });
    expect(out.result.requests[0]).toMatchObject({ id: requestId, status: 'executed' });
    // Asking again with its request id says what became of it, in the action's words.
    const again = await ok(tokens.proposer, { action: 'enter_journal_entry', input: input(), requestId: 'prop-1' });
    expect(again).toMatchObject({ replayed: true, outcome: 'posted', result: { type: 'journal_entry', id: entry.id, status: 'posted' } });
  });

  it('a person says no: nothing is entered', async () => {
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: journal('2026-03-15', '5.00', 'To be denied'), requestId: 'prop-2' });
    expect(out.outcome).toBe('asked');
    const before = await books();
    expect((await denyAgentRequest(admin, out.requestId, 'Not this one')).status).toBe('denied');
    expect(await books()).toEqual(before);
    const again = await ok(tokens.proposer, { action: 'enter_journal_entry', input: journal('2026-03-15', '5.00', 'To be denied'), requestId: 'prop-2' });
    expect(again).toMatchObject({ outcome: 'refused', replayed: true });
    expect(again.note).toMatch(/Not this one/);
  });

  it('prepare work is done at once; a dry run asks nothing', async () => {
    const count = (await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.proposer))).length;
    const out = await ok(tokens.proposer, { action: 'enter_journal_entry', input: journal('2026-03-16', '9.00'), dryRun: true });
    expect(out.outcome).toBe('dry_run');
    expect(out.note).toMatch(/ask a person first/);
    // Starting a reconciliation is prepare work, which this preset allows.
    const bank = await newBank('Ask Test');
    const started = await ok(tokens.proposer, { action: 'start_reconciliation', input: { bankAccountId: bank, statementDate: '2026-03-31', statementBalance: '100.00' }, requestId: 'prop-recon-1' });
    expect(started).toMatchObject({ outcome: 'done', operation: 'reconciliations.create', result: { status: 'in_progress', statement_date: '2026-03-31', statement_balance: '100.00' } });
    expect(started.result.reconciliation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.result.difference).toMatch(/^-?\d+\.\d{2}$/);
    expect(await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentIds.proposer))).toHaveLength(count);
    // Cancelling it removes it for good: that asks, for every preset.
    const cancel = await ok(tokens.proposer, { action: 'cancel_reconciliation', input: { reconciliationId: started.result.reconciliation_id }, requestId: 'prop-recon-1-off' });
    expect(cancel.outcome).toBe('refused');
    expect(cancel.note).toMatch(ROLE);
    expect((await ok(tokens.fullPoster, { action: 'cancel_reconciliation', input: { reconciliationId: started.result.reconciliation_id }, requestId: 'recon-1-off' })).outcome).toBe('asked');
    // Nothing went to the old approval queue on the way.
    expect((await db.select().from(aiProposals)).length).toBe(proposalsBefore);
  });

  // FAILS today (wave 4, curated): the version reaches the door and the route for the agent's own
  // run and its dry run, but lib/services/agentRequests.ts createAgentRequest guards the input
  // again (guardInput keeps params, query, body, confirm and reveal only), so the stored request
  // has no expectedUpdatedAt ({"body":{"phone":"555-0400"},"params":{"id":…}}). runApproved
  // (lib/agent/operate.ts withVersion) then has none to send, and once the person says yes on the
  // "books changed" preview the agent's edit is written over theirs. Keeping expectedUpdatedAt in
  // the stored input (as operate.ts withVersion does after its guards) makes this pass: then it.fails
  // becomes it.
  it.fails("a person's edit made after the agent asked is never overwritten: the version the agent read is compared when the work runs", async () => {
    const [read] = await db.select({ updatedAt: customers.updatedAt }).from(customers).where(eq(customers.id, rich.customerId));
    const out = await ok(tokens.proposer, {
      action: 'edit_customer',
      input: { id: rich.customerId, expectedUpdatedAt: read.updatedAt.toISOString(), changes: { phone: '555-0400' } },
      requestId: 'prop-cust-phone',
      reason: 'The new phone number on the March remittance.',
    });
    expect(out).toMatchObject({ outcome: 'asked', operation: 'customers.update', status: 'pending' });
    // Someone changes the same customer in Ironbooks before the request is approved.
    await updateCustomer(admin, rich.customerId, { phone: '555-0500' });
    const approve = async (input: Parameters<typeof approveAgentRequest>[2]) => {
      try {
        return (await approveAgentRequest(admin, out.requestId, input, { atHost: true })).status;
      } catch (err) {
        return `threw ${(err as { code?: string }).code ?? ''}`;
      }
    };
    let status = await approve({});
    // Shown the books changed, the person says yes again on what they now see: still not run over
    // the version the agent read.
    if (status === 'stale') status = await approve({ acceptStale: true });
    expect(status).not.toBe('executed');
    const [now] = await db.select({ phone: customers.phone }).from(customers).where(eq(customers.id, rich.customerId));
    expect(now.phone).toBe('555-0500');
  });
});

describe('a proposal still waiting in the old approval queue', () => {
  it('is entered the old way when a person approves its copy, named as the agent\'s and approved by them', async () => {
    const input = journal('2026-03-17', '21.00', 'Proposed before the upgrade');
    const [proposal] = await db
      .insert(aiProposals)
      .values({
        companyId: admin.companyId,
        createdBy: null,
        agentId: agentIds.proposer,
        kind: AGENT_PROPOSAL_KIND,
        summary: 'Journal entry 2026-03-17: Proposed before the upgrade ($21.00)',
        payload: { date: '2026-03-17', description: 'old', reference: null, lines: [], totalDebit: '21.00', rationale: null, agent: { id: agentIds.proposer, name: 'Agent proposer' }, action: 'enter_journal_entry', input, changes: [] },
        status: 'pending',
      })
      .returning();
    // What the upgrade (drizzle/0097) does with each one: a request named by the proposal.
    await db.insert(agentPermissionRequests).values({
      companyId: admin.companyId,
      agentId: agentIds.proposer,
      requestKey: `proposal:${proposal.id}`,
      operation: 'action:enter_journal_entry',
      class: 'change',
      input: input as unknown as Record<string, unknown>,
      summary: proposal.summary,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      proposalId: proposal.id,
    });
    const [copy] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.proposalId, proposal.id));
    expect((await approveAgentRequest(admin, copy.id, {}, { atHost: true })).status).toBe('executed');
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.description, 'Proposed before the upgrade'));
    expect(entry).toMatchObject({ agentId: agentIds.proposer, createdBy: rich.ctx.userId, status: 'posted' });
    const trail = await listAuditLogs(admin, { entityType: 'journal_entry', limit: 300 });
    expect(trail.rows.find((r) => r.entityId === entry.id)?.actorName).toBe('Agent proposer (agent), approved by Owner Person');
    const [settled] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposal.id));
    expect(settled.status).toBe('approved');
  });
});

describe('an agent with the Admin role', () => {
  let bankId: string;
  let invoiceId: string;

  /**
   * Each curated action next to the same request sent to run_operation. `stale`: the request names
   * a version older than the record's (expectedUpdatedAt, which both send the same way).
   */
  const pairs = (): Array<{ action: string; input: Out; operation: string; request: Out; stale?: true }> => [
    { action: 'enter_journal_entry', input: journal('2026-03-18', '11.00'), operation: 'journal-entries.create', request: { body: journal('2026-03-18', '11.00') } },
    { action: 'add_customer', input: { displayName: 'Admin Agent Customer' }, operation: 'customers.create', request: { body: { displayName: 'Admin Agent Customer' } } },
    { action: 'edit_customer', input: { id: rich.customerId, changes: { phone: '555-0199' } }, operation: 'customers.update', request: { params: { id: rich.customerId }, body: { phone: '555-0199' } } },
    { action: 'deactivate_customer', input: { id: rich.customerId }, operation: 'customers.delete', request: { params: { id: rich.customerId } } },
    { action: 'deactivate_vendor', input: { id: rich.vendorId }, operation: 'vendors.delete', request: { params: { id: rich.vendorId } } },
    { action: 'undo_last_reconciliation', input: { bankAccountId: bankId }, operation: 'reconciliations.undo', request: { body: { bankAccountId: bankId, expectStatementDate: null } } },
    {
      action: 'import_statement_lines',
      input: { bankAccountId: bankId, kind: 'bank', openingBalance: '0.00', closingBalance: '-12.00', rows: [{ date: '2026-03-18', description: 'FEE', amount: '-12.00' }] },
      operation: 'import',
      request: { body: { bankAccountId: bankId, fileType: 'rows', rows: [{ date: '2026-03-18', description: 'FEE', amount: '-12.00' }], statement: { kind: 'bank', openingBalance: '0.00', closingBalance: '-12.00' }, filename: 'statement lines from an agent' } },
    },
    {
      action: 'edit_customer',
      input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0199' } },
      operation: 'customers.update',
      request: { params: { id: rich.customerId }, body: { phone: '555-0199' }, expectedUpdatedAt: STALE },
      stale: true,
    },
    { action: 'void_invoice', input: { id: invoiceId, expectedUpdatedAt: STALE }, operation: 'invoices.delete', request: { params: { id: invoiceId }, expectedUpdatedAt: STALE }, stale: true },
    // The one action decided by another route than its window's (lib/agent/banking.ts): it is
    // given exactly what the bank feed read is given.
    { action: 'bank_feed_suggestions', input: { bankAccountId: bankId }, operation: 'bank-transactions', request: { query: { bankAccountId: bankId } } },
  ];

  it('gets nothing through a curated action that run_operation would not give it', async () => {
    bankId = await newBank('Admin Agent');
    invoiceId = await someInvoice();
    resetAgentRateLimits();
    const before = await fingerprint(['agent_requests']);
    const seen = new Map<string, Set<string>>();
    for (const who of ['adminReader', 'adminAsks', 'adminTrusted', 'adminFull']) {
      for (const p of pairs()) {
        const curated = await act(tokens[who], { action: p.action, input: p.input, dryRun: true });
        const generic = await act(tokens[who], { verb: 'run_operation', operation: p.operation, ...p.request, dryRun: true });
        const label = `${who} ${p.action}: ${JSON.stringify(curated.json).slice(0, 300)} / ${JSON.stringify(generic.json).slice(0, 300)}`;
        if (p.stale && generic.json.outcome !== 'refused') {
          // A stale version is a 409 either way. Here the action's is its quick first check's
          // (with the details); run_operation's is the route's own compare inside the run. That
          // the action's request carries the version to the route too is shown by "the version
          // the agent last read" below, with the quick check switched off.
          expect(curated.status, label).toBe(409);
          expect(curated.json.details, label).toMatchObject({ staleVersion: true });
          // The route's own answer, as it gives it to a person's window too (some routes, the
          // customer's among them, answer without the details).
          expect(generic.status, label).toBe(409);
          expect(generic.json.code, label).toBe('CONFLICT');
          expect(generic.json.error, label).toMatch(/was changed by/);
          seen.set(who, (seen.get(who) ?? new Set()).add(`${p.action}:stale`));
          continue;
        }
        // Refused, the action says what run_operation says, and nothing of the record.
        if (p.stale) expect(JSON.stringify(curated.json), label).not.toMatch(RECORD_FACTS);
        expect(curated.status, label).toBe(generic.status);
        expect(curated.json.outcome, label).toBe(generic.json.outcome);
        expect(curated.json.note, label).toBe(generic.json.note);
        expect(curated.json.error, label).toBe(generic.json.error);
        if (curated.status === 200) expect(curated.json.operation, label).toBe(p.operation);
        const treatment = String(curated.json.outcome === 'refused' ? 'refused' : /ask a person first/.test(curated.json.note ?? '') ? 'ask' : curated.status === 200 ? 'run' : 'error');
        seen.set(who, (seen.get(who) ?? new Set()).add(`${p.action}:${treatment}`));
      }
    }
    // Read only refuses every change (the stale ones included, in the policy's words); it may read
    // the bank feed, so it is given the suggestions too. Removals always ask, whatever the preset.
    const readerSaw = [...seen.get('adminReader')!];
    expect(readerSaw.filter((s) => !s.startsWith('bank_feed_suggestions:')).every((s) => s.endsWith(':refused')), readerSaw.join(' ')).toBe(true);
    expect(readerSaw).toContain('bank_feed_suggestions:run');
    for (const who of ['adminAsks', 'adminTrusted', 'adminFull']) {
      expect(seen.get(who), who).toContain('deactivate_customer:ask');
      expect(seen.get(who), who).toContain('deactivate_vendor:ask');
      expect(seen.get(who), who).toContain('edit_customer:stale');
      expect(seen.get(who), who).toContain('void_invoice:stale');
      expect(seen.get(who), who).toContain('bank_feed_suggestions:run');
    }
    expect(seen.get('adminTrusted')).toContain('enter_journal_entry:run');
    expect(seen.get('adminAsks')).toContain('enter_journal_entry:ask');
    // Statement lines: whatever the registry says of a rows import (the loop above holds the
    // action to run_operation's own answer for the same request), "Full, with asks" does it
    // itself, since it allows both bulk work within its cap and prepare work.
    expect(seen.get('adminFull')).toContain('import_statement_lines:run');
    expect(await fingerprint(['agent_requests'])).toEqual(before);
  });

  it('a real request it may not make on its own asks, exactly as run_operation does', async () => {
    const curated = await ok(tokens.adminTrusted, { action: 'deactivate_vendor', input: { id: rich.vendorId }, requestId: 'admin-vendor-off', reason: 'Vendor closed.' });
    const generic = await ok(tokens.adminTrusted, { verb: 'run_operation', operation: 'vendors.delete', params: { id: rich.vendorId }, requestId: 'admin-vendor-off-2', reason: 'Vendor closed.' });
    expect(curated).toMatchObject({ outcome: 'asked', operation: 'vendors.delete', status: 'pending' });
    expect(generic).toMatchObject({ outcome: 'asked', operation: 'vendors.delete', status: 'pending' });
    expect(curated.needs).toEqual(generic.needs);
    // The Admin-role agent's own statement import, within its cap, is staged and posts nothing.
    const ledger = (await books()).ledger;
    const imported = await ok(tokens.adminFull, { action: 'import_statement_lines', input: pairs()[6].input, requestId: 'admin-import-1' });
    expect(imported).toMatchObject({ outcome: 'done', operation: 'import', result: { added_to_feed: 1, tied_out: true, difference: '0.00' } });
    expect((await books()).ledger).toEqual(ledger);
    // Asked again, through either door, it is the same request.
    expect(await ok(tokens.adminFull, { action: 'import_statement_lines', input: pairs()[6].input, requestId: 'admin-import-1' })).toMatchObject({ replayed: true, outcome: 'done' });
    expect(await ok(tokens.adminFull, { verb: 'run_operation', operation: 'import', ...pairs()[6].request, requestId: 'admin-import-1' })).toMatchObject({ replayed: true, outcome: 'done' });
  });
});

describe('the version the agent last read', () => {
  it("goes with the action's request to the door and the route, not only to the action's own quick check", async () => {
    resetAgentRateLimits();
    const made = await createCustomer(admin, { displayName: 'Version Check Customer' } as Parameters<typeof createCustomer>[1]);
    const current = async () => (await db.select({ updatedAt: customers.updatedAt, phone: customers.phone }).from(customers).where(eq(customers.id, made.id)))[0];
    const read = await current();
    const version = read.updatedAt.toISOString();

    // With the action's quick check off, a stale version is still refused, now by the route's own
    // compare inside the run (lib/services/concurrency.ts withVersionCheck): the real guard
    // against writing over a person's edit made after the check. It is run_operation's 409 word
    // for word, for a dry run and for a real request alike.
    h.quickCheckOff = true;
    try {
      for (const [how, genericHow] of [
        [{ dryRun: true }, { dryRun: true }],
        [{ requestId: 'version-route-1' }, { requestId: 'version-route-2' }],
      ] as Array<[Out, Out]>) {
        const curated = await act(tokens.adminTrusted, { action: 'edit_customer', input: { id: made.id, expectedUpdatedAt: STALE, changes: { phone: '555-0601' } }, ...how });
        const generic = await act(tokens.adminTrusted, { verb: 'run_operation', operation: 'customers.update', params: { id: made.id }, body: { phone: '555-0601' }, expectedUpdatedAt: STALE, ...genericHow });
        const label = `${JSON.stringify(how)}: ${JSON.stringify(curated.json).slice(0, 300)} / ${JSON.stringify(generic.json).slice(0, 300)}`;
        expect(curated.status, label).toBe(409);
        expect(curated.json.code, label).toBe('CONFLICT');
        expect(curated.json.error, label).toMatch(/was changed by/);
        expect(generic.status, label).toBe(409);
        expect(curated.json.error, label).toBe(generic.json.error);
      }
    } finally {
      h.quickCheckOff = false;
    }
    expect((await current()).phone).toBe(read.phone);

    // The request the door keeps under the request id is the action's request with its version:
    // run_operation with that same version is the same request (given again), without it a
    // different one.
    const edited = await ok(tokens.adminTrusted, { action: 'edit_customer', input: { id: made.id, expectedUpdatedAt: version, changes: { phone: '555-0602' } }, requestId: 'version-door-1' });
    expect(edited.outcome, JSON.stringify(edited).slice(0, 300)).not.toBe('refused');
    const same = await ok(tokens.adminTrusted, { verb: 'run_operation', operation: 'customers.update', params: { id: made.id }, body: { phone: '555-0602' }, expectedUpdatedAt: version, requestId: 'version-door-1' });
    expect(same).toMatchObject({ replayed: true, outcome: edited.outcome });
    const without = await act(tokens.adminTrusted, { verb: 'run_operation', operation: 'customers.update', params: { id: made.id }, body: { phone: '555-0602' }, requestId: 'version-door-1' });
    expect(without.status, JSON.stringify(without.json).slice(0, 300)).toBe(409);
    expect(without.json.error).toMatch(/already used for a different request/);
  });
});

describe('too much at once', () => {
  /** The door's own process-wide counts (lib/agent/operate.ts rateLimited and inRunSlot). */
  const store = globalThis as typeof globalThis & { __bkaAgentDoorRate?: Map<string, number[]>; __bkaAgentDoorRuns?: Map<string, number> };

  it('a curated action is slowed down exactly as run_operation is: 429 with Retry-After, never a refusal of the work', async () => {
    const bank = await newBank('Rate Test');
    const lines = { bankAccountId: bank, kind: 'bank', openingBalance: '0.00', closingBalance: '-3.00', rows: [{ date: '2026-03-21', description: 'FEE', amount: '-3.00' }] };
    // Through the door, its own run (import and suggestions, which "Full, with asks" does itself),
    // a refusal (Read only), the agent's own requests, and run_operation itself.
    const sent: Array<[string, Out]> = [
      ['adminFull', { action: 'enter_journal_entry', input: journal('2026-03-21', '3.00'), dryRun: true }],
      ['adminFull', { action: 'import_statement_lines', input: lines, dryRun: true }],
      ['adminFull', { action: 'import_statement_lines', input: lines, requestId: 'rate-import-1' }],
      ['adminFull', { action: 'bank_feed_suggestions', input: { bankAccountId: bank } }],
      ['adminReader', { action: 'import_statement_lines', input: lines, requestId: 'rate-import-2' }],
      ['adminReader', { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0102' } }, requestId: 'rate-edit-1' }],
      // Allowed, and stale: told to slow down, not that the record changed (nothing is read first).
      ['adminFull', { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0102' } }, requestId: 'rate-edit-2' }],
      ['adminFull', { action: 'void_invoice', input: { id: '11111111-2222-4333-8444-555555555555', expectedUpdatedAt: STALE }, requestId: 'rate-void-1' }],
      // An answer kept under its request id is not given before the count either.
      ['poster', { action: 'enter_journal_entry', input: journal('2026-03-03', '14.00', 'Entered by the old runner'), requestId: 'old-runner-1' }],
      ['adminFull', { verb: 'run_operation', operation: 'journal-entries.create', body: journal('2026-03-21', '3.00'), dryRun: true }],
    ];
    const before = await fingerprint();
    try {
      for (const [who, body] of [...sent, ['adminFull', { action: 'list_my_proposals', input: {} }] as [string, Out]]) {
        resetAgentRateLimits();
        store.__bkaAgentDoorRate!.set(agentIds[who], Array.from({ length: AGENT_CALLS_PER_MINUTE }, () => Date.now()));
        const r = await act(tokens[who], body);
        const label = `${who} ${body.action ?? body.verb}: ${JSON.stringify(r.json).slice(0, 300)}`;
        expect(r.status, label).toBe(429);
        expect(r.json.code, label).toBe('RATE_LIMITED');
        expect(Number(r.retryAfter), label).toBeGreaterThan(0);
        expect(r.json.error, label).toMatch(/more than \d+ requests in the last minute/);
      }
      for (const [who, body] of sent) {
        resetAgentRateLimits();
        store.__bkaAgentDoorRuns!.set(agentIds[who], AGENT_RUNS_AT_ONCE);
        const r = await act(tokens[who], body);
        const label = `${who} ${body.action ?? body.verb}: ${JSON.stringify(r.json).slice(0, 300)}`;
        expect(r.status, label).toBe(429);
        expect(r.json.code, label).toBe('RATE_LIMITED');
        expect(r.retryAfter, label).toBe('2');
        expect(r.json.error, label).toMatch(/requests under way/);
      }
      // A run of the action's own gives its place back, however it ends.
      resetAgentRateLimits();
      expect((await act(tokens.adminFull, { action: 'import_statement_lines', input: { ...lines, closingBalance: '-9.00' }, dryRun: true })).status).toBe(400);
      expect(store.__bkaAgentDoorRuns!.get(agentIds.adminFull) ?? 0).toBe(0);
    } finally {
      resetAgentRateLimits();
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('each request is one call, however it is answered: a stale version, a refusal, the door, its own run, an earlier answer', async () => {
    const bank = await newBank('Count Test');
    const lines = { bankAccountId: bank, kind: 'bank', openingBalance: '0.00', closingBalance: '-4.00', rows: [{ date: '2026-03-22', description: 'FEE', amount: '-4.00' }] };
    const sent: Array<[string, Out, number]> = [
      // Answered by the action's own check: counted all the same, so it cannot be repeated without limit.
      ['adminFull', { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0103' } }, requestId: 'count-edit-1' }, 409],
      ['adminReader', { action: 'edit_customer', input: { id: rich.customerId, expectedUpdatedAt: STALE, changes: { phone: '555-0103' } }, requestId: 'count-edit-2' }, 200],
      ['adminFull', { action: 'enter_journal_entry', input: journal('2026-03-22', '4.00'), dryRun: true }, 200],
      ['adminFull', { action: 'import_statement_lines', input: lines, dryRun: true }, 200],
      ['adminFull', { action: 'bank_feed_suggestions', input: { bankAccountId: bank } }, 200],
      // An answer kept under its request id before the one path (stored in "Trusted bookkeeper").
      ['poster', { action: 'enter_journal_entry', input: journal('2026-03-03', '14.00', 'Entered by the old runner'), requestId: 'old-runner-1' }, 200],
      ['adminFull', { action: 'list_my_proposals', input: {} }, 200],
    ];
    const before = await fingerprint(['agent_requests']);
    try {
      for (const [who, body, status] of sent) {
        resetAgentRateLimits();
        const r = await act(tokens[who], body);
        const label = `${who} ${body.action}: ${JSON.stringify(r.json).slice(0, 300)}`;
        expect(r.status, label).toBe(status);
        expect(store.__bkaAgentDoorRate!.get(agentIds[who])?.length ?? 0, label).toBe(1);
        expect(store.__bkaAgentDoorRuns!.get(agentIds[who]) ?? 0, label).toBe(0);
      }
    } finally {
      resetAgentRateLimits();
    }
    expect(await fingerprint(['agent_requests'])).toEqual(before);
  });
});

describe('request ids are kept per agent and never travel', () => {
  it('each kept change or ask has one row; refused and dry-run requests have none', async () => {
    const rows = await db.select().from(agentRequests);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => ['posted', 'done', 'asked', 'failed'].includes(r.outcome) && r.result !== null)).toBe(true);
    expect(rows.filter((r) => r.requestKey.startsWith('denied-') || r.requestKey.startsWith('reports-') || r.requestKey.startsWith('ro-'))).toEqual([]);
    expect(new Set(rows.map((r) => `${r.agentId}:${r.requestKey}`)).size).toBe(rows.length);
  });
});
