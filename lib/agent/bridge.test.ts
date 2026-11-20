/**
 * Agent full access: the route bridge (lib/agent/bridge.ts) on a real PGlite company, through the
 * app's own route handlers, with the real input guards, facts, staged files and grants.
 *
 * What is proved:
 *  - A dry run of POST /api/estimates (and a purchase order, a time entry) answers a preview and
 *    leaves every table exactly as it was; a commit creates it, and its audit row names the agent
 *    (plan Phase 0 exit).
 *  - A 409 warning with a confirmation flag becomes needs_confirmation; the resend with the flag
 *    runs.
 *  - A read runs on the read-only handle, so a GET that would write fails; so does a read-class
 *    operation asked for as a commit.
 *  - A failing handler commits nothing and releases no email; a successful one sends it only after
 *    the commit; a dry run only shows it.
 *  - No header outside SERVICE_SCOPE_HEADERS reaches the handler, whatever the input carries.
 *  - Secrets are applied only on a commit, from actor.secrets; a secret the agent put in the body
 *    never reaches the handler; wrong closing-date passwords are rate-limited like a person's.
 *  - The handler's context is built from the actor, never from base.access.
 *  - The staleness key: two runs over the same books agree; a price the run reads or a record the
 *    input names, changed in between, gives another key.
 *  - Refusals before running, an edited copy of an operation, the gates a scope skips, time limits
 *    (reports longer), preview limits, staged files in and out, allowed folders (a folder still to
 *    be made included), grants, produced secrets, a dry run stopped at a call to another computer
 *    and the amount from the ledger.
 *
 * Only the time limits, the route handler and the request the bridge runs in (next/headers) are
 * replaced, and a test can register an edited copy of an operation (the one seam the registry has
 * here). Everything else is the app's own code; stageFile and useGrant are only watched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  handler: null as Handler | null,
  /** Edited copies of operations the registry hands out for their id while a test runs. */
  edited: new Map<string, unknown>(),
  limitMs: 10_000,
  reportLimitMs: 30_000,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

// The time limits, short for the tests that run past them.
vi.mock('./contract', async (orig) => {
  const real = await orig<typeof import('./contract')>();
  return {
    ...real,
    get BRIDGE_TIME_LIMIT_MS() {
      return h.limitMs;
    },
    get BRIDGE_REPORT_TIME_LIMIT_MS() {
      return h.reportLimitMs;
    },
  };
});

// The real modules, watched.
vi.mock('./files', async (orig) => {
  const real = await orig<typeof import('./files')>();
  return { ...real, stageFile: vi.fn(real.stageFile) };
});
vi.mock('@/lib/services/agentGrants', async (orig) => {
  const real = await orig<typeof import('@/lib/services/agentGrants')>();
  return { ...real, useGrant: vi.fn(real.useGrant) };
});

// One test handler at a time stands in for a route's own (after the registry checked the
// operation); an edited copy registered in h.edited is what the registry hands out for its id.
vi.mock('./operations/registry', async (orig) => {
  const real = await orig<typeof import('./operations/registry')>();
  type Op = NonNullable<ReturnType<typeof real.operationById>>;
  return {
    ...real,
    operationById: (id: string) => (h.edited.get(id) as Op | undefined) ?? real.operationById(id),
    operationForPath: (method: string, pathname: string) => {
      const found = real.operationForPath(method, pathname);
      const copy = found ? (h.edited.get(found.operation.id) as Op | undefined) : undefined;
      return found && copy ? { ...found, operation: copy } : found;
    },
    loadRouteHandler: async (op: Parameters<typeof real.loadRouteHandler>[0]) => {
      const fake = h.handler;
      const loaded = await real.loadRouteHandler(op);
      if (!fake) return loaded;
      h.handler = null;
      return fake;
    },
  };
});

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-bridge');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-bridge-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
process.env.BKA_AGENT_FILES_DIR = path.join(ROOT, 'agent-files');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.BKA_COMPANY_STATE;

import { getDb, closeDb, type DB } from '@/lib/db';
import { READ_ONLY_MESSAGE, isReadOnlyDb, readOnlyDb } from '@/lib/db/readOnly';
import { agentGrants, agents, auditLogs, companies, customers, estimates, items, purchaseOrders, singleUserMode, timeEntries, userSessions } from '@/lib/db/schema';
import { SERVICE_ORIGIN_HEADER, SERVICE_SCOPE_HEADERS, getServerContext, requestHeaders } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import { effects } from '@/lib/effects';
import { hashPassword } from '@/lib/auth';
import { attemptKeys, loginLimiter } from '@/lib/net/rateLimit';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { routeError } from '@/lib/routeErrors';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { agentAccess, createAgent } from '@/lib/services/agents';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import { writeAudit, type ServiceContext } from '@/lib/services/_base';
import { useGrant } from '@/lib/services/agentGrants';
import { allOperations, operationForRoute } from './operations/registry';
import type { Operation } from './operations/types';
import { PREVIEW_ROW_LIMIT, type BridgeActor, type OperationInput } from './contract';
import { PRODUCED_SECRET_TEXT } from './guards';
import { stageFile } from './files';
import { runOperation } from './bridge';

type Out = Record<string, any>;
let db: DB;
let rich: RichCompany;
let admin: ServiceContext;
let agentId: string;
let bookkeeping: EffectiveAccess;
let reportsOnly: EffectiveAccess;
/** The agent's own context, as lib/agentContext.ts builds it: read-only. */
let agentBase: ServiceContext;
const outbox = path.join(os.tmpdir(), `ironbooks-bridge-${process.pid}`);

/** The registry's own operation (never an edited copy). */
function op(id: string): Operation {
  const o = allOperations().find((x) => x.id === id);
  if (!o) throw new Error(`No operation ${id}`);
  return o;
}

/** An edited copy of an operation, registered for this test (the registry seam above). */
function edited(id: string, over: Partial<Operation>): Operation {
  const copy = { ...op(id), ...over } as Operation;
  h.edited.set(id, copy);
  return copy;
}

