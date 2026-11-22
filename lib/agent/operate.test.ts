/**
 * Agent full access: the agent's door (lib/agent/operate.ts, app/api/agent/actions/route.ts).
 *
 * Most tests replace the bridge, the input guard, the facts, the summary, the policy store, grants,
 * permission requests, staged files and the shell (they are other units' work) with stand-ins; the
 * policy engine (lib/agent/policy.ts decide), people's access (lib/services/access.ts) and the
 * request-id table (agent_requests, a real company database) are the real ones. The last block
 * puts the real bridge, guards, facts, summary and grants back and runs journal entries through
 * the app's own route on the same PGlite company. What is proved:
 *
 *  - every branch of operate: unknown, guarded, refused, read, dry run, run, ask, replay;
 *  - the policy decides a second time with what the dry run showed, and that answer is followed:
 *    run can become ask or refuse, and an ask whose amount was unknown can run; when nothing shows
 *    the real figures, the amount counts as unknown (two people, no grant by amount);
 *  - a missing reason never creates a request;
 *  - a warning from work that is not undone keeps its request id: never run twice;
 *  - a dry-run refusal becomes an ask only when an approved reveal would get it through;
 *  - the actor of an agent's own run never carries secrets, a reveal, a person or an approval; a
 *    run under a grant has the giver's access within the agent's role, and a grant whose giver is
 *    gone or lost the right does not apply;
 *  - runApproved runs as the approver, within the approver's access INTERSECTED with the agent's
 *    role; it tries the request first with those rights, shows a fresh preview instead of running
 *    when the books changed or the real figures are more than the person read (the card's figures,
 *    or the agent's own where the card had none), and never reads acceptStale; work found dated in
 *    a closed period goes back as closed-period work; a request only an approved reveal gets
 *    through is tried with the reveal for its figures alone, and its preview never leaves;
 *  - an ask whose real figures were not seen stores its amount as unknown, never the agent's figure;
 *  - intersectAccess is never wider than either side (property test over areas, activities, flags);
 *  - the verbs (find and describe judged as a real request is, examples, permissions with grants'
 *    real limits and this company's people signed in), the rate limits with when to try again, and
 *    the route sending `{ verb }` bodies to them (429 with Retry-After when slowed down) and
 *    everything else to the curated actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-operate');
const TEST_DIR = path.join(ROOT, 'data');
const SAVE_DIR = path.join(ROOT, 'saved');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-operate-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

const m = vi.hoisted(() => ({
  ops: new Map<string, unknown>(),
  shellOps: [] as unknown[],
  views: new Map<string, Record<string, unknown>>(),
  runOperation: vi.fn(),
  guardInput: vi.fn(),
  factsOf: vi.fn(),
  describeRequest: vi.fn(),
  loadAgentPolicy: vi.fn(),
  agentCeiling: vi.fn(),
  liveGrants: vi.fn(),
  createAgentRequest: vi.fn(),
  requestForAgent: vi.fn(),
  listRequestsForAgent: vi.fn(),
  cancelAgentRequest: vi.fn(),
  describeSchemas: vi.fn(),
  uploadChunk: vi.fn(),
  readStagedFile: vi.fn(),
  stagedFileInfo: vi.fn(),
  allowedFolder: vi.fn(),
  runShellOperation: vi.fn(),
  defaultAgentFolders: vi.fn(),
  listActiveSessions: vi.fn(),
  getServerContext: vi.fn(),
}));

// Stand-ins by default; the real module behind each, for the block that runs the real bridge.
vi.mock('@/lib/agent/bridge', async (orig) => ({ ...(await orig<Record<string, unknown>>()), runOperation: m.runOperation }));
vi.mock('@/lib/agent/guards', async (orig) => ({ ...(await orig<Record<string, unknown>>()), guardInput: m.guardInput }));
vi.mock('@/lib/agent/facts', async (orig) => ({ ...(await orig<Record<string, unknown>>()), factsOf: m.factsOf }));
vi.mock('@/lib/agent/describe', async (orig) => ({ ...(await orig<Record<string, unknown>>()), describeRequest: m.describeRequest }));
vi.mock('@/lib/services/agentPolicies', () => ({ loadAgentPolicy: m.loadAgentPolicy, agentCeiling: m.agentCeiling }));
vi.mock('@/lib/services/agentGrants', async (orig) => ({ ...(await orig<Record<string, unknown>>()), liveGrants: m.liveGrants }));
vi.mock('@/lib/services/agentRequests', () => ({
  createAgentRequest: m.createAgentRequest,
  requestForAgent: m.requestForAgent,
  listRequestsForAgent: m.listRequestsForAgent,
  cancelAgentRequest: m.cancelAgentRequest,
}));
// The schemas are a stand-in; the examples are the real reading of them (examplesOf).
vi.mock('@/lib/agent/operations/schemas', async (orig) => ({ ...(await orig<Record<string, unknown>>()), describeSchemas: m.describeSchemas }));
vi.mock('@/lib/agent/files', () => ({
  uploadChunk: m.uploadChunk,
  readStagedFile: m.readStagedFile,
  stagedFileInfo: m.stagedFileInfo,
  allowedFolder: m.allowedFolder,
  stageFile: vi.fn(),
  clearStagedFiles: vi.fn(),
}));
vi.mock('@/lib/agent/shell', () => ({
  runShellOperation: m.runShellOperation,
  defaultAgentFolders: m.defaultAgentFolders,
  AGENT_OUTBOX_NAME: 'Agent Outbox',
  shellAvailable: () => false,
}));
vi.mock('@/lib/agent/operations/shell', () => ({
  get SHELL_OPERATIONS() {
    return m.shellOps;
  },
}));
vi.mock('@/lib/agent/operations/registry', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  operationById: (id: string) => m.ops.get(id) ?? null,
  findOperations: (o: { query?: string; area?: string; class?: string; limit?: number } = {}) =>
    [...m.ops.values()]
      .filter((op) => {
        const x = op as { id: string; area: string | null; class: string };
        return (!o.area || x.area === o.area) && (!o.class || x.class === o.class) && (!o.query || x.id.includes(o.query));
      })
      .slice(0, o.limit ?? 30),
}));
vi.mock('@/lib/services/sessions', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listActiveSessions: m.listActiveSessions }));
vi.mock('@/lib/context', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getServerContext: m.getServerContext }));

import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  agentGrants,
  agentPermissionRequests,
  agentRequests,
  agents,
  auditLogs,
  companies,
  companyRoles,
  journalEntries,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { resolveAccess } from '@/lib/services/access';
import { maskedForAgent } from '@/lib/permissions/agentAccess';
import { OPERATION_CLASSES } from '@/lib/agent/operations/classes';
import {
  ACTIONS,
  AREA_KEYS,
  FLAGS,
  builtinRole,
  can,
  canActivity,
  canSomeActivity,
  fullAccess,
  isSubset,
  unionRoles,
  type EffectiveAccess,
  type PermissionGrant,
  type RoleDefinition,
} from '@/lib/permissions/model';
import { ACTIVITIES, ACTIVITY_KEYS, supportedActions, type ActivityDef } from '@/lib/permissions/activities';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { REQUEST_ID_MESSAGE } from './actions';
import { resolvePolicy } from './policy';
import type { AgentGrant, AgentPolicy, AgentPreset, Operation, RequestFacts } from './operations/types';
import type { BridgeActor, BridgeMode, BridgeResult, OperationInput, OperationPreview, ShellOperationDef } from './contract';
import {
  AGENT_CALLS_PER_MINUTE,
  AGENT_RUNS_AT_ONCE,
  AgentRateLimited,
  NO_REASON_NOTE,
  agentRetryAfter,
  handleVerb,
  intersectAccess,
  lowerRole,
  operate,
  resetAgentRateLimits,
  runApproved,
} from './operate';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function op(over: Partial<Operation> = {}): Operation {
  return {
    id: 'invoices.create',
    kind: 'route',
    route: '/api/invoices',
    method: 'POST',
    params: [],
    rule: { area: 'customers', action: 'create' },
    area: 'customers',
    action: 'create',
    activity: null,
    classified: true,
    class: 'enter',
    describe: 'Enter an invoice',
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
    amountField: null,
    alwaysAsk: false,
    bodySchema: null,
    ...over,
  };
}

const OPS: Operation[] = [
  op({ id: 'invoices.list', method: 'GET', rule: { area: 'customers', action: 'view' }, action: 'view', class: 'read', describe: 'List invoices', body: 'none' }),
  op({ id: 'invoices.create', amountField: 'total', confirmFlags: ['allowDuplicateNumber'] }),
  op({ id: 'invoices.batch', route: '/api/invoices/batch', class: 'bulk', countField: 'items', describe: 'Enter invoices in a batch' }),
  op({ id: 'invoices.delete', route: '/api/invoices/[id]', method: 'DELETE', params: ['id'], rule: { area: 'customers', action: 'delete' }, action: 'delete', class: 'remove', describe: 'Delete invoice {id}' }),
  op({ id: 'invoices.email', route: '/api/invoices/[id]/email', params: ['id'], class: 'outside', dryRun: 'none', effects: ['email'], describe: 'Email invoice {id}' }),
  op({ id: 'agents.create', route: '/api/agents', rule: { area: 'users', action: 'create' }, area: 'users', class: 'admin', availability: 'hard_floor', describe: 'Make an agent' }),
  op({ id: 'company.network', route: '/api/network-policy', method: 'PATCH', rule: { area: 'customers', action: 'modify' }, action: 'modify', class: 'settings', hostOnly: true, describe: 'Change network policy' }),
  // A change whose service opens its own database handle: the bridge commits it without a wrapping
  // transaction, so a failure may have kept part of it.
  op({ id: 'feeds.refresh', route: '/api/bank-feeds/refresh', dryRun: 'none', describe: 'Refresh the bank feeds' }),
  // A change whose full SSNs can be revealed (an approved reveal turns on "View sensitive payroll").
  op({
    id: 'employees.update',
    route: '/api/employees/[id]',
    method: 'PATCH',
    params: ['id'],
    rule: { area: 'payroll', action: 'modify' },
    area: 'payroll',
    action: 'modify',
    class: 'change',
    reveal: 'ssn',
    describe: 'Change employee {id}',
  }),
  // Work that names no amount field (its amount is what the ledger shows).
  op({ id: 'customers.create', route: '/api/customers', describe: 'Add a customer' }),
  // Work that is not undone when it stops, with a warning the agent may accept.
  op({ id: 'feeds.import', route: '/api/bank-feeds/import', dryRun: 'none', confirmFlags: ['allowDuplicate'], effects: ['network'], describe: 'Import bank lines' }),
  // A route with a preview of its own: the bridge describes it, so its figures are never seen ahead.
  op({ id: 'bills.receive', route: '/api/receiving/bill', dryRun: 'preview', amountField: 'total', describe: 'Enter a bill for received items' }),
  // Desktop and server actions (lib/agent/operations/shell.ts). The area and action are the test's
  // own, so a role that is not Admin passes the ceiling.
  op({ id: 'files.save', kind: 'shell', route: 'saveStagedFile', rule: null, action: 'view', class: 'file', dryRun: 'none', describe: 'Save file {fileId} in {folder}' }),
  op({ id: 'shell.print.file', kind: 'shell', route: 'printFileFlow', rule: null, action: 'print', class: 'print', dryRun: 'none', describe: 'Print file {fileId}' }),
];

function shellDef(over: Partial<ShellOperationDef>): ShellOperationDef {
  return {
    id: 'shell.print.file',
    runner: 'electron',
    flow: 'printFileFlow',
    class: 'print',
    area: 'customers',
    describe: 'Print a file',
    why: 'Paper leaves the computer.',
    input: { fileId: { type: 'fileId', required: true, describe: 'The file' } },
    questions: [],
    needsSecret: [],
    hostOnly: false,
    fileAdmin: false,
    restarts: false,
    ...over,
  };
}

function custom(permissions: PermissionGrant, flags: RoleDefinition['flags'] = {}): EffectiveAccess {
  return unionRoles([{ key: 'custom', name: 'Custom', description: '', builtin: false, permissions, flags }]);
}

/** The agent's role: customers, payroll, banking and the general ledger in full, and every flag (the door must mask them). */
const CEILING = custom(
  { customers: ['full'], payroll: ['full'], banking: ['full'], accounting: ['full'] },
  { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true },
);

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false, ...over };
}

/** The facts stand-in: amount from body.total, count from body.items, date from body.date. */
function bodyFacts(_op: Operation, input: OperationInput, opts: { closingDate: string | null }): RequestFacts {
  const b = (input.body ?? {}) as Record<string, unknown>;
  const date = typeof b.date === 'string' ? b.date : null;
  return facts({
    confirm: input.confirm ?? [],
    reveal: input.reveal === true,
    amount: typeof b.total === 'string' ? b.total : null,
    count: Array.isArray(b.items) ? b.items.length : null,
    date,
    closedPeriod: Boolean(date && opts.closingDate && date <= opts.closingDate),
  });
}

