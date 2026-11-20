/**
 * Agent full access: permission requests (lib/services/agentRequests.ts), on a real PGlite company.
 * The run of an approved request (lib/agent/operate.ts runApproved), the input guard, the policy
 * store, grants and email are replaced: what is proved here is the approval system itself.
 *
 *  - every approval rule, each alone: the person's own route right, Admin, file Admin, role flags,
 *    the host computer, a request still waiting, a role that can make changes;
 *  - an agent's context (or a run inside an agent's scope) can never approve, deny or list for a person;
 *  - two clicks run the work once; two-person approval needs two different people, each passing
 *    every rule;
 *  - the books changed since the agent asked: nothing runs, the new preview waits for a second yes,
 *    and only someone shown the latest preview can give it;
 *  - an approved reveal's answer is read in full only by people holding the View flag it needed;
 *  - requests expire; a run cut off by a stop is settled later; an agent only ever sees its own;
 *    the same request id asks once;
 *  - a secret typed by the approver, produced by the run or put in the input by the agent never
 *    reaches the row, the audit trail or an error;
 *  - more than the hourly limit of asks pauses the agent;
 *  - a wait ends when a person decides, and when its time is up;
 *  - an email notice goes out only when nobody is signed in;
 *  - a request copied from an old proposal is settled in both tables, and never runs on the old
 *    path when it needs more than one plain yes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-requests');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-requests-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

const m = vi.hoisted(() => ({
  ops: new Map<string, unknown>(),
  policies: new Map<string, Record<string, unknown>>(),
  runApproved: vi.fn(),
  createGrant: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock('@/lib/agent/operations/registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  operationById: (id: string) => m.ops.get(id) ?? null,
}));
vi.mock('@/lib/agent/operate', () => ({
  runApproved: m.runApproved,
  operate: vi.fn(),
  handleVerb: vi.fn(),
}));
vi.mock('@/lib/agent/guards', async (importOriginal) => ({
  // The real helpers (the summary of a stale request is built with them), and a stand-in guard.
  ...(await importOriginal<Record<string, unknown>>()),
  // The guard unit strips secret fields and refuses the hard floor; a stand-in that does both.
  guardInput:(_op: unknown, input: { body?: Record<string, unknown> }) => {
    const body = { ...(input?.body ?? {}) };
    if (body.hardFloor) return { input, refused: 'Agents can never do this.', stripped: [] };
    delete body.password;
    return { input: { ...input, body }, refused: null, stripped: ['password'] };
  },
  applySecrets: vi.fn(),
  redactAnswer: vi.fn(),
}));
vi.mock('@/lib/services/agentPolicies', () => ({
  loadAgentPolicy: async (_ctx: unknown, agentId: string) => ({
    preset: 'ask_every_change',
    classes: {},
    areas: {},
    bulkCap: null,
    twoPersonOver: null,
    requestExpiryDays: 7,
    folders: [],
    notifyEmail: false,
    pausedAt: null,
    ...(m.policies.get(agentId) ?? {}),
  }),
}));
vi.mock('@/lib/services/agentGrants', () => ({
  createGrant: m.createGrant,
  liveGrants: vi.fn(),
  revokeGrant: vi.fn(),
  useGrant: vi.fn(),
  listGrants: vi.fn(),
}));
vi.mock('@/lib/services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMail: m.sendMail,
}));

import { getDb, closeDb, type DB } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import {
  agentPermissionRequests,
  agents,
  aiProposals,
  auditLogs,
  customers,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { fullAccess, legacyRoleFor } from '@/lib/permissions/model';
import { runWithServiceContext } from '@/lib/context';
import type { BridgeResult, NewAgentRequest } from '@/lib/agent/contract';
import { ASKS_PER_HOUR_BEFORE_PAUSE } from '@/lib/agent/contract';
import type { ApprovalNeeds, Operation, RequestFacts } from '@/lib/agent/operations/types';
import { createCompany } from './company';
import { agentAccess, createAgent } from './agents';
import { resolveAccess } from './access';
import { endSession, startSession } from './sessions';
import { ServiceError, type ServiceContext } from './_base';
import {
  approveAgentRequest,
  batchApprove,
  cancelAgentRequest,
  createAgentRequest,
  denyAgentRequest,
  expireRequests,
  listRequestsForAgent,
  listRequestsForPerson,
  pendingCountForPerson,
  requestForAgent,
  requestForPerson,
  waitForDecision,
} from './agentRequests';

let db: DB;
let companyId: string;
const people: Record<string, ServiceContext> = {};
const agentCtx: Record<string, ServiceContext> = {};
let seq = 0;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function op(id: string, over: Partial<Operation> = {}): Operation {
  const o: Operation = {
    id,
    kind: 'route',
    route: `/api/test/${id}`,
    method: 'POST',
    params: [],
    rule: { area: 'customers', action: 'create' },
    area: 'customers',
    action: 'create',
    activity: null,
    classified: true,
    class: 'enter',
    describe: 'Enter a test record',
    availability: 'agent',
    why: null,
    dryRun: 'transaction',
    body: 'json',
    output: 'json',
    confirmFlags: [],
    sensitiveFields: [],
    reveal: null,
    hostOnly: false,
    fileAdmin: false,
    needsSecret: [],
    producesSecret: [],
    effects: [],
    countField: null,
    amountField: 'amount',
    alwaysAsk: false,
    bodySchema: null,
    ...over,
  };
  m.ops.set(id, o);
  return o;
}

const NO_NEEDS: ApprovalNeeds = {
  admin: false,
  fileAdmin: false,
  hostOnly: false,
  flag: null,
  flags: [],
  grantAdminOnly: false,
  secrets: [],
  twoPerson: false,
  grantable: 'yes',
};

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return { confirm: [], reveal: false, amount: '10.00', count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false, ...over };
}

function ask(agent: string, opId: string, over: Partial<NewAgentRequest> = {}) {
  seq += 1;
  return createAgentRequest(agentCtx[agent], {
    kind: 'operation',
    requestKey: `req-${seq}`,
    operation: m.ops.get(opId) as Operation,
    input: { body: { name: `Record ${seq}`, amount: '10.00' } },
    reason: 'Entering the month-end paperwork.',
    summary: `Enter test record ${seq}`,
    effectiveClass: 'enter',
    needs: NO_NEEDS,
    facts: facts(),
    preview: null,
    stalenessKey: 'v1',
    grantAsked: null,
    ...over,
  });
}

function bridge(over: Partial<BridgeResult> = {}): BridgeResult {
  return {
    mode: 'commit',
    httpStatus: 200,
    outcome: 'ok',
    result: { id: 'rec-1', ok: true },
    file: null,
    preview: null,
    warnings: [],
    error: null,
    effects: [],
    facts: facts(),
    stalenessKey: 'v1',
    produced: [],
    ...over,
  };
}

async function expectError(p: Promise<unknown>, code: string, message?: RegExp): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    if (message) expect((e as ServiceError).message).toMatch(message);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

async function rowOf(id: string) {
  const [row] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, id));
  return row;
}

async function person(name: string, roleKey: string | null, inCompany = companyId): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${name.toLowerCase()}@requests.test`, name, passwordHash: 'x' }).returning();
  if (roleKey) {
    await db.insert(userCompanies).values({ userId: u.id, companyId: inCompany, role: 'accountant', isActive: true });
    await db.insert(userRoleAssignments).values({ companyId: inCompany, userId: u.id, roleKey });
  }
  return u.id;
}

async function personCtx(userId: string): Promise<ServiceContext> {
  const r = await resolveAccess(db, companyId, userId);
  return { db, companyId, userId, access: r.access, role: legacyRoleFor(r.access, r.isOwner) };
}

async function makeAgent(key: string, opts: { unattended?: boolean } = {}): Promise<void> {
  const made = await createAgent(people.adaTrusted, { name: `Agent ${key}`, roleKeys: ['bookkeeper'], mode: 'propose', unattended: opts.unattended });
  const access = await agentAccess(db, { companyId, roleKeys: ['bookkeeper'] });
  agentCtx[key] = {
    db: readOnlyDb(db),
    companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access,
    agent: { id: made.agent.id, name: made.agent.name, mode: 'propose' },
    readOnly: true,
  };
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [ada] = await db.insert(users).values({ email: 'ada@requests.test', name: 'Ada Admin', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Requests Co', ownerId: ada.id });
  companyId = company.id;
  // A second company in the same file: Dee is an Admin of the first only, so not the FILE Admin.
  const other = await createCompany(db, { name: 'Other Co', ownerId: ada.id });

  people.adaTrusted = { db, companyId, userId: ada.id, role: 'owner', access: fullAccess() };
  const dee = await person('Dee', 'admin');
  await db.insert(userCompanies).values({ userId: dee, companyId: other.id, role: 'accountant', isActive: true });
  await db.insert(userRoleAssignments).values({ companyId: other.id, userId: dee, roleKey: 'bookkeeper' });
  const bo = await person('Bo', 'bookkeeper');
  const cy = await person('Cy', 'full_access');
  const rae = await person('Rae', 'reports_only');

  people.ada = await personCtx(ada.id);
  people.dee = await personCtx(dee);
  people.bo = await personCtx(bo);
  people.cy = await personCtx(cy);
  people.rae = await personCtx(rae);

  for (const key of ['a', 'b', 'cap', 'two', 'note', 'batch']) await makeAgent(key, { unattended: key === 'note' });

  op('test.enter');
  op('test.admin', { class: 'admin', area: 'customers' });
  op('test.file', { fileAdmin: true });
  op('test.host', { hostOnly: true });
  op('test.change', { class: 'change', method: 'PATCH', rule: { area: 'customers', action: 'modify' }, action: 'modify' });
  op('test.vendor', { sensitiveFields: ['taxId', 'accountNumber', 'apiKey'] });
  op('test.floor', { availability: 'hard_floor' });
  op('test.reveal', {
    class: 'read',
    method: 'GET',
    rule: { area: 'customers', action: 'view' },
    action: 'view',
    reveal: 'ssn',
    sensitiveFields: ['ssn'],
    dryRun: 'none',
    amountField: null,
  });
}, 240_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  m.runApproved.mockReset();
  m.runApproved.mockResolvedValue(bridge());
  m.createGrant.mockReset();
  m.createGrant.mockImplementation(async () => ({ id: crypto.randomUUID() }));
  m.sendMail.mockReset();
  m.sendMail.mockResolvedValue({ from: 'books@requests.test', to: 'x' });
});

// ---------------------------------------------------------------------------
// The agent asks
// ---------------------------------------------------------------------------

describe('an agent asks', () => {
  it('stores the request with its class, needs, facts, staleness key and expiry, and shows it to the agent', async () => {
    const before = Date.now();
    const view = await ask('a', 'test.enter', { facts: facts({ amount: '42.50' }) });
    expect(view.status).toBe('pending');
    expect(view.agentName).toBe('Agent a');
    expect(view.class).toBe('enter');
    expect(view.amount).toBe('42.50');
    expect(view.reason).toBe('Entering the month-end paperwork.');
    expect(view.needs).not.toHaveProperty('request');
    const row = await rowOf(view.id);
    expect(row.stalenessKey).toBe('v1');
    expect(row.operation).toBe('test.enter');
    // Facts and kind live in needs.request (the table has no column for them).
    expect((row.needs as unknown as { request: { facts: RequestFacts; kind: string } }).request.facts.amount).toBe('42.50');
    expect((row.needs as unknown as { request: { kind: string } }).request.kind).toBe('operation');
    const days = (row.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it('expires after the days the policy says', async () => {
    m.policies.set(agentCtx.b.agent!.id, { requestExpiryDays: 2 });
    try {
      const view = await ask('b', 'test.enter');
      const days = (Date.parse(view.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(1.99);
      expect(days).toBeLessThan(2.01);
    } finally {
      m.policies.delete(agentCtx.b.agent!.id);
    }
  });

  it('asking again with the same request id gives the same request; other work under it is refused', async () => {
    const first = await ask('a', 'test.enter', { requestKey: 'same-key-1', input: { body: { name: 'Same', amount: '5.00' } } });
    const again = await createAgentRequest(agentCtx.a, {
      kind: 'operation',
      requestKey: 'same-key-1',
      operation: m.ops.get('test.enter') as Operation,
      input: { body: { amount: '5.00', name: 'Same' } },
      reason: 'Again',
      summary: 'Again',
      effectiveClass: 'enter',
      needs: NO_NEEDS,
      facts: facts(),
      preview: null,
      stalenessKey: null,
    });
    expect(again.id).toBe(first.id);
    await expectError(ask('a', 'test.enter', { requestKey: 'same-key-1', input: { body: { name: 'Other', amount: '5.00' } } }), 'CONFLICT', /already used/);
    await expectError(ask('a', 'test.change', { requestKey: 'same-key-1', input: { body: { name: 'Same', amount: '5.00' } } }), 'CONFLICT');
    const rows = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.requestKey, 'same-key-1'));
    expect(rows).toHaveLength(1);
  });

  it('refuses a reason over 500 characters, a bad request id, the hard floor, and a person', async () => {
    await expectError(ask('a', 'test.enter', { reason: 'x'.repeat(501) }), 'VALIDATION', /500/);
    await expectError(ask('a', 'test.enter', { requestKey: 'x' }), 'VALIDATION');
    await expectError(ask('a', 'test.floor'), 'FORBIDDEN');
    await expectError(ask('a', 'test.enter', { input: { body: { hardFloor: true } } }), 'FORBIDDEN', /never/);
    await expectError(
      createAgentRequest(people.ada, {
        kind: 'operation',
        requestKey: 'person-key',
        operation: m.ops.get('test.enter') as Operation,
        input: {},
        reason: null,
        summary: 'x',
        effectiveClass: 'enter',
        needs: NO_NEEDS,
        facts: facts(),
        preview: null,
        stalenessKey: null,
      }),
      'FORBIDDEN',
    );
  });

  it('keeps the agent\'s words but drops characters that hide or reverse text', async () => {
    // Built from code points: the characters themselves never appear in source.
    const [rlo, pdf, zwsp, bom] = [0x202e, 0x202c, 0x200b, 0xfeff].map((n) => String.fromCodePoint(n));
    const view = await ask('a', 'test.enter', { reason: `Pay ${rlo}txt.exe${pdf} the${zwsp} vendor${bom}\r\nLine two` });
    expect(view.reason).toBe('Pay txt.exe the vendor\nLine two');
  });

  it('an agent only ever sees its own requests', async () => {
    const mine = await ask('a', 'test.enter');
    expect(await requestForAgent(agentCtx.b, mine.id)).toBeNull();
    expect(await requestForAgent(agentCtx.a, mine.id)).toMatchObject({ id: mine.id });
    const key = (await rowOf(mine.id)).requestKey;
    expect((await requestForAgent(agentCtx.a, key))?.id).toBe(mine.id);
    expect(await requestForAgent(agentCtx.b, key)).toBeNull();
    const listB = await listRequestsForAgent(agentCtx.b);
    expect(listB.every((r) => r.agentId === agentCtx.b.agent!.id)).toBe(true);
    await expectError(cancelAgentRequest(agentCtx.b, mine.id), 'NOT_FOUND');
    await expectError(waitForDecision(agentCtx.b, mine.id, 0), 'NOT_FOUND');
  });

  it('withdraws its own waiting request, once', async () => {
    const view = await ask('a', 'test.enter');
    const cancelled = await cancelAgentRequest(agentCtx.a, view.id);
    expect(cancelled.status).toBe('cancelled');
    await expectError(cancelAgentRequest(agentCtx.a, view.id), 'CONFLICT');
    await expectError(approveAgentRequest(people.ada, view.id, {}, { atHost: true }), 'CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Who may approve, each rule alone
// ---------------------------------------------------------------------------

describe('who may approve', () => {
  it('the person\'s own access must allow the route: someone without it neither sees nor approves it', async () => {
    const view = await ask('a', 'test.enter');
    expect((await requestForPerson(people.bo, view.id)).canApprove).toBe(true);
    await expectError(requestForPerson(people.rae, view.id), 'NOT_FOUND');
    await expectError(approveAgentRequest(people.rae, view.id, {}, { atHost: true }), 'NOT_FOUND');
    await expectError(denyAgentRequest(people.rae, view.id, null), 'NOT_FOUND');
    expect((await listRequestsForPerson(people.rae, { status: 'all' })).find((r) => r.id === view.id)).toBeUndefined();
    expect(m.runApproved).not.toHaveBeenCalled();
  });

  it('needs.admin: only an Admin', async () => {
    const view = await ask('a', 'test.enter', { needs: { ...NO_NEEDS, admin: true } });
    const asBo = await requestForPerson(people.bo, view.id);
    expect(asBo.canApprove).toBe(false);
    expect(asBo.cannotApproveWhy).toMatch(/Only an Admin/);
    expect(asBo.grantMinutesMax).toBe(0);
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'FORBIDDEN', /Only an Admin/);
    expect(m.runApproved).not.toHaveBeenCalled();
    expect((await approveAgentRequest(people.dee, view.id, {}, { atHost: true })).status).toBe('executed');
  });

  it('an admin-class operation needs an Admin even when the caller says it does not', async () => {
    const view = await ask('a', 'test.admin', { effectiveClass: 'admin' });
    expect(view.needs?.admin).toBe(true);
    await expectError(approveAgentRequest(people.cy, view.id, {}, { atHost: true }), 'FORBIDDEN', /Only an Admin/);
  });

  it('needs.fileAdmin: only an Admin of every company in the file', async () => {
    const view = await ask('a', 'test.file');
    expect(view.needs?.fileAdmin).toBe(true);
    const asDee = await requestForPerson(people.dee, view.id);
    expect(asDee.canApprove).toBe(false);
    expect(asDee.cannotApproveWhy).toMatch(/every company in this file/);
    await expectError(approveAgentRequest(people.dee, view.id, {}, { atHost: true }), 'FORBIDDEN', /every company/);
    expect((await approveAgentRequest(people.ada, view.id, {}, { atHost: true })).status).toBe('executed');
  });

  it('needs.flags: the approver holds each flag themselves', async () => {
    const view = await ask('a', 'test.enter', { needs: { ...NO_NEEDS, flag: 'sensitivePayroll', flags: ['sensitivePayroll'] } });
    const asBo = await requestForPerson(people.bo, view.id);
    expect(asBo.canApprove).toBe(false);
    expect(asBo.cannotApproveWhy).toMatch(/View sensitive payroll data/);
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'FORBIDDEN', /sensitive payroll/);
    expect((await approveAgentRequest(people.cy, view.id, {}, { atHost: true })).status).toBe('executed');
  });

  it('a closed-period request needs the closed-period right (worked out again, not taken from the caller)', async () => {
    const view = await ask('a', 'test.enter', { facts: facts({ closedPeriod: true, date: '2020-01-31' }) });
    expect(view.needs?.flags).toContain('closedPeriod');
    expect(view.class).toBe('period');
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'FORBIDDEN', /closing date/);
  });

  it('needs.hostOnly: only from the host computer\'s own window', async () => {
    const view = await ask('a', 'test.host');
    expect(view.needs?.hostOnly).toBe(true);
    // A list cannot tell where the window is: the rule is left to the approval itself.
    expect((await requestForPerson(people.bo, view.id)).canApprove).toBe(true);
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: false }), 'FORBIDDEN', /computer that holds the company file/);
    expect(m.runApproved).not.toHaveBeenCalled();
    const done = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(done.status).toBe('executed');
    expect(m.runApproved.mock.calls[0][3]).toEqual({ atHost: true });
  });

  it('an operation made host-only after the agent asked is judged by what the registry says now', async () => {
    op('test.reclass');
    const view = await ask('a', 'test.reclass');
    expect(view.needs?.hostOnly).toBe(false);
    op('test.reclass', { hostOnly: true });
    try {
      await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: false }), 'FORBIDDEN', /computer that holds the company file/);
      expect(m.runApproved).not.toHaveBeenCalled();
    } finally {
      op('test.reclass');
    }
  });

  it('only a waiting request, and never after it expired', async () => {
    const view = await ask('a', 'test.enter');
    await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, view.id));
    const asBo = await requestForPerson(people.bo, view.id);
    expect(asBo.status).toBe('expired');
    expect(asBo.canApprove).toBe(false);
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'CONFLICT', /expired/);
    expect(m.runApproved).not.toHaveBeenCalled();
  });

  it('the badge counts what this person could approve', async () => {
    const before = await pendingCountForPerson(people.bo);
    await ask('a', 'test.enter', { needs: { ...NO_NEEDS, admin: true } });
    await ask('a', 'test.enter');
    expect(await pendingCountForPerson(people.bo)).toBe(before + 1);
    expect(await pendingCountForPerson(people.rae)).toBe(0);
  });

  it('a removed agent\'s request cannot be approved, only denied', async () => {
    await makeAgent('gone');
    const view = await ask('gone', 'test.enter');
    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentCtx.gone.agent!.id));
    await expectError(approveAgentRequest(people.ada, view.id, {}, { atHost: true }), 'FORBIDDEN', /removed/);
    expect((await denyAgentRequest(people.ada, view.id, null)).status).toBe('denied');
  });

  it('a view-only role is never shown an approval it could not give, and cannot approve or deny', async () => {
    const view = await ask('b', 'test.enter');
    const viewOnly: ServiceContext = { ...people.bo, role: 'viewer' };
    const seen = await requestForPerson(viewOnly, view.id);
    expect(seen.canApprove).toBe(false);
    expect(seen.cannotApproveWhy).toMatch(/only look at the books/);
    await expectError(approveAgentRequest(viewOnly, view.id, {}, { atHost: true }), 'FORBIDDEN', /only look at the books/);
    await expectError(denyAgentRequest(viewOnly, view.id, null), 'FORBIDDEN', /only look at the books/);
    expect(m.runApproved).not.toHaveBeenCalled();
    expect((await rowOf(view.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// What a person reads of a run's answer
// ---------------------------------------------------------------------------

describe('the answer of an approved reveal', () => {
  const SSN = '123-45-6789';

  it('is shown in full only to people who hold the View flag it needed; the agent keeps its answer (D6)', async () => {
    const view = await ask('b', 'test.reveal', {
      effectiveClass: 'read_sensitive',
      input: { query: { id: 'emp-1' }, reveal: true },
      facts: facts({ reveal: true, amount: null }),
    });
    expect(view.needs?.flags).toContain('sensitivePayroll');
    m.runApproved.mockResolvedValue(bridge({ result: { employee: { name: 'Dana Lee', ssn: SSN } }, file: { fileId: 'f-1', name: 'w2.pdf', type: 'application/pdf', size: 10 } }));
    expect((await approveAgentRequest(people.ada, view.id, {}, { atHost: true })).status).toBe('executed');

    // Bo's role allows the route but not "View sensitive payroll data": a note, no value, no file.
    const asBo = await requestForPerson(people.bo, view.id);
    expect(asBo.status).toBe('executed');
    expect(JSON.stringify(asBo)).not.toContain(SSN);
    expect(asBo.result).toMatch(/View sensitive payroll data/);
    expect(asBo.file).toBeNull();
    for (const status of ['all', 'executed'] as const) {
      const listed = (await listRequestsForPerson(people.bo, { status })).find((r) => r.id === view.id);
      expect(listed).toBeDefined();
      expect(JSON.stringify(listed)).not.toContain(SSN);
    }

    // Cy holds the flag and reads it in full; the agent reads what was revealed to it.
    expect(JSON.stringify((await requestForPerson(people.cy, view.id)).result)).toContain(SSN);
    expect(JSON.stringify((await requestForAgent(agentCtx.b, view.id))?.result)).toContain(SSN);
  });

  it('an ordinary answer is masked by the reader\'s own flags', async () => {
    const view = await ask('b', 'test.enter');
    m.runApproved.mockResolvedValue(bridge({ result: { vendor: { name: 'Acme', taxId: '987-65-4321' } } }));
    await approveAgentRequest(people.ada, view.id, {}, { atHost: true });
    const asBo = await requestForPerson(people.bo, view.id);
    expect(asBo.result).toEqual({ vendor: { name: 'Acme', taxId: '***-**-4321' } });
  });
});

// ---------------------------------------------------------------------------
// Never from an agent
// ---------------------------------------------------------------------------

describe('an agent can never act for a person', () => {
  it('approve, deny, list and read for a person are refused for an agent context; the badge is 0', async () => {
    const view = await ask('a', 'test.enter');
    await expectError(approveAgentRequest(agentCtx.a, view.id, {}, { atHost: true }), 'FORBIDDEN');
    await expectError(approveAgentRequest(agentCtx.b, view.id, {}, { atHost: true }), 'FORBIDDEN');
    await expectError(denyAgentRequest(agentCtx.a, view.id, 'no'), 'FORBIDDEN');
    await expectError(listRequestsForPerson(agentCtx.a), 'FORBIDDEN');
    await expectError(requestForPerson(agentCtx.a, view.id), 'FORBIDDEN');
    await expectError(batchApprove(agentCtx.a, [view.id], { atHost: true }), 'FORBIDDEN');
    expect(await pendingCountForPerson(agentCtx.a)).toBe(0);
    // A person's context that carries an agent is an agent's.
    await expectError(approveAgentRequest({ ...people.ada, agent: agentCtx.a.agent }, view.id, {}, { atHost: true }), 'FORBIDDEN');
    expect(m.runApproved).not.toHaveBeenCalled();
    expect((await rowOf(view.id)).status).toBe('pending');
  });

  it('a person\'s context inside an agent\'s service scope cannot approve either', async () => {
    const view = await ask('a', 'test.enter');
    await expectError(
      runWithServiceContext(agentCtx.a, { path: '/api/estimates', method: 'GET' }, () => approveAgentRequest(people.ada, view.id, {}, { atHost: true })),
      'FORBIDDEN',
    );
    expect(m.runApproved).not.toHaveBeenCalled();
  });

  it('a context without a person is refused', async () => {
    const view = await ask('a', 'test.enter');
    await expectError(approveAgentRequest({ db, companyId, userId: null }, view.id, {}, { atHost: true }), 'FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------

describe('approving', () => {
  it('runs the work as the approver, records the decision and the answer the agent reads', async () => {
    m.runApproved.mockResolvedValue(bridge({ result: { id: 'inv-9', number: '1042' } }));
    const view = await ask('a', 'test.enter');
    const res = await approveAgentRequest(people.bo, view.id, { note: 'Thanks' }, { atHost: false });
    expect(res.status).toBe('executed');
    expect(res.request.decidedByName).toBe('Bo');
    const [ctxArg, reqArg] = m.runApproved.mock.calls[0];
    expect(ctxArg.userId).toBe(people.bo.userId);
    expect(ctxArg.agent).toBeUndefined();
    expect(ctxArg.access).toBeTruthy();
    expect(reqArg).toMatchObject({ id: view.id, agentId: agentCtx.a.agent!.id, operation: 'test.enter' });
    const agentView = await requestForAgent(agentCtx.a, view.id);
    expect(agentView).toMatchObject({ status: 'executed', result: { id: 'inv-9', number: '1042' }, note: 'Thanks' });
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, view.id)));
    expect(audit.some((a) => (a.newValues as { status?: string }).status === 'executed' && a.userId === people.bo.userId)).toBe(true);
  });

  it('a run that fails leaves the request failed with the app\'s own message', async () => {
    m.runApproved.mockResolvedValue(bridge({ outcome: 'error', httpStatus: 400, result: null, error: { message: 'Customer is inactive.', code: 'VALIDATION', details: null } }));
    const view = await ask('a', 'test.enter');
    const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request.error).toBe('Customer is inactive.');
    expect((await requestForAgent(agentCtx.a, view.id))?.status).toBe('failed');
  });

  it('two clicks, or two people at once, run the work once', async () => {
    let release: () => void = () => {};
    m.runApproved.mockImplementation(() => new Promise<BridgeResult>((resolve) => (release = () => resolve(bridge()))));
    const view = await ask('a', 'test.enter');
    const first = approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    const second = approveAgentRequest(people.cy, view.id, {}, { atHost: true });
    const third = approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    const settled = await Promise.allSettled([
      first.finally(() => undefined),
      second,
      third,
      (async () => {
        await vi.waitFor(() => expect(m.runApproved).toHaveBeenCalledTimes(1));
        release();
      })(),
    ]);
    const outcomes = settled.slice(0, 3);
    expect(outcomes.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of outcomes.filter((x) => x.status === 'rejected')) {
      expect(((s as PromiseRejectedResult).reason as ServiceError).code).toBe('CONFLICT');
    }
    expect(m.runApproved).toHaveBeenCalledTimes(1);
    await expectError(approveAgentRequest(people.cy, view.id, {}, { atHost: true }), 'CONFLICT');
    expect(m.runApproved).toHaveBeenCalledTimes(1);
  });

  it('two-person approval needs two different people, each passing every rule', async () => {
    m.policies.set(agentCtx.two.agent!.id, { twoPersonOver: '1000.00' });
    try {
      const view = await ask('two', 'test.enter', { facts: facts({ amount: '5000.00' }) });
      expect(view.needs?.twoPerson).toBe(true);
      const firstYes = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
      expect(firstYes.status).toBe('needs_second_approver');
      expect(firstYes.request.status).toBe('pending');
      expect(firstYes.request.grantMinutesMax).toBe(0);
      expect(m.runApproved).not.toHaveBeenCalled();
      // The same person again is not a second person.
      const asBo = await requestForPerson(people.bo, view.id);
      expect(asBo.canApprove).toBe(false);
      expect(asBo.cannotApproveWhy).toMatch(/different person/);
      await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'FORBIDDEN', /different person/);
      // A second person who fails a rule is still refused.
      await expectError(approveAgentRequest(people.rae, view.id, {}, { atHost: true }), 'NOT_FOUND');
      const secondYes = await approveAgentRequest(people.cy, view.id, {}, { atHost: true });
      expect(secondYes.status).toBe('executed');
      expect(m.runApproved).toHaveBeenCalledTimes(1);
      const row = await rowOf(view.id);
      expect(row.decidedBy).toBe(people.bo.userId);
      expect(row.secondApprover).toBe(people.cy.userId);
      expect(secondYes.request.secondApproverName).toBe('Cy');
    } finally {
      m.policies.delete(agentCtx.two.agent!.id);
    }
  });

  it('the second of two people must pass every rule too: a flag, the Admin role', async () => {
    m.policies.set(agentCtx.two.agent!.id, { twoPersonOver: '1000.00' });
    try {
      const flagged = await ask('two', 'test.enter', {
        facts: facts({ amount: '5000.00' }),
        needs: { ...NO_NEEDS, flag: 'sensitivePayroll', flags: ['sensitivePayroll'] },
      });
      expect((await approveAgentRequest(people.cy, flagged.id, {}, { atHost: true })).status).toBe('needs_second_approver');
      // Bo sees the request (the route is his) but lacks the flag.
      expect((await requestForPerson(people.bo, flagged.id)).cannotApproveWhy).toMatch(/View sensitive payroll data/);
      await expectError(approveAgentRequest(people.bo, flagged.id, {}, { atHost: true }), 'FORBIDDEN', /sensitive payroll/);
      expect(m.runApproved).not.toHaveBeenCalled();
      expect((await approveAgentRequest(people.ada, flagged.id, {}, { atHost: true })).status).toBe('executed');

      const forAdmins = await ask('two', 'test.enter', { facts: facts({ amount: '5000.00' }), needs: { ...NO_NEEDS, admin: true } });
      expect((await approveAgentRequest(people.ada, forAdmins.id, {}, { atHost: true })).status).toBe('needs_second_approver');
      await expectError(approveAgentRequest(people.cy, forAdmins.id, {}, { atHost: true }), 'FORBIDDEN', /Only an Admin/);
      expect(m.runApproved).toHaveBeenCalledTimes(1);
      expect((await approveAgentRequest(people.dee, forAdmins.id, {}, { atHost: true })).status).toBe('executed');
      expect(m.runApproved).toHaveBeenCalledTimes(2);
    } finally {
      m.policies.delete(agentCtx.two.agent!.id);
    }
  });

  it('the books changed: nothing runs, the new preview waits, and a second yes with acceptStale runs it', async () => {
    const newPreview = { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { total: '20.00' }, truncated: false };
    m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', preview: newPreview, stalenessKey: 'v2', facts: facts({ amount: '20.00' }) }));
    const view = await ask('a', 'test.enter');
    const stale = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(stale.status).toBe('stale');
    expect(stale.request.status).toBe('pending');
    expect(stale.request.preview).toMatchObject({ routePreview: { total: '20.00' } });
    expect(stale.request.amount).toBe('20.00');
    expect(stale.request.decidedByName).toBeNull();
    // The card shows the summary of the new preview, built from the operation (not the agent's text).
    expect(stale.request.summary).toBe('Enter a test record');
    const row = await rowOf(view.id);
    expect(row.stalenessKey).toBe('v2');
    expect(row.status).toBe('pending');

    const done = await approveAgentRequest(people.bo, view.id, { acceptStale: true }, { atHost: true });
    expect(done.status).toBe('executed');
    expect(m.runApproved).toHaveBeenCalledTimes(2);
    // The run still compares the books with the preview Bo was shown (key v2): acceptStale stays here.
    expect(m.runApproved.mock.calls[1][2]).toMatchObject({ acceptStale: false });
  });

  it('acceptStale on a request whose books never changed does not skip the check', async () => {
    const view = await ask('b', 'test.enter');
    await approveAgentRequest(people.bo, view.id, { acceptStale: true }, { atHost: true });
    expect(m.runApproved.mock.calls[0][2]).toMatchObject({ acceptStale: false });
  });

  it('nobody runs a preview they were not shown: only those shown the latest one may say yes to it', async () => {
    const preview = (total: string) => ({ ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { total }, truncated: false });
    const view = await ask('b', 'test.enter');
    // Bo's click finds the books changed: round 1 (P2) waits, shown to Bo only.
    m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', preview: preview('20.00'), stalenessKey: 'v2' }));
    expect((await approveAgentRequest(people.bo, view.id, {}, { atHost: true })).status).toBe('stale');
    expect(m.runApproved).toHaveBeenCalledTimes(1);

    // Cy still has the first card open (P1) and clicks Approve: he is shown P2, nothing runs.
    const cyShown = await approveAgentRequest(people.cy, view.id, {}, { atHost: true });
    expect(cyShown.status).toBe('stale');
    expect(cyShown.request.preview).toMatchObject({ routePreview: { total: '20.00' } });
    // Dee was never shown P2: acceptStale alone does not let her run it.
    expect((await approveAgentRequest(people.dee, view.id, { acceptStale: true }, { atHost: true })).status).toBe('stale');
    expect(m.runApproved).toHaveBeenCalledTimes(1);

    // Cy says yes to P2, but the books changed again: round 2 (P3), shown to Cy only.
    m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', preview: preview('30.00'), stalenessKey: 'v3' }));
    const again = await approveAgentRequest(people.cy, view.id, { acceptStale: true }, { atHost: true });
    expect(again.status).toBe('stale');
    expect(again.request.preview).toMatchObject({ routePreview: { total: '30.00' } });
    expect(m.runApproved).toHaveBeenCalledTimes(2);
    // Bo said yes to P2 only: his acceptStale is not a yes to P3.
    const boShown = await approveAgentRequest(people.bo, view.id, { acceptStale: true }, { atHost: true });
    expect(boShown.status).toBe('stale');
    expect(boShown.request.preview).toMatchObject({ routePreview: { total: '30.00' } });
    expect(m.runApproved).toHaveBeenCalledTimes(2);

    // Cy says yes to P3 with the books as P3 showed them: it runs, compared with v3.
    const done = await approveAgentRequest(people.cy, view.id, { acceptStale: true }, { atHost: true });
    expect(done.status).toBe('executed');
    expect(m.runApproved).toHaveBeenCalledTimes(3);
    expect(m.runApproved.mock.calls[2][2]).toMatchObject({ acceptStale: false });
    expect((await rowOf(view.id)).decidedBy).toBe(people.cy.userId);
  });

  it('a dry run that now fails ends the request, saying the books changed and nothing was done', async () => {
    m.runApproved.mockResolvedValueOnce(
      bridge({ mode: 'dry_run', outcome: 'error', stalenessKey: 'v2', result: null, error: { message: 'Customer is inactive.', code: 'VALIDATION', details: null } }),
    );
    const view = await ask('b', 'test.enter');
    const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request.error).toBe('The books changed since the agent asked, and this would no longer go through, so nothing was done. Customer is inactive.');
  });

  it('a stale run that now needs two people goes back to waiting for two', async () => {
    m.policies.set(agentCtx.two.agent!.id, { twoPersonOver: '1000.00' });
    try {
      m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', preview: null, stalenessKey: 'v9', facts: facts({ amount: '9000.00' }) }));
      const view = await ask('two', 'test.enter', { facts: facts({ amount: '50.00' }) });
      expect(view.needs?.twoPerson).toBe(false);
      const stale = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
      expect(stale.status).toBe('stale');
      expect(stale.request.needs?.twoPerson).toBe(true);
      expect((await approveAgentRequest(people.bo, view.id, { acceptStale: true }, { atHost: true })).status).toBe('needs_second_approver');
    } finally {
      m.policies.delete(agentCtx.two.agent!.id);
    }
  });

  it('gives standing permission after a successful run, within the allowed time', async () => {
    const view = await ask('a', 'test.enter');
    const forBo = await requestForPerson(people.bo, view.id);
    expect(forBo.grantMinutesMax).toBeGreaterThan(0);
    await expectError(
      approveAgentRequest(people.bo, view.id, { grant: { minutes: 24 * 60 + 1, constraints: {} } }, { atHost: true }),
      'VALIDATION',
    );
    expect(m.runApproved).not.toHaveBeenCalled();
    const res = await approveAgentRequest(people.bo, view.id, { grant: { minutes: 1, constraints: { maxAmount: '10.00' } } }, { atHost: true });
    expect(res.status).toBe('executed');
    expect(m.createGrant).toHaveBeenCalledTimes(1);
    const [grantCtx, , newGrant] = m.createGrant.mock.calls[0];
    expect(grantCtx.userId).toBe(people.bo.userId);
    expect(newGrant).toMatchObject({ agentId: agentCtx.a.agent!.id, operation: 'test.enter', minutes: 1, requestId: view.id });
    expect(res.request.grantId).toBeTruthy();
  });

  it('a request for standing permission only gives the grant', async () => {
    const view = await ask('a', 'test.enter', { kind: 'grant', input: {}, grantAsked: { constraints: { maxAmount: '50.00' }, minutes: 1 } });
    expect(view.kind).toBe('grant');
    expect(view.grantAsked).toEqual({ constraints: { maxAmount: '50.00' }, minutes: 1 });
    const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(res.status).toBe('executed');
    expect(m.runApproved).not.toHaveBeenCalled();
    expect(m.createGrant).toHaveBeenCalledTimes(1);
    expect(m.createGrant.mock.calls[0][2]).toMatchObject({ constraints: { maxAmount: '50.00' }, minutes: 1, requestId: view.id });
    expect(res.request.grantId).toBeTruthy();
  });

  it('a request for standing permission on a class that allows none can only be denied', async () => {
    const view = await ask('a', 'test.enter', { kind: 'grant', input: {}, grantAsked: { constraints: {}, minutes: 1 }, needs: { ...NO_NEEDS, grantable: 'no' } });
    const asAda = await requestForPerson(people.ada, view.id);
    expect(asAda.canApprove).toBe(false);
    expect(asAda.cannotApproveWhy).toMatch(/Standing permission cannot be given/);
  });

  it('denies with a note the agent reads; a note over 500 characters is refused', async () => {
    const view = await ask('a', 'test.enter');
    await expectError(denyAgentRequest(people.bo, view.id, 'n'.repeat(501)), 'VALIDATION', /500/);
    const denied = await denyAgentRequest(people.bo, view.id, 'Wrong customer; use Acme West.');
    expect(denied.status).toBe('denied');
    expect((await requestForAgent(agentCtx.a, view.id))?.note).toBe('Wrong customer; use Acme West.');
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'CONFLICT', /denied/);
    expect(m.runApproved).not.toHaveBeenCalled();
  });

  it('batch approve takes same-operation enter or change requests only, each approved on its own', async () => {
    const one = await ask('a', 'test.enter');
    const two = await ask('a', 'test.enter');
    const other = await ask('a', 'test.change', { effectiveClass: 'change' });
    const admin = await ask('a', 'test.admin', { effectiveClass: 'admin' });
    const host = await ask('a', 'test.host');
    await expectError(batchApprove(people.ada, [one.id, other.id], { atHost: true }), 'VALIDATION', /same kind of work/);
    await expectError(batchApprove(people.ada, [admin.id], { atHost: true }), 'VALIDATION', /on its own/);
    await expectError(batchApprove(people.ada, [host.id], { atHost: true }), 'VALIDATION', /host computer/);
    expect(m.runApproved).not.toHaveBeenCalled();
    m.runApproved.mockResolvedValueOnce(bridge()).mockResolvedValueOnce(bridge({ outcome: 'error', error: { message: 'Duplicate number.', code: null, details: null } }));
    const results = await batchApprove(people.bo, [one.id, two.id], { atHost: true });
    expect(results.map((r) => r.status)).toEqual(['executed', 'failed']);
    expect(m.runApproved).toHaveBeenCalledTimes(2);
  });

  it('batch approve refuses a request that needs something typed in or two people', async () => {
    const secret = await ask('b', 'test.enter', { needs: { ...NO_NEEDS, secrets: ['closing_password'] } });
    await expectError(batchApprove(people.ada, [secret.id], { atHost: true }), 'VALIDATION', /typed in/);
    m.policies.set(agentCtx.two.agent!.id, { twoPersonOver: '1.00' });
    try {
      const big = await ask('two', 'test.enter', { facts: facts({ amount: '99.00' }) });
      await expectError(batchApprove(people.ada, [big.id], { atHost: true }), 'VALIDATION', /two people/);
    } finally {
      m.policies.delete(agentCtx.two.agent!.id);
    }
    expect(m.runApproved).not.toHaveBeenCalled();
  });

  it('batch approve reports where each request stands when one is refused part way', async () => {
    const one = await ask('batch', 'test.enter');
    const two = await ask('batch', 'test.enter');
    const three = await ask('batch', 'test.enter');
    const agentId = agentCtx.batch.agent!.id;
    let calls = 0;
    m.runApproved.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // While the first runs, Cy approves the second himself and someone pauses the agent.
        await approveAgentRequest(people.cy, two.id, {}, { atHost: true });
        await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, agentId));
      }
      return bridge();
    });
    try {
      const results = await batchApprove(people.bo, [one.id, two.id, three.id], { atHost: true });
      expect(results.map((r) => r.status)).toEqual(['executed', 'executed', 'failed']);
      expect(results[1].request.decidedByName).toBe('Cy');
      expect(results[2].request.status).toBe('pending');
      expect(results[2].request.error).toMatch(/paused/);
      expect((await rowOf(three.id)).status).toBe('pending');
      expect(calls).toBe(2);
    } finally {
      await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, agentId));
    }
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('secrets never reach the row', () => {
  const TYPED = 'Cl0sing-Pass!';
  const PRODUCED = 'Temp-Pass-9876';
  const AGENT_PASSWORD = 'agent-sent-pw';
  const AGENT_KEY = 'ak-live-123456';

  it('a secret typed by the approver, produced by the run or sent by the agent is in no column, no audit row', async () => {
    const view = await ask('a', 'test.vendor', {
      input: {
        body: { name: 'Vendor', amount: '10.00', password: AGENT_PASSWORD, apiKey: AGENT_KEY, smtpPassword: AGENT_PASSWORD, taxId: '123-45-6789', accountNumber: '000123456789' },
      },
    });
    // While waiting: no secret stored; protected data kept for the run, masked in every view.
    let row = await rowOf(view.id);
    expect(JSON.stringify(row)).not.toContain(AGENT_PASSWORD);
    expect(JSON.stringify(row)).not.toContain(AGENT_KEY);
    expect(view.input?.body).toMatchObject({ taxId: '***-**-6789', accountNumber: '••••6789' });
    expect(JSON.stringify(view)).not.toContain('123-45-6789');
    expect(JSON.stringify(await requestForPerson(people.ada, view.id))).not.toContain('000123456789');

    m.runApproved.mockResolvedValue(
      bridge({
        result: { id: 'v-1', echoed: `used ${TYPED}`, temp: PRODUCED },
        produced: [{ kind: 'new_user_password', label: 'Temporary password for Dana Lee', value: PRODUCED }],
      }),
    );
    const res = await approveAgentRequest(people.ada, view.id, { secrets: { closing_password: TYPED } }, { atHost: true });
    expect(res.status).toBe('executed');
    // The run got what was typed; the approver gets what was produced; nothing else does.
    expect(m.runApproved.mock.calls[0][2].secrets).toEqual({ closing_password: TYPED });
    expect(m.runApproved.mock.calls[0][1].input.body.taxId).toBe('123-45-6789');
    expect(res.produced).toEqual([{ kind: 'new_user_password', label: 'Temporary password for Dana Lee', value: PRODUCED }]);
    expect(JSON.stringify(res.request)).not.toContain(PRODUCED);
    expect(JSON.stringify(res.request)).not.toContain(TYPED);

    row = await rowOf(view.id);
    const everyColumn = JSON.stringify(row);
    for (const s of [TYPED, PRODUCED, AGENT_PASSWORD, AGENT_KEY, '123-45-6789', '000123456789']) expect(everyColumn).not.toContain(s);
    const agentSees = JSON.stringify(await requestForAgent(agentCtx.a, view.id));
    for (const s of [TYPED, PRODUCED, AGENT_PASSWORD, AGENT_KEY]) expect(agentSees).not.toContain(s);
    const audit = JSON.stringify(await db.select().from(auditLogs).where(eq(auditLogs.entityId, view.id)));
    for (const s of [TYPED, PRODUCED, AGENT_PASSWORD, AGENT_KEY]) expect(audit).not.toContain(s);
  });

  it('the books changed: the new preview and summary are stored without what was typed or produced', async () => {
    const view = await ask('b', 'test.vendor', { input: { body: { name: 'Vendor', amount: '10.00', taxId: '123-45-6789' } } });
    m.runApproved.mockResolvedValueOnce(
      bridge({
        mode: 'dry_run',
        stalenessKey: 'v2',
        result: { name: `Vendor ${TYPED}`, note: PRODUCED },
        preview: { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { echoed: `would use ${TYPED}`, temp: PRODUCED }, truncated: false },
        produced: [{ kind: 'new_user_password', label: 'Temporary password', value: PRODUCED }],
      }),
    );
    const res = await approveAgentRequest(people.ada, view.id, { secrets: { closing_password: TYPED } }, { atHost: true });
    expect(res.status).toBe('stale');
    expect(res.produced).toEqual([]);
    for (const s of [TYPED, PRODUCED]) expect(JSON.stringify(res.request)).not.toContain(s);
    const row = await rowOf(view.id);
    expect(row.status).toBe('pending');
    const everyColumn = JSON.stringify(row);
    for (const s of [TYPED, PRODUCED]) expect(everyColumn).not.toContain(s);
    const agentSees = JSON.stringify(await requestForAgent(agentCtx.b, view.id));
    for (const s of [TYPED, PRODUCED, '123-45-6789']) expect(agentSees).not.toContain(s);
    const audit = JSON.stringify(await db.select().from(auditLogs).where(eq(auditLogs.entityId, view.id)));
    for (const s of [TYPED, PRODUCED]) expect(audit).not.toContain(s);
  });

  it('a failed run whose message repeats the typed secret stores the message without it', async () => {
    m.runApproved.mockResolvedValue(bridge({ outcome: 'error', result: null, error: { message: `The password ${TYPED} is wrong.`, code: 'FORBIDDEN', details: null } }));
    const view = await ask('a', 'test.enter');
    const res = await approveAgentRequest(people.ada, view.id, { secrets: { closing_password: TYPED } }, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request.error).toBe('The password ••• is wrong.');
    expect(JSON.stringify(await rowOf(view.id))).not.toContain(TYPED);
  });

  it('a password typed as a desktop flow\'s answer is kept out of the stored error too', async () => {
    const ANSWER = 'Flow-Answer-Pass-77';
    m.runApproved.mockResolvedValue(bridge({ outcome: 'error', result: null, error: { message: `Could not open with ${ANSWER}.`, code: null, details: null } }));
    const view = await ask('a', 'test.enter');
    const res = await approveAgentRequest(people.ada, view.id, { answers: { filePassword: ANSWER, overwrite: 'yes' } }, { atHost: true });
    expect(m.runApproved.mock.calls[0][2].answers).toEqual({ filePassword: ANSWER, overwrite: 'yes' });
    expect(res.request.error).toBe('Could not open with •••.');
    expect(JSON.stringify(await rowOf(view.id))).not.toContain(ANSWER);
  });

  it('a thrown error from the run is stored as a plain message, never with the secret', async () => {
    m.runApproved.mockRejectedValue(new Error(`boom ${TYPED}`));
    const view = await ask('a', 'test.enter');
    const res = await approveAgentRequest(people.ada, view.id, { secrets: { closing_password: TYPED } }, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request.error).not.toContain(TYPED);
    expect(res.request.error).toMatch(/unexpected problem/);
  });
});

// ---------------------------------------------------------------------------
// Expiry, the hourly limit, waiting
// ---------------------------------------------------------------------------

describe('expiry', () => {
  it('expireRequests marks overdue waiting requests expired and masks what they kept', async () => {
    const view = await ask('a', 'test.vendor', { input: { body: { name: 'V', amount: '1.00', taxId: '987-65-4321' } } });
    await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(agentPermissionRequests.id, view.id));
    expect(await expireRequests(people.ada)).toBeGreaterThanOrEqual(1);
    const row = await rowOf(view.id);
    expect(row.status).toBe('expired');
    expect(JSON.stringify(row.input)).not.toContain('987-65-4321');
    expect(await expireRequests(people.ada)).toBe(0);
    expect((await requestForAgent(agentCtx.a, view.id))?.status).toBe('expired');
  });

  it('a request left being carried out when Ironbooks stopped is marked failed later, its input masked', async () => {
    const view = await ask('b', 'test.vendor', { input: { body: { name: 'V', amount: '1.00', taxId: '555-44-3333' } } });
    const recent = await ask('b', 'test.enter');
    const claimedAt = (msAgo: number) => ({ status: 'approved', decidedBy: people.bo.userId, decidedAt: new Date(Date.now() - msAgo) });
    await db.update(agentPermissionRequests).set(claimedAt(3 * 3_600_000)).where(eq(agentPermissionRequests.id, view.id));
    await db.update(agentPermissionRequests).set(claimedAt(1_000)).where(eq(agentPermissionRequests.id, recent.id));

    const seen = await requestForAgent(agentCtx.b, view.id);
    expect(seen?.status).toBe('failed');
    expect(seen?.error).toMatch(/cannot tell how it ended/);
    expect(JSON.stringify((await rowOf(view.id)).input)).not.toContain('555-44-3333');
    // A run claimed a moment ago may still be going: it is left alone.
    await expireRequests(people.ada);
    expect((await rowOf(recent.id)).status).toBe('approved');
    await db.update(agentPermissionRequests).set(claimedAt(3 * 3_600_000)).where(eq(agentPermissionRequests.id, recent.id));
    await expireRequests(people.ada);
    expect((await rowOf(recent.id)).status).toBe('failed');
  });
});

describe('the hourly limit', () => {
  it(`more than ${ASKS_PER_HOUR_BEFORE_PAUSE} asks in an hour pauses the agent until a person resumes it`, async () => {
    for (let i = 0; i < ASKS_PER_HOUR_BEFORE_PAUSE; i++) await ask('cap', 'test.enter');
    await expectError(ask('cap', 'test.enter'), 'FORBIDDEN', /more than 50 times/);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentCtx.cap.agent!.id));
    expect(row.pausedAt).toBeTruthy();
    const paused = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent'), eq(auditLogs.entityId, agentCtx.cap.agent!.id)));
    expect(paused.some((a) => (a.newValues as { pausedFor?: string }).pausedFor === 'too_many_requests')).toBe(true);
    await expectError(ask('cap', 'test.enter'), 'FORBIDDEN', /paused/);
    const count = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agentCtx.cap.agent!.id));
    expect(count).toHaveLength(ASKS_PER_HOUR_BEFORE_PAUSE);
    // A paused agent's requests cannot be approved.
    await expectError(approveAgentRequest(people.ada, count[0].id, {}, { atHost: true }), 'FORBIDDEN', /paused/);
    // A person turns it back on: the count starts again from the pause.
    await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, agentCtx.cap.agent!.id));
    expect((await ask('cap', 'test.enter')).status).toBe('pending');
  }, 60_000);
});

describe('waiting for a decision', () => {
  it('resolves at once when already decided', async () => {
    const view = await ask('a', 'test.enter');
    await denyAgentRequest(people.bo, view.id, null);
    const t = Date.now();
    expect((await waitForDecision(agentCtx.a, view.id, 30)).status).toBe('denied');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('resolves when a person decides, well before the time is up', async () => {
    const view = await ask('a', 'test.enter');
    const t = Date.now();
    const waiting = waitForDecision(agentCtx.a, view.id, 30);
    await new Promise((r) => setTimeout(r, 100));
    await denyAgentRequest(people.bo, view.id, 'Not this month.');
    const got = await waiting;
    expect(got.status).toBe('denied');
    expect(got.note).toBe('Not this month.');
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('resolves with the request still waiting when the time is up', async () => {
    const view = await ask('a', 'test.enter');
    const t = Date.now();
    const got = await waitForDecision(agentCtx.a, view.id, 0.3);
    expect(got.status).toBe('pending');
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('a first of two approvals does not end the wait; the decision does', async () => {
    m.policies.set(agentCtx.two.agent!.id, { twoPersonOver: '1.00' });
    try {
      const view = await ask('two', 'test.enter', { facts: facts({ amount: '99.00' }) });
      const waiting = waitForDecision(agentCtx.two, view.id, 30);
      await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
      await new Promise((r) => setTimeout(r, 150));
      await approveAgentRequest(people.cy, view.id, {}, { atHost: true });
      expect((await waiting).status).toBe('executed');
    } finally {
      m.policies.delete(agentCtx.two.agent!.id);
    }
  });

  it('marks an overdue request expired when it sees one', async () => {
    const view = await ask('a', 'test.enter');
    await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, view.id));
    expect((await waitForDecision(agentCtx.a, view.id, 5)).status).toBe('expired');
    expect((await rowOf(view.id)).status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// Notice by email (D7)
// ---------------------------------------------------------------------------

describe('notice by email for an unattended agent', () => {
  it('emails the Admins the agent and the summary only, when the policy asks for it', async () => {
    m.policies.set(agentCtx.note.agent!.id, { notifyEmail: true });
    try {
      await ask('note', 'test.enter', { summary: 'Enter bill 553 from Staples https://evil.example/x', reason: 'SECRET REASON' });
      await vi.waitFor(() => expect(m.sendMail).toHaveBeenCalled());
      const to = m.sendMail.mock.calls.map((c) => c[0].to).sort();
      expect(to).toEqual(['ada@requests.test', 'dee@requests.test']);
      const mail = m.sendMail.mock.calls[0][0];
      expect(mail.subject).toContain('Agent note');
      expect(mail.text).toContain('Enter bill 553 from Staples');
      expect(mail.text).not.toContain('evil.example');
      expect(mail.text).not.toContain('SECRET REASON');
    } finally {
      m.policies.delete(agentCtx.note.agent!.id);
    }
  });

  it('a notice that cannot be sent never fails the request; an attended agent sends none', async () => {
    m.policies.set(agentCtx.a.agent!.id, { notifyEmail: true });
    try {
      expect((await ask('a', 'test.enter')).status).toBe('pending');
      await new Promise((r) => setTimeout(r, 50));
      expect(m.sendMail).not.toHaveBeenCalled();
    } finally {
      m.policies.delete(agentCtx.a.agent!.id);
    }
    m.sendMail.mockRejectedValue(new Error('mail server down'));
    await makeAgent('note2', { unattended: true });
    m.policies.set(agentCtx.note2.agent!.id, { notifyEmail: true });
    try {
      expect((await ask('note2', 'test.enter')).status).toBe('pending');
      await vi.waitFor(() => expect(m.sendMail).toHaveBeenCalled());
    } finally {
      m.policies.delete(agentCtx.note2.agent!.id);
    }
  });

  it('sends nothing while someone is signed in (they see the badge)', async () => {
    await makeAgent('note3', { unattended: true });
    m.policies.set(agentCtx.note3.agent!.id, { notifyEmail: true });
    const session = await startSession(db, { userId: people.bo.userId!, companyId });
    try {
      expect((await ask('note3', 'test.enter')).status).toBe('pending');
      await new Promise((r) => setTimeout(r, 300));
      expect(m.sendMail).not.toHaveBeenCalled();
    } finally {
      await endSession(db, session.id);
      m.policies.delete(agentCtx.note3.agent!.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Requests copied from old proposals
// ---------------------------------------------------------------------------

describe('requests copied from old proposals', () => {
  async function copied(name: string, needs: ApprovalNeeds | null = null): Promise<{ proposalId: string; requestId: string }> {
    const agent = agentCtx.a.agent!;
    const [p] = await db
      .insert(aiProposals)
      .values({
        companyId,
        createdBy: null,
        agentId: agent.id,
        kind: 'agent_action',
        summary: `New customer: ${name}`,
        payload: { action: 'add_customer', input: { displayName: name }, agent: { id: agent.id, name: agent.name } },
        status: 'pending',
      })
      .returning();
    seq += 1;
    const [r] = await db
      .insert(agentPermissionRequests)
      .values({
        companyId,
        agentId: agent.id,
        requestKey: `proposal:${p.id}`,
        operation: 'action:add_customer',
        class: 'change',
        input: { displayName: name },
        summary: `New customer: ${name}`,
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        proposalId: p.id,
        needs,
      })
      .returning();
    return { proposalId: p.id, requestId: r.id };
  }

  async function proposalOf(proposalId: string) {
    const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    return p;
  }

  it('one that would need two people or a password is never run on the old path', async () => {
    for (const needs of [{ ...NO_NEEDS, twoPerson: true }, { ...NO_NEEDS, secrets: ['closing_password' as const] }]) {
      const { proposalId, requestId } = await copied(`Legacy Guarded ${needs.twoPerson ? 'Two' : 'Secret'} LLC`, needs);
      const asAda = await requestForPerson(people.ada, requestId);
      expect(asAda.canApprove).toBe(false);
      expect(asAda.cannotApproveWhy).toMatch(/older kind of proposal/);
      await expectError(approveAgentRequest(people.ada, requestId, {}, { atHost: true }), 'FORBIDDEN', /older kind of proposal/);
      expect((await proposalOf(proposalId)).status).toBe('pending');
      expect((await rowOf(requestId)).status).toBe('pending');
    }
    const made = await db.select().from(customers).where(like(customers.displayName, 'Legacy Guarded%'));
    expect(made).toHaveLength(0);
  });

  it('withdrawn or expired shows in Ask AI as not done, in words it knows', async () => {
    const withdrawn = await copied('Legacy Withdrawn LLC');
    expect((await cancelAgentRequest(agentCtx.a, withdrawn.requestId)).status).toBe('cancelled');
    expect(await proposalOf(withdrawn.proposalId)).toMatchObject({ status: 'rejected', error: 'The agent withdrew this request.' });

    const overdue = await copied('Legacy Overdue LLC');
    await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, overdue.requestId));
    await expireRequests(people.ada);
    expect((await rowOf(overdue.requestId)).status).toBe('expired');
    expect(await proposalOf(overdue.proposalId)).toMatchObject({ status: 'rejected', error: 'This request expired before anyone decided it.' });
  });

  it('approving runs the old path and settles the proposal too', async () => {
    const { proposalId, requestId } = await copied('Legacy Approved LLC');
    const res = await approveAgentRequest(people.ada, requestId, {}, { atHost: true });
    expect(res.status).toBe('executed');
    expect(m.runApproved).not.toHaveBeenCalled();
    const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    expect(p.status).toBe('approved');
    expect(p.decidedBy).toBe(people.ada.userId);
    const made = await db.select().from(customers).where(and(eq(customers.companyId, companyId), like(customers.displayName, 'Legacy Approved LLC')));
    expect(made).toHaveLength(1);
    expect((await rowOf(requestId)).status).toBe('executed');
  });

  it('denying settles the proposal too', async () => {
    const { proposalId, requestId } = await copied('Legacy Denied LLC');
    expect((await denyAgentRequest(people.ada, requestId, 'No')).status).toBe('denied');
    const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    expect(p.status).toBe('rejected');
  });

  it('a proposal already decided under Ask AI shows that state here and is not run again', async () => {
    const { proposalId, requestId } = await copied('Legacy Elsewhere LLC');
    await db.update(aiProposals).set({ status: 'approved', decidedBy: people.ada.userId, decidedAt: new Date() }).where(eq(aiProposals.id, proposalId));
    const view = await requestForPerson(people.ada, requestId);
    expect(view.status).toBe('executed');
    await expectError(approveAgentRequest(people.ada, requestId, {}, { atHost: true }), 'CONFLICT');
    const made = await db.select().from(customers).where(like(customers.displayName, 'Legacy Elsewhere LLC'));
    expect(made).toHaveLength(0);
  });

  it('a person without the route right cannot approve one', async () => {
    const { requestId } = await copied('Legacy Rights LLC');
    await expectError(approveAgentRequest(people.rae, requestId, {}, { atHost: true }), 'NOT_FOUND');
  });
});