function actorFor(over: Partial<BridgeActor> = {}): BridgeActor {
  return {
    agent: { id: agentId, name: 'Bridge Agent', preset: 'trusted_bookkeeper', onBehalfOf: rich.ctx.userId },
    access: bookkeeping,
    role: 'accountant',
    userId: null,
    approval: { approvedBy: null, requestId: null, grantId: null },
    reveal: false,
    secrets: {},
    folders: [],
    atHost: true,
    ...over,
  };
}

const run = (operation: Operation, input: OperationInput, mode: 'read' | 'dry_run' | 'commit', over: Partial<BridgeActor> = {}, base?: ServiceContext) =>
  runOperation(base ?? agentBase, operation, input, mode, actorFor(over));

/** Row counts of every table, the ledger total, and the transaction log length. */
async function fingerprint() {
  const tables = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const r = (await db.execute(sql.raw(`select count(*)::int as n from "${table_name}"`))) as unknown as { rows: Array<{ n: number }> };
    counts[table_name] = r.rows[0].n;
  }
  const ledger = (await db.execute(sql`select coalesce(sum(debit),0)::text as d, count(*)::int as n from journal_entry_lines`)) as unknown as { rows: Array<Out> };
  return { counts, ledger: ledger.rows[0], log: readAllTransactionLog(TEST_DIR).records.length };
}

const estimateBody = (ref: string | null = null) => ({
  customerId: rich.customerId,
  date: '2026-03-02',
  refNumber: ref,
  lines: [{ description: 'Consulting', quantity: '2', rate: '150.00' }],
});
const poBody = () => ({
  vendorId: rich.vendorId,
  date: '2026-03-02',
  lines: [{ accountId: rich.acct['6300'], description: 'Paper', quantity: '3', rate: '20.00' }],
});
const timeBody = () => ({ customerId: rich.customerId, date: '2026-03-02', hours: '2.5', description: 'Setting up the books', billable: true });
const journalBody = () => ({
  date: '2026-03-03',
  description: 'Supplies bought with cash',
  lines: [
    { accountId: rich.acct['6300'], debit: '250.00' },
    { accountId: rich.acct['1000'], credit: '250.00' },
  ],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(outbox, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  rich = await seedRichCompany(db, TEST_DIR, 'Bridge Co');
  admin = { ...rich.ctx, role: 'owner', access: fullAccess() };
  const made = await createAgent(admin, { name: 'Bridge Agent', roleKeys: ['full_access'], preset: 'trusted_bookkeeper' });
  agentId = made.agent.id;
  bookkeeping = await agentAccess(db, { companyId: rich.ctx.companyId, roleKeys: ['full_access'] });
  reportsOnly = await agentAccess(db, { companyId: rich.ctx.companyId, roleKeys: ['reports_only'] });
  agentBase = {
    db: readOnlyDb(db),
    companyId: rich.ctx.companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access: bookkeeping,
    agent: { id: agentId, name: 'Bridge Agent', mode: 'post', onBehalfOf: rich.ctx.userId },
    readOnly: true,
  };
}, 240_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(outbox, { recursive: true, force: true });
});

beforeEach(() => {
  h.handler = null;
  h.limitMs = 10_000;
  h.reportLimitMs = 30_000;
  h.edited.clear();
  h.headers.clear();
  h.cookies.clear();
  vi.mocked(useGrant).mockClear();
});

describe('Phase 0 exit: an estimate, a purchase order and a time entry', () => {
  it('a dry run of POST /api/estimates previews it and leaves every table as it was', async () => {
    const before = await fingerprint();
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.outcome).toBe('ok');
    expect(r.httpStatus).toBe(201);
    expect((r.result as Out).total ?? (r.result as Out).estimate?.total).toBeTruthy();
    expect(r.preview).not.toBeNull();
    expect(r.preview!.ledger).not.toBeNull();
    const created = r.preview!.records.find((x) => x.kind === 'estimate' && x.action === 'create');
    expect(created, JSON.stringify(r.preview!.records)).toBeTruthy();
    expect(created!.fields.length).toBeGreaterThan(0);
    expect(r.preview!.effects).toEqual([]);
    expect(r.preview!.truncated).toBe(false);
    expect(r.stalenessKey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.produced).toEqual([]);
    expect(r.file).toBeNull();
    // The real facts: the estimate's total from the answer.
    expect(r.facts.amount).toBe('300.00');
    expect(await fingerprint()).toEqual(before);
  });

  it('a commit creates the estimate, and its audit row carries the agent and the approval', async () => {
    const approvedBy = rich.ctx.userId!;
    const requestId = randomUUID();
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', {
      userId: approvedBy,
      approval: { approvedBy, requestId, grantId: null },
    });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.outcome).toBe('ok');
    expect(r.httpStatus).toBe(201);
    const id = ((r.result as Out).id ?? (r.result as Out).estimate?.id) as string;
    const [row] = await db.select().from(estimates).where(eq(estimates.id, id));
    expect(row).toBeTruthy();
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.entityType, 'estimate')));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].agentId).toBe(agentId);
    expect(audit[0].approvedBy).toBe(approvedBy);
    expect(audit[0].agentRequestId).toBe(requestId);
    expect(r.preview!.records.some((x) => x.id === id)).toBe(true);
    expect(r.effects).toEqual([]);
  });

  it('a purchase order: the dry run keeps nothing, the commit keeps it', async () => {
    const before = await fingerprint();
    const dry = await run(op('purchase-orders.create'), { body: poBody() }, 'dry_run');
    expect(dry.error, JSON.stringify(dry.error)).toBeNull();
    expect(dry.preview!.records.some((x) => x.action === 'create')).toBe(true);
    expect(await fingerprint()).toEqual(before);

    const done = await run(op('purchase-orders.create'), { body: poBody() }, 'commit');
    expect(done.error, JSON.stringify(done.error)).toBeNull();
    const id = ((done.result as Out).id ?? (done.result as Out).purchaseOrder?.id) as string;
    expect((await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id))).length).toBe(1);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(audit.agentId).toBe(agentId);
  });

  it('a time entry: the dry run keeps nothing, the commit keeps it', async () => {
    const before = await fingerprint();
    const dry = await run(op('time-entries.create'), { body: timeBody() }, 'dry_run');
    expect(dry.error, JSON.stringify(dry.error)).toBeNull();
    expect(await fingerprint()).toEqual(before);

    const done = await run(op('time-entries.create'), { body: timeBody() }, 'commit');
    expect(done.error, JSON.stringify(done.error)).toBeNull();
    const id = (done.result as Out).id as string;
    expect((await db.select().from(timeEntries).where(eq(timeEntries.id, id))).length).toBe(1);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(audit.agentId).toBe(agentId);
  });

  it('a journal entry with no amountField still has its true amount: the largest entry it posts', async () => {
    const dry = await run(op('journal-entries.create'), { body: journalBody() }, 'dry_run');
    expect(dry.error, JSON.stringify(dry.error)).toBeNull();
    expect(dry.preview!.ledger!.entries.length).toBe(1);
    expect(dry.facts.amount).toBe('250.00');
  });
});