function preview(entries: number): OperationPreview {
  return {
    ledger: {
      entries: Array.from({ length: entries }, (_, i) => ({
        journalEntryId: `je-${i}`,
        entryNumber: i + 1,
        date: '2026-11-20',
        description: 'Invoice',
        status: 'posted',
        source: null,
        lines: [],
      })),
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

function bridged(mode: BridgeMode, over: Partial<BridgeResult> = {}): BridgeResult {
  return {
    mode,
    httpStatus: 200,
    outcome: 'ok',
    result: { id: 'inv-1', total: '10.00' },
    file: null,
    preview: mode === 'read' ? null : preview(1),
    warnings: [],
    error: null,
    effects: [],
    facts: facts(),
    stalenessKey: mode === 'read' ? null : 'k1',
    produced: [],
    ...over,
  };
}

/** What the bridge answers per mode in one test; anything not given is a plain success. */
function bridgeAnswers(answers: Partial<Record<BridgeMode, (input: OperationInput) => Partial<BridgeResult>>>) {
  m.runOperation.mockImplementation(async (_base: unknown, operation: Operation, input: OperationInput, mode: BridgeMode) => {
    const over = answers[mode]?.(input) ?? {};
    return bridged(mode, { facts: bodyFacts(operation, input, { closingDate: null }), ...over });
  });
}

function callsOf(mode: BridgeMode): Array<{ base: ServiceContext; operation: Operation; input: OperationInput; actor: BridgeActor }> {
  return m.runOperation.mock.calls
    .filter((c) => c[3] === mode)
    .map((c) => ({ base: c[0] as ServiceContext, operation: c[1] as Operation, input: c[2] as OperationInput, actor: c[4] as BridgeActor }));
}

let policy: AgentPolicy;
let grants: AgentGrant[];
let db: DB;
let companyId: string;
let ownerId: string;
let agentId: string;
let agentCtx: ServiceContext;
let approver: ServiceContext;
let n = 0;
const rid = () => `req-${++n}-${Math.random().toString(36).slice(2, 8)}`;

function usePolicy(preset: AgentPreset, limits: Parameters<typeof resolvePolicy>[2] = {}) {
  policy = resolvePolicy(preset, [], { folders: [SAVE_DIR], ...limits });
}

function storeView(view: Record<string, unknown>) {
  m.views.set(String(view.id), view);
  m.views.set(`key:${String(view.requestKey ?? '')}`, view);
}

/** A live grant of this agent (20 minutes left), given by the owner unless said otherwise. */
function grantOf(over: Partial<AgentGrant> = {}): AgentGrant {
  return {
    id: randomUUID(),
    agentId,
    operation: 'invoices.create',
    constraints: {},
    givenBy: ownerId,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    revokedAt: null,
    uses: 0,
    ...over,
  };
}

/** A person of the company: by their legacy role, or with a custom role of these rights. */
async function member(name: string, role: string, permissions?: PermissionGrant, isActive = true): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${randomUUID()}@operate.test`, name, passwordHash: 'x' }).returning();
  const legacy = (['owner', 'admin', 'accountant', 'viewer'] as const).find((r) => r === role) ?? 'viewer';
  await db.insert(userCompanies).values({ userId: u.id, companyId, role: legacy, isActive });
  if (permissions) {
    const [r] = await db.insert(companyRoles).values({ companyId, name, permissions: permissions as Record<string, string[]>, flags: {} }).returning();
    await db.insert(userRoleAssignments).values({ companyId, userId: u.id, roleKey: r.id });
  }
  return u.id;
}

async function claimRow(requestKey: string) {
  const [row] = await db.select().from(agentRequests).where(eq(agentRequests.requestKey, requestKey));
  return row ?? null;
}

async function expectError(p: Promise<unknown>, code: string, message?: RegExp | string): Promise<ServiceError> {
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

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@operate.test', name: 'Olive Owner', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  // A company as the app makes one: its owner's membership and the default chart of accounts.
  const company = await createCompany(db, { name: 'Operate Co', ownerId });
  companyId = company.id;
  const [agent] = await db
    .insert(agents)
    .values({ companyId, name: 'Robo', roleKeys: ['bookkeeper'], mode: 'propose', tokenHash: 'f'.repeat(64), tokenPrefix: 'ib_test' })
    .returning();
  agentId = agent.id;
  agentCtx = {
    db,
    companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access: CEILING,
    agent: { id: agentId, name: 'Robo', mode: 'propose', onBehalfOf: ownerId },
    readOnly: true,
  };
  approver = { db, companyId, userId: ownerId, role: 'owner', access: fullAccess() };
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  resetAgentRateLimits();
  m.ops.clear();
  for (const o of OPS) m.ops.set(o.id, o);
  m.shellOps.length = 0;
  m.shellOps.push(shellDef({}), shellDef({ id: 'files.save', runner: 'server', flow: 'saveStagedFile', class: 'file', area: null }));
  m.views.clear();
  usePolicy('trusted_bookkeeper');
  grants = [];
  m.guardInput.mockImplementation((_op: Operation, input: OperationInput) => ({ input, refused: null, stripped: [] }));
  m.factsOf.mockImplementation(bodyFacts);
  m.describeRequest.mockImplementation((o: Operation) => `Summary of ${o.id}`);
  m.loadAgentPolicy.mockImplementation(async () => policy);
  m.agentCeiling.mockImplementation(async () => ({ access: CEILING, role: 'accountant', roleNames: ['Bookkeeper'] }));
  m.liveGrants.mockImplementation(async () => grants);
  m.defaultAgentFolders.mockReturnValue([]);
  m.createAgentRequest.mockImplementation(async (_ctx: ServiceContext, req: Out) => {
    const existing = m.views.get(`key:${req.requestKey}`);
    if (existing) return existing;
    const view = {
      id: randomUUID(),
      requestKey: req.requestKey,
      kind: req.kind,
      agentId,
      agentName: 'Robo',
      operation: req.operation.id,
      class: req.effectiveClass,
      area: req.operation.area,
      status: 'pending',
      reason: req.reason,
      summary: req.summary,
      amount: req.facts.amount,
      needs: req.needs,
      input: req.input,
      preview: req.preview,
      grantAsked: req.grantAsked ?? null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      decidedAt: null,
      decidedByName: null,
      secondApproverName: null,
      note: null,
      error: null,
      result: null,
      file: null,
      grantId: null,
    };
    storeView(view);
    return view;
  });
  m.requestForAgent.mockImplementation(async (_ctx: ServiceContext, idOrKey: string) => m.views.get(idOrKey) ?? m.views.get(`key:${idOrKey}`) ?? null);
  bridgeAnswers({});
});

// ---------------------------------------------------------------------------
// operate
// ---------------------------------------------------------------------------

describe('operate', () => {
  afterEach(() => {
    // Whatever a test did, an agent's own run never carried a person, an approval, a secret or a reveal.
    for (const c of m.runOperation.mock.calls) {
      if (c[0] !== agentCtx) continue;
      const actor = c[4] as BridgeActor;
      expect(actor.userId).toBeNull();
      expect(actor.secrets).toEqual({});
      expect(actor.reveal).toBe(false);
      expect(actor.atHost).toBe(false);
      expect(actor.approval.approvedBy).toBeNull();
      expect(actor.approval.requestId).toBeNull();
      expect(Object.values(actor.access.flags).every((f) => f === false)).toBe(true);
    }
  });

  it('is for agents only', async () => {
    await expectError(operate({ ...agentCtx, agent: undefined }, { operation: 'invoices.list' }), 'FORBIDDEN', 'This is for agents.');
  });

  it('refuses an unknown operation and points to find_operations', async () => {
    const a = await operate(agentCtx, { operation: 'invoices.teleport' });
    expect(a).toMatchObject({ operation: 'invoices.teleport', outcome: 'refused' });
    expect(a.note).toMatch(/find_operations/);
    expect(m.runOperation).not.toHaveBeenCalled();
  });

  it('refuses what the input guard refuses, and says what it left out', async () => {
    m.guardInput.mockReturnValueOnce({ input: {}, refused: 'Agents can never turn the audit trail off.', stripped: [] });
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { auditOff: true }, requestId: rid() });
    expect(a).toMatchObject({ outcome: 'refused', note: 'Agents can never turn the audit trail off.' });

    m.guardInput.mockImplementationOnce((_o: Operation, input: OperationInput) => ({ input, refused: null, stripped: ['body.password'] }));
    const b = await operate(agentCtx, { operation: 'invoices.list' });
    expect(b.outcome).toBe('read');
    expect(b.note).toMatch(/only a person may set them: body\.password/);
    expect(m.runOperation).toHaveBeenCalledTimes(1);
  });

  it('refuses the hard floor and what the policy says Never to, before anything runs', async () => {
    const floor = await operate(agentCtx, { operation: 'agents.create', body: { name: 'Robo 2' }, requestId: rid() });
    expect(floor.outcome).toBe('refused');
    expect(floor.note).toMatch(/never do this/);

    usePolicy('read_only');
    const never = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), dryRun: true });
    expect(never.outcome).toBe('refused');
    expect(never.note).toMatch(/has not allowed agents to enter new records/);
    expect(m.runOperation).not.toHaveBeenCalled();
    expect(m.createAgentRequest).not.toHaveBeenCalled();
  });

  it('reads at once, on the read path, as the agent with its access masked', async () => {
    bridgeAnswers({ read: () => ({ result: [{ id: 'inv-1' }] }) });
    const a = await operate(agentCtx, { operation: 'invoices.list', query: { status: 'open' } });
    expect(a).toEqual({ operation: 'invoices.list', outcome: 'read', result: [{ id: 'inv-1' }] });
    const [call] = callsOf('read');
    expect(call.base).toBe(agentCtx);
    expect(call.input).toEqual({ query: { status: 'open' } });
    expect(call.actor).toMatchObject({
      agent: { id: agentId, name: 'Robo', preset: 'trusted_bookkeeper', onBehalfOf: ownerId },
      role: 'accountant',
      userId: null,
      approval: { approvedBy: null, requestId: null, grantId: null },
      reveal: false,
      secrets: {},
      folders: [SAVE_DIR],
      atHost: false,
    });
    // The role's rights stay; the View flags and the closed-period right are off.
    expect(call.actor.access.permissions.customers).toEqual(CEILING.permissions.customers);
    expect(call.actor.access.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
    expect(m.runOperation).toHaveBeenCalledTimes(1);
  });

  it("passes the app's own error back when a read fails", async () => {
    bridgeAnswers({ read: () => ({ outcome: 'error', httpStatus: 404, result: null, error: { message: 'Invoice not found', code: null, details: null } }) });
    await expectError(operate(agentCtx, { operation: 'invoices.list' }), 'NOT_FOUND', 'Invoice not found');
  });

  it('dry run: really runs, keeps nothing, and says what the real request would meet', async () => {
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, dryRun: true });
    expect(a).toMatchObject({ outcome: 'dry_run', result: { id: 'inv-1', total: '10.00' } });
    expect(a.preview?.ledger?.entries).toHaveLength(1);
    expect(a.ledger?.entries).toHaveLength(1);
    expect(a.note).toMatch(/Nothing was kept\. .*done straight away/);
    expect(callsOf('dry_run')).toHaveLength(1);
    expect(callsOf('commit')).toHaveLength(0);

    usePolicy('ask_every_change');
    const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, dryRun: true });
    expect(b.outcome).toBe('dry_run');
    expect(b.note).toMatch(/would ask a person first.*request_id and a reason/);
    expect(m.createAgentRequest).not.toHaveBeenCalled();

    // Judged on what the dry run showed: 500 records is over the cap.
    usePolicy('full_with_asks');
    bridgeAnswers({ dry_run: () => ({ facts: facts({ count: 500 }) }) });
    const c = await operate(agentCtx, { operation: 'invoices.batch', body: { items: [1, 2] }, dryRun: true });
    expect(c.outcome).toBe('dry_run');
    expect(c.note).toMatch(/would be refused: This would change 500 records/);

    // Work that cannot be tried is described, not run.
    m.runOperation.mockClear();
    const d = await operate(agentCtx, { operation: 'invoices.email', params: { id: 'inv-1' }, dryRun: true });
    expect(d.outcome).toBe('dry_run');
    expect(d.note).toMatch(/cannot be tried without really doing it/);
    expect(m.runOperation).not.toHaveBeenCalled();
  });

  it('a real change needs a request id', async () => {
    const err = await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' } }), 'VALIDATION');
    expect(err.message).toBe(REQUEST_ID_MESSAGE);
    expect(m.runOperation).not.toHaveBeenCalled();
  });

  it('runs: dry run first, then the real thing; posted when it made entries, done when not', async () => {
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    expect(a).toMatchObject({ operation: 'invoices.create', outcome: 'posted', summary: 'Summary of invoices.create', result: { id: 'inv-1', total: '10.00' } });
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    expect((await claimRow(key))?.outcome).toBe('posted');

    bridgeAnswers({ commit: () => ({ preview: preview(0) }) });
    const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '11' }, requestId: rid() });
    expect(b.outcome).toBe('done');
  });

  it('the same request id gives the first answer again; with other input it is refused', async () => {
    const key = rid();
    const first = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    m.runOperation.mockClear();
    const again = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    expect(again).toEqual({ ...first, replayed: true });
    expect(m.runOperation).not.toHaveBeenCalled();
    await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '99' }, requestId: key }), 'CONFLICT', /already used for a different request/);
  });

  it('a first try still under way, or one that never said how it ended, is not run again', async () => {
    const { agentInputHash } = await import('./actions');
    const body = { total: '10' };
    const hash = agentInputHash('invoices.create', { body });
    const fresh = rid();
    await db.insert(agentRequests).values({ companyId, agentId, requestKey: fresh, action: 'invoices.create', inputHash: hash, outcome: 'running' });
    await expectError(operate(agentCtx, { operation: 'invoices.create', body, requestId: fresh }), 'CONFLICT', /still being carried out/);

    const old = rid();
    await db
      .insert(agentRequests)
      .values({ companyId, agentId, requestKey: old, action: 'invoices.create', inputHash: hash, outcome: 'running', createdAt: new Date(Date.now() - 60 * 60_000) });
    await expectError(operate(agentCtx, { operation: 'invoices.create', body, requestId: old }), 'CONFLICT', /cannot tell how it ended/);
    expect(callsOf('commit')).toHaveLength(0);
  });

  it('the second decision, on the dry run\'s figures, can turn a run into an ask', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ amount: '5000.00' }), stalenessKey: 'books-v7' }) });
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key, reason: 'Monthly retainer for Acme' });
    expect(a).toMatchObject({ outcome: 'asked', status: 'pending' });
    expect(a.needs?.twoPerson).toBe(true);
    expect(callsOf('commit')).toHaveLength(0);
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
    const req = m.createAgentRequest.mock.calls[0][1] as Out;
    expect(req).toMatchObject({
      kind: 'operation',
      requestKey: key,
      reason: 'Monthly retainer for Acme',
      summary: 'Summary of invoices.create',
      effectiveClass: 'enter',
      stalenessKey: 'books-v7',
      grantAsked: null,
    });
    expect(req.operation.id).toBe('invoices.create');
    expect(req.facts.amount).toBe('5000.00');
    expect(req.preview.ledger.entries).toHaveLength(1);
    expect(a.requestId).toBe(m.views.get(`key:${key}`)?.id);
  });

  it('...and without a reason that ask is refused, and no request is created', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ amount: '5000.00' }) }) });
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    expect(a).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    expect(m.createAgentRequest).not.toHaveBeenCalled();
    expect(callsOf('commit')).toHaveLength(0);
    expect(await claimRow(key)).toBeNull();

    usePolicy('ask_every_change');
    const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), reason: '   ' });
    expect(b).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    expect(m.createAgentRequest).not.toHaveBeenCalled();
  });

  it('the second decision can turn a run into a refusal (bulk cap on the real count)', async () => {
    usePolicy('full_with_asks');
    bridgeAnswers({ dry_run: () => ({ facts: facts({ count: 500 }) }) });
    const a = await operate(agentCtx, { operation: 'invoices.batch', body: { items: [1, 2, 3] }, requestId: rid() });
    expect(a.outcome).toBe('refused');
    expect(a.note).toMatch(/This would change 500 records, more than this agent may change in one request \(200\)/);
    expect(callsOf('commit')).toHaveLength(0);
    expect(m.createAgentRequest).not.toHaveBeenCalled();
  });

  it('an ask whose amount was unknown runs once the dry run shows it is small, with no reason needed', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ amount: '12.00' }) }) });
    const a = await operate(agentCtx, { operation: 'invoices.create', body: {}, requestId: rid() });
    expect(a.outcome).toBe('posted');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    expect(m.createAgentRequest).not.toHaveBeenCalled();
  });

  it('asks a person, and asking again answers what became of the request', async () => {
    usePolicy('ask_every_change');
    const key = rid();
    const body = { total: '10' };
    const a = await operate(agentCtx, { operation: 'invoices.create', body, requestId: key, reason: 'Acme asked for it' });
    expect(a).toMatchObject({ outcome: 'asked', status: 'pending', summary: 'Summary of invoices.create' });
    expect(a.note).toMatch(/Nothing is done yet\. A person who may do this themselves has to approve it/);
    expect(a.replayed).toBeUndefined();
    expect(callsOf('dry_run')).toHaveLength(1);
    expect(callsOf('commit')).toHaveLength(0);
    expect((await claimRow(key))?.outcome).toBe('asked');

    const view = m.views.get(`key:${key}`)!;
    const again = () => operate(agentCtx, { operation: 'invoices.create', body, requestId: key, reason: 'Acme asked for it' });
    expect(await again()).toMatchObject({ outcome: 'asked', replayed: true, requestId: view.id });

    Object.assign(view, { status: 'executed', result: { id: 'inv-77' }, decidedByName: 'Olive Owner' });
    // A row from before the requests service kept what the run posted: told from its preview.
    expect(await again()).toMatchObject({ outcome: 'posted', replayed: true, result: { id: 'inv-77' } });
    // What the run itself posted decides when the request says (AgentRequestView.posted), never the preview.
    Object.assign(view, { posted: false });
    expect((await again()).outcome).toBe('done');
    Object.assign(view, { posted: true, preview: null });
    expect((await again()).outcome).toBe('posted');
    Object.assign(view, { posted: undefined });
    expect((await again()).outcome).toBe('done');

    Object.assign(view, { status: 'denied', note: 'Not this month.' });
    expect((await again()).note).toBe('A person said no: "Not this month."');

    Object.assign(view, { status: 'expired', note: null });
    expect(await again()).toMatchObject({ outcome: 'refused' });
    expect((await again()).note).toMatch(/expired/);

    Object.assign(view, { status: 'failed', error: 'Customer is inactive.' });
    expect((await again()).note).toMatch(/did not work: Customer is inactive\./);
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
  });

  it('a warning comes back as needs_confirmation; resent with the flag it goes on', async () => {
    bridgeAnswers({
      dry_run: (input) =>
        input.confirm?.includes('allowDuplicateNumber')
          ? {}
          : { outcome: 'needs_confirmation', httpStatus: 409, warnings: [{ flag: 'allowDuplicateNumber', message: 'Invoice 1001 is already used.' }] },
    });
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10', number: '1001' }, requestId: key });
    expect(a).toMatchObject({ outcome: 'needs_confirmation', warnings: [{ flag: 'allowDuplicateNumber' }] });
    expect(a.note).toMatch(/confirm: \["allowDuplicateNumber"\]/);
    expect(callsOf('commit')).toHaveLength(0);
    expect(await claimRow(key)).toBeNull();

    const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10', number: '1001' }, confirm: ['allowDuplicateNumber'], requestId: key });
    expect(b.outcome).toBe('posted');

    // A flag the operation does not list cannot be accepted.
    bridgeAnswers({ dry_run: () => ({ outcome: 'needs_confirmation', warnings: [{ flag: 'allowOverBilling', message: 'Over the estimate.' }] }) });
    const c = await operate(agentCtx, { operation: 'invoices.create', body: { total: '12' }, requestId: rid() });
    expect(c.note).toMatch(/cannot be accepted with a flag/);
  });

  it("a failed run gives the app's own error and frees the request id", async () => {
    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 400, error: { message: 'Customer is inactive.', code: 'VALIDATION', details: { field: 'customerId' } } }) });
    const key = rid();
    const err = await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key }), 'VALIDATION', 'Customer is inactive.');
    expect(err.details).toEqual({ field: 'customerId' });
    expect(await claimRow(key)).toBeNull();

    bridgeAnswers({});
    expect((await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key })).outcome).toBe('posted');
  });

  it('a change that may have been partly kept keeps its request id: asking again gives that failure, never a second run', async () => {
    // feeds.refresh is not one transaction (dryRun 'none'): a failure after the handler ran may have kept part of it.
    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 502, result: null, preview: null, error: { message: 'The bank did not answer.', code: null, details: null } }) });
    const key = rid();
    const first = await expectError(operate(agentCtx, { operation: 'feeds.refresh', body: {}, requestId: key }), 'INTERNAL', /^The bank did not answer\. Part of it may already have been done/);
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['commit']);
    expect((await claimRow(key))?.outcome).toBe('failed');

    bridgeAnswers({});
    const again = await expectError(operate(agentCtx, { operation: 'feeds.refresh', body: {}, requestId: key }), 'INTERNAL', first.message);
    expect(again.details).toMatchObject({ requestId: key, replayed: true });
    expect(callsOf('commit')).toHaveLength(1);

    // Refused before the handler ran: nothing was done, so the request id is free again.
    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 0, result: null, preview: null, error: { message: 'Leave the audit setting out.', code: 'REFUSED', details: null } }) });
    const free = rid();
    await expectError(operate(agentCtx, { operation: 'feeds.refresh', body: {}, requestId: free }), 'FORBIDDEN', 'Leave the audit setting out.');
    expect(await claimRow(free)).toBeNull();
    bridgeAnswers({});
    expect((await operate(agentCtx, { operation: 'feeds.refresh', body: {}, requestId: free })).outcome).toBe('posted');

    // One transaction rolled back, but a call to another computer had already gone out: kept as well.
    const sent = { effect: { kind: 'network' as const, summary: 'Contact bank.example', detail: {} }, status: 'sent' as const, error: null, ranDuringOperation: true };
    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 400, result: null, preview: null, effects: [sent], error: { message: 'Rate not found.', code: 'VALIDATION', details: null } }) });
    const called = rid();
    await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: called }), 'VALIDATION', /Part of it may already have been done/);
    expect((await claimRow(called))?.outcome).toBe('failed');
  });

  it('a warning from work that is not undone keeps its request id with what happened: the same id never runs it twice', async () => {
    const sent = { effect: { kind: 'network' as const, summary: 'Contact bank.example', detail: {} }, status: 'sent' as const, error: null, ranDuringOperation: true };
    const warned: Partial<BridgeResult> = {
      outcome: 'needs_confirmation',
      httpStatus: 409,
      result: null,
      preview: null,
      effects: [sent],
      warnings: [{ flag: 'allowDuplicate', message: 'These lines look like ones already imported.' }],
    };
    bridgeAnswers({ commit: (input) => (input.confirm?.includes('allowDuplicate') ? {} : warned) });
    const key = rid();
    const body = { account: 'checking' };
    const a = await operate(agentCtx, { operation: 'feeds.import', body, requestId: key });
    expect(a).toMatchObject({ outcome: 'needs_confirmation', warnings: [{ flag: 'allowDuplicate' }], effects: [sent] });
    expect(a.note).toMatch(/part of it may already have been done \(effects lists what already went out\)/);
    expect(a.note).toMatch(/new request_id and confirm: \["allowDuplicate"\]/);
    expect(a.note).not.toMatch(/Nothing was done/);
    expect((await claimRow(key))?.outcome).toBe('warned');

    // The same id and input: the same answer, nothing run again.
    const again = await operate(agentCtx, { operation: 'feeds.import', body, requestId: key });
    expect(again).toEqual({ ...a, replayed: true });
    expect(callsOf('commit')).toHaveLength(1);
    // The same id with the flag is another request: refused, never run.
    await expectError(operate(agentCtx, { operation: 'feeds.import', body, confirm: ['allowDuplicate'], requestId: key }), 'CONFLICT', /already used for a different request/);
    expect(callsOf('commit')).toHaveLength(1);
    // A new id with the flag goes on.
    expect((await operate(agentCtx, { operation: 'feeds.import', body, confirm: ['allowDuplicate'], requestId: rid() })).outcome).toBe('posted');

    // Nothing sent, but its service keeps what it did before the warning: kept as well.
    bridgeAnswers({ commit: () => ({ ...warned, effects: [] }) });
    const quiet = rid();
    const b = await operate(agentCtx, { operation: 'feeds.import', body: { account: 'savings' }, requestId: quiet });
    expect(b.outcome).toBe('needs_confirmation');
    expect(b.note).toMatch(/part of it may already have been done\./);
    expect((await claimRow(quiet))?.outcome).toBe('warned');
  });

  it('when nothing can show the real figures, the amount counts as unknown: two people, whatever the body says', async () => {
    const described = { ...preview(0), ledger: null, routePreview: { ran: false, note: 'Described only.' } };
    bridgeAnswers({ dry_run: () => ({ preview: described, stalenessKey: null }) });
    // No two-person limit: the amount does not matter, so it runs as before (no dry run is possible).
    const plain = await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, requestId: rid() });
    expect(plain.outcome).toBe('posted');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['commit']);

    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    m.runOperation.mockClear();
    const tried = await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, dryRun: true });
    expect(tried.outcome).toBe('dry_run');
    expect(tried.note).toMatch(/would ask a person first.*two different people must approve it/);
    const silent = await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, requestId: rid() });
    expect(silent).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    const key = rid();
    const asked = await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, requestId: key, reason: 'The delivery came today' });
    expect(asked).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
    expect(callsOf('commit')).toHaveLength(0);
    // The person is shown the figures the policy judged on: the amount unknown, never the agent's
    // own figure presented as the amount; the needs are those of the worst case.
    const req = m.createAgentRequest.mock.calls[0][1] as Out;
    expect(req.facts.amount).toBeNull();
    expect(req.needs.twoPerson).toBe(true);
  });

  it('closing-date work counts its amount as unknown, and says why there is no preview', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    await db.update(companies).set({ settings: { closingDate: '2026-06-30' } }).where(eq(companies.id, companyId));
    try {
      const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10', date: '2026-03-01' }, requestId: rid(), reason: 'Late March invoice' });
      expect(a).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
      expect(a.note).toMatch(/because it is dated on or before the closing date, so the person approving it sees no preview/);
      expect(m.runOperation).not.toHaveBeenCalled();
      // The card's amount is unknown, not the body's 10 (nothing checked it).
      expect((m.createAgentRequest.mock.calls.at(-1)?.[1] as Out).facts).toMatchObject({ amount: null, closedPeriod: true, date: '2026-03-01' });

      bridgeAnswers({ dry_run: () => ({ outcome: 'error', httpStatus: 400, preview: null, error: { message: 'The period is closed.', code: 'PERIOD_CLOSED', details: null } }) });
      const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), reason: 'Correction' });
      expect(b).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
      expect((m.createAgentRequest.mock.calls.at(-1)?.[1] as Out).facts).toMatchObject({ amount: null, closedPeriod: true });

      // With no two-person limit the amount still shows as unknown on the card.
      usePolicy('trusted_bookkeeper');
      await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), reason: 'Correction' });
      const plain = m.createAgentRequest.mock.calls.at(-1)?.[1] as Out;
      expect(plain.facts).toMatchObject({ amount: null, closedPeriod: true });
      expect(plain.needs.twoPerson).toBe(false);
      expect(plain.preview).toBeNull();
    } finally {
      await db.update(companies).set({ settings: null }).where(eq(companies.id, companyId));
    }
  });

  it('a dry run that went all the way and moved no money has the amount 0.00, so the two-person limit does not hold it', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    const created = { ...preview(0), ledger: { entries: [], changes: [{ action: 'create', kind: 'customer', id: 'c-1' }] }, records: [{ action: 'create', kind: 'customer', id: 'c-1', fields: [] }] };
    bridgeAnswers({ dry_run: () => ({ preview: created }), commit: () => ({ preview: created }) });
    const a = await operate(agentCtx, { operation: 'customers.create', body: { displayName: 'Acme' }, requestId: rid() });
    expect(a.outcome).toBe('done');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);

    // An edit (or a void) of something that exists may move money without a new entry: unknown.
    const edited = { ...created, ledger: { entries: [], changes: [{ action: 'update', kind: 'invoice', id: 'i-1' }] } };
    bridgeAnswers({ dry_run: () => ({ preview: edited }) });
    expect(await operate(agentCtx, { operation: 'customers.create', body: { displayName: 'Acme 2' }, requestId: rid() })).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    // An amount field that could not be read stays unknown.
    bridgeAnswers({ dry_run: () => ({ preview: created }) });
    expect(await operate(agentCtx, { operation: 'invoices.create', body: {}, requestId: rid() })).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    expect(callsOf('commit')).toHaveLength(1);
  });

  it("the bridge's own refusals are said as what they are, with the bridge's code kept", async () => {
    bridgeAnswers({
      dry_run: () => ({
        outcome: 'error',
        httpStatus: 0,
        result: null,
        preview: null,
        error: { message: 'This operation takes no confirmations. Leave confirm out.', code: 'UNKNOWN_CONFIRM_FLAG', details: { allowed: [], unknown: ['x'] } },
      }),
    });
    const flag = await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() }), 'VALIDATION', /takes no confirmations/);
    expect(flag.details).toEqual({ allowed: [], unknown: ['x'], code: 'UNKNOWN_CONFIRM_FLAG' });

    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 0, result: null, preview: null, error: { message: 'Only at the host computer.', code: 'HOST_ONLY', details: null } }) });
    const host = await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() }), 'FORBIDDEN', 'Only at the host computer.');
    expect(host.details).toEqual({ code: 'HOST_ONLY' });

    bridgeAnswers({ commit: () => ({ outcome: 'error', httpStatus: 0, result: null, preview: null, error: { message: 'This took longer than 30 seconds.', code: 'TIMEOUT', details: { seconds: 30 } } }) });
    const slow = await expectError(operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() }), 'CONFLICT', /longer than/);
    expect(slow.details).toEqual({ seconds: 30, code: 'TIMEOUT' });
  });

  it('a dry run refused for want of the View flag an approved reveal adds asks without a preview; nothing else does', async () => {
    usePolicy('ask_every_change');
    const forbidden: Partial<BridgeResult> = {
      outcome: 'error',
      httpStatus: 403,
      result: null,
      preview: null,
      error: { message: 'This needs "View sensitive payroll".', code: 'FORBIDDEN', details: null },
    };
    bridgeAnswers({ dry_run: () => forbidden });
    const reveal = { operation: 'employees.update', params: { id: 'emp-1' }, body: { ssn: '123-45-6789' }, reveal: true };
    const a = await operate(agentCtx, { ...reveal, requestId: rid(), reason: 'Correct the SSN' });
    expect(a.outcome).toBe('asked');
    expect(a.note).toMatch(/could not be tried with this agent's own rights.*sees no preview/);
    expect((m.createAgentRequest.mock.calls[0][1] as Out).preview).toBeNull();
    const d = await operate(agentCtx, { ...reveal, dryRun: true });
    expect(d.outcome).toBe('dry_run');
    expect(d.note).toMatch(/could not be tried with this agent's own rights.*would ask a person first/);

    // Without the reveal, no approval adds a flag (the bridge turns the View flags on only for an
    // approved reveal): the refusal is said, with how to ask for the full values.
    const plain = await expectError(operate(agentCtx, { operation: 'employees.update', params: { id: 'emp-1' }, body: {}, requestId: rid(), reason: 'x' }), 'FORBIDDEN', /View sensitive payroll/);
    expect(plain.message).toMatch(/send it again with reveal: true and a reason/);
    // Allowed without asking: the refusal is the answer, never an ask.
    usePolicy('trusted_bookkeeper');
    await expectError(operate(agentCtx, { operation: 'employees.update', params: { id: 'emp-1' }, body: {}, requestId: rid() }), 'FORBIDDEN', /View sensitive payroll/);
    usePolicy('ask_every_change');

    // Refusals no approval can lift are said, never put to a person, reveal or not: the agent
    // itself, an archived company and the route map (the bridge's own gates, status 0), a feature
    // switched off, the Accountant's Copy rule, and a right of the role (the handler's, marked).
    const unliftable: Array<Partial<BridgeResult>> = [
      { ...forbidden, httpStatus: 0, error: { message: 'This agent no longer has access.', code: 'FORBIDDEN', details: { agent: true } } },
      { ...forbidden, httpStatus: 0, error: { message: 'This company is not available. Open it in Ironbooks first.', code: 'FORBIDDEN', details: null } },
      { ...forbidden, httpStatus: 0, error: { message: 'You do not have permission to modify Payroll.', code: 'FORBIDDEN', details: { area: 'payroll', action: 'modify' } } },
      { ...forbidden, error: { message: 'Payroll is turned off in Preferences.', code: 'FORBIDDEN', details: { featureOff: true } } },
      { ...forbidden, error: { message: "That isn't available in an Accountant's Copy.", code: 'FORBIDDEN', details: { accountantCopy: true } } },
      { ...forbidden, error: { message: 'You do not have permission to view Items.', code: 'FORBIDDEN', details: { area: 'items', action: 'view' } } },
    ];
    for (const r of unliftable) {
      bridgeAnswers({ dry_run: () => r });
      const err = await expectError(operate(agentCtx, { ...reveal, requestId: rid(), reason: 'x' }), 'FORBIDDEN');
      expect(err.message).toBe(r.error!.message);
      const tried = await expectError(operate(agentCtx, { ...reveal, dryRun: true }), 'FORBIDDEN');
      expect(tried.message).toBe(r.error!.message);
    }

    // A role that lacks the flag itself is refused before anything runs (the policy's role check).
    m.agentCeiling.mockImplementation(async () => ({ access: custom({ payroll: ['full'] }), role: 'accountant', roleNames: ['Payroll clerk'] }));
    const noFlag = await operate(agentCtx, { ...reveal, requestId: rid(), reason: 'x' });
    expect(noFlag.outcome).toBe('refused');
    expect(noFlag.note).toMatch(/Your role does not allow this/);
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
    expect(callsOf('commit')).toHaveLength(0);
  });

  it('an agent asking for a reveal, or sending secret-like fields, still runs with no reveal and no secrets', async () => {
    const hostile = { total: '10', password: 'hunter2', apiKey: 'sk-live-123', closingPassword: 'pw' };
    // A reveal on a write asks a person (read_sensitive); its preview is tried as the agent itself.
    const a = await operate(agentCtx, { operation: 'invoices.create', body: hostile, reveal: true, dryRun: true });
    expect(a.outcome).toBe('dry_run');
    expect(a.note).toMatch(/would ask a person first/);
    const b = await operate(agentCtx, { operation: 'invoices.create', body: hostile, reveal: true, requestId: rid(), reason: 'Show the full numbers' });
    expect(b.outcome).toBe('asked');
    // Allowed and run at once: dry run and real run alike.
    const c = await operate(agentCtx, { operation: 'invoices.create', body: hostile, requestId: rid() });
    expect(c.outcome).toBe('posted');
    const runs = m.runOperation.mock.calls.filter((x) => x[0] === agentCtx);
    expect(runs.map((x) => x[3])).toEqual(['dry_run', 'dry_run', 'dry_run', 'commit']);
    for (const x of runs) {
      const actor = x[4] as BridgeActor;
      expect(actor.reveal).toBe(false);
      expect(actor.secrets).toEqual({});
      expect(actor.userId).toBeNull();
      expect(actor.approval).toEqual({ approvedBy: null, requestId: null, grantId: null });
    }
    // The reveal reaches the bridge only as the agent's wish; the actor decides what is shown.
    expect((runs[0][2] as OperationInput).reveal).toBe(true);
  });

  it('a dry run that meets the closing date says so, and what the real request would meet', async () => {
    bridgeAnswers({
      dry_run: () => ({ outcome: 'error', httpStatus: 400, result: null, preview: null, error: { message: 'The period is closed.', code: 'PERIOD_CLOSED', details: null } }),
    });
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, dryRun: true });
    expect(a.outcome).toBe('dry_run');
    expect(a.note).toMatch(/dated on or before the closing date\. Sent without dry_run, it would ask a person first\..*the closing-date password on the approval card/);
    expect(a.preview).toBeUndefined();
    expect(callsOf('commit')).toHaveLength(0);
    expect(m.createAgentRequest).not.toHaveBeenCalled();
  });

  it('secrets an operation produces never reach the agent, nor the stored answer', async () => {
    const SECRET = 'Temp-Pass-9137';
    bridgeAnswers({ commit: () => ({ produced: [{ kind: 'new_user_password', label: 'Temporary password for Dana Lee', value: SECRET }] }) });
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    expect(a.outcome).toBe('posted');
    expect(a).not.toHaveProperty('produced');
    expect(JSON.stringify(a)).not.toContain(SECRET);
    const row = await claimRow(key);
    expect(row?.outcome).toBe('posted');
    expect(JSON.stringify(row?.result)).not.toContain(SECRET);
    const again = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: key });
    expect(again.replayed).toBe(true);
    expect(JSON.stringify(again)).not.toContain(SECRET);
  });

  it('an approved read answers as a read when asked again', async () => {
    const key = rid();
    const a = await operate(agentCtx, { operation: 'invoices.list', reveal: true, requestId: key, reason: 'Need the full account number' });
    expect(a.outcome).toBe('asked');
    expect(m.runOperation).not.toHaveBeenCalled();
    Object.assign(m.views.get(`key:${key}`)!, { status: 'executed', result: [{ id: 'inv-1' }], preview: preview(1) });
    const again = await operate(agentCtx, { operation: 'invoices.list', reveal: true, requestId: key, reason: 'Need the full account number' });
    expect(again).toMatchObject({ outcome: 'read', replayed: true, result: [{ id: 'inv-1' }] });
  });

  it('work dated on or before the closing date asks, with the closing-date password on the card', async () => {
    await db.update(companies).set({ settings: { closingDate: '2026-06-30' } }).where(eq(companies.id, companyId));
    try {
      // Known from the body: nothing can be previewed without the password, so the bridge is not called.
      const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10', date: '2026-03-01' }, requestId: rid(), reason: 'Late March invoice' });
      expect(a.outcome).toBe('asked');
      expect(a.needs?.secrets).toContain('closing_password');
      expect(a.note).toMatch(/the closing-date password on the approval card/);
      expect(m.factsOf.mock.calls[0][2]).toEqual({ closingDate: '2026-06-30' });
      expect(m.runOperation).not.toHaveBeenCalled();

      // Known only when the dry run hits the closing date.
      bridgeAnswers({ dry_run: () => ({ outcome: 'error', httpStatus: 400, error: { message: 'The period is closed.', code: 'PERIOD_CLOSED', details: null } }) });
      const b = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), reason: 'Correction' });
      expect(b.outcome).toBe('asked');
      expect(b.needs?.secrets).toContain('closing_password');
      expect(callsOf('commit')).toHaveLength(0);
      expect((m.createAgentRequest.mock.calls.at(-1)?.[1] as Out).preview).toBeNull();
    } finally {
      await db.update(companies).set({ settings: null }).where(eq(companies.id, companyId));
    }
  });

  it("runs under a live grant and says so, with the giver's access within the agent's role; the dry run carries no grant", async () => {
    usePolicy('ask_every_change');
    const grantId = randomUUID();
    grants = [grantOf({ id: grantId })];
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() });
    expect(a).toMatchObject({ outcome: 'posted', grantId });
    expect(callsOf('dry_run')[0].actor.approval.grantId).toBeNull();
    const [commit] = callsOf('commit');
    expect(commit.actor.approval).toEqual({ approvedBy: null, requestId: null, grantId });
    // Plan §4.5: the giver's access INTERSECTED with the agent's ceiling, masked; never a person.
    const giver = await resolveAccess(db, companyId, ownerId);
    expect(commit.actor.access).toEqual(maskedForAgent(intersectAccess(giver.access, CEILING)));
    expect(commit.actor).toMatchObject({ userId: null, reveal: false, secrets: {}, role: 'accountant' });
  });

  it('a grant runs within what its giver may do: narrower than the agent, the run is narrower too', async () => {
    usePolicy('ask_every_change');
    const clerk = await member('Cora Clerk', 'customers-only', { customers: ['full'] });
    const grantId = randomUUID();
    grants = [grantOf({ id: grantId, givenBy: clerk })];
    const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() });
    expect(a).toMatchObject({ outcome: 'posted', grantId });
    const access = callsOf('commit')[0].actor.access;
    expect(access.permissions.customers).toEqual(CEILING.permissions.customers);
    // The agent's role holds payroll and banking; the clerk who gave the grant does not.
    expect(access.permissions.payroll).toEqual([]);
    expect(access.permissions.banking).toEqual([]);
    expect(isSubset(access, CEILING)).toBe(true);
  });

  it('a grant whose giver is gone, inactive or without the right does not apply: the request is asked', async () => {
    usePolicy('ask_every_change');
    const viewer = await member('Vic Viewer', 'viewer');
    const inactive = await member('Ina Inactive', 'owner', undefined, false);
    for (const givenBy of [randomUUID(), viewer, inactive]) {
      m.runOperation.mockClear();
      m.createAgentRequest.mockClear();
      grants = [grantOf({ givenBy })];
      const a = await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid(), reason: 'Monthly retainer' });
      expect(a).toMatchObject({ outcome: 'asked', status: 'pending' });
      expect(a.grantId).toBeUndefined();
      expect(callsOf('commit')).toHaveLength(0);
      expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
    }
    // Another grant that does stand answers instead of the one set aside.
    const good = randomUUID();
    grants = [grantOf({ givenBy: viewer }), grantOf({ id: good })];
    expect(await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() })).toMatchObject({ outcome: 'posted', grantId: good });
    // Without a reason, the ask a grant could not answer is refused like any other.
    grants = [grantOf({ givenBy: viewer })];
    expect(await operate(agentCtx, { operation: 'invoices.create', body: { total: '10' }, requestId: rid() })).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
  });

  it("a grant never covers an amount nobody could check: work that cannot be tried asks, the grant's limit unused", async () => {
    usePolicy('ask_every_change');
    grants = [grantOf({ operation: 'bills.receive', constraints: { maxAmount: '500' } })];
    const a = await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, requestId: rid(), reason: 'The delivery came today' });
    expect(a.outcome).toBe('asked');
    expect(callsOf('commit')).toHaveLength(0);
    // A grant with no amount limit is not about the amount: it still answers.
    grants = [grantOf({ operation: 'bills.receive' })];
    expect((await operate(agentCtx, { operation: 'bills.receive', body: { total: '10' }, requestId: rid() })).outcome).toBe('posted');
  });

  it('a desktop action never runs on the agent\'s own say-so, even under a grant', async () => {
    usePolicy('full_with_asks');
    grants = [{ id: randomUUID(), agentId, operation: 'shell.print.file', constraints: {}, givenBy: ownerId, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), revokedAt: null, uses: 0 }];
    const a = await operate(agentCtx, { operation: 'shell.print.file', body: { fileId: 'a'.repeat(32) }, requestId: rid(), reason: 'Print the statement' });
    expect(a.outcome).toBe('asked');
    expect(m.runOperation).not.toHaveBeenCalled();
    expect(m.runShellOperation).not.toHaveBeenCalled();
  });

  it(`stops an agent after ${AGENT_CALLS_PER_MINUTE} calls in a minute, in plain words, and says when to try again`, async () => {
    for (let i = 0; i < AGENT_CALLS_PER_MINUTE; i++) expect((await operate(agentCtx, { operation: 'nothing.here' })).note).toMatch(/find_operations/);
    const a = await operate(agentCtx, { operation: 'invoices.list' });
    expect(a.outcome).toBe('refused');
    expect(a.note).toMatch(/more than 120 requests in the last minute.*Wait about \d+ seconds?, then carry on/);
    expect(m.runOperation).not.toHaveBeenCalled();
    // Every verb, an operation's included, is slowed down as an error that carries the wait.
    for (const verb of ['get_my_permissions', 'run_operation'] as const) {
      const err = await expectError(handleVerb(agentCtx, verb, verb === 'run_operation' ? { operation: 'invoices.list' } : {}), 'FORBIDDEN', /more than 120 requests/);
      expect(err).toBeInstanceOf(AgentRateLimited);
      const secs = agentRetryAfter(err);
      expect(secs).toBeGreaterThanOrEqual(1);
      expect(secs).toBeLessThanOrEqual(60);
      expect(err.details).toMatchObject({ rateLimited: true, retryAfterSeconds: secs });
    }
    expect(m.runOperation).not.toHaveBeenCalled();
    // An error that only looks alike (the bridge's closing-password limiter) is not the door's.
    expect(agentRetryAfter(new ServiceError('FORBIDDEN', 'Too many wrong passwords.', { rateLimited: true, retryAfterSeconds: 30 }))).toBeNull();
  });

  it(`runs at most ${AGENT_RUNS_AT_ONCE} operations of one agent at once; one more is told to wait, and the place comes back`, async () => {
    const gates: Array<() => void> = [];
    m.runOperation.mockImplementation(
      (_b: unknown, operation: Operation, input: OperationInput, mode: BridgeMode) =>
        new Promise<BridgeResult>((resolve) => gates.push(() => resolve(bridged(mode, { facts: bodyFacts(operation, input, { closingDate: null }) })))),
    );
    const running = Array.from({ length: AGENT_RUNS_AT_ONCE }, () => operate(agentCtx, { operation: 'invoices.list' }));
    await vi.waitFor(() => expect(gates).toHaveLength(AGENT_RUNS_AT_ONCE));
    const busy = await operate(agentCtx, { operation: 'invoices.list' });
    expect(busy).toMatchObject({ outcome: 'refused' });
    expect(busy.note).toMatch(/already has 4 requests under way.*Wait about 2 seconds/);
    const verb = await expectError(handleVerb(agentCtx, 'run_operation', { operation: 'invoices.list' }), 'FORBIDDEN', /already has 4 requests under way/);
    expect(agentRetryAfter(verb)).toBe(2);
    // Another agent is not held up by this one.
    const other = { ...agentCtx, agent: { ...agentCtx.agent!, id: randomUUID() } };
    const elsewhere = operate(other, { operation: 'invoices.list' });
    await vi.waitFor(() => expect(gates).toHaveLength(AGENT_RUNS_AT_ONCE + 1));
    for (const open of gates) open();
    expect((await Promise.all(running)).map((x) => x.outcome)).toEqual(Array(AGENT_RUNS_AT_ONCE).fill('read'));
    expect((await elsewhere).outcome).toBe('read');
    // A run that throws gives its place back too.
    m.runOperation.mockRejectedValueOnce(new Error('boom'));
    await expect(operate(agentCtx, { operation: 'invoices.list' })).rejects.toThrow('boom');
    bridgeAnswers({});
    const again = await Promise.all(Array.from({ length: AGENT_RUNS_AT_ONCE }, () => operate(agentCtx, { operation: 'invoices.list' })));
    expect(again.every((x) => x.outcome === 'read')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runApproved
// ---------------------------------------------------------------------------

/**
 * A stored request as the requests service keeps one: its staleness key, and in `needs` what the
 * person must have plus, under `request`, the facts they were shown.
 */
async function storedRequest(
  stalenessKey: string | null,
  operation = 'invoices.create',
  shown: Partial<RequestFacts> | null = { amount: '10' },
  twoPerson = false,
): Promise<string> {
  const needs = {
    admin: false,
    fileAdmin: false,
    hostOnly: false,
    flag: null,
    flags: [],
    secrets: [],
    twoPerson,
    grantable: 'yes',
    request: { kind: 'operation', facts: shown ? facts(shown) : undefined, staleRound: 0, staleSeen: [] },
  };
  const [row] = await db
    .insert(agentPermissionRequests)
    .values({
      companyId,
      agentId,
      requestKey: rid(),
      operation,
      class: 'enter',
      summary: 'Enter an invoice',
      stalenessKey,
      needs: needs as never,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: agentPermissionRequests.id });
  return row.id;
}

describe('runApproved', () => {
  it('runs as the approver, within what the approver and the agent both have', async () => {
    const id = await storedRequest(null);
    const input = { body: { total: '10' }, reveal: true };
    const r = await runApproved(approver, { id, agentId, operation: 'invoices.create', input }, { secrets: { closing_password: 'pw' }, answers: {} }, { atHost: true });
    expect(r.mode).toBe('commit');
    // Tried first with the approver's rights (no reveal, no secrets), then run.
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    expect(callsOf('dry_run')[0].actor).toMatchObject({ reveal: false, secrets: {}, userId: ownerId });
    const [call] = callsOf('commit');
    expect(call.base).toBe(approver);
    expect(call.input).toEqual(input);
    expect(call.actor).toMatchObject({
      agent: { id: agentId, name: 'Robo', preset: 'trusted_bookkeeper', onBehalfOf: ownerId },
      role: 'accountant',
      userId: ownerId,
      approval: { approvedBy: ownerId, requestId: id, grantId: null },
      reveal: true,
      secrets: { closing_password: 'pw' },
      folders: [SAVE_DIR],
      atHost: true,
    });
    expect(call.actor.access).toEqual(intersectAccess(fullAccess(), CEILING));
    expect(isSubset(call.actor.access, CEILING)).toBe(true);

    // An approver without the View flags: the run has none either, whatever the agent's role holds.
    m.runOperation.mockClear();
    const plain = { ...approver, role: 'accountant' as const, access: custom({ customers: ['full'] }) };
    await runApproved(plain, { id, agentId, operation: 'invoices.create', input }, {}, { atHost: false });
    const [second] = callsOf('commit');
    expect(second.actor.access.flags).toEqual({ sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false });
    expect(second.actor.access.permissions.payroll).toEqual([]);
  });

  it('refuses anyone but a signed-in person, and work neither side may do', async () => {
    const id = await storedRequest(null);
    const req = { id, agentId, operation: 'invoices.create', input: { body: { total: '10' } } };
    await expectError(runApproved(agentCtx, req, {}, { atHost: true }), 'FORBIDDEN', /signed in to Ironbooks/);
    await expectError(runApproved({ ...approver, userId: null }, req, {}, { atHost: true }), 'FORBIDDEN', /signed in to Ironbooks/);
    await expectError(runApproved({ ...approver, agent: agentCtx.agent }, req, {}, { atHost: true }), 'FORBIDDEN');
    const viewer = { ...approver, role: 'viewer' as const, access: unionRoles([builtinRole('view_only')!]) };
    await expectError(runApproved(viewer, req, {}, { atHost: true }), 'FORBIDDEN', /rights you and the agent both have/);
    await expectError(runApproved(approver, { ...req, operation: 'agents.create' }, {}, { atHost: true }), 'FORBIDDEN', /never do this/);
    await expectError(runApproved(approver, { ...req, operation: 'company.network' }, {}, { atHost: false }), 'FORBIDDEN', /computer that holds the company file/);
    expect(m.runOperation).not.toHaveBeenCalled();
  });

  it('refuses for an agent that was removed or paused', async () => {
    const id = await storedRequest(null);
    const req = { id, agentId, operation: 'invoices.create', input: { body: { total: '10' } } };
    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
    try {
      await expectError(runApproved(approver, req, {}, { atHost: true }), 'FORBIDDEN', /has been removed/);
    } finally {
      await db.update(agents).set({ revokedAt: null }).where(eq(agents.id, agentId));
    }
    usePolicy('trusted_bookkeeper', { pausedAt: new Date().toISOString() });
    await expectError(runApproved(approver, req, {}, { atHost: true }), 'FORBIDDEN', /paused/);
    expect(m.runOperation).not.toHaveBeenCalled();
  });

  it('when the books changed since the agent asked, shows what would happen now and runs nothing', async () => {
    const id = await storedRequest('k1');
    const req = { id, agentId, operation: 'invoices.create', input: { body: { total: '10' }, reveal: true } };
    bridgeAnswers({ dry_run: () => ({ stalenessKey: 'k2', preview: preview(2) }) });
    const stale = await runApproved(approver, req, { secrets: { closing_password: 'pw' } }, { atHost: true });
    expect(stale.mode).toBe('dry_run');
    expect(stale.preview?.ledger?.entries).toHaveLength(2);
    expect(callsOf('commit')).toHaveLength(0);
    // That preview may be stored on the request, where the agent reads it: no reveal, no secrets.
    expect(callsOf('dry_run')[0].actor).toMatchObject({ reveal: false, secrets: {}, userId: ownerId });

    // Every yes is checked against the key stored on the request, acceptStale or not...
    m.runOperation.mockClear();
    expect((await runApproved(approver, req, { acceptStale: true }, { atHost: true })).mode).toBe('dry_run');
    expect(callsOf('commit')).toHaveLength(0);

    // ...so once the approval service has stored the new key with the new preview, the next yes runs it.
    await db.update(agentPermissionRequests).set({ stalenessKey: 'k2' }).where(eq(agentPermissionRequests.id, id));
    m.runOperation.mockClear();
    const accepted = await runApproved(approver, req, { acceptStale: true, secrets: { closing_password: 'pw' } }, { atHost: true });
    expect(accepted.mode).toBe('commit');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    expect(callsOf('commit')[0].actor).toMatchObject({ reveal: true, secrets: { closing_password: 'pw' } });

    // The books changed yet again after the person saw the new preview: shown again, not run.
    m.runOperation.mockClear();
    bridgeAnswers({ dry_run: () => ({ stalenessKey: 'k3' }) });
    expect((await runApproved(approver, req, { acceptStale: true }, { atHost: true })).mode).toBe('dry_run');
    expect(callsOf('commit')).toHaveLength(0);
  });

  it('asked without a preview: tried with the approver\'s rights first, and shown to the person again when it would do more than they saw', async () => {
    const more: Array<[string, Partial<RequestFacts>, Partial<RequestFacts>]> = [
      ['invoices.create', { amount: '10' }, { amount: '5000.00' }],
      ['invoices.create', { amount: '10' }, { amount: '-25.00' }],
      ['invoices.create', { amount: '10' }, { amount: '10', closedPeriod: true }],
      ['invoices.batch', { count: 2 }, { count: 5 }],
    ];
    for (const [operation, shown, real] of more) {
      m.runOperation.mockClear();
      const id = await storedRequest(null, operation, shown);
      bridgeAnswers({ dry_run: () => ({ facts: facts(real), preview: preview(3), stalenessKey: 'k-real' }) });
      const r = await runApproved(approver, { id, agentId, operation, input: { body: { total: '10' } } }, {}, { atHost: true });
      expect(r.mode, `${operation} ${JSON.stringify(real)}`).toBe('dry_run');
      expect(r.outcome).toBe('ok');
      expect(r.preview?.ledger?.entries).toHaveLength(3);
      expect(callsOf('commit')).toHaveLength(0);
    }

    // What the person was shown cannot be read: nothing counts as shown, so the real preview is shown.
    m.runOperation.mockClear();
    const unread = await storedRequest(null, 'invoices.create', null);
    bridgeAnswers({});
    expect((await runApproved(approver, { id: unread, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true })).mode).toBe('dry_run');
    expect(callsOf('commit')).toHaveLength(0);

    // Within what was shown (an amount shown as unknown, with no figure of the agent's, included): it runs.
    for (const [shown, real, body] of [
      [{ amount: '10' }, { amount: '10.00' }, { total: '10' }],
      [{ amount: '10' }, { amount: '-10' }, { total: '10' }],
      [{ amount: null }, { amount: '900.00' }, {}],
      [{ amount: null }, { amount: '10.00' }, { total: '10' }],
    ] as Array<[Partial<RequestFacts>, Partial<RequestFacts>, Record<string, unknown>]>) {
      m.runOperation.mockClear();
      const id = await storedRequest(null, 'invoices.create', shown);
      bridgeAnswers({ dry_run: () => ({ facts: facts(real) }) });
      expect((await runApproved(approver, { id, agentId, operation: 'invoices.create', input: { body } }, {}, { atHost: true })).mode, JSON.stringify(shown)).toBe('commit');
      expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    }

    // The card had the amount as unknown, but the summary line showed the agent's own 10: a real
    // 900 is more than the person read, so they see it first.
    m.runOperation.mockClear();
    const claimed = await storedRequest(null, 'invoices.create', { amount: null });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ amount: '900.00' }), stalenessKey: 'k-900' }) });
    const again = await runApproved(approver, { id: claimed, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true });
    expect(again).toMatchObject({ mode: 'dry_run', outcome: 'ok', stalenessKey: 'k-900', facts: { amount: '900.00' } });
    expect(callsOf('commit')).toHaveLength(0);
  });

  it('a dry run at approval that meets the closing date judges closed-period work: back to the person when it was not shown so, refused when the policy says Never', async () => {
    const closed: Partial<BridgeResult> = { outcome: 'error', httpStatus: 400, result: null, preview: null, error: { message: 'The period is closed.', code: 'PERIOD_CLOSED', details: null } };
    bridgeAnswers({ dry_run: () => closed });
    const input = { body: { total: '10', date: '2026-03-01' } };
    // Asked as open-period work (the closing date moved since), with or without a preview: nothing
    // runs; it goes back as closed-period work, its amount unknown, with why.
    for (const key of [null, 'k1']) {
      m.runOperation.mockClear();
      const id = await storedRequest(key, 'invoices.create', { amount: '10', closedPeriod: false });
      const back = await runApproved(approver, { id, agentId, operation: 'invoices.create', input }, { secrets: { closing_password: 'pw' } }, { atHost: true });
      expect(back, String(key)).toMatchObject({ mode: 'dry_run', outcome: 'ok', stalenessKey: null, result: null, facts: { amount: null, closedPeriod: true } });
      expect(back.preview?.ledger).toBeNull();
      expect(String((back.preview?.routePreview as Out).note)).toMatch(/dated on or before the closing date.*closing-date password/);
      expect(callsOf('commit')).toHaveLength(0);
    }

    // Closed periods set to Never since: refused, nothing done, whatever was shown.
    policy = { ...policy, classes: { ...policy.classes, period: 'never' } };
    for (const shown of [{ amount: '10', closedPeriod: false }, { amount: '10', closedPeriod: true }]) {
      const id = await storedRequest(null, 'invoices.create', shown);
      await expectError(
        runApproved(approver, { id, agentId, operation: 'invoices.create', input }, { secrets: { closing_password: 'pw' } }, { atHost: true }),
        'FORBIDDEN',
        /^Nothing was done\./,
      );
    }
    expect(callsOf('commit')).toHaveLength(0);

    // Shown as closed-period work with a preview this try cannot be compared with: never run on it.
    usePolicy('trusted_bookkeeper');
    const keyed = await storedRequest('k1', 'invoices.create', { amount: '10', closedPeriod: true });
    expect(await runApproved(approver, { id: keyed, agentId, operation: 'invoices.create', input }, { secrets: { closing_password: 'pw' } }, { atHost: true })).toMatchObject({
      mode: 'dry_run',
      outcome: 'error',
    });
    expect(callsOf('commit')).toHaveLength(0);
  });

  it('a request only an approved reveal gets through is tried again with the reveal for its figures alone; its preview never leaves', async () => {
    const forbidden: Partial<BridgeResult> = {
      outcome: 'error',
      httpStatus: 403,
      result: null,
      preview: null,
      error: { message: 'This needs "View sensitive payroll".', code: 'FORBIDDEN', details: null },
    };
    const secret = { id: 'emp-1', ssn: '123-45-6789' };
    let seen: Partial<RequestFacts> = { amount: '0.00' };
    m.runOperation.mockImplementation(async (_b: unknown, operation: Operation, input: OperationInput, mode: BridgeMode, actor: BridgeActor) => {
      if (mode === 'dry_run' && !actor.reveal) return bridged(mode, { ...forbidden, facts: bodyFacts(operation, input, { closingDate: null }) });
      if (mode === 'dry_run') return bridged(mode, { result: secret, facts: facts(seen), stalenessKey: 'k-revealed' });
      return bridged(mode, { result: secret });
    });
    const input = { params: { id: 'emp-1' }, body: { total: '10' }, reveal: true };

    // More than the person read (the agent said 10): asked again with the real figures, no preview,
    // no answer, no staleness key, so the unmasked values go nowhere.
    seen = { amount: '5000.00' };
    const more = await storedRequest(null, 'employees.update', { amount: null });
    const back = await runApproved(approver, { id: more, agentId, operation: 'employees.update', input }, { secrets: { closing_password: 'pw' } }, { atHost: true });
    expect(back).toMatchObject({ mode: 'dry_run', outcome: 'ok', result: null, stalenessKey: null, facts: { amount: '5000.00' } });
    expect(back.preview?.ledger).toBeNull();
    expect(back.preview?.records).toEqual([]);
    expect(String((back.preview?.routePreview as Out).note)).toMatch(/would do more than the request showed.*not shown, because it holds those protected values/);
    expect(JSON.stringify(back)).not.toContain('123-45-6789');
    expect(callsOf('commit')).toHaveLength(0);
    const [masked, revealed] = callsOf('dry_run');
    expect(masked.actor).toMatchObject({ reveal: false, secrets: {} });
    expect(revealed.actor).toMatchObject({ reveal: true, secrets: {}, userId: ownerId, approval: { approvedBy: ownerId, requestId: more } });

    // The real figures need two people where the request did not: asked again, saying why.
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    m.runOperation.mockClear();
    const two = await storedRequest(null, 'employees.update', { amount: '5000.00' }, false);
    const twice = await runApproved(approver, { id: two, agentId, operation: 'employees.update', input }, {}, { atHost: true });
    expect(twice).toMatchObject({ mode: 'dry_run', outcome: 'ok', facts: { amount: '5000.00' } });
    expect(String((twice.preview?.routePreview as Out).note)).toMatch(/two different people must approve it/);
    expect(callsOf('commit')).toHaveLength(0);

    // Within what was read, and already of two people: it runs, with the reveal.
    m.runOperation.mockClear();
    const fine = await storedRequest(null, 'employees.update', { amount: '5000.00' }, true);
    expect((await runApproved(approver, { id: fine, agentId, operation: 'employees.update', input }, {}, { atHost: true })).mode).toBe('commit');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'dry_run', 'commit']);
    expect(callsOf('commit')[0].actor.reveal).toBe(true);
    usePolicy('trusted_bookkeeper');
  });

  it('what a dry run cannot get through at approval: the closing date and a reveal go on; anything else ends it, nothing done', async () => {
    const closed: Partial<BridgeResult> = { outcome: 'error', httpStatus: 400, result: null, preview: null, error: { message: 'The period is closed.', code: 'PERIOD_CLOSED', details: null } };
    const shownClosed = { amount: '10', closedPeriod: true };
    bridgeAnswers({ dry_run: () => closed });
    // The closing-date override is the commit's alone: a dry run of closed-period work cannot pass.
    const id = await storedRequest(null, 'invoices.create', shownClosed);
    expect((await runApproved(approver, { id, agentId, operation: 'invoices.create', input: { body: { total: '10', date: '2026-03-01' } } }, { secrets: { closing_password: 'pw' } }, { atHost: true })).mode).toBe('commit');
    expect(callsOf('commit')[0].actor.secrets).toEqual({ closing_password: 'pw' });

    // With a two-person limit, figures nobody could check need two people: a request that did not
    // say so goes back to the person (nothing runs), with the amount unknown and why.
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    m.runOperation.mockClear();
    const one = await storedRequest(null, 'invoices.create', shownClosed, false);
    const back = await runApproved(approver, { id: one, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true });
    expect(back).toMatchObject({ mode: 'dry_run', outcome: 'ok', stalenessKey: null, facts: { amount: null, closedPeriod: true } });
    expect(back.preview?.routePreview).toMatchObject({ ran: false });
    expect(String((back.preview?.routePreview as Out).note)).toMatch(/could not try this ahead of time.*two different people must approve it/);
    expect(callsOf('commit')).toHaveLength(0);
    // Already asked of two people: it runs.
    const two = await storedRequest(null, 'invoices.create', shownClosed, true);
    expect((await runApproved(approver, { id: two, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true })).mode).toBe('commit');
    usePolicy('trusted_bookkeeper');

    // A reveal: the dry run is kept without it, so the View flag is missing there, not on the run.
    m.runOperation.mockClear();
    bridgeAnswers({ dry_run: () => ({ ...closed, httpStatus: 403, error: { message: 'This needs "View sensitive payroll".', code: 'FORBIDDEN', details: null } }) });
    const reveal = await storedRequest(null, 'employees.update', { amount: null });
    const ran = await runApproved(approver, { id: reveal, agentId, operation: 'employees.update', input: { params: { id: 'emp-1' }, body: {}, reveal: true } }, {}, { atHost: true });
    expect(ran.mode).toBe('commit');
    expect(callsOf('commit')[0].actor.reveal).toBe(true);

    // Without a reveal, the same refusal would meet the run too: it ends here, nothing done.
    m.runOperation.mockClear();
    const plain = await storedRequest(null, 'employees.update', { amount: null });
    await expectError(
      runApproved(approver, { id: plain, agentId, operation: 'employees.update', input: { params: { id: 'emp-1' }, body: {} } }, {}, { atHost: true }),
      'FORBIDDEN',
      /View sensitive payroll".* It was tried before running and would not go through, so nothing was done\./,
    );
    // Any other failure too (a refusal no approval lifts, a customer since made inactive).
    for (const r of [
      { ...closed, httpStatus: 403, error: { message: 'Payroll is turned off in Preferences.', code: 'FORBIDDEN', details: { featureOff: true } } },
      { ...closed, httpStatus: 400, error: { message: 'Customer is inactive.', code: 'VALIDATION', details: null } },
    ]) {
      bridgeAnswers({ dry_run: () => r });
      const fresh = await storedRequest(null, 'employees.update', { amount: null });
      await expectError(
        runApproved(approver, { id: fresh, agentId, operation: 'employees.update', input: { params: { id: 'emp-1' }, body: {}, reveal: true } }, {}, { atHost: true }),
        r.error.code,
        r.error.message,
      );
    }
    expect(callsOf('commit')).toHaveLength(0);

    // A warning ends it with the warning (the agent can send it again with the flag).
    bridgeAnswers({ dry_run: () => ({ outcome: 'needs_confirmation', httpStatus: 409, warnings: [{ flag: 'allowDuplicateNumber', message: 'Invoice 1001 is already used.' }] }) });
    const warned = await storedRequest(null);
    expect(await runApproved(approver, { id: warned, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true })).toMatchObject({
      mode: 'dry_run',
      outcome: 'needs_confirmation',
    });
    expect(callsOf('commit')).toHaveLength(0);
  });

  it("the agent's policy as it is now still holds for an approved request, on the real figures", async () => {
    // A record limit lowered since it was asked.
    usePolicy('full_with_asks', { bulkCap: 200 });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ count: 500 }) }) });
    const big = await storedRequest(null, 'invoices.batch', { count: 500 });
    await expectError(
      runApproved(approver, { id: big, agentId, operation: 'invoices.batch', input: { body: { items: [1] } } }, {}, { atHost: true }),
      'FORBIDDEN',
      /^Nothing was done\. This would change 500 records, more than this agent may change in one request \(200\)/,
    );
    // A class an Admin has set to Never since.
    usePolicy('read_only');
    bridgeAnswers({});
    const never = await storedRequest(null);
    await expectError(runApproved(approver, { id: never, agentId, operation: 'invoices.create', input: { body: { total: '10' } } }, {}, { atHost: true }), 'FORBIDDEN', /has not allowed agents to enter new records/);
    // A two-person limit set since: the person sees it again and a second person approves too.
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    bridgeAnswers({ dry_run: () => ({ facts: facts({ amount: '5000.00' }), stalenessKey: 'k5' }) });
    const large = await storedRequest('k5', 'invoices.create', { amount: '5000.00' }, false);
    expect((await runApproved(approver, { id: large, agentId, operation: 'invoices.create', input: { body: { total: '5000.00' } } }, {}, { atHost: true })).mode).toBe('dry_run');
    const both = await storedRequest('k5', 'invoices.create', { amount: '5000.00' }, true);
    expect((await runApproved(approver, { id: both, agentId, operation: 'invoices.create', input: { body: { total: '5000.00' } } }, {}, { atHost: true })).mode).toBe('commit');
    expect(callsOf('commit')).toHaveLength(1);
  });

  it('an approved read runs as a read, on the read path, with the reveal the person approved', async () => {
    const id = await storedRequest('k1', 'invoices.list');
    const r = await runApproved(approver, { id, agentId, operation: 'invoices.list', input: { reveal: true } }, {}, { atHost: false });
    expect(r.mode).toBe('read');
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['read']);
    expect(callsOf('read')[0].actor).toMatchObject({ reveal: true, userId: ownerId, approval: { approvedBy: ownerId, requestId: id } });
  });

  it('a desktop action goes to the shell with the answers and the typed secrets', async () => {
    const id = await storedRequest(null, 'shell.print.file');
    m.runShellOperation.mockResolvedValueOnce({ ok: true, result: { printed: true }, error: null, restarting: false });
    const input = { body: { fileId: 'b'.repeat(32), printer: 'Front desk' } };
    const r = await runApproved(approver, { id, agentId, operation: 'shell.print.file', input }, { answers: { q1: true }, secrets: { file_password: 'pw' } }, { atHost: true });
    expect(r).toMatchObject({ mode: 'commit', outcome: 'ok', httpStatus: 200, result: { printed: true }, produced: [], error: null });
    const [base, def, request, answers, secrets] = m.runShellOperation.mock.calls[0];
    expect(base).toBe(approver);
    expect((def as ShellOperationDef).id).toBe('shell.print.file');
    expect(request).toEqual({ id, agentId, input: input.body });
    expect(answers).toEqual({ q1: true });
    expect(secrets).toEqual({ file_password: 'pw' });
    expect(m.runOperation).not.toHaveBeenCalled();

    m.runShellOperation.mockResolvedValueOnce({ ok: false, result: null, error: 'The printer is offline.', restarting: false });
    const failed = await runApproved(approver, { id, agentId, operation: 'shell.print.file', input }, {}, { atHost: true });
    expect(failed).toMatchObject({ outcome: 'error', error: { message: 'The printer is offline.' } });
  });

  /** The shell module's own files.save (lib/agent/shell.ts), over this file's stand-ins for staged files and the policy. */
  async function realShellSave() {
    const real = await vi.importActual<typeof import('./shell')>('./shell');
    m.runShellOperation.mockImplementation(real.runShellOperation);
    m.allowedFolder.mockImplementation(async (allowed: string[], folder: string) => (allowed.includes(folder) ? folder : null));
  }

  it('files.save is the shell module\'s: it saves into an allowed folder, and nowhere else', async () => {
    await realShellSave();
    const id = await storedRequest(null, 'files.save');
    const fileId = 'c'.repeat(32);
    m.readStagedFile.mockResolvedValue({ file: { fileId, name: 'statement.pdf', type: 'application/pdf', size: 5 }, bytes: new TextEncoder().encode('%PDF-') });
    const r = await runApproved(approver, { id, agentId, operation: 'files.save', input: { body: { fileId, folder: SAVE_DIR, name: 'March.pdf' } } }, {}, { atHost: true });
    expect(r, JSON.stringify(r.error)).toMatchObject({ mode: 'commit', outcome: 'ok', result: { saved: true, name: 'March.pdf' } });
    expect(fs.readFileSync(path.join(SAVE_DIR, 'March.pdf'), 'utf8')).toBe('%PDF-');
    const [base, def, request] = m.runShellOperation.mock.calls[0];
    expect(base).toBe(approver);
    expect((def as ShellOperationDef).id).toBe('files.save');
    expect(request).toEqual({ id, agentId, input: { fileId, folder: SAVE_DIR, name: 'March.pdf' } });
    expect(m.readStagedFile.mock.calls[0][0]).toEqual({ companyId, agentId });
    expect(m.runOperation).not.toHaveBeenCalled();

    const elsewhere = path.join(ROOT, 'elsewhere');
    const no = await runApproved(approver, { id, agentId, operation: 'files.save', input: { body: { fileId, folder: elsewhere } } }, {}, { atHost: true });
    expect(no).toMatchObject({ outcome: 'error' });
    expect(no.error?.message).toMatch(/not a folder agents may save in/);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });

  it('files.save never replaces a file that is already there, whatever the approval card showed', async () => {
    await realShellSave();
    const id = await storedRequest(null, 'files.save');
    const fileId = 'f'.repeat(32);
    m.readStagedFile.mockResolvedValue({ file: { fileId, name: 'statement.pdf', type: 'application/pdf', size: 5 }, bytes: new TextEncoder().encode('%PDF-') });
    // Saved by a person after the agent asked, before anyone approved.
    const theirs = path.join(SAVE_DIR, 'Theirs.pdf');
    fs.writeFileSync(theirs, 'a person saved this');
    const r = await runApproved(approver, { id, agentId, operation: 'files.save', input: { body: { fileId, folder: SAVE_DIR, name: 'Theirs.pdf' } } }, {}, { atHost: true });
    expect(r).toMatchObject({ mode: 'commit', outcome: 'error', result: null });
    expect(r.error?.message).toMatch(/already a file called "Theirs\.pdf".*never replaces a file for an agent/);
    expect(fs.readFileSync(theirs, 'utf8')).toBe('a person saved this');
  });
});

// ---------------------------------------------------------------------------
// intersectAccess and lowerRole
// ---------------------------------------------------------------------------

describe('intersectAccess', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const CHOICES = ['view', 'create', 'modify', 'delete', 'print', 'full', 'view_balance'];

  function randomAccess(r: () => number): EffectiveAccess {
    const grant: Record<string, string[]> = {};
    const some = () => CHOICES.filter(() => r() < 0.35);
    for (const area of AREA_KEYS) if (r() < 0.3) grant[area] = some();
    for (const key of ACTIVITY_KEYS) if (r() < 0.12) grant[key] = some();
    const flags: Record<string, boolean> = {};
    for (const f of FLAGS) flags[f.key] = r() < 0.5;
    const roles: RoleDefinition[] = [{ key: `r${Math.floor(r() * 4)}`, name: 'R', description: '', builtin: false, permissions: grant as PermissionGrant, flags }];
    if (r() < 0.1) roles.push(builtinRole('admin')!);
    const access = unionRoles(roles);
    // Some accesses are built by hand, without per-activity rights.
    return r() < 0.15 ? { ...access, activities: undefined } : access;
  }

  it('is never wider than either side, and keeps what both share (property test)', () => {
    const r = rng(20261120);
    for (let i = 0; i < 250; i++) {
      const a = randomAccess(r);
      const b = r() < 0.1 ? a : randomAccess(r);
      const x = intersectAccess(a, b);
      expect(isSubset(x, a)).toBe(true);
      expect(isSubset(x, b)).toBe(true);
      for (const area of AREA_KEYS) {
        for (const act of ACTIONS) {
          if (can(x, area, act)) expect(can(a, area, act) && can(b, area, act)).toBe(true);
          if (canSomeActivity(x, area, act)) expect(canSomeActivity(a, area, act) && canSomeActivity(b, area, act)).toBe(true);
        }
      }
      for (const def of ACTIVITIES as readonly ActivityDef[]) {
        for (const act of supportedActions(def)) {
          const both = canActivity(a, def.key, act) && canActivity(b, def.key, act);
          if (canActivity(x, def.key, act)) expect(both).toBe(true);
          // What both sides allow is kept (plain actions; View Balance rides on View).
          if (both && act !== 'view_balance') expect(canActivity(x, def.key, act)).toBe(true);
        }
      }
      for (const f of FLAGS) if (x.flags[f.key]) expect(a.flags[f.key] && b.flags[f.key]).toBe(true);
      if (x.isAdmin) expect(a.isAdmin && b.isAdmin).toBe(true);
      for (const k of x.roleKeys) expect(a.roleKeys.includes(k) && b.roleKeys.includes(k)).toBe(true);
    }
  });

  it('an Admin approving gives the agent nothing beyond its role', () => {
    const x = intersectAccess(fullAccess(), CEILING);
    expect(x.isAdmin).toBe(false);
    expect(x.permissions.users).toEqual([]);
    expect(x.permissions.customers).toEqual(CEILING.permissions.customers);
  });

  it('lowerRole takes the lower, and anything unknown as view-only', () => {
    expect(lowerRole('owner', 'accountant')).toBe('accountant');
    expect(lowerRole('admin', 'owner')).toBe('admin');
    expect(lowerRole('viewer', 'owner')).toBe('viewer');
    expect(lowerRole(undefined, 'owner')).toBe('viewer');
    expect(lowerRole('constructor' as never, 'owner')).toBe('viewer');
  });
});

// ---------------------------------------------------------------------------
// handleVerb
// ---------------------------------------------------------------------------

describe('handleVerb', () => {
  it('refuses a verb that does not exist, with the list of those that do', async () => {
    await expectError(handleVerb(agentCtx, 'approve_request' as never, {}), 'VALIDATION', /There is no verb "approve_request".*find_operations/);
  });

  it('find_operations: at most 30, each with how this agent is treated and why', async () => {
    const a = (await handleVerb(agentCtx, 'find_operations', { query: 'invoices' })) as Out;
    const byId = Object.fromEntries(a.operations.map((o: Out) => [o.id, o]));
    expect(byId['invoices.list']).toMatchObject({ treatment: 'run', why: null, class: 'read', method: 'GET', route: '/api/invoices' });
    expect(byId['invoices.create']).toMatchObject({ treatment: 'run' });
    expect(byId['invoices.delete']).toMatchObject({ treatment: 'ask' });
    expect(byId['invoices.delete'].why).toMatch(/^Asks a person first\./);
    expect(a.more).toBe(false);

    const floor = (await handleVerb(agentCtx, 'find_operations', { query: 'agents' })) as Out;
    expect(floor.operations[0]).toMatchObject({ id: 'agents.create', treatment: 'refused' });
    expect(floor.operations[0].why).toMatch(/never do this/);

    for (let i = 0; i < 40; i++) m.ops.set(`reports.r${i}`, op({ id: `reports.r${i}`, method: 'GET', class: 'read', rule: { area: 'customers', action: 'view' } }));
    const many = (await handleVerb(agentCtx, 'find_operations', { query: 'reports.r', limit: 50 })) as Out;
    expect(many.operations).toHaveLength(30);
    expect(many.more).toBe(true);
    await expectError(handleVerb(agentCtx, 'find_operations', { query: 'x', dry_run: true }), 'VALIDATION');
  });

  it('find_operations: an ordinary request decides the treatment; the limits that change it are said', async () => {
    // A two-person limit does not make every entry ask: an ordinary one runs, and why says when not.
    usePolicy('full_with_asks', { twoPersonOver: '1000', bulkCap: 50 });
    const a = (await handleVerb(agentCtx, 'find_operations', { query: 'invoices' })) as Out;
    const byId = Object.fromEntries(a.operations.map((o: Out) => [o.id, o]));
    expect(byId['invoices.create']).toMatchObject({ treatment: 'run', class: 'enter' });
    expect(byId['invoices.create'].why).toMatch(/Above 1000, or when its amount cannot be told ahead of time, two different people must approve it/);
    expect(byId['invoices.batch']).toMatchObject({ treatment: 'run' });
    expect(byId['invoices.batch'].why).toMatch(/At most 50 records in one request/);
    // A read is never held by the amount.
    expect(byId['invoices.list'].why).toBeNull();
    // Protected values: asking for them always asks.
    const e = (await handleVerb(agentCtx, 'find_operations', { query: 'employees' })) as Out;
    expect(e.operations[0].why).toMatch(/reveal: true\) always asks a person/);

    // Under standing permission it runs, and says until when; a grant whose giver may not do it does not count.
    usePolicy('ask_every_change');
    const viewer = await member('Wes Viewer', 'viewer');
    const good = grantOf();
    grants = [grantOf({ givenBy: viewer }), good];
    const g = (await handleVerb(agentCtx, 'find_operations', { query: 'invoices.create' })) as Out;
    expect(g.operations[0]).toMatchObject({ id: 'invoices.create', treatment: 'run' });
    expect(g.operations[0].why).toBe(`Runs under standing permission a person gave, until ${good.expiresAt}.`);
    grants = [grantOf({ givenBy: viewer })];
    const none = (await handleVerb(agentCtx, 'find_operations', { query: 'invoices.create' })) as Out;
    expect(none.operations[0]).toMatchObject({ treatment: 'ask' });
  });

  it('find_operations: work that cannot be tried ahead is judged with its amount unknown, as every real request of it is', async () => {
    // With a two-person limit, an entry whose figures are never seen ahead always needs two people.
    usePolicy('full_with_asks', { twoPersonOver: '1000' });
    for (const id of ['bills.receive', 'feeds.refresh']) {
      const [found] = ((await handleVerb(agentCtx, 'find_operations', { query: id })) as Out).operations;
      expect(found, id).toMatchObject({ id, treatment: 'ask' });
      expect(found.why).toMatch(/two different people must approve it/);
      expect(found.why).toMatch(/cannot be tried ahead of time, so its amount counts as unknown/);
      // What a real request of it meets: the same.
      const real = await operate(agentCtx, { operation: id, body: { total: '1' }, requestId: rid(), reason: 'Today' });
      expect(real).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
    }
    // One that is tried first still runs when its real amount is small.
    const [tried] = ((await handleVerb(agentCtx, 'find_operations', { query: 'invoices.create' })) as Out).operations;
    expect(tried).toMatchObject({ treatment: 'run' });
    // Without the limit, the amount does not matter.
    usePolicy('full_with_asks');
    const [plain] = ((await handleVerb(agentCtx, 'find_operations', { query: 'bills.receive' })) as Out).operations;
    expect(plain).toMatchObject({ treatment: 'run', why: null });
  });

  it("describe_operation: the schemas, notes and this agent's treatment", async () => {
    m.describeSchemas.mockResolvedValueOnce({ body: { type: 'object', properties: { total: { type: 'string' } } }, query: null });
    const d = (await handleVerb(agentCtx, 'describe_operation', { operation: 'invoices.create' })) as Out;
    expect(d).toMatchObject({ id: 'invoices.create', treatment: 'run', dryRun: 'transaction', confirmFlags: ['allowDuplicateNumber'], bodySchema: { type: 'object' }, querySchema: null });
    expect(d.notes.join(' ')).toMatch(/dry_run: true first/);
    expect(d.notes.join(' ')).toMatch(/"total"/);

    m.describeSchemas.mockRejectedValueOnce(new Error('not built yet'));
    const e = (await handleVerb(agentCtx, 'describe_operation', { operation: 'invoices.email' })) as Out;
    expect(e.bodySchema).toBeNull();
    expect(e.notes.join(' ')).toMatch(/could not be loaded/);
    await expectError(handleVerb(agentCtx, 'describe_operation', { operation: 'nope.nope' }), 'NOT_FOUND', /find_operations/);
  });

  it('describe_operation: the examples its classification has, as run_operation takes them; none when it has none', async () => {
    m.describeSchemas.mockResolvedValue({ body: null, query: null });
    const none = (await handleVerb(agentCtx, 'describe_operation', { operation: 'invoices.create' })) as Out;
    expect(none.examples).toEqual([]);

    // The classification of POST /api/invoices (lib/agent/operations/classes) given examples: one
    // written as a whole request, one as a body alone.
    const classified = OPERATION_CLASSES['POST /api/invoices'] as { examples?: unknown };
    expect(classified).toBeTruthy();
    classified.examples = [{ body: { customerId: 'c-1', total: '10.00' }, confirm: ['allowDuplicateNumber'], note: 'A plain invoice' }, { customerId: 'c-2', total: '5.00' }];
    try {
      const d = (await handleVerb(agentCtx, 'describe_operation', { operation: 'invoices.create' })) as Out;
      expect(d.examples).toEqual([{ body: { customerId: 'c-1', total: '10.00' }, confirm: ['allowDuplicateNumber'] }, { body: { customerId: 'c-2', total: '5.00' } }]);
      expect(d.notes.join(' ')).toMatch(/Each of examples is a request as run_operation takes it/);
      // Still the whole description beside them.
      expect(d).toMatchObject({ id: 'invoices.create', treatment: 'run', confirmFlags: ['allowDuplicateNumber'] });
    } finally {
      delete classified.examples;
    }
  });

  it('run_operation is operate, with its arguments checked strictly', async () => {
    const a = (await handleVerb(agentCtx, 'run_operation', { operation: 'invoices.list' })) as Out;
    expect(a.outcome).toBe('read');
    await expectError(handleVerb(agentCtx, 'run_operation', { operation: 'invoices.create', dry_run: true }), 'VALIDATION');
    await expectError(handleVerb(agentCtx, 'run_operation', { operation: 'invoices.create', reason: 'x'.repeat(501) }), 'VALIDATION', /500/);
  });

  it('list_my_requests and cancel_request (by the request id the agent chose)', async () => {
    m.listRequestsForAgent.mockResolvedValueOnce([{ id: 'r1' }]);
    expect(await handleVerb(agentCtx, 'list_my_requests', { status: 'pending', limit: 5 })).toEqual({ requests: [{ id: 'r1' }] });
    expect(m.listRequestsForAgent).toHaveBeenCalledWith(agentCtx, { status: 'pending', limit: 5 });

    const id = randomUUID();
    storeView({ id, requestKey: 'my-key-1', status: 'pending' });
    m.cancelAgentRequest.mockResolvedValueOnce({ id, status: 'cancelled' });
    expect(await handleVerb(agentCtx, 'cancel_request', { requestId: 'my-key-1' })).toEqual({ request: { id, status: 'cancelled' } });
    expect(m.cancelAgentRequest).toHaveBeenCalledWith(agentCtx, id);
    await expectError(handleVerb(agentCtx, 'cancel_request', { requestId: 'nobody' }), 'NOT_FOUND');
  });

  it('get_my_permissions: ceiling, policy, and whether a person of this company is signed in', async () => {
    m.listActiveSessions.mockResolvedValueOnce([{ id: 's1', userId: ownerId }]);
    const p = (await handleVerb(agentCtx, 'get_my_permissions', {})) as Out;
    expect(p).toMatchObject({
      agent: { id: agentId, name: 'Robo' },
      roles: ['Bookkeeper'],
      preset: 'trusted_bookkeeper',
      paused: false,
      folders: [SAVE_DIR],
      grants: [],
      someoneSignedIn: true,
    });
    expect(p.classes.enter).toBe('allow');
    // Signed in, but not a person of this company, or no longer active: nobody who may answer.
    const outsider = (await db.insert(users).values({ email: `${randomUUID()}@elsewhere.test`, name: 'Otto Outsider', passwordHash: 'x' }).returning())[0].id;
    const gone = await member('Gil Gone', 'accountant', undefined, false);
    m.listActiveSessions.mockResolvedValueOnce([{ id: 's2', userId: outsider }, { id: 's3', userId: gone }]);
    expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(false);
    const active = await member('Ada Active', 'accountant');
    m.listActiveSessions.mockResolvedValueOnce([{ id: 's4', userId: outsider }, { id: 's5', userId: active }]);
    expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(true);
    m.listActiveSessions.mockResolvedValueOnce([]);
    expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(false);
    m.listActiveSessions.mockRejectedValueOnce(new Error('boom'));
    expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(false);
  });

  it("get_my_permissions: the grants that would really let something run, with their real limits", async () => {
    usePolicy('full_with_asks', { twoPersonOver: '1000', bulkCap: 50 });
    const viewer = await member('Val Viewer', 'viewer');
    const small = grantOf({ constraints: { maxAmount: '200', maxUses: 5 } });
    const large = grantOf({ constraints: { maxAmount: '5000' } });
    const open = grantOf({ constraints: {} });
    const batch = grantOf({ operation: 'invoices.batch', constraints: { maxCount: 500 } });
    const theirs = grantOf({ givenBy: viewer });
    // Work that cannot be tried ahead: its amount is never known, so a grant limited by amount never
    // covers it, nor does any grant while the unknown amount needs two people.
    const cappedUntried = grantOf({ operation: 'bills.receive', constraints: { maxAmount: '200' } });
    const openUntried = grantOf({ operation: 'bills.receive', constraints: {} });
    // A person approves each desktop action: a grant on one never lets anything run.
    const printing = grantOf({ operation: 'shell.print.file', constraints: {} });
    grants = [small, large, open, batch, theirs, cappedUntried, openUntried, printing];
    const p = (await handleVerb(agentCtx, 'get_my_permissions', {})) as Out;
    const byId = Object.fromEntries((p.grants as AgentGrant[]).map((g) => [g.id, g]));
    // A grant never covers what needs two people: its amount limit is at most the two-person limit.
    expect(byId[small.id].constraints).toEqual({ maxAmount: '200', maxUses: 5 });
    expect(byId[large.id].constraints).toEqual({ maxAmount: '1000' });
    expect(byId[open.id].constraints).toEqual({ maxAmount: '1000' });
    // The agent's record limit holds under a grant too.
    expect(byId[batch.id].constraints).toEqual({ maxAmount: '1000', maxCount: 50 });
    // Given by someone who may not do it themselves: it would not apply, so it is not listed.
    expect(byId[theirs.id]).toBeUndefined();
    expect(byId[cappedUntried.id]).toBeUndefined();
    expect(byId[openUntried.id]).toBeUndefined();
    expect(byId[printing.id]).toBeUndefined();
    expect(p.grants).toHaveLength(4);

    // Without a two-person limit, the open one covers it (no amount limit is made up for it); the
    // one limited by amount still never does. A real request agrees with both answers.
    usePolicy('ask_every_change');
    const q = (await handleVerb(agentCtx, 'get_my_permissions', {})) as Out;
    const listed = Object.fromEntries((q.grants as AgentGrant[]).map((g) => [g.id, g]));
    expect(listed[openUntried.id].constraints).toEqual({});
    expect(listed[cappedUntried.id]).toBeUndefined();
    grants = [cappedUntried];
    expect(await operate(agentCtx, { operation: 'bills.receive', body: { total: '5' }, requestId: rid(), reason: 'Delivery' })).toMatchObject({ outcome: 'asked' });
    grants = [openUntried];
    expect(await operate(agentCtx, { operation: 'bills.receive', body: { total: '5' }, requestId: rid() })).toMatchObject({ outcome: 'posted', grantId: openUntried.id });
  });

  it("get_my_permissions: someoneSignedIn looks only at this company's people, and finds an owner with no membership row", async () => {
    const signed = await member('Sid Signed', 'accountant');
    // Many people signed in to other company files on this computer.
    const elsewhere = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, userId: randomUUID() }));
    m.listActiveSessions.mockImplementation(async (_db: unknown, o: { companyId?: string } = {}) =>
      o.companyId === companyId ? [{ id: 'm1', userId: signed }] : [...elsewhere, { id: 'm1', userId: signed }],
    );
    expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(true);
    expect(m.listActiveSessions).toHaveBeenCalledWith(db, { companyId });

    // The owner may have no membership row: still a person who may answer.
    const [row] = await db.select().from(userCompanies).where(and(eq(userCompanies.userId, ownerId), eq(userCompanies.companyId, companyId)));
    await db.delete(userCompanies).where(and(eq(userCompanies.userId, ownerId), eq(userCompanies.companyId, companyId)));
    try {
      m.listActiveSessions.mockImplementation(async (_db: unknown, o: { companyId?: string } = {}) => (o.companyId ? [] : [...elsewhere, { id: 'o1', userId: ownerId }]));
      expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(true);
      m.listActiveSessions.mockImplementation(async (_db: unknown, o: { companyId?: string } = {}) => (o.companyId ? [] : elsewhere));
      expect(((await handleVerb(agentCtx, 'get_my_permissions', {})) as Out).someoneSignedIn).toBe(false);
    } finally {
      await db.insert(userCompanies).values(row);
    }
  });

  it('ask_for_permission asks for a grant; never for classes that cannot have one', async () => {
    usePolicy('ask_every_change');
    const no = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'invoices.delete', reason: 'Cleanup', requestId: rid() })) as Out;
    expect(no.outcome).toBe('refused');
    expect(no.note).toMatch(/cannot give standing permission/);

    const capped = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'invoices.batch', reason: 'Month end', requestId: rid() })) as Out;
    expect(capped.note).toMatch(/constraints\.max_count/);

    const silent = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'invoices.create', reason: ' ', requestId: rid() })) as Out;
    expect(silent).toMatchObject({ outcome: 'refused', note: NO_REASON_NOTE });
    expect(m.createAgentRequest).not.toHaveBeenCalled();

    const key = rid();
    const a = (await handleVerb(agentCtx, 'ask_for_permission', {
      operation: 'invoices.create',
      constraints: { maxAmount: 500, maxUses: 12 },
      minutes: 90,
      reason: 'Entering this week\'s invoices',
      requestId: key,
    })) as Out;
    expect(a).toMatchObject({ outcome: 'asked', status: 'pending' });
    const req = m.createAgentRequest.mock.calls[0][1] as Out;
    expect(req).toMatchObject({ kind: 'grant', requestKey: key, input: {}, preview: null, grantAsked: { constraints: { maxAmount: '500', maxUses: 12 }, minutes: 90 } });
    expect(req.summary).toBe('Standing permission for "invoices.create" (Enter new) for up to 90 minutes: amounts up to 500, at most 12 uses.');

    usePolicy('ask_every_change', { twoPersonOver: '100' });
    const big = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'invoices.create', constraints: { maxAmount: '5000' }, reason: 'Big ones', requestId: rid() })) as Out;
    expect(big.note).toMatch(/max_amount at or below 100/);

    usePolicy('trusted_bookkeeper');
    const already = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'invoices.create', reason: 'x', requestId: rid() })) as Out;
    expect(already).toMatchObject({ outcome: 'done' });
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);

    // A desktop or file action never runs on standing permission, so none is asked for.
    usePolicy('full_with_asks');
    const shell = (await handleVerb(agentCtx, 'ask_for_permission', { operation: 'shell.print.file', reason: 'Print the checks', requestId: rid() })) as Out;
    expect(shell.outcome).toBe('refused');
    expect(shell.note).toMatch(/approves each desktop or file action on its own/);
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
  });

  it('ask_for_permission asked again answers what became of it, the grant given since included', async () => {
    usePolicy('ask_every_change');
    const key = rid();
    const args = { operation: 'invoices.create', constraints: { maxAmount: '200' }, reason: 'This week\'s invoices', requestId: key };
    expect(((await handleVerb(agentCtx, 'ask_for_permission', args)) as Out).outcome).toBe('asked');

    // Approved: the grant exists now, so a fresh decision would say there is nothing to ask.
    const grantId = randomUUID();
    Object.assign(m.views.get(`key:${key}`)!, { status: 'executed', grantId });
    grants = [{ id: grantId, agentId, operation: 'invoices.create', constraints: { maxAmount: '200' }, givenBy: ownerId, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), revokedAt: null, uses: 0 }];
    const again = (await handleVerb(agentCtx, 'ask_for_permission', args)) as Out;
    expect(again).toMatchObject({ outcome: 'done', grantId, replayed: true, requestId: m.views.get(`key:${key}`)!.id });
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);
    await expectError(handleVerb(agentCtx, 'ask_for_permission', { ...args, minutes: 30 }), 'CONFLICT', /already used for a different request/);
  });

  it('upload_file and get_file only ever reach this agent\'s own files', async () => {
    m.uploadChunk.mockResolvedValueOnce({ uploadId: 'u1', received: 3, file: null });
    expect(await handleVerb(agentCtx, 'upload_file', { name: 'a.csv', type: 'text/csv', chunkBase64: 'YWJj', last: false })).toEqual({ uploadId: 'u1', received: 3, file: null });
    expect(m.uploadChunk).toHaveBeenCalledWith({ companyId, agentId }, { name: 'a.csv', type: 'text/csv', chunkBase64: 'YWJj', last: false });

    const fileId = 'd'.repeat(32);
    const file = { fileId, name: 'a.csv', type: 'text/csv', size: 3 };
    m.stagedFileInfo.mockResolvedValueOnce(file);
    m.readStagedFile.mockResolvedValueOnce({ file, bytes: new TextEncoder().encode('abc') });
    expect(await handleVerb(agentCtx, 'get_file', { fileId })).toEqual({ file, base64: 'YWJj' });
    expect(m.stagedFileInfo).toHaveBeenCalledWith({ companyId, agentId }, fileId);
    expect(m.readStagedFile).toHaveBeenCalledWith({ companyId, agentId }, fileId);

    m.stagedFileInfo.mockResolvedValueOnce(null);
    await expectError(handleVerb(agentCtx, 'get_file', { fileId }), 'NOT_FOUND', /24 hours/);
  });

  it('save_file asks to save into an allowed folder, with a preview of the save', async () => {
    const fileId = 'e'.repeat(32);
    m.readStagedFile.mockResolvedValue({ file: { fileId, name: 'report.pdf', type: 'application/pdf', size: 3 }, bytes: new TextEncoder().encode('pdf') });
    m.allowedFolder.mockImplementation(async (allowed: string[], folder: string) => (allowed.includes(folder) ? folder : null));
    const key = rid();
    const a = (await handleVerb(agentCtx, 'save_file', { fileId, folder: SAVE_DIR, name: 'April.pdf', requestId: key, reason: 'Keep the April report' })) as Out;
    expect(a).toMatchObject({ operation: 'files.save', outcome: 'asked' });
    const req = m.createAgentRequest.mock.calls[0][1] as Out;
    expect(req.operation.id).toBe('files.save');
    expect(req.input).toEqual({ body: { fileId, folder: SAVE_DIR, name: 'April.pdf' } });
    expect(req.preview.effects[0]).toMatchObject({ kind: 'file' });
    expect(fs.existsSync(path.join(SAVE_DIR, 'April.pdf'))).toBe(false);
    expect(m.runOperation).not.toHaveBeenCalled();

    const no = (await handleVerb(agentCtx, 'save_file', { fileId, folder: path.join(ROOT, 'other'), requestId: rid(), reason: 'x' })) as Out;
    expect(no.outcome).toBe('refused');
    expect(no.note).toMatch(/not one this agent may save to.*Agent Outbox.*added for this agent/);

    // Never over a file that is already there: not even put to a person.
    fs.writeFileSync(path.join(SAVE_DIR, 'Kept.pdf'), 'a person saved this');
    const there = (await handleVerb(agentCtx, 'save_file', { fileId, folder: SAVE_DIR, name: 'Kept.pdf', requestId: rid(), reason: 'x' })) as Out;
    expect(there.outcome).toBe('refused');
    expect(there.note).toMatch(/already a file called "Kept\.pdf".*never replaces a file for an agent/);
    const tried = await operate(agentCtx, { operation: 'files.save', body: { fileId, folder: SAVE_DIR, name: 'Kept.pdf' }, dryRun: true });
    expect(tried).toMatchObject({ outcome: 'refused' });
    expect(fs.readFileSync(path.join(SAVE_DIR, 'Kept.pdf'), 'utf8')).toBe('a person saved this');
    expect(m.createAgentRequest).toHaveBeenCalledTimes(1);

    // The folders agents may always use (the same rule as the save itself) are allowed too.
    const outbox = path.join(ROOT, 'Agent Outbox');
    m.defaultAgentFolders.mockReturnValue([outbox]);
    const out = (await handleVerb(agentCtx, 'save_file', { fileId, folder: outbox, requestId: rid(), reason: 'For the accountant' })) as Out;
    expect(out.outcome).toBe('asked');
    expect(m.allowedFolder.mock.calls.at(-1)?.[0]).toEqual([outbox, SAVE_DIR]);
  });
});

// ---------------------------------------------------------------------------
// The real bridge: journal entries through the app's own route, on this PGlite company
// ---------------------------------------------------------------------------

describe('against the real bridge, on a PGlite company', () => {
  type Real = {
    bridge: typeof import('./bridge');
    guards: typeof import('./guards');
    facts: typeof import('./facts');
    describe: typeof import('./describe');
    context: typeof import('@/lib/context');
    grants: typeof import('@/lib/services/agentGrants');
    registry: typeof import('./operations/registry');
  };
  let real: Real;
  const acct: Record<string, string> = {};
  const JE = 'journal-entries.create';

  /** A journal entry the route posts for `amount`; its body names no amount (the operation has no amount field). */
  const jeBody = (amount: string, description: string) => ({
    date: '2026-03-03',
    description,
    lines: [
      { accountId: acct['6300'], debit: amount },
      { accountId: acct['1000'], credit: amount },
    ],
  });

  async function entriesNamed(description: string): Promise<number> {
    const rows = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.description, description)));
    return rows.length;
  }

  beforeAll(async () => {
    real = {
      bridge: await vi.importActual<Real['bridge']>('./bridge'),
      guards: await vi.importActual<Real['guards']>('./guards'),
      facts: await vi.importActual<Real['facts']>('./facts'),
      describe: await vi.importActual<Real['describe']>('./describe'),
      context: await vi.importActual<Real['context']>('@/lib/context'),
      grants: await vi.importActual<Real['grants']>('@/lib/services/agentGrants'),
      registry: await vi.importActual<Real['registry']>('./operations/registry'),
    };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, companyId))) acct[a.code] = a.id;
    expect(acct['6300'] && acct['1000']).toBeTruthy();
  }, 120_000);

  beforeEach(() => {
    // The real modules behind the stand-ins: bridge, guards, facts, summary, the route's own
    // context (inside the bridge's scope), live grants, and the registry's own operation.
    m.runOperation.mockImplementation(real.bridge.runOperation);
    m.guardInput.mockImplementation(real.guards.guardInput);
    m.factsOf.mockImplementation(real.facts.factsOf);
    m.describeRequest.mockImplementation(real.describe.describeRequest);
    m.getServerContext.mockImplementation(real.context.getServerContext);
    m.liveGrants.mockImplementation(real.grants.liveGrants);
    const je = real.registry.operationById(JE);
    expect(je).toBeTruthy();
    m.ops.set(JE, je!);
  });

  it('decides again on what the run really posts: a small entry runs, a large one asks two people with its real amount', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    // The body names no amount: on the body alone, it would need two people.
    const small = await operate(agentCtx, { operation: JE, body: jeBody('250.00', 'Supplies, small'), requestId: rid() });
    expect(small, JSON.stringify(small)).toMatchObject({ operation: JE, outcome: 'posted' });
    expect(small.ledger?.entries).toHaveLength(1);
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run', 'commit']);
    expect(m.createAgentRequest).not.toHaveBeenCalled();
    expect(await entriesNamed('Supplies, small')).toBe(1);

    m.runOperation.mockClear();
    const large = await operate(agentCtx, { operation: JE, body: jeBody('5000.00', 'Supplies, large'), requestId: rid(), reason: 'Year-end supplies' });
    expect(large, JSON.stringify(large)).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
    expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run']);
    const req = m.createAgentRequest.mock.calls.at(-1)![1] as Out;
    expect(req.facts.amount).toBe('5000.00');
    expect(req.preview.ledger.entries).toHaveLength(1);
    expect(typeof req.stalenessKey).toBe('string');
    expect(await entriesNamed('Supplies, large')).toBe(0);
  });

  it("an approval of a request asked without a preview tries it with the approver's rights first: more than was shown is shown, nothing done", async () => {
    usePolicy('trusted_bookkeeper');
    const input = { body: jeBody('5000.00', 'Approved without a preview') };
    const understated = await storedRequest(null, JE, { amount: '250.00' });
    const r = await runApproved(approver, { id: understated, agentId, operation: JE, input }, {}, { atHost: true });
    expect(r, JSON.stringify(r.error)).toMatchObject({ mode: 'dry_run', outcome: 'ok' });
    expect(r.facts.amount).toBe('5000.00');
    expect(r.preview?.ledger?.entries).toHaveLength(1);
    expect(typeof r.stalenessKey).toBe('string');
    expect(await entriesNamed('Approved without a preview')).toBe(0);

    // Shown as it really is: it runs, as the approver, and the audit trail says who approved it.
    const shown = await storedRequest(null, JE, { amount: '5000.00' });
    const done = await runApproved(approver, { id: shown, agentId, operation: JE, input }, {}, { atHost: true });
    expect(done, JSON.stringify(done.error)).toMatchObject({ mode: 'commit', outcome: 'ok' });
    expect(await entriesNamed('Approved without a preview')).toBe(1);
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.agentRequestId, shown)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ agentId, approvedBy: ownerId });
  });

  it('a request as the door asks it, whose period was closed since: the approval sends it back as closed-period work, amount unknown, nothing posted', async () => {
    usePolicy('trusted_bookkeeper', { twoPersonOver: '1000' });
    const asked = await operate(agentCtx, { operation: JE, body: jeBody('5000.00', 'Closed since it was asked'), requestId: rid(), reason: 'Year-end accrual' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ outcome: 'asked', needs: { twoPerson: true } });
    const req = m.createAgentRequest.mock.calls.at(-1)![1] as Out;
    expect(req.facts).toMatchObject({ amount: '5000.00', closedPeriod: false });
    expect(typeof req.stalenessKey).toBe('string');
    // Kept as the requests service keeps it: its staleness key, and the figures the person is shown.
    const id = await storedRequest(req.stalenessKey, JE, req.facts, req.needs.twoPerson);
    const [before] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await db
      .update(companies)
      .set({ settings: { ...((before?.settings as Record<string, unknown> | null) ?? {}), closingDate: '2026-06-30' } })
      .where(eq(companies.id, companyId));
    try {
      m.runOperation.mockClear();
      const r = await runApproved(approver, { id, agentId, operation: JE, input: req.input }, {}, { atHost: true });
      expect(r, JSON.stringify(r.error)).toMatchObject({ mode: 'dry_run', outcome: 'ok', stalenessKey: null, result: null, facts: { amount: null, closedPeriod: true } });
      expect(String((r.preview?.routePreview as Out).note)).toMatch(/closing-date password/);
      expect(m.runOperation.mock.calls.map((c) => c[3])).toEqual(['dry_run']);
      expect(await entriesNamed('Closed since it was asked')).toBe(0);
    } finally {
      await db.update(companies).set({ settings: before?.settings ?? null }).where(eq(companies.id, companyId));
    }
  });

  it("a run under a grant has the giver's access within the agent's role, counts one use, and is recorded under it; a giver who lost the right lends nothing", async () => {
    usePolicy('ask_every_change');
    const [g] = await db
      .insert(agentGrants)
      .values({ companyId, agentId, operation: JE, class: 'enter', constraints: {}, givenBy: ownerId, expiresAt: new Date(Date.now() + 20 * 60_000) })
      .returning();
    const a = await operate(agentCtx, { operation: JE, body: jeBody('75.00', 'Under standing permission'), requestId: rid() });
    expect(a, JSON.stringify(a)).toMatchObject({ outcome: 'posted', grantId: g.id });
    const [commit] = callsOf('commit');
    const giver = await resolveAccess(db, companyId, ownerId);
    expect(commit.actor.access).toEqual(maskedForAgent(intersectAccess(giver.access, CEILING)));
    expect(commit.actor.approval).toEqual({ approvedBy: null, requestId: null, grantId: g.id });
    expect((await db.select().from(agentGrants).where(eq(agentGrants.id, g.id)))[0].uses).toBe(1);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.agentGrantId, g.id)));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({ agentId, approvedBy: null });
    expect(await entriesNamed('Under standing permission')).toBe(1);
    await db.update(agentGrants).set({ revokedAt: new Date() }).where(eq(agentGrants.id, g.id));

    // An Admin gives one, then is made view-only: the grant no longer applies and the request is asked.
    const admin = await member('Ada Admin', 'admin');
    const [h] = await db
      .insert(agentGrants)
      .values({ companyId, agentId, operation: JE, class: 'enter', constraints: {}, givenBy: admin, expiresAt: new Date(Date.now() + 20 * 60_000) })
      .returning();
    await db.update(userCompanies).set({ role: 'viewer' }).where(and(eq(userCompanies.userId, admin), eq(userCompanies.companyId, companyId)));
    m.runOperation.mockClear();
    const b = await operate(agentCtx, { operation: JE, body: jeBody('80.00', 'After the giver lost the right'), requestId: rid(), reason: 'Office supplies' });
    expect(b, JSON.stringify(b)).toMatchObject({ outcome: 'asked' });
    expect(b.grantId).toBeUndefined();
    expect(callsOf('commit')).toHaveLength(0);
    expect((await db.select().from(agentGrants).where(eq(agentGrants.id, h.id)))[0].uses).toBe(0);
    expect(await entriesNamed('After the giver lost the right')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('POST /api/agent/actions', () => {
  async function post(body: unknown): Promise<{ status: number; json: Out }> {
    const res = await actionsPOST(
      new NextRequest('http://localhost:45123/api/agent/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    );
    return { status: res.status, json: (await res.json()) as Out };
  }

  it('sends a body with a verb to the door, and anything else to the curated actions', async () => {
    m.getServerContext.mockResolvedValue(agentCtx);
    const verb = await post({ verb: 'run_operation', operation: 'invoices.list' });
    expect(verb.status).toBe(200);
    expect(verb.json).toMatchObject({ operation: 'invoices.list', outcome: 'read' });

    const unknown = await post({ verb: 'make_me_admin' });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/There is no verb/);

    const action = await post({ action: 'no_such_action', input: {} });
    expect(action.status).toBe(400);
    expect(action.json.error).toMatch(/Unknown action/);
  });

  it('is still for agents only', async () => {
    m.getServerContext.mockResolvedValue(approver);
    const r = await post({ verb: 'get_my_permissions' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('This is for agents.');
  });

  it('answers a slowed-down agent with 429 and Retry-After, for any verb', async () => {
    m.getServerContext.mockResolvedValue(agentCtx);
    for (let i = 0; i < AGENT_CALLS_PER_MINUTE; i++) await operate(agentCtx, { operation: 'nothing.here' });
    for (const body of [{ verb: 'get_my_permissions' }, { verb: 'run_operation', operation: 'invoices.list' }]) {
      const res = await actionsPOST(
        new NextRequest('http://localhost:45123/api/agent/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      );
      expect(res.status).toBe(429);
      const wait = Number(res.headers.get('retry-after'));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const json = (await res.json()) as Out;
      expect(json).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: wait } });
      expect(json.error).toMatch(/more than 120 requests in the last minute.*Wait about/);
    }
    expect(m.runOperation).not.toHaveBeenCalled();
    // Other errors are answered as before.
    resetAgentRateLimits();
    const unknown = await post({ verb: 'make_me_admin' });
    expect(unknown.status).toBe(400);
  });
});
