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
 *    path when it needs more than one plain yes;
 *  - what a view tells (wave 3): the stale mark, what the committed run posted and which entries,
 *    the standing permission actually given or why none was, a desktop flow's questions, and
 *    whether THIS window may approve (a teammate's never approves host-only work, nor counts it);
 *  - the badge: count and newest from one read, nothing for an agent, never crowded out by work
 *    the person cannot see; it marks what is overdue (masking what it kept) at most once a minute;
 *  - the standing window offered is the one createGrant accepts (the company's own day, host-only
 *    and file-Admin work), worked out once per kind of work in a list;
 *  - batch approval reports one it could not approve as not approved and runs the others;
 *  - an approval that claimed a request and lost track of its run ends it as failed, outcome unknown;
 *  - a password the route always takes is typed before anything is claimed;
 *  - a desktop flow that fails is failed for good and never runs again under the same id.
 *
 * Grants are the real grantMinutesFor (wrapped) and a stand-in createGrant; one test uses the real
 * createGrant to show the card's window is the one it accepts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like, lte } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-requests');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-requests-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

type AnyFn = (...args: never[]) => unknown;

const m = vi.hoisted(() => ({
  ops: new Map<string, unknown>(),
  policies: new Map<string, Record<string, unknown>>(),
  runApproved: vi.fn(),
  createGrant: vi.fn(),
  grantMinutesFor: vi.fn(),
  sendMail: vi.fn(),
  // The real ones, kept by the mock below: the card's window comes from the real grantMinutesFor.
  real: {} as { createGrant?: AnyFn; grantMinutesFor?: AnyFn },
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
vi.mock('@/lib/services/agentGrants', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/services/agentGrants')>();
  m.real.createGrant = real.createGrant as unknown as AnyFn;
  m.real.grantMinutesFor = real.grantMinutesFor as unknown as AnyFn;
  return {
    ...real,
    createGrant: m.createGrant,
    grantMinutesFor: m.grantMinutesFor,
    liveGrants: vi.fn(),
    revokeGrant: vi.fn(),
    useGrant: vi.fn(),
    listGrants: vi.fn(),
  };
});
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
  companies,
  customers,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { fullAccess, legacyRoleFor } from '@/lib/permissions/model';
import { runWithServiceContext } from '@/lib/context';
import type { BridgeResult, NewAgentRequest, OperationPreview } from '@/lib/agent/contract';
import { ASKS_PER_HOUR_BEFORE_PAUSE } from '@/lib/agent/contract';
import type { ApprovalNeeds, Operation, RequestFacts } from '@/lib/agent/operations/types';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { createCompany } from './company';
import { agentAccess, createAgent } from './agents';
import { resolveAccess } from './access';
import { endSession, startSession } from './sessions';
import { ServiceError, type ServiceContext } from './_base';
import {
  approveAgentRequest,
  badgeForPerson,
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
  shownStatus,
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

/**
 * Run with the clock at midday on this computer (the test company has no time zone of its own, so
 * its day is this computer's): a standing window is the rest of the company's day, and a test that
 * gives one must not depend on the hour it runs at. The latest midday that is not in the future, so
 * nothing made meanwhile is dated ahead of what later tests make. Only Date is frozen; timers run
 * as usual.
 */
async function atMidday<T>(fn: () => Promise<T>): Promise<T> {
  const noon = new Date();
  if (noon.getHours() < 12) noon.setDate(noon.getDate() - 1);
  noon.setHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(noon);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Run with the clock frozen at `at`, moved on with the function handed to `fn`. */
async function frozenAt<T>(at: Date, fn: (moveTo: (ms: number) => void) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  try {
    return await fn((ms) => vi.setSystemTime(new Date(at.getTime() + ms)));
  } finally {
    vi.useRealTimers();
  }
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
  // A stand-in that answers as createGrant does (an AgentGrant), without writing one.
  m.createGrant.mockImplementation(
    async (ctx: ServiceContext, _facts: unknown, g: { agentId: string; operation: string; constraints: object; minutes: number }) => ({
      id: crypto.randomUUID(),
      agentId: g.agentId,
      operation: g.operation,
      constraints: g.constraints,
      givenBy: ctx.userId,
      expiresAt: new Date(Date.now() + g.minutes * 60_000).toISOString(),
      revokedAt: null,
      uses: 0,
    }),
  );
  // The real window (the company's day, host-only and file-Admin work, the person's role).
  m.grantMinutesFor.mockReset();
  m.grantMinutesFor.mockImplementation((...args: never[]) => m.real.grantMinutesFor!(...args));
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
    // Left out, the window counts as the host's (the contract's rule); a teammate's says so.
    expect((await requestForPerson(people.bo, view.id)).canApprove).toBe(true);
    const fromTeammate = await requestForPerson(people.bo, view.id, { atHost: false });
    expect(fromTeammate.canApprove).toBe(false);
    expect(fromTeammate.cannotApproveWhy).toMatch(/computer that holds the company file/);
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

  it('gives standing permission after a successful run, within the allowed time', () =>
    atMidday(async () => {
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
    }));

  it('a request for standing permission only gives the grant', () =>
    atMidday(async () => {
      const view = await ask('a', 'test.enter', { kind: 'grant', input: {}, grantAsked: { constraints: { maxAmount: '50.00' }, minutes: 1 } });
      expect(view.kind).toBe('grant');
      expect(view.grantAsked).toEqual({ constraints: { maxAmount: '50.00' }, minutes: 1 });
      const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
      expect(res.status).toBe('executed');
      expect(m.runApproved).not.toHaveBeenCalled();
      expect(m.createGrant).toHaveBeenCalledTimes(1);
      expect(m.createGrant.mock.calls[0][2]).toMatchObject({ constraints: { maxAmount: '50.00' }, minutes: 1, requestId: view.id });
      expect(res.request.grantId).toBeTruthy();
      // What was given, as createGrant gave it: for the card and for the agent.
      expect(res.request.grant).toMatchObject({ minutes: 1, constraints: { maxAmount: '50.00' } });
      expect((await requestForAgent(agentCtx.a, view.id))?.grant).toEqual(res.request.grant);
      // A grant request posts nothing, and says so.
      expect(res.request).toMatchObject({ posted: false, entryIds: [], grantError: null });
    }));

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
      // The third was not approved (the agent was paused) and nothing ran for it: not a failed run.
      expect(results.map((r) => r.status)).toEqual(['executed', 'executed', 'not_approved']);
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
    // What the old path's run posted is read in its own transaction: a new customer posts nothing.
    expect(res.request).toMatchObject({ posted: false, entryIds: [], grant: null, grantError: null });
  });

  it('denying settles the proposal too', async () => {
    const { proposalId, requestId } = await copied('Legacy Denied LLC');
    expect((await denyAgentRequest(people.ada, requestId, 'No')).status).toBe('denied');
    const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, proposalId));
    expect(p.status).toBe('rejected');
  });

  it('a proposal already decided under Ask AI shows that state here and is not run again', () =>
    frozenAt(new Date(Date.now() + 10 * 60_000), async (moveTo) => {
      const { proposalId, requestId } = await copied('Legacy Elsewhere LLC');
      expect((await badgeForPerson(people.ada, { atHost: true })).newest?.id).toBe(requestId);
      await db.update(aiProposals).set({ status: 'approved', decidedBy: people.ada.userId, decidedAt: new Date() }).where(eq(aiProposals.id, proposalId));
      // The badge does not count it, though nothing has marked the request yet (it settled under a minute ago).
      moveTo(20_000);
      expect((await badgeForPerson(people.ada, { atHost: true })).newest?.id).not.toBe(requestId);
      expect((await rowOf(requestId)).status).toBe('pending');
      const view = await requestForPerson(people.ada, requestId);
      expect(view.status).toBe('executed');
      await expectError(approveAgentRequest(people.ada, requestId, {}, { atHost: true }), 'CONFLICT');
      const made = await db.select().from(customers).where(like(customers.displayName, 'Legacy Elsewhere LLC'));
      expect(made).toHaveLength(0);
    }));

  it('a person without the route right cannot approve one', async () => {
    const { requestId } = await copied('Legacy Rights LLC');
    await expectError(approveAgentRequest(people.rae, requestId, {}, { atHost: true }), 'NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// What a view tells (wave 3)
// ---------------------------------------------------------------------------

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

/** A preview whose ledger holds these journal entries, in this order. */
function withLedger(ids: string[]): OperationPreview {
  return {
    ledger: {
      entries: ids.map((journalEntryId, i) => ({ journalEntryId, entryNumber: i + 1, date: '2026-11-20', description: null, status: 'posted', source: null, lines: [] })),
      changes: [],
    },
    records: [],
    effects: [],
    warnings: [],
    loss: null,
    routePreview: null,
    truncated: false,
  };
}

const NEW_PREVIEW: OperationPreview = { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { total: '20.00' }, truncated: false };

describe('what a view tells', () => {
  beforeAll(async () => {
    await makeAgent('w3');
  });

  it('posted and entryIds are what the committed run posted, for the person and the agent', async () => {
    const view = await ask('w3', 'test.enter');
    expect(view).toMatchObject({ posted: false, entryIds: [], stale: false, grant: null, grantError: null });
    m.runApproved.mockResolvedValue(bridge({ preview: withLedger([E1, E2]) }));
    const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(res.request).toMatchObject({ status: 'executed', posted: true, entryIds: [E1, E2] });
    expect(await requestForAgent(agentCtx.w3, view.id)).toMatchObject({ posted: true, entryIds: [E1, E2] });
    expect((await requestForPerson(people.cy, view.id)).entryIds).toEqual([E1, E2]);

    // Asked with a preview that posts, but the run itself only changed records: nothing was posted.
    const plain = await ask('w3', 'test.enter', { preview: withLedger([E1]) });
    m.runApproved.mockResolvedValue(bridge({ preview: withLedger([]) }));
    expect((await approveAgentRequest(people.bo, plain.id, {}, { atHost: true })).request).toMatchObject({ posted: false, entryIds: [] });
  });

  it('entryIds are only the entries the run made; one it voided or deleted still counts as posting', async () => {
    // The bridge lists the entries a run made, then those it voided, deleted or changed, marked `touched`.
    const touched = (p: OperationPreview, how: string) => {
      const entries = p.ledger!.entries as unknown as Array<Record<string, unknown>>;
      entries[entries.length - 1] = { ...entries[entries.length - 1], touched: how };
      return p;
    };
    m.runApproved.mockResolvedValueOnce(bridge({ preview: touched(withLedger([E1, E2]), 'deleted') }));
    const made = await ask('w3', 'test.enter');
    const res = await approveAgentRequest(people.bo, made.id, {}, { atHost: true });
    expect(res.request).toMatchObject({ status: 'executed', posted: true, entryIds: [E1] });
    // Only a void: the ledger moved (the agent's own commit would say 'posted' too), nothing to link to.
    m.runApproved.mockResolvedValueOnce(bridge({ preview: touched(withLedger([E2]), 'voided') }));
    const voided = await ask('w3', 'test.enter');
    expect((await approveAgentRequest(people.bo, voided.id, {}, { atHost: true })).request).toMatchObject({ posted: true, entryIds: [] });
  });

  it('a run that never read the ledger does not claim to know what it posted', async () => {
    // An operation whose service opens its own database handle (dryRun 'none'), or a desktop flow,
    // reports no ledger: no preview at all, or one whose ledger is null.
    for (const preview of [null, { ...NEW_PREVIEW, routePreview: null }]) {
      m.runApproved.mockResolvedValueOnce(bridge({ preview }));
      const view = await ask('w3', 'test.enter');
      const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
      expect(res.request.status).toBe('executed');
      expect(res.request.posted).toBeUndefined();
      expect(res.request.entryIds).toBeUndefined();
      const agentSees = await requestForAgent(agentCtx.w3, view.id);
      expect(agentSees?.posted).toBeUndefined();
      expect((await rowOf(view.id)).result).not.toHaveProperty('posted');
    }
  });

  it('a run that failed, or that the books changed under, posted nothing', async () => {
    m.runApproved.mockResolvedValueOnce(
      bridge({ mode: 'dry_run', outcome: 'error', stalenessKey: 'v2', preview: withLedger([E1]), result: null, error: { message: 'Customer is inactive.', code: null, details: null } }),
    );
    const view = await ask('w3', 'test.enter');
    expect((await approveAgentRequest(people.bo, view.id, {}, { atHost: true })).request).toMatchObject({ status: 'failed', posted: false, entryIds: [] });
  });

  it('a request done before this was kept does not claim to know what it posted', async () => {
    const view = await ask('w3', 'test.enter');
    await db
      .update(agentPermissionRequests)
      .set({ status: 'executed', result: { answer: { id: 'old-1' }, file: null } })
      .where(eq(agentPermissionRequests.id, view.id));
    const seen = await requestForAgent(agentCtx.w3, view.id);
    expect(seen?.result).toEqual({ id: 'old-1' });
    expect(seen?.posted).toBeUndefined();
    expect(seen?.entryIds).toBeUndefined();
  });

  it('a request waiting in a stale round carries the stale mark for everyone; it goes once done', async () => {
    const view = await ask('w3', 'test.enter');
    m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', preview: NEW_PREVIEW, stalenessKey: 'v2' }));
    const stale = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(stale.status).toBe('stale');
    expect(stale.request.stale).toBe(true);
    expect((await requestForPerson(people.cy, view.id)).stale).toBe(true);
    expect((await listRequestsForPerson(people.cy, { agentId: agentCtx.w3.agent!.id })).find((r) => r.id === view.id)?.stale).toBe(true);
    expect((await requestForAgent(agentCtx.w3, view.id))?.stale).toBe(true);
    const done = await approveAgentRequest(people.bo, view.id, { acceptStale: true }, { atHost: true });
    expect(done.request).toMatchObject({ status: 'executed', stale: false });
  });

  it('the standing permission given is on the request: its minutes, limits and end', () =>
    atMidday(async () => {
      const view = await ask('w3', 'test.enter');
      const before = Date.now();
      const res = await approveAgentRequest(people.bo, view.id, { grant: { minutes: 5, constraints: { maxAmount: '10.00' } } }, { atHost: true });
      expect(res.status).toBe('executed');
      expect(res.request.grant).toMatchObject({ minutes: 5, constraints: { maxAmount: '10.00' } });
      const ends = Date.parse(res.request.grant!.expiresAt);
      expect(ends).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
      expect(ends).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
      expect(res.request.grantError).toBeNull();
      expect((await requestForAgent(agentCtx.w3, view.id))?.grant).toEqual(res.request.grant);
    }));

  it('standing permission refused with the approval: the work still counts as done, and the person is told why', () =>
    atMidday(async () => {
      const WHY = 'Only an Admin can give standing permission for sending things outside this computer. Approve this request on its own, or ask an Admin.';
      m.createGrant.mockRejectedValueOnce(new ServiceError('FORBIDDEN', WHY));
      const view = await ask('w3', 'test.enter');
      const res = await approveAgentRequest(people.bo, view.id, { grant: { minutes: 1, constraints: {} } }, { atHost: true });
      expect(res.status).toBe('executed');
      expect(res.request).toMatchObject({ status: 'executed', error: null, grantId: null, grant: null, grantError: WHY });
      expect((await requestForPerson(people.bo, view.id)).grantError).toBe(WHY);
      const audit = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, view.id)));
      expect(audit.some((a) => (a.newValues as { grantNotGiven?: string }).grantNotGiven === WHY)).toBe(true);
    }));

  it('standing permission that fails for a reason nobody can name: the work is done, and nobody is told to ask again', () =>
    atMidday(async () => {
      // A plain error (no ServiceError), then an answer without a grant id: both the same to the person.
      m.createGrant.mockRejectedValueOnce(new Error('disk I/O error at page 42'));
      m.createGrant.mockResolvedValueOnce({ id: null });
      for (const n of [1, 2]) {
        const view = await ask('w3', 'test.enter', { summary: `Enter test record grant-${n}` });
        const res = await approveAgentRequest(people.bo, view.id, { grant: { minutes: 1, constraints: {} } }, { atHost: true });
        expect(res.status).toBe('executed');
        expect(res.request).toMatchObject({ status: 'executed', error: null, grantId: null, grant: null });
        expect(res.request.grantError).toMatch(/^Standing permission was not given because of an unexpected problem\. The work itself was done/);
        // Never the words that would have the work entered twice, never the inner error.
        expect(res.request.grantError).not.toMatch(/send the request again|could not finish this work/);
        expect(res.request.grantError).not.toContain('disk I/O');
      }
      expect(m.runApproved).toHaveBeenCalledTimes(2);
    }));

  it('a list works out the standing window once per kind of work, not once per request', () =>
    atMidday(async () => {
      await makeAgent('win');
      for (const amount of ['1.00', '2.00', '3.00']) await ask('win', 'test.enter', { facts: facts({ amount }) });
      await ask('win', 'test.change', { effectiveClass: 'change' });
      m.grantMinutesFor.mockClear();
      const listed = await listRequestsForPerson(people.bo, { agentId: agentCtx.win.agent!.id });
      expect(listed).toHaveLength(4);
      expect(listed.every((r) => r.canApprove && r.grantMinutesMax > 0)).toBe(true);
      // One company-day read for the three entries (amounts differ), one for the change.
      expect(m.grantMinutesFor).toHaveBeenCalledTimes(2);
    }));

  it('a route with no permission rule is refused in decide()\'s words: no role can allow it', async () => {
    op('test.norule', { rule: null });
    const view = await ask('w3', 'test.norule');
    const asAda = await requestForPerson(people.ada, view.id);
    expect(asAda.canApprove).toBe(false);
    expect(asAda.cannotApproveWhy).toMatch(/^No role can allow this request, not even Admin, because Ironbooks has no permission rule for it\./);
    expect(asAda.cannotApproveWhy).not.toMatch(/Someone who has that right/);
    await expectError(approveAgentRequest(people.ada, view.id, {}, { atHost: true }), 'FORBIDDEN', /No role can allow this request/);
    // Nobody but an Admin even sees it: nobody else's access allows it.
    await expectError(requestForPerson(people.bo, view.id), 'NOT_FOUND');
    expect(m.runApproved).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The status as a person sees it (exported for the audit report)
// ---------------------------------------------------------------------------

describe('shownStatus', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');

  it('pending past its expiry is expired; settled ones are as stored; an unknown word is withdrawn', () => {
    expect(shownStatus({ status: 'pending', expiresAt: new Date('2026-11-21T00:00:00.000Z') }, now)).toBe('pending');
    expect(shownStatus({ status: 'pending', expiresAt: '2026-11-19T00:00:00.000Z' }, now)).toBe('expired');
    expect(shownStatus({ status: 'pending', expiresAt: now }, now)).toBe('expired');
    // An expiry that cannot be read can never be approved.
    expect(shownStatus({ status: 'pending', expiresAt: null }, now)).toBe('expired');
    expect(shownStatus({ status: 'pending', expiresAt: 'soon' }, now)).toBe('expired');
    for (const s of ['approved', 'denied', 'executed', 'failed', 'cancelled', 'expired'] as const) {
      expect(shownStatus({ status: s, expiresAt: '2026-11-19T00:00:00.000Z' }, now)).toBe(s);
    }
    expect(shownStatus({ status: 'mystery', expiresAt: null }, now)).toBe('cancelled');
  });

  it('the first of two approvals leaves the request waiting, for a second person', async () => {
    await makeAgent('two3');
    m.policies.set(agentCtx.two3.agent!.id, { twoPersonOver: '1.00' });
    try {
      const view = await ask('two3', 'test.enter', { facts: facts({ amount: '99.00' }) });
      expect((await approveAgentRequest(people.bo, view.id, {}, { atHost: true })).status).toBe('needs_second_approver');
      const row = await rowOf(view.id);
      expect(row.decidedBy).toBe(people.bo.userId);
      expect(shownStatus(row)).toBe('pending');
    } finally {
      m.policies.delete(agentCtx.two3.agent!.id);
    }
  });
});

// ---------------------------------------------------------------------------
// The title bar's badge
// ---------------------------------------------------------------------------

describe('the badge', () => {
  // A moment the badge last settled at more than a minute before, or after (as a clock set back):
  // either way its first call settles, so "within the minute" is counted from there.
  const fresh = () => new Date(Date.now() + 10 * 60_000);

  afterEach(async () => {
    // What these tests made is dated ahead: it must not stay the newest waiting request for later tests.
    for (const key of ['badge', 'crowd']) {
      if (!agentCtx[key]) continue;
      await db
        .update(agentPermissionRequests)
        .set({ status: 'cancelled' })
        .where(and(eq(agentPermissionRequests.agentId, agentCtx[key].agent!.id), eq(agentPermissionRequests.status, 'pending')));
    }
  });

  it('counts and names the newest request this person could approve, from one read', () =>
    frozenAt(fresh(), async (moveTo) => {
      await makeAgent('badge');
      const before = await badgeForPerson(people.bo, { atHost: true });
      const first = await ask('badge', 'test.enter', { summary: 'Enter bill 1 from Staples', reason: 'THE AGENT SAYS THIS' });
      const second = await ask('badge', 'test.enter', { summary: 'Enter bill 2 from Staples', reason: 'THE AGENT SAYS THIS' });
      // Newer still, but not Bo's to approve.
      await ask('badge', 'test.enter', { needs: { ...NO_NEEDS, admin: true } });
      const after = await badgeForPerson(people.bo, { atHost: true });
      expect(after.pending).toBe(before.pending + 2);
      expect(after.newest).toEqual({ id: second.id, agentName: 'Agent badge', summary: 'Enter bill 2 from Staples', createdAt: second.createdAt });
      expect(JSON.stringify(after)).not.toContain('THE AGENT SAYS THIS');
      expect(await pendingCountForPerson(people.bo)).toBe(after.pending);
      expect((await badgeForPerson(people.rae, { atHost: true })).pending).toBe(0);

      // Past its expiry: not counted, though nothing has marked it yet (the badge settled under a minute ago).
      await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, second.id));
      moveTo(30_000);
      const later = await badgeForPerson(people.bo, { atHost: true });
      expect(later.pending).toBe(before.pending + 1);
      expect(later.newest?.id).toBe(first.id);
      expect((await rowOf(second.id)).status).toBe('pending');
      // A minute on, the badge marks it.
      moveTo(61_000);
      expect((await badgeForPerson(people.bo, { atHost: true })).pending).toBe(before.pending + 1);
      expect((await rowOf(second.id)).status).toBe('expired');
    }));

  it('marks what is overdue at most once a minute, masking for good what the request kept for its run', () =>
    frozenAt(fresh(), async (moveTo) => {
      await badgeForPerson(people.bo, { atHost: true });
      const view = await ask('badge', 'test.vendor', { input: { body: { name: 'V', amount: '1.00', taxId: '987-65-1111', accountNumber: '000999888777' } } });
      // Kept in the row while it can still run (the run must enter what the agent asked for).
      expect(JSON.stringify((await rowOf(view.id)).input)).toContain('987-65-1111');
      await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, view.id));
      moveTo(10_000);
      await badgeForPerson(people.bo, { atHost: true });
      expect((await rowOf(view.id)).status).toBe('pending');
      moveTo(61_000);
      // Nobody opened the list or the card: the title bar's poll settled it.
      await badgeForPerson(people.bo, { atHost: true });
      const row = await rowOf(view.id);
      expect(row.status).toBe('expired');
      for (const v of ['987-65-1111', '000999888777']) expect(JSON.stringify(row.input)).not.toContain(v);
      // Even for someone who sees none of it: settling is the company's, the count is the person's.
      await db.update(agentPermissionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentPermissionRequests.id, (await ask('badge', 'test.enter')).id));
      moveTo(130_000);
      expect((await badgeForPerson(people.rae, { atHost: true })).pending).toBe(0);
      const stillWaiting = await db
        .select()
        .from(agentPermissionRequests)
        .where(and(eq(agentPermissionRequests.companyId, companyId), eq(agentPermissionRequests.status, 'pending'), lte(agentPermissionRequests.expiresAt, new Date())));
      expect(stillWaiting).toHaveLength(0);
    }));

  it('someone who is not an Admin is not crowded out by work they cannot see', () =>
    frozenAt(fresh(), async () => {
      // More requests Bo cannot see than the badge judges at once, all newer than his.
      await makeAgent('crowd');
      op('test.adminonly', { rule: { area: 'users', action: 'modify' }, area: 'users', action: 'modify', class: 'admin' });
      const mine = await ask('crowd', 'test.enter', { summary: 'Enter the one Bo can approve' });
      const now = new Date();
      const many = Array.from({ length: 520 }, (_, i) => ({
        companyId,
        agentId: agentCtx.crowd.agent!.id,
        requestKey: `crowd-${i}`,
        operation: 'test.adminonly',
        class: 'admin',
        input: {},
        summary: `Admin work ${i}`,
        status: 'pending',
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: new Date(now.getTime() + 60_000 + i),
        needs: { ...NO_NEEDS, admin: true },
      }));
      const inserted = await db.insert(agentPermissionRequests).values(many).returning({ id: agentPermissionRequests.id });
      try {
        await expectError(requestForPerson(people.bo, inserted[0].id), 'NOT_FOUND');
        const badge = await badgeForPerson(people.bo, { atHost: true });
        expect(badge.newest?.id).toBe(mine.id);
        expect(badge.pending).toBeGreaterThanOrEqual(1);
        // The Admin sees and counts them.
        expect((await badgeForPerson(people.ada, { atHost: true })).pending).toBeGreaterThanOrEqual(500);
      } finally {
        await db.delete(agentPermissionRequests).where(like(agentPermissionRequests.requestKey, 'crowd-%'));
      }
    }));

  it('is nothing for an agent, a run inside an agent\'s scope, or a context without a person', async () => {
    const none = { pending: 0, newest: null };
    expect(await badgeForPerson(agentCtx.a, { atHost: true })).toEqual(none);
    expect(await badgeForPerson({ ...people.ada, agent: agentCtx.a.agent }, { atHost: true })).toEqual(none);
    expect(
      await runWithServiceContext(agentCtx.a, { path: '/api/estimates', method: 'GET' }, () => badgeForPerson(people.ada, { atHost: true })),
    ).toEqual(none);
    expect(await badgeForPerson({ db, companyId, userId: null }, { atHost: true })).toEqual(none);
  });
});