describe('the staleness key', () => {
  const consulting = async () => {
    const [item] = await db
      .select({ id: items.id, price: items.salesPrice, editedAt: items.editedAt })
      .from(items)
      .where(and(eq(items.companyId, rich.ctx.companyId), eq(items.name, 'Consulting')));
    return item;
  };
  /** An item line with no rate: the app works out the price from the item. */
  const invoiceBody = (itemId: string) => ({ customerId: rich.customerId, date: '2026-03-02', lines: [{ itemId, quantity: '2' }] });

  it('two dry runs over the same books agree, for every kind of record', async () => {
    const item = await consulting();
    const cases: Array<[string, unknown]> = [
      ['estimates.create', estimateBody()],
      ['purchase-orders.create', poBody()],
      ['time-entries.create', timeBody()],
      ['journal-entries.create', journalBody()],
      ['invoices.create', invoiceBody(item.id)],
    ];
    for (const [id, body] of cases) {
      const a = await run(op(id), { body }, 'dry_run');
      const b = await run(op(id), { body }, 'dry_run');
      expect(a.error, `${id}: ${JSON.stringify(a.error)}`).toBeNull();
      expect(a.stalenessKey, id).toMatch(/^[0-9a-f]{64}$/);
      expect(b.stalenessKey, id).toBe(a.stalenessKey);
    }
  });

  it('a price the run reads, changed in between, gives another key and the new amount', async () => {
    const item = await consulting();
    const before = await run(op('invoices.create'), { body: invoiceBody(item.id) }, 'dry_run');
    expect(before.error, JSON.stringify(before.error)).toBeNull();
    await db.update(items).set({ salesPrice: '9999.00' }).where(eq(items.id, item.id));
    try {
      const after = await run(op('invoices.create'), { body: invoiceBody(item.id) }, 'dry_run');
      expect(after.error, JSON.stringify(after.error)).toBeNull();
      expect(after.stalenessKey).not.toBe(before.stalenessKey);
      expect(Number(after.facts.amount)).toBeGreaterThan(Number(before.facts.amount));
    } finally {
      await db.update(items).set({ salesPrice: item.price }).where(eq(items.id, item.id));
    }
    // Put back, the item was still edited twice (its version moved): the key stays another one,
    // and agrees with itself.
    expect((await consulting()).editedAt.getTime()).not.toBe(item.editedAt.getTime());
    const again = await run(op('invoices.create'), { body: invoiceBody(item.id) }, 'dry_run');
    const once = await run(op('invoices.create'), { body: invoiceBody(item.id) }, 'dry_run');
    expect(again.stalenessKey).not.toBe(before.stalenessKey);
    expect(once.stalenessKey).toBe(again.stalenessKey);
  });

  it('a record the input names, changed in between, gives another key', async () => {
    const before = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    await db.execute(sql`update customers set updated_at = updated_at + interval '1 second' where id = ${rich.customerId}`);
    const after = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(after.error, JSON.stringify(after.error)).toBeNull();
    expect(after.stalenessKey).not.toBe(before.stalenessKey);
    const [c] = await db.select({ updatedAt: customers.updatedAt }).from(customers).where(eq(customers.id, rich.customerId));
    expect(c.updatedAt).toBeTruthy();
  });
});

describe('warnings that need a yes', () => {
  it('a duplicate estimate number answers needs_confirmation; the resend with the flag runs', async () => {
    const ref = `B-${Date.now()}`;
    const first = await run(op('estimates.create'), { body: estimateBody(ref) }, 'commit');
    expect(first.outcome, JSON.stringify(first.error)).toBe('ok');

    const before = await fingerprint();
    const again = await run(op('estimates.create'), { body: estimateBody(ref) }, 'commit');
    expect(again.outcome).toBe('needs_confirmation');
    expect(again.httpStatus).toBe(409);
    expect(again.warnings).toHaveLength(1);
    expect(again.warnings[0].flag).toBe('allowDuplicateNumber');
    expect(again.warnings[0].message).toMatch(/already used/i);
    expect(again.error).toBeNull();
    expect(await fingerprint()).toEqual(before);

    const dry = await run(op('estimates.create'), { body: estimateBody(ref), confirm: ['allowDuplicateNumber'] }, 'dry_run');
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    const yes = await run(op('estimates.create'), { body: estimateBody(ref), confirm: ['allowDuplicateNumber'] }, 'commit');
    expect(yes.outcome, JSON.stringify(yes.error)).toBe('ok');
    expect(yes.httpStatus).toBe(201);
  });

  it('a flag already sent that the route still refuses, and a 409 naming no flag, are errors', async () => {
    const answer409 = (body: Out) => async () => NextResponse.json(body, { status: 409 });
    h.handler = answer409({
      error: 'Number 7 is already used.',
      code: 'CONFLICT',
      fixes: [{ id: 'keep', kind: 'retry', label: 'Keep it', patch: [{ op: 'set', path: 'allowDuplicateNumber', value: true }] }],
    });
    const looped = await run(op('estimates.create'), { body: estimateBody(), confirm: ['allowDuplicateNumber'] }, 'commit');
    expect(looped.outcome).toBe('error');
    expect(looped.error!.message).toBe('Number 7 is already used.');

    h.handler = answer409({ error: 'Someone else changed this estimate. Open it again.', code: 'CONFLICT' });
    const plain = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(plain.outcome).toBe('error');
    expect(plain.warnings).toEqual([]);
    expect(plain.error!.code).toBe('CONFLICT');
  });
});

describe('reads', () => {
  const writer = (seen: Out) => async () => {
    try {
      const ctx = await getServerContext();
      seen.readOnly = ctx.readOnly;
      seen.handle = isReadOnlyDb(ctx.db);
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      return NextResponse.json({ wrote: true });
    } catch (err) {
      return routeError(err, 'bridge-test');
    }
  };

  it('a read runs on the read-only handle and answers the list', async () => {
    const r = await run(op('estimates.list'), {}, 'read');
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.outcome).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.preview).toBeNull();
    expect(r.result).toBeTruthy();
  });

  it('a GET that would write fails on the read-only handle', async () => {
    const seen: Out = {};
    h.handler = writer(seen);
    const before = await fingerprint();
    const r = await run(op('estimates.list'), {}, 'read', { role: 'accountant' });
    expect(seen.readOnly).toBe(true);
    expect(seen.handle).toBe(true);
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(403);
    expect(r.error!.message).toBe(READ_ONLY_MESSAGE);
    expect(await fingerprint()).toEqual(before);
  });

  it('a read-class operation asked for as a commit or a dry run still only reads', async () => {
    for (const mode of ['commit', 'dry_run'] as const) {
      const seen: Out = {};
      h.handler = writer(seen);
      const before = await fingerprint();
      const r = await run(op('estimates.list'), {}, mode);
      expect(seen, mode).toEqual({ readOnly: true, handle: true });
      expect(r.mode).toBe(mode);
      expect(r.outcome).toBe('error');
      expect(r.httpStatus).toBe(403);
      expect(r.effects).toEqual([]);
      expect(await fingerprint()).toEqual(before);
    }
  });

  it('a file answer is staged with the name its Content-Disposition gives', async () => {
    h.handler = async () =>
      new Response(new Uint8Array([37, 80, 68, 70, 45]), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="Estimate 1001.pdf"' },
      });
    const r = await run(op('estimates.pdf'), { params: { id: randomUUID() } }, 'read');
    expect(r.outcome).toBe('ok');
    expect(r.result).toBeNull();
    expect(r.file).toMatchObject({ name: 'Estimate 1001.pdf', type: 'application/pdf', size: 5 });
    expect(vi.mocked(stageFile)).toHaveBeenLastCalledWith({ companyId: rich.ctx.companyId, agentId }, expect.objectContaining({ name: 'Estimate 1001.pdf' }));
  });
});