// ---------------------------------------------------------------------------
// The window it is approved from, and desktop flows
// ---------------------------------------------------------------------------

describe('the window it is approved from', () => {
  beforeAll(async () => {
    await makeAgent('host');
  });

  it('a teammate\'s window is told plainly it cannot approve host-only work, and does not count it', async () => {
    const view = await ask('host', 'test.host');
    const fromTeammate = await requestForPerson(people.bo, view.id, { atHost: false });
    expect(fromTeammate).toMatchObject({ canApprove: false, grantMinutesMax: 0 });
    expect(fromTeammate.cannotApproveWhy).toMatch(/only in Ironbooks on the computer that holds the company file/);
    const listed = (atHost?: boolean) =>
      listRequestsForPerson(people.bo, { agentId: agentCtx.host.agent!.id, ...(atHost === undefined ? {} : { atHost }) }).then((l) => l.find((r) => r.id === view.id));
    expect((await listed(false))?.canApprove).toBe(false);
    expect((await listed(true))?.canApprove).toBe(true);
    expect((await listed())?.canApprove).toBe(true);

    const atHost = await badgeForPerson(people.bo, { atHost: true });
    const teammate = await badgeForPerson(people.bo, { atHost: false });
    expect(atHost.newest?.id).toBe(view.id);
    expect(teammate.newest?.id).not.toBe(view.id);
    expect(teammate.pending).toBeLessThan(atHost.pending);
    // Saying no works from any window.
    expect((await denyAgentRequest(people.bo, view.id, null)).status).toBe('denied');
  });

  it('host-only work offers no standing window, though its class would allow one', () =>
    atMidday(async () => {
      // The same class, at the same hour, from the same person: a window is offered.
      const plain = await ask('host', 'test.enter');
      expect((await requestForPerson(people.bo, plain.id, { atHost: true })).grantMinutesMax).toBeGreaterThan(0);
      const view = await ask('host', 'test.host');
      const card = await requestForPerson(people.bo, view.id, { atHost: true });
      expect(card.canApprove).toBe(true);
      expect(card.grantMinutesMax).toBe(0);
      await expectError(approveAgentRequest(people.bo, view.id, { grant: { minutes: 1, constraints: {} } }, { atHost: true }), 'VALIDATION', /cannot be given/);
      expect(m.runApproved).not.toHaveBeenCalled();
      expect((await rowOf(view.id)).status).toBe('pending');
    }));

  it('file-Admin work offers no standing window either, though its class would allow one', () =>
    atMidday(async () => {
      // test.file is everyday entry (class enter), not host-only: only the file-Admin rule is in play.
      expect((m.ops.get('test.file') as Operation).hostOnly).toBe(false);
      const plain = await ask('host', 'test.enter');
      expect((await requestForPerson(people.ada, plain.id, { atHost: true })).grantMinutesMax).toBeGreaterThan(0);
      const view = await ask('host', 'test.file');
      expect(view.class).toBe('enter');
      // Ada is the Admin of every company in the file, so she may approve it, once.
      const card = await requestForPerson(people.ada, view.id, { atHost: true });
      expect(card.canApprove).toBe(true);
      expect(card.grantMinutesMax).toBe(0);
      await expectError(approveAgentRequest(people.ada, view.id, { grant: { minutes: 1, constraints: {} } }, { atHost: true }), 'VALIDATION', /cannot be given/);
      expect(m.runApproved).not.toHaveBeenCalled();
      expect(m.createGrant).not.toHaveBeenCalled();
      expect((await rowOf(view.id)).status).toBe('pending');
      expect((await approveAgentRequest(people.ada, view.id, {}, { atHost: true })).status).toBe('executed');
    }));
});