describe('effects and failures', () => {
  const sender = vi.fn(async () => ({ messageId: 'x' }));
  const allowed = path.join(outbox, 'allowed');
  const probe = (status: number) => async () => {
    const ctx = await getServerContext();
    await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID(), newValues: { note: 'probe' } });
    await effects.email({ to: 'ap@acme.test', subject: 'Estimate 1001' }, sender);
    return status < 400
      ? NextResponse.json({ ok: true }, { status })
      : NextResponse.json({ error: 'That did not work. Check the lines and try again.', code: 'VALIDATION' }, { status });
  };

  beforeEach(() => {
    sender.mockClear();
    fs.mkdirSync(allowed, { recursive: true });
  });

  it('a failing handler commits nothing and releases no effect', async () => {
    const before = await fingerprint();
    h.handler = probe(400);
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatchObject({ message: 'That did not work. Check the lines and try again.', code: 'VALIDATION' });
    expect(r.effects).toEqual([]);
    expect(sender).not.toHaveBeenCalled();
    expect(await fingerprint()).toEqual(before);
  });

  it('a dry run shows the email and sends nothing; a commit sends it after the commit', async () => {
    h.handler = probe(201);
    const dry = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(dry.outcome).toBe('ok');
    expect(dry.preview!.effects).toHaveLength(1);
    expect(dry.preview!.effects[0]).toMatchObject({ kind: 'email' });
    expect(dry.preview!.records.find((x) => x.kind === 'bridge_probe')!.fields).toEqual([{ field: 'note', before: null, after: 'probe' }]);
    expect(sender).not.toHaveBeenCalled();

    h.handler = probe(201);
    const done = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(done.outcome).toBe('ok');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(done.effects).toEqual([expect.objectContaining({ status: 'sent', ranDuringOperation: false })]);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityType, 'bridge_probe'));
    expect(audit.agentId).toBe(agentId);
  });

  it('a file saved outside the agent\'s folders fails the run; inside, even in a folder still to be made, it is saved after the commit', async () => {
    const elsewhere = path.join(outbox, 'elsewhere');
    const later = path.join(allowed, 'reports', '2026');
    const saver = (dir: string) => async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      await effects.writeFile({ dir, name: 'report.txt', bytes: 'hello' });
      return NextResponse.json({ ok: true });
    };
    const before = await fingerprint();
    h.handler = saver(elsewhere);
    const refused = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(refused.outcome).toBe('error');
    expect(refused.error!.code).toBe('FOLDER_NOT_ALLOWED');
    expect(fs.existsSync(path.join(elsewhere, 'report.txt'))).toBe(false);
    expect(await fingerprint()).toEqual(before);

    // ".." cannot climb out either.
    h.handler = saver(`${allowed}${path.sep}..${path.sep}elsewhere`);
    const climbed = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(climbed.error!.code).toBe('FOLDER_NOT_ALLOWED');

    expect(fs.existsSync(later)).toBe(false);
    h.handler = saver(later);
    const saved = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(saved.outcome, JSON.stringify(saved.error)).toBe('ok');
    expect(saved.effects).toEqual([expect.objectContaining({ status: 'sent' })]);
    expect(fs.readFileSync(path.join(later, 'report.txt'), 'utf8')).toBe('hello');
  });

  it('work that runs past the time limit answers so, and rolls back when it ends', async () => {
    h.limitMs = 300;
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      await effects.email({ to: 'ap@acme.test', subject: 'Late' }, sender);
      await sleep(900);
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const before = await fingerprint();
    const started = Date.now();
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(Date.now() - started).toBeLessThan(800);
    expect(r.outcome).toBe('error');
    expect(r.error!.code).toBe('TIMEOUT');
    expect(r.error!.message).toMatch(/took longer than/);
    await sleep(1200);
    expect(sender).not.toHaveBeenCalled();
    expect(await fingerprint()).toEqual(before);
  });

  it('a report has the longer time limit; anything else the shorter one', async () => {
    const report = op('reports.ap-aging');
    const slow = (ms: number) => async () => {
      await sleep(ms);
      return NextResponse.json({ rows: [] });
    };
    h.limitMs = 200;
    h.reportLimitMs = 5_000;
    h.handler = slow(500);
    const inTime = await run(report, {}, 'read');
    expect(inTime.outcome, JSON.stringify(inTime.error)).toBe('ok');

    h.handler = slow(500);
    const list = await run(op('estimates.list'), {}, 'read');
    expect(list.error!.code).toBe('TIMEOUT');

    h.reportLimitMs = 200;
    h.handler = slow(500);
    const late = await run(report, {}, 'read');
    expect(late.error!.code).toBe('TIMEOUT');
    await sleep(500);
  });

  it('a preview keeps at most PREVIEW_ROW_LIMIT fields of a record and effects, and says it left some out', async () => {
    h.handler = async () => {
      const ctx = await getServerContext();
      const many = Object.fromEntries(Array.from({ length: PREVIEW_ROW_LIMIT + 5 }, (_, i) => [`f${i}`, i]));
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID(), newValues: many });
      for (let i = 0; i <= PREVIEW_ROW_LIMIT; i++) await effects.email({ to: 'ap@acme.test', subject: `Note ${i}` }, sender);
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.truncated).toBe(true);
    expect(r.preview!.records.find((x) => x.kind === 'bridge_probe')!.fields).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(r.preview!.effects).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(sender).not.toHaveBeenCalled();
  });

  it('a success answer that cannot be read keeps nothing (the agent must never retry saved work)', async () => {
    const before = await fingerprint();
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      return new Response('{"half": ', { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(r.outcome).toBe('error');
    expect(r.error!.message).toMatch(/Nothing was saved/);
    expect(await fingerprint()).toEqual(before);
  });

  it('a handler that throws instead of answering is an error, and keeps nothing', async () => {
    const before = await fingerprint();
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      throw new Error('boom');
    };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit');
    expect(r.outcome).toBe('error');
    expect(r.error!.code).toBe('INTERNAL');
    expect(r.error!.message).not.toContain('boom');
    expect(await fingerprint()).toEqual(before);
  });

  it('a dry run that reaches a call to another computer stops there and says so; any other answer stands', async () => {
    h.handler = async () => {
      try {
        await effects.network({ host: 'api.example.test', purpose: 'reading the statement' }, async () => 1);
        return NextResponse.json({ ok: true });
      } catch (err) {
        return routeError(err, 'bridge-test');
      }
    };
    const stopped = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(stopped.outcome).toBe('ok');
    expect(stopped.error).toBeNull();
    expect(stopped.preview!.ledger).toBeNull();
    expect(stopped.preview!.routePreview).toEqual({ ran: false, note: expect.stringMatching(/api\.example\.test/) });
    expect(stopped.preview!.effects).toEqual([expect.objectContaining({ kind: 'network' })]);

    // A route that caught the stop and answered something else: that answer is the error.
    h.handler = async () => {
      try {
        await effects.network({ host: 'api.example.test', purpose: 'reading the statement' }, async () => 1);
      } catch {
        /* carried on another way */
      }
      return NextResponse.json({ error: 'This customer is inactive. Make it active first.', code: 'VALIDATION' }, { status: 400 });
    };
    const other = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(other.outcome).toBe('error');
    expect(other.error!.message).toMatch(/inactive/);
  });

  it('an operation that cannot be rolled back is described in a dry run, not run', async () => {
    const before = await fingerprint();
    h.handler = async () => {
      throw new Error('must not run');
    };
    const described = edited('estimates.create', { dryRun: 'none', effects: ['email'] });
    const r = await run(described, { body: estimateBody() }, 'dry_run');
    h.handler = null;
    expect(r.outcome).toBe('ok');
    expect(r.httpStatus).toBe(0);
    expect(r.result).toBeNull();
    expect(r.preview!.ledger).toBeNull();
    expect(r.preview!.effects).toEqual([expect.objectContaining({ kind: 'email' })]);
    expect((r.preview!.routePreview as Out).ran).toBe(false);
    expect(await fingerprint()).toEqual(before);
  });

  it('a commit of such an operation runs without a wrapping transaction, inside the scope and the outbox', async () => {
    h.handler = probe(201);
    const r = await run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'commit');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(r.effects).toEqual([expect.objectContaining({ status: 'sent' })]);
  });

  it('such a commit saving outside the folders keeps its work, sends nothing, and reports the call that ran', async () => {
    const id = randomUUID();
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: id });
      await effects.network({ host: 'api.example.test', purpose: 'checking the address' }, async () => 'ok');
      await effects.email({ to: 'ap@acme.test', subject: 'Estimate' }, sender);
      await effects.writeFile({ dir: path.join(outbox, 'elsewhere-2'), name: 'x.txt', bytes: 'x' });
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(201);
    expect(r.error!.code).toBe('FOLDER_NOT_ALLOWED');
    expect(r.error!.message).toMatch(/none of the emails, files or print jobs/);
    expect(sender).not.toHaveBeenCalled();
    expect(r.effects).toEqual([expect.objectContaining({ status: 'sent', ranDuringOperation: true })]);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).length).toBe(1);
  });
});

describe('what the handler sees', () => {
  it('no header outside SERVICE_SCOPE_HEADERS, whatever the input or the request the bridge runs in carries', async () => {
    // The request the bridge runs in: a person's, with their cookie.
    h.headers.set('cookie', 'bka_session=a-person');
    h.headers.set('authorization', 'Bearer someone');
    h.headers.set('x-bka-launch', 'launch-pass');
    h.headers.set('host', 'localhost:3000');
    const seen: Out = {};
    h.handler = async (req) => {
      seen.request = [...req.headers.keys()];
      seen.scope = [...(await requestHeaders()).keys()];
      seen.url = req.url;
      return NextResponse.json({ ok: true });
    };
    const input = {
      query: { status: 'open' },
      headers: { cookie: 'agent-cookie', authorization: 'Bearer agent', 'x-bka-launch': 'stolen', 'x-closing-password': 'agent-typed' },
    } as unknown as OperationInput;
    const r = await run(op('estimates.list'), input, 'read');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    const stamps = [ROUTE_PATH_HEADER, ROUTE_METHOD_HEADER, SERVICE_ORIGIN_HEADER];
    for (const name of seen.request as string[]) expect(SERVICE_SCOPE_HEADERS).toContain(name);
    for (const name of seen.scope as string[]) expect([...SERVICE_SCOPE_HEADERS, ...stamps]).toContain(name);
    for (const name of ['cookie', 'authorization', 'x-bka-launch', 'host', 'x-closing-password']) {
      expect(seen.request).not.toContain(name);
      expect(seen.scope).not.toContain(name);
    }
    // NextRequest names a loopback address "localhost"; the path and query are the agent's.
    const url = new URL(seen.url as string);
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(`${url.pathname}${url.search}`).toBe('/api/estimates?status=open');
  });

  it('the context is built from the actor, never from base.access', async () => {
    const seen: Out = {};
    h.handler = async () => {
      const ctx = await getServerContext();
      Object.assign(seen, { ...ctx, db: undefined });
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const personBase: ServiceContext = { ...admin, sessionId: randomUUID(), closingDateOverride: true };
    const approval = { approvedBy: null, requestId: randomUUID(), grantId: null };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run', { approval }, personBase);
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(seen.access.isAdmin).toBe(bookkeeping.isAdmin);
    expect(seen.access.permissions).toEqual(bookkeeping.permissions);
    expect(seen.access.flags.sensitivePayroll).toBe(false);
    expect(seen.access.flags.fullAccountNumbers).toBe(false);
    expect(seen.userId).toBeNull();
    expect(seen.sessionId).toBeUndefined();
    expect(seen.closingDateOverride).toBe(false);
    expect(seen.role).toBe('accountant');
    expect(seen.companyId).toBe(rich.ctx.companyId);
    expect(seen.agent).toEqual({ id: agentId, name: 'Bridge Agent', mode: 'post', preset: 'trusted_bookkeeper', onBehalfOf: rich.ctx.userId });
    expect(seen.approval).toEqual(approval);
    expect(seen.readOnly).toBeUndefined();
  });

  it('an actor whose role cannot enter estimates is refused, though base has full access', async () => {
    const before = await fingerprint();
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { access: reportsOnly, role: 'viewer' }, admin);
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(0);
    expect(r.error!.code).toBe('FORBIDDEN');
    expect(await fingerprint()).toEqual(before);
  });

  it('full SSNs and account numbers only for an approved reveal of that kind', async () => {
    const revealing = allOperations().find((o) => o.kind === 'route' && o.reveal === 'account_numbers' && o.availability === 'agent' && o.method === 'GET');
    expect(revealing).toBeTruthy();
    const params = Object.fromEntries(revealing!.params.map((p) => [p, randomUUID()]));
    const flagsSeen: Array<Record<string, boolean>> = [];
    const spy = async () => {
      flagsSeen.push({ ...(await getServerContext()).access!.flags });
      return NextResponse.json({ ok: true });
    };
    const everything = fullAccess();
    h.handler = spy;
    await run(revealing!, { params }, 'read', { access: everything, role: 'admin', reveal: false });
    h.handler = spy;
    await run(revealing!, { params, reveal: true }, 'read', { access: everything, role: 'admin', reveal: true });
    expect(flagsSeen[0]).toMatchObject({ sensitivePayroll: false, fullAccountNumbers: false });
    expect(flagsSeen[1]).toMatchObject({ sensitivePayroll: false, fullAccountNumbers: true });
  });

  it('produced secrets go to produced, never into the result', async () => {
    const token = 'tok-4821-abcdef-0123';
    h.handler = async () => NextResponse.json({ id: 'link-1', token, url: `https://phone.test/r/${token}` }, { status: 201 });
    const r = await run(op('receipts.upload-links.create'), { body: {} }, 'commit', { access: fullAccess(), role: 'admin' });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.produced).toEqual([expect.objectContaining({ kind: 'capability_link', value: token })]);
    expect((r.result as Out).token).toBe(PRODUCED_SECRET_TEXT);
    expect(JSON.stringify(r.result)).not.toContain(token);
  });
});