describe('a desktop flow', () => {
  const DEF = SHELL_OPERATIONS.find((d) => d.id === 'shell.company.open')!;
  const FILE = { body: { file: 'C:\\Books\\Acme.ironbooks' } };
  const ANSWERS = { temporaryFolder: 'Cancel', readOnlyFile: 'Cancel', cloudFolder: false };

  beforeAll(async () => {
    await makeAgent('shell');
    op(DEF.id, {
      kind: 'shell',
      route: DEF.flow,
      rule: null,
      area: null,
      action: null,
      class: DEF.class,
      hostOnly: true,
      fileAdmin: true,
      dryRun: 'none',
      amountField: null,
      describe: DEF.describe,
    });
  });

  const askShell = (over: Partial<NewAgentRequest> = {}) => ask('shell', DEF.id, { effectiveClass: 'file', input: FILE, facts: facts({ amount: null }), stalenessKey: null, ...over });

  it('its questions are on the card, and each must have an answer the shell can use before anything runs', async () => {
    const view = await askShell();
    const card = await requestForPerson(people.ada, view.id, { atHost: true });
    expect(card.questions).toEqual(DEF.questions);
    expect(card.questions!.length).toBeGreaterThan(0);
    expect(card).toMatchObject({ canApprove: true, grantMinutesMax: 0 });
    // Anything that is not a desktop flow has none.
    expect((await requestForPerson(people.ada, (await ask('shell', 'test.enter')).id)).questions).toEqual([]);

    await expectError(approveAgentRequest(people.ada, view.id, {}, { atHost: true }), 'VALIDATION', /Answer every question/);
    await expectError(approveAgentRequest(people.ada, view.id, { answers: { ...ANSWERS, cloudFolder: '' } }, { atHost: true }), 'VALIDATION', /Answer every question/);
    await expectError(approveAgentRequest(people.ada, view.id, { answers: { ...ANSWERS, temporaryFolder: 'Maybe' } }, { atHost: true }), 'VALIDATION', /one of: Save a Copy and Open It/);
    await expectError(approveAgentRequest(people.ada, view.id, { answers: { ...ANSWERS, cloudFolder: 'perhaps' } }, { atHost: true }), 'VALIDATION', /yes or no/);
    await expectError(approveAgentRequest(people.ada, view.id, { answers: ANSWERS }, { atHost: false }), 'FORBIDDEN', /computer that holds the company file/);
    expect(m.runApproved).not.toHaveBeenCalled();
    expect((await rowOf(view.id)).status).toBe('pending');

    // The shell's own words are accepted too (any case, yes/no as text).
    const res = await approveAgentRequest(people.ada, view.id, { answers: { temporaryFolder: 'open it here anyway', readOnlyFile: 'CANCEL', cloudFolder: 'Yes' } }, { atHost: true });
    expect(res.status).toBe('executed');
    expect(m.runApproved.mock.calls[0][2].answers).toEqual({ temporaryFolder: 'open it here anyway', readOnlyFile: 'CANCEL', cloudFolder: 'Yes' });
  });

  it('one that fails is failed for good and never runs again under the same id', async () => {
    const SAID = 'Ironbooks needed an answer and the approval gave none, so it stopped there. The agent can ask again.';
    m.runApproved.mockResolvedValue(bridge({ outcome: 'error', httpStatus: 0, result: null, stalenessKey: null, error: { message: SAID, code: null, details: null } }));
    const view = await askShell({ requestKey: 'shell-open-once' });
    const res = await approveAgentRequest(people.ada, view.id, { answers: ANSWERS }, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request).toMatchObject({ status: 'failed', error: SAID, posted: false, stale: false });
    await expectError(approveAgentRequest(people.ada, view.id, { answers: ANSWERS }, { atHost: true }), 'CONFLICT');
    await expectError(batchApprove(people.ada, [view.id], { atHost: true }), 'VALIDATION');
    expect(m.runApproved).toHaveBeenCalledTimes(1);
    // Asking again with the same request id gives the failed request back: nothing new to approve.
    expect(await askShell({ requestKey: 'shell-open-once' })).toMatchObject({ id: view.id, status: 'failed' });
    expect(await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.requestKey, 'shell-open-once'))).toHaveLength(1);
  });

  it('a flow whose password is needed only for a protected file can be approved without one', async () => {
    // A portable file saved without a password needs none: the flow asks only when the file is protected.
    const PORTABLE = SHELL_OPERATIONS.find((d) => d.id === 'shell.portable.open')!;
    expect(PORTABLE.needsSecret).toEqual(['backup_password']);
    op(PORTABLE.id, {
      kind: 'shell',
      route: PORTABLE.flow,
      rule: null,
      area: null,
      action: null,
      class: PORTABLE.class,
      hostOnly: true,
      fileAdmin: true,
      dryRun: 'none',
      amountField: null,
      describe: PORTABLE.describe,
      needsSecret: [...PORTABLE.needsSecret],
    });
    const view = await ask('shell', PORTABLE.id, {
      effectiveClass: 'file',
      input: { body: { file: 'C:\\Books\\Acme.bkp', target: 'C:\\Books\\Acme Restored.ironbooks' } },
      facts: facts({ amount: null }),
      stalenessKey: null,
    });
    const res = await approveAgentRequest(people.ada, view.id, { answers: { openNow: false } }, { atHost: true });
    expect(res.status).toBe('executed');
    expect(m.runApproved).toHaveBeenCalledTimes(1);
    expect(m.runApproved.mock.calls[0][2].secrets).toEqual({});
  });

  it('an answer that reads like "the books changed" never sends it back to waiting', async () => {
    m.runApproved.mockResolvedValueOnce(bridge({ mode: 'dry_run', outcome: 'ok', stalenessKey: 'v2', preview: NEW_PREVIEW }));
    const view = await askShell();
    const res = await approveAgentRequest(people.ada, view.id, { answers: ANSWERS }, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request).toMatchObject({ status: 'failed', stale: false });
    expect(res.request.error).toMatch(/unexpected problem/);
    expect((await rowOf(view.id)).status).toBe('failed');
    await expectError(approveAgentRequest(people.ada, view.id, { answers: ANSWERS }, { atHost: true }), 'CONFLICT');
    expect(m.runApproved).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The standing window is the one createGrant accepts
// ---------------------------------------------------------------------------

describe('the standing window offered', () => {
  it("is the end of the company's own day, not this computer's, and createGrant accepts exactly it", async () => {
    await makeAgent('tz');
    const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const settings = (company.settings ?? {}) as Record<string, unknown>;
    await db.update(companies).set({ settings: { ...settings, timezone: 'Asia/Kolkata' } }).where(eq(companies.id, companyId));
    // 17:45 UTC is 23:15 in Kolkata (no daylight saving): 45 minutes are left of the company's day,
    // whatever this computer's own zone says. Only Date is frozen; timers run as usual.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T17:45:00.000Z'));
    m.createGrant.mockImplementation((...args: never[]) => m.real.createGrant!(...args));
    try {
      const view = await ask('tz', 'test.enter');
      const card = await requestForPerson(people.bo, view.id, { atHost: true });
      expect(card.grantMinutesMax).toBe(45);
      await expectError(approveAgentRequest(people.bo, view.id, { grant: { minutes: 46, constraints: {} } }, { atHost: true }), 'VALIDATION', /at most 45 minutes/);
      expect(m.runApproved).not.toHaveBeenCalled();
      const res = await approveAgentRequest(people.bo, view.id, { grant: { minutes: 45, constraints: {} } }, { atHost: true });
      expect(res.status).toBe('executed');
      expect(res.request.grantError).toBeNull();
      expect(res.request.grantId).toBeTruthy();
      expect(res.request.grant).toEqual({ minutes: 45, constraints: {}, expiresAt: '2026-11-20T18:30:00.000Z' });
    } finally {
      vi.useRealTimers();
      await db.update(companies).set({ settings }).where(eq(companies.id, companyId));
    }
  });
});

// ---------------------------------------------------------------------------
// Batch approval reports what it did not approve
// ---------------------------------------------------------------------------

describe('batch approval, item by item', () => {
  it('one this person may not approve is reported not approved, nothing runs for it, and the others still run', async () => {
    await makeAgent('batch3');
    const one = await ask('batch3', 'test.enter');
    const adminOnly = await ask('batch3', 'test.enter', { needs: { ...NO_NEEDS, admin: true } });
    const three = await ask('batch3', 'test.enter');
    const results = await batchApprove(people.bo, [one.id, adminOnly.id, three.id], { atHost: true });
    expect(results.map((r) => r.status)).toEqual(['executed', 'not_approved', 'executed']);
    expect(results[1].request.status).toBe('pending');
    expect(results[1].request.error).toMatch(/Only an Admin/);
    expect(m.runApproved).toHaveBeenCalledTimes(2);
    expect((await rowOf(adminOnly.id)).status).toBe('pending');
    // Still waiting for someone who may approve it.
    expect((await approveAgentRequest(people.dee, adminOnly.id, {}, { atHost: true })).status).toBe('executed');
  });

  it('one someone else denied meanwhile is not approved either, and says so', async () => {
    const one = await ask('batch3', 'test.enter');
    const two = await ask('batch3', 'test.enter');
    let calls = 0;
    m.runApproved.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await denyAgentRequest(people.cy, two.id, 'Not this one.');
      return bridge();
    });
    const results = await batchApprove(people.bo, [one.id, two.id], { atHost: true });
    expect(results.map((r) => r.status)).toEqual(['executed', 'not_approved']);
    expect(results[1].request).toMatchObject({ status: 'denied', error: 'This request was denied.' });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// An approval that claimed a request and then lost track of it
// ---------------------------------------------------------------------------

describe('an approval that loses track of its run', () => {
  const LOST = /cannot tell whether it was done\. Check the books before asking the agent to send it again\./;
  // A run that worked, with an answer that cannot be kept (JSON has no big integers): the approval
  // stops after the run has ended, before it can record how it went.
  const unkeepable = () => bridge({ result: { id: 'rec-1', big: BigInt(10) } });

  beforeAll(async () => {
    await makeAgent('lost');
  });

  it('ends the request as failed at once, its outcome unknown and its input masked, never "being carried out"', async () => {
    m.runApproved.mockResolvedValueOnce(unkeepable());
    const view = await ask('lost', 'test.vendor', { input: { body: { name: 'V', amount: '1.00', taxId: '555-66-7777' } } });
    const res = await approveAgentRequest(people.bo, view.id, {}, { atHost: true });
    expect(res.status).toBe('failed');
    expect(res.request.status).toBe('failed');
    expect(res.request.error).toMatch(LOST);
    const row = await rowOf(view.id);
    expect(row.status).toBe('failed');
    expect(JSON.stringify(row.input)).not.toContain('555-66-7777');
    expect((await requestForAgent(agentCtx.lost, view.id))?.status).toBe('failed');
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, view.id)));
    expect(audit.some((a) => (a.newValues as { outcomeUnknown?: boolean }).outcomeUnknown === true)).toBe(true);
    expect(m.runApproved).toHaveBeenCalledTimes(1);
  });

  it('in a batch, one it claimed and lost track of is failed, never "not approved"; the others still run', async () => {
    const one = await ask('lost', 'test.enter');
    const two = await ask('lost', 'test.enter');
    const three = await ask('lost', 'test.enter');
    let calls = 0;
    m.runApproved.mockImplementation(async () => {
      calls += 1;
      if (calls !== 2) return bridge();
      // The second run worked, then its record could not be kept, and the request can no longer be
      // ended as this approval's (it no longer reads as Bo's claim): only the batch knows it claimed it.
      await db.update(agentPermissionRequests).set({ decidedBy: people.cy.userId }).where(eq(agentPermissionRequests.id, two.id));
      return unkeepable();
    });
    try {
      const results = await batchApprove(people.bo, [one.id, two.id, three.id], { atHost: true });
      expect(results.map((r) => r.status)).toEqual(['executed', 'failed', 'executed']);
      expect(results[1].request.error).toMatch(LOST);
      expect(calls).toBe(3);
    } finally {
      // Left "being carried out" (the stuck-run rule would settle it hours from now).
      await db.update(agentPermissionRequests).set({ status: 'failed' }).where(eq(agentPermissionRequests.id, two.id));
    }
  });

  it('in a batch, one it claimed and ended as failed is reported failed', async () => {
    const one = await ask('lost', 'test.enter');
    const two = await ask('lost', 'test.enter');
    m.runApproved.mockResolvedValueOnce(unkeepable()).mockResolvedValueOnce(bridge());
    const results = await batchApprove(people.bo, [one.id, two.id], { atHost: true });
    expect(results.map((r) => r.status)).toEqual(['failed', 'executed']);
    expect(results[0].request.error).toMatch(LOST);
    expect((await rowOf(one.id)).status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// A password the run cannot do without
// ---------------------------------------------------------------------------

describe('a password the run cannot do without', () => {
  beforeAll(async () => {
    await makeAgent('pw');
    // Its route always takes the closing-date password (as moving the closing date does).
    op('test.secret', { needsSecret: ['closing_password'] });
  });

  it('a yes without it is sent back to the card: nothing is claimed or run, the request still waits', async () => {
    const view = await ask('pw', 'test.secret');
    await expectError(approveAgentRequest(people.bo, view.id, {}, { atHost: true }), 'VALIDATION', /^Type the closing-date password on the card, then approve again\. Nothing was done\.$/);
    await expectError(approveAgentRequest(people.bo, view.id, { secrets: { closing_password: '' } }, { atHost: true }), 'VALIDATION', /closing-date password/);
    expect(m.runApproved).not.toHaveBeenCalled();
    expect((await rowOf(view.id)).status).toBe('pending');
    const done = await approveAgentRequest(people.bo, view.id, { secrets: { closing_password: 'Close-2026!' } }, { atHost: true });
    expect(done.status).toBe('executed');
    expect(m.runApproved.mock.calls[0][2].secrets).toEqual({ closing_password: 'Close-2026!' });
  });

  it('the first of two approvals types nothing; the second one must', async () => {
    m.policies.set(agentCtx.pw.agent!.id, { twoPersonOver: '1.00' });
    try {
      const view = await ask('pw', 'test.secret', { facts: facts({ amount: '99.00' }) });
      expect((await approveAgentRequest(people.bo, view.id, {}, { atHost: true })).status).toBe('needs_second_approver');
      await expectError(approveAgentRequest(people.cy, view.id, {}, { atHost: true }), 'VALIDATION', /closing-date password/);
      expect(m.runApproved).not.toHaveBeenCalled();
      expect((await approveAgentRequest(people.cy, view.id, { secrets: { closing_password: 'Close-2026!' } }, { atHost: true })).status).toBe('executed');
    } finally {
      m.policies.delete(agentCtx.pw.agent!.id);
    }
  });
});