describe('secrets come only from the approving person, on a commit', () => {
  const closing = () => op('company.closing-date.update');
  const everything = { access: fullAccess(), role: 'admin' as const };
  const seen: Out[] = [];
  const spy = async (req: Request) => {
    const ctx = await getServerContext();
    seen.push({
      request: req.headers.get('x-closing-password'),
      scope: (await requestHeaders()).get('x-closing-password'),
      override: ctx.closingDateOverride,
      body: await req.json(),
    });
    return NextResponse.json({ ok: true });
  };
  /** What the agent sends: a closing date, and passwords of its own that must never reach the route. */
  const agentBody = { closingDate: '2025-12-31', currentPassword: 'agent-typed', password: 'agent-new' };
  beforeEach(() => {
    seen.length = 0;
  });

  it('never in a dry run, even when the actor holds the secret; the agent\'s own are taken out', async () => {
    h.handler = spy;
    const r = await run(closing(), { body: agentBody }, 'dry_run', { ...everything, secrets: { closing_password: 'pw-1' } });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(seen).toEqual([{ request: null, scope: null, override: false, body: { closingDate: '2025-12-31' } }]);
  });

  it('a commit without the secret is refused before anything runs', async () => {
    h.handler = spy;
    const r = await run(closing(), { body: agentBody }, 'commit', everything);
    h.handler = null;
    expect(r.outcome).toBe('error');
    expect(r.error!.code).toBe('SECRET_NEEDED');
    expect(r.error!.details).toEqual({ secrets: ['closing_password'] });
    expect(seen).toEqual([]);
  });

  it('a commit with it: the header, the body field the route reads, and the verified override', async () => {
    h.handler = spy;
    const r = await run(closing(), { body: agentBody }, 'commit', { ...everything, secrets: { closing_password: 'pw-1' } });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(seen).toEqual([{ request: 'pw-1', scope: 'pw-1', override: true, body: { closingDate: '2025-12-31', currentPassword: 'pw-1' } }]);
    expect(JSON.stringify(r)).not.toContain('agent-typed');
  });

  it('a secret the scope cannot carry (a header outside the list) refuses the run', async () => {
    h.handler = spy;
    const staged = await stageFile({ companyId: rich.ctx.companyId, agentId }, { name: 'copy.ibk', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) });
    const r = await run(op('portable.restore'), { body: { fileId: staged.fileId } }, 'commit', { ...everything, secrets: { backup_password: 'b-secret-1' } });
    h.handler = null;
    expect(r.outcome).toBe('error');
    expect(r.error!.code).toBe('SECRET_NOT_CARRIED');
    expect(seen).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('b-secret-1');
  });

  it('wrong closing-date passwords are counted by the person\'s own limiter, and a locked one refuses before anything runs', async () => {
    const owner = rich.ctx.userId!;
    const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, rich.ctx.companyId));
    const original = company.settings;
    const resetLimiter = () => {
      (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    };
    resetLimiter();
    await db
      .update(companies)
      .set({ settings: { ...((original ?? {}) as Record<string, unknown>), closingDatePasswordHash: await hashPassword('right-pw-1') } })
      .where(eq(companies.id, rich.ctx.companyId));
    try {
      const guess = (pw: string) => {
        h.handler = spy;
        return run(closing(), { body: { closingDate: '2025-12-31' } }, 'commit', { ...everything, userId: owner, secrets: { closing_password: pw } });
      };
      let refusedAt = -1;
      for (let i = 0; i < 10 && refusedAt < 0; i++) {
        const r = await guess(`wrong-${i}`);
        if (r.outcome === 'error') {
          refusedAt = i;
          expect(r.error!.code).toBe('FORBIDDEN');
          expect(r.error!.message).toMatch(/Too many wrong closing-date passwords/);
          expect(r.error!.details).toMatchObject({ rateLimited: true });
          expect(r.httpStatus).toBe(0);
        }
      }
      // Some guesses ran (without the override), then the limiter stopped them.
      expect(refusedAt).toBeGreaterThan(1);
      expect(refusedAt).toBeLessThanOrEqual(6);
      expect(seen.length).toBe(refusedAt);
      expect(seen.every((s) => s.override === false)).toBe(true);
      // Locked now, even with the right password, and for the person's own window too.
      const right = await guess('right-pw-1');
      expect(right.error!.details).toMatchObject({ rateLimited: true });
      const keys = attemptKeys('closing-password', `${rich.ctx.companyId}:${owner}`, (await getRequestOrigin()).addr).filter((k) => !k.includes(':addr:'));
      expect(loginLimiter().check(keys).allowed).toBe(false);
    } finally {
      await db.update(companies).set({ settings: original }).where(eq(companies.id, rich.ctx.companyId));
      resetLimiter();
    }
  });
});

describe('refused before running', () => {
  const est = () => op('estimates.create');
  const refusedWith = async (code: string, p: Promise<Awaited<ReturnType<typeof runOperation>>>) => {
    const r = await p;
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(0);
    expect(r.error!.code).toBe(code);
    expect(r.error!.message.length).toBeGreaterThan(10);
  };

  it('what is not a route, not for agents, not a read, host-only, an unlisted flag or refused by the guards', async () => {
    const shell = op('shell.company.switch');
    expect(shell.kind).toBe('shell');
    await refusedWith('NOT_A_ROUTE', run(shell, {}, 'dry_run'));
    const personOnly = operationForRoute('POST', '/api/unlock')!;
    expect(personOnly.availability).toBe('person_only');
    await refusedWith('NOT_AVAILABLE', run(personOnly, { body: {} }, 'commit'));
    await refusedWith('NOT_A_READ', run(est(), { body: estimateBody() }, 'read'));
    const hostOnly = op('ai.settings.update');
    expect(hostOnly.hostOnly).toBe(true);
    await refusedWith('HOST_ONLY', run(hostOnly, { body: {} }, 'commit', { atHost: false }));
    await refusedWith('UNKNOWN_CONFIRM_FLAG', run(est(), { body: estimateBody(), confirm: ['allowEverything'] }, 'dry_run'));
    // guardInput: nothing in an estimate is masked, so there is nothing to reveal.
    await refusedWith('REFUSED', run(est(), { body: estimateBody(), reveal: true }, 'dry_run'));
  });

  it('an edited copy of an operation is a programming error: it throws and never runs', async () => {
    h.handler = async () => {
      throw new Error('must not run');
    };
    const before = await fingerprint();
    await expect(runOperation(agentBase, { ...est(), dryRun: 'none' }, { body: estimateBody() }, 'commit', actorFor())).rejects.toThrow(/differs from the registry/);
    const personOnly = operationForRoute('POST', '/api/unlock')!;
    await expect(runOperation(agentBase, { ...personOnly, availability: 'agent' }, { body: {} }, 'commit', actorFor())).rejects.toThrow(/differs from the registry/);
    await expect(runOperation(agentBase, { ...est(), confirmFlags: ['allowLedgerRewrite'] }, { body: estimateBody() }, 'dry_run', actorFor())).rejects.toThrow(
      /differs from the registry/,
    );
    h.handler = null;
    expect(await fingerprint()).toEqual(before);
  });

  it('path values that are missing, unsafe, unknown or lead to another route', async () => {
    await refusedWith('REFUSED', run(op('estimates.update'), { body: {} }, 'dry_run'));
    await refusedWith('REFUSED', run(op('estimates.update'), { params: { id: '..' }, body: {} }, 'dry_run'));
    await refusedWith('REFUSED', run(op('estimates.update'), { params: { id: 'a/b' }, body: {} }, 'dry_run'));
    await refusedWith('VALIDATION', run(op('estimates.update'), { params: { id: 'expire' }, body: {} }, 'dry_run'));
    // A path value the route does not take is taken out, never put in the path.
    let params: Out = {};
    h.handler = async (_req, ctx) => {
      params = await ctx.params;
      return NextResponse.json({ ok: true });
    };
    const id = randomUUID();
    await run(op('estimates.update'), { params: { id, other: 'x' } as Record<string, string>, body: {} }, 'dry_run');
    expect(params).toEqual({ id });
  });

  it('a paused agent, and single-user mode held by someone else', async () => {
    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, agentId));
    try {
      await refusedWith('PAUSED', run(est(), { body: estimateBody() }, 'dry_run'));
    } finally {
      await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, agentId));
    }

    const owner = rich.ctx.userId!;
    const [session] = await db.insert(userSessions).values({ userId: owner, companyId: rich.ctx.companyId }).returning();
    await db.insert(singleUserMode).values({ id: rich.ctx.companyId, sessionId: session.id, userId: owner });
    try {
      await refusedWith('FORBIDDEN', run(est(), { body: estimateBody() }, 'dry_run'));
      // The person holding it may approve an agent's work.
      const held = await run(est(), { body: estimateBody() }, 'dry_run', { userId: owner });
      expect(held.outcome, JSON.stringify(held.error)).toBe('ok');
    } finally {
      await db.delete(singleUserMode).where(eq(singleUserMode.id, rich.ctx.companyId));
      await db.delete(userSessions).where(eq(userSessions.id, session.id));
    }
  });
});

describe('standing permission', () => {
  const grant = async (over: Partial<typeof agentGrants.$inferInsert> = {}) => {
    const [g] = await db
      .insert(agentGrants)
      .values({
        companyId: rich.ctx.companyId,
        agentId,
        operation: 'estimates.create',
        class: 'enter',
        constraints: {},
        givenBy: rich.ctx.userId!,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...over,
      })
      .returning();
    return g.id;
  };
  const usesOf = async (id: string) => (await db.select({ uses: agentGrants.uses }).from(agentGrants).where(eq(agentGrants.id, id)))[0].uses;

  it('a commit counts one use inside its own transaction; a dry run and a failed commit count none', async () => {
    const grantId = await grant();
    const approval = { approvedBy: null, requestId: null, grantId };
    await run(op('estimates.create'), { body: estimateBody() }, 'dry_run', { approval });
    expect(useGrant).not.toHaveBeenCalled();
    expect(await usesOf(grantId)).toBe(0);

    h.handler = async () => NextResponse.json({ error: 'That did not work. Check the lines and try again.', code: 'VALIDATION' }, { status: 400 });
    const failedRun = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { approval });
    expect(failedRun.outcome).toBe('error');
    expect(useGrant).toHaveBeenCalledTimes(1);
    expect(await usesOf(grantId)).toBe(0);

    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { approval });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(await usesOf(grantId)).toBe(1);
    expect(vi.mocked(useGrant).mock.calls.at(-1)![0].db).not.toBe(db);
    const id = ((r.result as Out).id ?? (r.result as Out).estimate?.id) as string;
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(audit.agentGrantId).toBe(grantId);
  });

  it('a used-up grant refuses the run and keeps nothing', async () => {
    const grantId = await grant({ constraints: { maxUses: 1 }, uses: 1 });
    const before = await fingerprint();
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { approval: { approvedBy: null, requestId: null, grantId } });
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(0);
    expect(r.error!.message).toMatch(/used up/);
    expect(await fingerprint()).toEqual(before);
  });
});

describe('staged files in', () => {
  const owner = () => ({ companyId: rich.ctx.companyId, agentId });

  it('a FileRef in a JSON body becomes the file\'s base64 text; a missing one is refused', async () => {
    const staged = await stageFile(owner(), { name: 'receipt.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3, 250]) });
    let body: Out | null = null;
    h.handler = async (req) => {
      body = (await req.json()) as Out;
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(op('estimates.create'), { body: { ...estimateBody(), attachment: { fileId: staged.fileId } } }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(body!.attachment).toBe(Buffer.from([1, 2, 3, 250]).toString('base64'));

    const missing = await run(op('estimates.create'), { body: { ...estimateBody(), attachment: { fileId: 'f'.repeat(32) } } }, 'dry_run');
    expect(missing.outcome).toBe('error');
    expect(missing.error!.code).toBe('FILE_NOT_FOUND');
  });

  it('a bytes body is the file itself; a multipart body carries fields and files', async () => {
    const staged = await stageFile(owner(), { name: 'backup.bkp', type: 'application/octet-stream', bytes: new Uint8Array([9, 8, 7]) });
    let got: number[] = [];
    h.handler = async (req) => {
      got = [...new Uint8Array(await req.arrayBuffer())];
      return NextResponse.json({ ok: true });
    };
    const bytesOp = edited('estimates.create', { body: 'bytes' });
    const r = await run(bytesOp, { body: { fileId: staged.fileId } }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(got).toEqual([9, 8, 7]);

    let form: { memo: unknown; name: string | null; size: number | null; flag: unknown } | null = null;
    h.handler = async (req) => {
      const f = await req.formData();
      const file = f.get('receipt') as File | null;
      form = { memo: f.get('memo'), name: file?.name ?? null, size: file ? file.size : null, flag: f.get('allowDuplicateNumber') };
      return NextResponse.json({ ok: true });
    };
    const formOp = edited('estimates.create', { body: 'multipart' });
    const m = await run(formOp, { body: { fields: { memo: 'Lunch' }, files: { receipt: { fileId: staged.fileId } } }, confirm: ['allowDuplicateNumber'] }, 'dry_run');
    expect(m.outcome, JSON.stringify(m.error)).toBe('ok');
    expect(form).toEqual({ memo: 'Lunch', name: 'backup.bkp', size: 3, flag: 'true' });
  });

  it('confirmation flags land at their dotted path in a JSON body', async () => {
    let body: Out | null = null;
    h.handler = async (req) => {
      body = (await req.json()) as Out;
      return NextResponse.json({ ok: true });
    };
    const nested = edited('estimates.create', { confirmFlags: ['statement.acknowledgeDifference'] });
    const r = await run(nested, { body: { statement: { id: 'x' } }, confirm: ['statement.acknowledgeDifference'] }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(body).toEqual({ statement: { id: 'x', acknowledgeDifference: true } });
  });
});
