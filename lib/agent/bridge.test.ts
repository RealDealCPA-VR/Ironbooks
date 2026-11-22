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
 *    never reaches the handler; wrong closing-date passwords are rate-limited like a person's. A
 *    backup's, a portable file's or a copy's user name, password and recovery key travel in their
 *    headers only as the approver typed them, never as the agent sent them, and not after the run.
 *  - The amount is the whole ledger of the run: entries made add up; an entry voided, deleted or
 *    rewritten in place is shown in the ledger preview and counted; "0.00" when the run moves no
 *    entry; an amount field that cannot be read stays unknown.
 *  - The note of a dry run that was not tried out is true, for the agent and the approval card.
 *  - POST /api/import's tie-out 400 is a warning that needs a yes; a scope that will not open is an
 *    internal refusal; a folder outside the agent's is never looked at, and a file is saved only
 *    in the folder that was checked; a dryRun 'none' commit has a 10-minute limit of its own.
 *  - The handler's context is built from the actor, never from base.access.
 *  - The staleness key: two runs over the same books agree; a price the run reads or a record the
 *    input names, changed in between, gives another key. What the run assigns to itself is left
 *    out (wave 4): the next estimate, purchase order, invoice or journal entry number another
 *    request took, a posting elsewhere, ids of rows the run made wherever they show (a value, a
 *    source, a reference cut to 8 hex digits, a second audit kind on one id, a row dated back), so
 *    none of those makes a waiting request stale; an existing row's id stays as it is.
 *  - Wave 4 also: a void plus an unrelated posting adds up, an edit re-posting one document counts
 *    once; editing a record that existed with no entry is an unknown amount; an entry only named by
 *    an audit row is not shown as changed; a flagged dry run's preview carries the warning the flag
 *    accepted; expectedUpdatedAt reaches the route as x-expected-updated-at (409 on a person's
 *    edit in between); the launch pass reaches the handler only for an approval at the host and
 *    never the scope; ledger lines name who they are for and their class; a wrong closing-date
 *    password typed on the card is refused before the route runs and counted once, and Set Closing
 *    Date does not count it again; no agent changes or deletes a role an agent holds.
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
import { NextRequest, NextResponse } from 'next/server';

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
  return { ...real, stageFile: vi.fn(real.stageFile), allowedFolder: vi.fn(real.allowedFolder) };
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
import { SERVICE_ORIGIN_HEADER, SERVICE_SCOPE_HEADERS, SERVICE_SCOPE_SECRET_HEADERS, getServerContext, requestHeaders, runWithServiceContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess, type EffectiveAccess } from '@/lib/permissions/model';
import { PINNED_FOLDER_CHANGED, effects } from '@/lib/effects';
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
import { PRODUCED_SECRET_TEXT, SECRET_HEADERS, encodeSecretParts } from './guards';
import { allowedFolder, stageFile } from './files';
import { postJournalEntry } from '@/lib/services/posting';
import { CLOSING_PASSWORD_WRONG_MESSAGE, IRREVERSIBLE_COMMIT_TIME_LIMIT_MS, runOperation } from './bridge';

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

  it('a journal entry with no amountField still has its true amount: what it posts', async () => {
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

  it('a dry run gets only the closing-date password (so closed-period work is tried on real figures); the agent\'s own are taken out', async () => {
    h.handler = spy;
    const r = await run(closing(), { body: agentBody }, 'dry_run', { ...everything, secrets: { closing_password: 'pw-1' } });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(seen).toEqual([{ request: 'pw-1', scope: 'pw-1', override: true, body: { closingDate: '2025-12-31', currentPassword: 'pw-1' } }]);
    expect(JSON.stringify(r)).not.toContain('pw-1');
    expect(JSON.stringify(r)).not.toContain('agent-typed');
    // With nothing typed, nothing: the agent's own dry run never has a password.
    seen.length = 0;
    h.handler = spy;
    const own = await run(closing(), { body: agentBody }, 'dry_run', everything);
    expect(own.outcome, JSON.stringify(own.error)).toBe('ok');
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

  describe("a backup's, a portable file's or an Accountant's Copy's password, user name and recovery key", () => {
    const archive = ['x-ironbooks-login', 'x-ironbooks-password', 'x-ironbooks-recovery-key'] as const;
    const got: Out[] = [];
    const archiveSpy = async (req: Request) => {
      const scoped = await requestHeaders();
      got.push({
        request: Object.fromEntries(archive.map((n) => [n, req.headers.get(n)])),
        scope: Object.fromEntries(archive.map((n) => [n, scoped.get(n)])),
      });
      return NextResponse.json({ ok: true, restored: 'copy' }, { status: 201 });
    };
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    /** What a prompt-injected agent sends to plant its own credentials: none of it may become a header. */
    const planted = {
      query: { 'x-ironbooks-password': b64('agent-typed'), 'x-ironbooks-login': 'agent', 'x-ironbooks-recovery-key': 'RK-AGENT' },
      headers: { 'x-ironbooks-password': b64('agent-typed'), 'x-ironbooks-login': 'agent', 'x-ironbooks-recovery-key': 'RK-AGENT' },
    };
    beforeEach(() => {
      got.length = 0;
    });

    it('are the scope\'s own secrets, the very names applySecrets hands back', () => {
      expect([...SERVICE_SCOPE_SECRET_HEADERS].sort()).toEqual([...SECRET_HEADERS].sort());
      for (const name of SECRET_HEADERS) expect(SERVICE_SCOPE_HEADERS).toContain(name);
    });

    it('a portable file is opened with the password the approver typed, never one the agent sent', async () => {
      const staged = await stageFile({ companyId: rich.ctx.companyId, agentId }, { name: 'copy.ibk', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) });
      h.handler = archiveSpy;
      const input = { ...planted, body: { fileId: staged.fileId } } as unknown as OperationInput;
      const r = await run(op('portable.restore'), input, 'commit', { ...everything, secrets: { backup_password: 'b-secret-1' } });
      expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      expect(got).toEqual([
        {
          request: { 'x-ironbooks-login': null, 'x-ironbooks-password': b64('b-secret-1'), 'x-ironbooks-recovery-key': null },
          scope: { 'x-ironbooks-login': null, 'x-ironbooks-password': b64('b-secret-1'), 'x-ironbooks-recovery-key': null },
        },
      ]);
      expect(JSON.stringify(r)).not.toContain('b-secret-1');
      expect(JSON.stringify(r)).not.toContain(b64('b-secret-1'));
    });

    it('a backup is restored with the user name and password, or the recovery key, the approver typed', async () => {
      const restore = op('backups.restore');
      h.handler = archiveSpy;
      const withLogin = await run(restore, { ...planted, body: { id: 'backup-1' } } as unknown as OperationInput, 'commit', {
        ...everything,
        secrets: { archive_credentials: encodeSecretParts({ login: 'dana@books.test', password: 'pä55-wörd' }) },
      });
      expect(withLogin.outcome, JSON.stringify(withLogin.error)).toBe('ok');
      h.handler = archiveSpy;
      const withKey = await run(restore, { body: { id: 'backup-1' } }, 'commit', { ...everything, secrets: { archive_credentials: 'RK-7Q2M-44XZ' } });
      expect(withKey.outcome, JSON.stringify(withKey.error)).toBe('ok');
      expect(got.map((g) => g.request)).toEqual([
        { 'x-ironbooks-login': 'dana@books.test', 'x-ironbooks-password': b64('pä55-wörd'), 'x-ironbooks-recovery-key': null },
        { 'x-ironbooks-login': null, 'x-ironbooks-password': null, 'x-ironbooks-recovery-key': 'RK-7Q2M-44XZ' },
      ]);
      expect(got.map((g) => g.scope)).toEqual(got.map((g) => g.request));
      // The agent's planted values never became a header (a query name is only a query name).
      for (const g of got) expect(JSON.stringify(g)).not.toMatch(/agent|RK-AGENT/);
      expect(JSON.stringify([withLogin, withKey])).not.toMatch(/pä55|dana@books\.test|RK-7Q2M/);
    });

    it('never from the agent alone, never in a dry run; a commit without them runs without any (the route needs none for a backup of this same file)', async () => {
      // A commit with nothing typed: the sign-in of another file is optional to the route
      // (ApprovalNeeds.optionalSecrets), so it runs, and with none of what the agent planted.
      h.handler = archiveSpy;
      const without = await run(op('backups.restore'), { ...planted, body: { id: 'backup-1' } } as unknown as OperationInput, 'commit', everything);
      h.handler = null;
      expect(without.outcome, JSON.stringify(without.error)).toBe('ok');
      const none = { 'x-ironbooks-login': null, 'x-ironbooks-password': null, 'x-ironbooks-recovery-key': null };
      expect(got).toEqual([{ request: none, scope: none }]);
      got.length = 0;
      // A secret the route always needs is still asked for before anything runs.
      h.handler = archiveSpy;
      const staged0 = await stageFile({ companyId: rich.ctx.companyId, agentId }, { name: 'copy.ibk', type: 'application/octet-stream', bytes: new Uint8Array([5]) });
      const refused = await run(op('portable.restore'), { body: { fileId: staged0.fileId } }, 'commit', everything);
      h.handler = null;
      expect(refused.error!.code).toBe('SECRET_NEEDED');
      expect(refused.error!.details).toEqual({ secrets: ['backup_password'] });
      expect(got).toEqual([]);
      // A dry run that really runs (a copy of the operation that can be rolled back), with the
      // approver's secret in hand: still none of them reaches the handler.
      const tried = edited('portable.restore', { dryRun: 'transaction' });
      const staged = await stageFile({ companyId: rich.ctx.companyId, agentId }, { name: 'copy.ibk', type: 'application/octet-stream', bytes: new Uint8Array([4]) });
      h.handler = archiveSpy;
      const dry = await run(tried, { body: { fileId: staged.fileId } }, 'dry_run', { ...everything, secrets: { backup_password: 'b-secret-2' } });
      expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
      expect(got).toEqual([
        { request: { 'x-ironbooks-login': null, 'x-ironbooks-password': null, 'x-ironbooks-recovery-key': null }, scope: { 'x-ironbooks-login': null, 'x-ironbooks-password': null, 'x-ironbooks-recovery-key': null } },
      ]);
    });

    it('work the run left behind no longer reads them once it is over', async () => {
      let late!: Promise<Array<string | null>>;
      h.handler = async () => {
        late = new Promise((resolve) => {
          setTimeout(async () => {
            const hh = await requestHeaders();
            resolve(archive.map((n) => hh.get(n)));
          }, 30);
        });
        return NextResponse.json({ ok: true }, { status: 201 });
      };
      const r = await run(op('backups.restore'), { body: { id: 'backup-1' } }, 'commit', {
        ...everything,
        secrets: { archive_credentials: encodeSecretParts({ login: 'dana@books.test', password: 'pw-late' }) },
      });
      expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      expect(await late).toEqual([null, null, null]);
    });
  });

  it('a wrong closing-date password refuses at once, before the route runs, counted once by the person\'s own limiter; a locked one refuses even the right one', async () => {
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
    const keys = async () => attemptKeys('closing-password', `${rich.ctx.companyId}:${owner}`, (await getRequestOrigin()).addr).filter((k) => !k.includes(':addr:'));
    try {
      const guess = (pw: string, mode: 'dry_run' | 'commit' = 'commit') => {
        h.handler = spy;
        return run(closing(), { body: { closingDate: '2025-12-31' } }, mode, { ...everything, userId: owner, secrets: { closing_password: pw } });
      };
      let lockedAt = -1;
      for (let i = 0; i < 10 && lockedAt < 0; i++) {
        const r = await guess(`wrong-${i}`, i % 2 ? 'dry_run' : 'commit');
        expect(r.outcome).toBe('error');
        expect(r.httpStatus).toBe(0);
        expect(r.error!.code).toBe('FORBIDDEN');
        expect(JSON.stringify(r)).not.toContain(`wrong-${i}`);
        if ((r.error!.details as Out)?.rateLimited) {
          lockedAt = i;
          expect(r.error!.message).toMatch(/Too many wrong closing-date passwords/);
        } else {
          expect(r.error!.message).toMatch(/closing-date password typed on the approval card is not correct, so nothing was done/);
          expect(r.error!.details).toEqual({ closingPassword: 'wrong' });
        }
      }
      // Each wrong one was refused before the route ran, and counted once: the lock comes after a
      // few, never on the first.
      expect(seen).toEqual([]);
      expect(lockedAt).toBeGreaterThan(1);
      expect(lockedAt).toBeLessThanOrEqual(6);
      // Locked now, even with the right password, and for the person's own window too.
      const right = await guess('right-pw-1');
      expect(right.error!.details).toMatchObject({ rateLimited: true });
      expect(seen).toEqual([]);
      expect(loginLimiter().check(await keys()).allowed).toBe(false);

      // Unlocked again, the right one runs the route with the override, and counts nothing wrong.
      resetLimiter();
      const ok = await guess('right-pw-1');
      expect(ok.outcome, JSON.stringify(ok.error)).toBe('ok');
      expect(seen).toEqual([{ request: 'right-pw-1', scope: 'right-pw-1', override: true, body: { closingDate: '2025-12-31', currentPassword: 'right-pw-1' } }]);
    } finally {
      await db.update(companies).set({ settings: original }).where(eq(companies.id, rich.ctx.companyId));
      resetLimiter();
    }
  });

  it('a wrong one is refused at once even where the request does not show it is needed (a void sent with only an id): the person is told the true reason', async () => {
    const owner = rich.ctx.userId!;
    const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, rich.ctx.companyId));
    const original = company.settings;
    (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    await db
      .update(companies)
      .set({ settings: { ...((original ?? {}) as Record<string, unknown>), closingDatePasswordHash: await hashPassword('right-pw-3') } })
      .where(eq(companies.id, rich.ctx.companyId));
    try {
      const got: Out[] = [];
      h.handler = async (req) => {
        const ctx = await getServerContext();
        got.push({ request: req.headers.get('x-closing-password') !== null, override: ctx.closingDateOverride });
        return NextResponse.json({ id: randomUUID(), total: '300.00' }, { status: 201 });
      };
      // Nothing in the input is dated: the card asked for the password because the record is.
      for (const mode of ['dry_run', 'commit'] as const) {
        const r = await run(op('estimates.create'), { body: estimateBody() }, mode, { ...everything, userId: owner, secrets: { closing_password: 'not-it' } });
        expect(r.outcome, mode).toBe('error');
        expect(r.error!.code).toBe('FORBIDDEN');
        expect(r.error!.message).toBe(CLOSING_PASSWORD_WRONG_MESSAGE);
        expect(JSON.stringify(r)).not.toContain('not-it');
      }
      expect(got).toEqual([]);
      // The right one goes on, with the override for an access holding the closed-period right.
      const ok = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { ...everything, userId: owner, secrets: { closing_password: 'right-pw-3' } });
      expect(ok.outcome, JSON.stringify(ok.error)).toBe('ok');
      expect(got).toEqual([{ request: true, override: true }]);
    } finally {
      await db.update(companies).set({ settings: original }).where(eq(companies.id, rich.ctx.companyId));
      (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    }
  });

  it('Set Closing Date takes the password the bridge checked without counting it again, in the scope\'s realm', async () => {
    // The real route, as a non-Admin with the closing-date right moving the date earlier: it needs
    // the current password (body.currentPassword), the one the approver typed on the card.
    const owner = rich.ctx.userId!;
    const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, rich.ctx.companyId));
    const original = company.settings;
    const resetLimiter = () => {
      (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
    };
    resetLimiter();
    await db
      .update(companies)
      .set({ settings: { ...((original ?? {}) as Record<string, unknown>), closingDate: '2026-01-31', closingDatePasswordHash: await hashPassword('right-pw-2') } })
      .where(eq(companies.id, rich.ctx.companyId));
    const notAdmin: EffectiveAccess = { ...fullAccess(), isAdmin: false };
    try {
      const limiter = loginLimiter() as unknown as { begin: (...a: unknown[]) => unknown };
      const counted: string[][] = [];
      const begin = limiter.begin.bind(limiter);
      limiter.begin = (keys: unknown, ...rest: unknown[]) => {
        counted.push([...(keys as string[])]);
        return begin(keys, ...rest);
      };
      try {
        const r = await run(closing(), { body: { closingDate: '2025-12-31' } }, 'commit', { access: notAdmin, role: 'accountant', userId: owner, secrets: { closing_password: 'right-pw-2' } });
        expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      } finally {
        limiter.begin = begin;
      }
      // One guess, under the person's own keys; none under the agent scope's ("this computer, outside Ironbooks").
      expect(counted).toHaveLength(1);
      expect(counted[0].some((k) => k.includes('outside'))).toBe(false);
      const [after] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, rich.ctx.companyId));
      expect((after.settings as Out).closingDate).toBe('2025-12-31');
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

describe('the amount: the whole of what the run moves in the ledger (factsFor)', () => {
  const je = (amount: string, description: string) => ({
    date: '2026-03-03',
    description,
    lines: [
      { accountId: rich.acct['6300'], debit: amount },
      { accountId: rich.acct['1000'], credit: amount },
    ],
  });
  /** A posted journal entry, made through the bridge itself; its id. */
  const posted = async (amount: string, description: string) => {
    const r = await run(op('journal-entries.create'), { body: je(amount, description) }, 'commit');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    return r.preview!.ledger!.entries[0].journalEntryId;
  };
  const statusOf = async (id: string) => {
    const res = (await db.execute(sql`select status::text as s from journal_entries where id = ${id}`)) as unknown as { rows: Array<{ s: string }> };
    return res.rows[0]?.s;
  };
  const jePost = async (amount: string, description: string) => {
    const { POST } = await import('@/app/api/journal-entries/route');
    return POST(
      new NextRequest('http://127.0.0.1/api/journal-entries', {
        method: 'POST',
        body: JSON.stringify(je(amount, description)),
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  it('no amount field and no entry made, voided, deleted or changed: "0.00" after a dry run and a commit', async () => {
    const t = op('time-entries.create');
    expect(t.amountField).toBeNull();
    const dry = await run(t, { body: timeBody() }, 'dry_run');
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    expect(dry.preview!.ledger!.entries).toEqual([]);
    expect(dry.facts.amount).toBe('0.00');
    const done = await run(t, { body: timeBody() }, 'commit');
    expect(done.outcome, JSON.stringify(done.error)).toBe('ok');
    expect(done.facts.amount).toBe('0.00');
    // When the run did not go through, it stays unknown.
    h.handler = async () => NextResponse.json({ error: 'That did not work. Check the lines and try again.', code: 'VALIDATION' }, { status: 400 });
    const failedRun = await run(t, { body: timeBody() }, 'dry_run');
    expect(failedRun.outcome).toBe('error');
    expect(failedRun.facts.amount).toBeNull();
  });

  it('an amount field that cannot be read stays unknown, whatever the ledger shows', async () => {
    expect(op('estimates.create').amountField).toBe('total');
    h.handler = async () => NextResponse.json({ id: randomUUID(), total: 'a lot' }, { status: 201 });
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.facts.amount).toBeNull();
  });

  it('the entries one run makes add up: two entries are their sum, not the larger one', async () => {
    h.handler = async () => {
      for (const [amount, what] of [
        ['250.00', 'Paper'],
        ['400.00', 'Toner'],
      ]) {
        const res = await jePost(amount, what);
        if (res.status !== 201) return res;
      }
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(op('journal-entries.create'), { body: je('250.00', 'Paper') }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries).toHaveLength(2);
    // Entries the run made carry no touched mark.
    for (const e of r.preview!.ledger!.entries) expect(e).not.toHaveProperty('touched');
    expect(r.facts.amount).toBe('650.00');
  });

  it('an operation with an amount field still takes the larger of its field and the largest single entry', async () => {
    h.handler = async () => {
      await jePost('900.00', 'Big');
      await jePost('800.00', 'Not counted with the other');
      return NextResponse.json({ id: randomUUID(), total: '300.00' }, { status: 201 });
    };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.facts.amount).toBe('900.00');
  });

  it('voiding an entry: the ledger preview shows it, and it is judged at its total', async () => {
    const id = await posted('50000.00', 'Check 1042 to Paper Supply');
    const before = await fingerprint();
    const dry = await run(op('journal-entries.delete'), { params: { id } }, 'dry_run');
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    expect(dry.facts.amount).toBe('50000.00');
    const shown = dry.preview!.ledger!.entries.find((e) => e.journalEntryId === id);
    expect(shown, JSON.stringify(dry.preview!.ledger)).toMatchObject({
      status: 'void',
      touched: 'voided',
      date: '2026-03-03',
      description: 'Voided by this request: Check 1042 to Paper Supply',
      lines: expect.arrayContaining([expect.objectContaining({ accountId: rich.acct['6300'], debit: '50000.00', credit: null })]),
    });
    expect(dry.preview!.truncated).toBe(false);
    // A dry run keeps nothing, and two of them agree on the staleness key.
    expect(await fingerprint()).toEqual(before);
    expect(await statusOf(id)).toBe('posted');
    const again = await run(op('journal-entries.delete'), { params: { id } }, 'dry_run');
    expect(again.stalenessKey).toBe(dry.stalenessKey);

    const done = await run(op('journal-entries.delete'), { params: { id } }, 'commit');
    expect(done.outcome, JSON.stringify(done.error)).toBe('ok');
    expect(done.facts.amount).toBe('50000.00');
    expect(await statusOf(id)).toBe('void');

    // Void already: a run that only touches it moves no money, so nothing is counted for it.
    h.handler = async () => {
      const ctx = await getServerContext();
      await ctx.db.execute(sql`update journal_entries set updated_at = updated_at where id = ${id}`);
      return NextResponse.json({ ok: true });
    };
    const touchedOnly = await run(op('journal-entries.delete'), { params: { id } }, 'dry_run');
    expect(touchedOnly.outcome, JSON.stringify(touchedOnly.error)).toBe('ok');
    expect(touchedOnly.preview!.ledger!.entries).toEqual([
      expect.objectContaining({ journalEntryId: id, status: 'void', touched: 'changed', description: 'Changed by this request: Check 1042 to Paper Supply' }),
    ]);
    expect(touchedOnly.facts.amount).toBe('0.00');
  });

  it('lines rewritten in place (a reclassify, a merge) are found through the ledger rewrite flag and counted', async () => {
    const { allowLedgerRewrite } = await import('@/lib/services/posting');
    const id = await posted('700.00', 'Rent for March');
    h.handler = async () => {
      const ctx = await getServerContext();
      await allowLedgerRewrite(ctx, 'reclassify');
      await ctx.db.execute(sql`update journal_entry_lines set memo = 'moved' where journal_entry_id = ${id}`);
      return NextResponse.json({ ok: true });
    };
    const r = await run(op('journal-entries.update'), { params: { id }, body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries).toEqual([
      expect.objectContaining({
        journalEntryId: id,
        status: 'posted',
        touched: 'changed',
        description: 'Changed by this request: Rent for March',
        lines: expect.arrayContaining([expect.objectContaining({ memo: 'moved', debit: '700.00' })]),
      }),
    ]);
    expect(r.facts.amount).toBe('700.00');
  });

  it('an entry deleted outright counts by what its audit row kept; with nothing kept the amount is unknown; a draft counts nothing', async () => {
    const deleting = (old: Record<string, unknown>) => async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'delete', entityType: 'journal_entry', entityId: randomUUID(), oldValues: old });
      return NextResponse.json({ ok: true });
    };
    const lines = [
      { accountId: rich.acct['6300'], debit: '75.00', credit: null, memo: 'gone' },
      { accountId: rich.acct['1000'], debit: null, credit: '75.00', memo: null },
    ];
    h.handler = deleting({ entryNumber: 99001, date: '2026-03-03', description: 'Gone for good', status: 'posted', total: '75.00', lines });
    const kept = await run(op('journal-entries.update'), { params: { id: randomUUID() }, body: {} }, 'dry_run');
    expect(kept.outcome, JSON.stringify(kept.error)).toBe('ok');
    expect(kept.facts.amount).toBe('75.00');
    expect(kept.preview!.ledger!.entries).toEqual([
      expect.objectContaining({
        status: 'deleted',
        touched: 'deleted',
        entryNumber: 99001,
        description: 'Deleted by this request: Gone for good',
        lines: [
          expect.objectContaining({ accountId: rich.acct['6300'], debit: '75.00', credit: null, memo: 'gone' }),
          expect.objectContaining({ accountId: rich.acct['1000'], debit: null, credit: '75.00' }),
        ],
      }),
    ]);
    expect(kept.preview!.ledger!.entries[0].lines[0].accountName).not.toBe('An account');

    h.handler = deleting({ status: 'posted', description: 'No figures kept' });
    const unknown = await run(op('journal-entries.update'), { params: { id: randomUUID() }, body: {} }, 'dry_run');
    expect(unknown.outcome, JSON.stringify(unknown.error)).toBe('ok');
    expect(unknown.facts.amount).toBeNull();

    h.handler = deleting({ status: 'draft', total: '75.00', description: 'Never posted' });
    const draft = await run(op('journal-entries.update'), { params: { id: randomUUID() }, body: {} }, 'dry_run');
    expect(draft.outcome, JSON.stringify(draft.error)).toBe('ok');
    expect(draft.facts.amount).toBe('0.00');
  });

  it('a posted entry only given a new title, number, link or line memo is shown but moves no money: "0.00"', async () => {
    const id = await posted('3000.00', 'Rent for April');
    h.handler = async () => {
      const ctx = await getServerContext();
      // What assigning a check number, retitling, relinking a merged item and a memo fix do.
      await ctx.db.execute(sql`update journal_entries set reference = 'CHK-2001', description = 'Rent for April, office', source_ref = 'merged:item' where id = ${id}`);
      await ctx.db.execute(sql`update journal_entry_lines set memo = 'April' where journal_entry_id = ${id}`);
      return NextResponse.json({ ok: true });
    };
    const r = await run(op('journal-entries.update'), { params: { id }, body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries).toEqual([
      expect.objectContaining({ journalEntryId: id, status: 'posted', touched: 'changed', description: 'Changed by this request: Rent for April, office' }),
    ]);
    expect(r.facts.amount).toBe('0.00');
  });

  it('a draft the run posts moves its whole total into the books', async () => {
    const draft = await postJournalEntry(admin, {
      date: new Date('2026-03-05T00:00:00Z'),
      description: 'Accrued wages',
      status: 'draft',
      lines: [
        { accountId: rich.acct['6300'], debit: '425.00' },
        { accountId: rich.acct['1000'], credit: '425.00' },
      ],
    });
    h.handler = async () => {
      const ctx = await getServerContext();
      await ctx.db.execute(sql`update journal_entries set status = 'posted' where id = ${draft.id}`);
      return NextResponse.json({ ok: true });
    };
    const r = await run(op('journal-entries.update'), { params: { id: draft.id }, body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries).toEqual([expect.objectContaining({ journalEntryId: draft.id, status: 'posted', touched: 'changed' })]);
    expect(r.facts.amount).toBe('425.00');
    expect(await statusOf(draft.id)).toBe('draft');

    // Voiding a draft takes nothing out of the books.
    h.handler = async () => {
      const ctx = await getServerContext();
      await ctx.db.execute(sql`update journal_entries set status = 'void', voided_at = now() where id = ${draft.id}`);
      return NextResponse.json({ ok: true });
    };
    const voided = await run(op('journal-entries.update'), { params: { id: draft.id }, body: {} }, 'dry_run');
    expect(voided.outcome, JSON.stringify(voided.error)).toBe('ok');
    expect(voided.preview!.ledger!.entries).toEqual([expect.objectContaining({ journalEntryId: draft.id, touched: 'voided' })]);
    expect(voided.facts.amount).toBe('0.00');
  });
});

describe('the ledger preview masks account numbers in memos and descriptions, as every other reader does', () => {
  const full = '000123456789';
  /** An older entry (from before the masking fix): its memo and description hold the full number. */
  const legacy = async () => {
    const made = await run(
      op('journal-entries.create'),
      {
        body: {
          date: '2026-03-06',
          description: 'Sales tax payment',
          lines: [
            { accountId: rich.acct['6300'], debit: '640.00' },
            { accountId: rich.acct['1000'], credit: '640.00' },
          ],
        },
      },
      'commit',
    );
    expect(made.outcome, JSON.stringify(made.error)).toBe('ok');
    const id = made.preview!.ledger!.entries[0].journalEntryId;
    await db.execute(sql`update journal_entry_lines set memo = ${`Acct # ${full}`} where journal_entry_id = ${id}`);
    await db.execute(sql`update journal_entries set description = ${`Sales tax payment, Acct # ${full}`} where id = ${id}`);
    return id;
  };

  it('a void dry run shows the memo and description masked; the audit diff too', async () => {
    const id = await legacy();
    const dry = await run(op('journal-entries.delete'), { params: { id } }, 'dry_run');
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    const shown = dry.preview!.ledger!.entries.find((e) => e.journalEntryId === id)!;
    expect(shown.description).toBe('Voided by this request: Sales tax payment, Acct # ••••6789');
    expect(shown.lines.map((l) => l.memo)).toEqual(['Acct # ••••6789', 'Acct # ••••6789']);
    expect(JSON.stringify(dry.preview)).not.toContain(full);
  });

  it('an entry deleted outright: the lines its audit row kept are masked too', async () => {
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, {
        action: 'delete',
        entityType: 'journal_entry',
        entityId: randomUUID(),
        oldValues: {
          status: 'posted',
          description: `Check, Acct # ${full}`,
          total: '20.00',
          lines: [
            { accountId: rich.acct['6300'], debit: '20.00', credit: null, memo: `Acct # ${full}` },
            { accountId: rich.acct['1000'], debit: null, credit: '20.00', memo: null },
          ],
        },
      });
      return NextResponse.json({ ok: true });
    };
    const r = await run(op('journal-entries.update'), { params: { id: randomUUID() }, body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries[0]).toMatchObject({ description: 'Deleted by this request: Check, Acct # ••••6789' });
    expect(r.preview!.ledger!.entries[0].lines[0].memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(r.preview)).not.toContain(full);
  });

  it('an entry the run makes (a reversal copying its memos) is masked the same way', async () => {
    h.handler = async () => {
      const ctx = await getServerContext();
      await postJournalEntry(ctx, {
        date: new Date('2026-03-07T00:00:00Z'),
        description: `Reversal of Acct # ${full}`,
        lines: [
          { accountId: rich.acct['1000'], debit: '640.00', memo: `Acct # ${full}` },
          { accountId: rich.acct['6300'], credit: '640.00' },
        ],
      });
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(op('journal-entries.create'), { body: journalBody() }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries[0]).toMatchObject({ description: 'Reversal of Acct # ••••6789' });
    expect(JSON.stringify(r.preview)).not.toContain(full);
  });

  it('with a reveal of full account numbers a person approved for this call, the full number shows', async () => {
    const id = await legacy();
    // No reveal asked: masked, whatever the actor's own rights.
    const plain = await run(op('journal-entries.delete'), { params: { id } }, 'dry_run', { access: fullAccess(), role: 'admin' });
    expect(plain.outcome, JSON.stringify(plain.error)).toBe('ok');
    expect(JSON.stringify(plain.preview)).not.toContain(full);
    const revealing = edited('journal-entries.delete', { reveal: 'account_numbers' });
    const dry = await run(revealing, { params: { id }, reveal: true }, 'dry_run', { access: fullAccess(), role: 'admin', reveal: true });
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    const shown = dry.preview!.ledger!.entries.find((e) => e.journalEntryId === id)!;
    expect(shown.lines.map((l) => l.memo)).toEqual([`Acct # ${full}`, `Acct # ${full}`]);
    expect(shown.description).toBe(`Voided by this request: Sales tax payment, Acct # ${full}`);
  });
});

describe('what a dry run that was not tried out says', () => {
  it('an operation with a preview of its own: its preview is the same operation with its preview option, and may need approval', async () => {
    const preview = op('items.bulk.save');
    expect(preview.dryRun).toBe('preview');
    h.handler = async () => {
      throw new Error('must not run');
    };
    const before = await fingerprint();
    const r = await run(preview, { body: {} }, 'dry_run');
    h.handler = null;
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    const note = (r.preview!.routePreview as Out).note as string;
    expect((r.preview!.routePreview as Out).ran).toBe(false);
    expect(note).toMatch(/same operation/);
    expect(note).toMatch(/preview option/);
    expect(note).toMatch(/may need approval/);
    expect(note).toMatch(/Nothing was changed/);
    expect(note).not.toMatch(/separate operation/);
    // Not every such description names the option (vendors.bulk.save, customers.bulk.save do not),
    // and the approval card does not show the description: the note does not point there.
    expect(note).not.toMatch(/description/);
    // Shown on the card under "Ironbooks did not try this ahead of time": it does not say that again.
    expect(note).not.toMatch(/not tried|did not try/i);
    expect(await fingerprint()).toEqual(before);
  });

  it('an operation that cannot be undone says why, and that the person approving it decides', async () => {
    h.handler = async () => {
      throw new Error('must not run');
    };
    const r = await run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'dry_run');
    h.handler = null;
    const note = (r.preview!.routePreview as Out).note as string;
    expect(note).toMatch(/cannot be run and then undone/);
    expect(note).toMatch(/the person approving it decides from its description/);
    expect(note).not.toMatch(/not tried|did not try/i);
    expect(note).not.toMatch(/answer/);
  });

  it('a read the agent may see only once approved says its answer would reach the agent first, never that it cannot be undone', async () => {
    const users = op('users.list');
    expect(users).toMatchObject({ method: 'GET', class: 'admin', dryRun: 'none' });
    h.handler = async () => {
      throw new Error('must not run');
    };
    const r = await run(users, {}, 'dry_run', { access: fullAccess(), role: 'admin' });
    h.handler = null;
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.result).toBeNull();
    const note = (r.preview!.routePreview as Out).note as string;
    expect((r.preview!.routePreview as Out).ran).toBe(false);
    expect(note).toMatch(/hand its answer to the agent before a person approved it/);
    expect(note).toMatch(/the person approving it decides from its description/);
    expect(note).not.toMatch(/undone|outside the books/);
    expect(note).not.toMatch(/not tried|did not try/i);

    // Fail closed: such a read is never dry run, even if its classification said it could be.
    const read = allOperations().find((o) => o.kind === 'route' && o.availability === 'agent' && o.method === 'GET' && o.class === 'read' && o.params.length === 0)!;
    let ran = false;
    h.handler = async () => {
      ran = true;
      return NextResponse.json({ rows: [] });
    };
    const leaked = await run(edited(read.id, { class: 'admin', dryRun: 'transaction' }), {}, 'dry_run', { access: fullAccess(), role: 'admin' });
    h.handler = null;
    expect(ran).toBe(false);
    expect(leaked.result).toBeNull();
    expect((leaked.preview!.routePreview as Out).note).toMatch(/hand its answer to the agent/);
  });
});

describe('POST /api/import: a statement that does not tie out is a warning that needs a yes (WAVE1 note 7)', () => {
  const rowsBody = () => ({
    bankAccountId: randomUUID(),
    fileType: 'rows',
    rows: [{ date: '2026-03-01', description: 'Deposit', amount: '12.50' }],
    statement: { kind: 'bank', openingBalance: '100.00', closingBalance: '117.50' },
  });

  it("the route's own 400 with details.tieOut becomes needs_confirmation; the resend with the flag gets past it", async () => {
    const imp = op('import');
    expect(imp.confirmFlags).toContain('statement.acknowledgeDifference');
    const before = await fingerprint();
    const r = await run(imp, { body: rowsBody() }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('needs_confirmation');
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([{ flag: 'statement.acknowledgeDifference', message: expect.stringMatching(/off from the statement by/) }]);
    const yes = await run(imp, { body: rowsBody(), confirm: ['statement.acknowledgeDifference'] }, 'dry_run');
    expect(yes.outcome).not.toBe('needs_confirmation');
    expect(JSON.stringify(yes.error)).not.toMatch(/off from the statement/);
    expect(await fingerprint()).toEqual(before);
  });

  it('an ordinary 400, the flag already sent, a tie-out that is fine and an operation that does not list the flag stay errors', async () => {
    const tieOut400 = async () =>
      NextResponse.json({ error: 'The rows are off from the statement by -5.00.', code: 'VALIDATION', details: { tieOut: { ok: false, difference: '-5.00' } } }, { status: 400 });
    h.handler = async () => NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
    const plain = await run(op('import'), { body: rowsBody() }, 'dry_run');
    expect(plain.outcome).toBe('error');
    expect(plain.warnings).toEqual([]);
    h.handler = tieOut400;
    const looped = await run(op('import'), { body: rowsBody(), confirm: ['statement.acknowledgeDifference'] }, 'dry_run');
    expect(looped.outcome).toBe('error');
    expect(looped.error!.message).toMatch(/off from the statement/);
    h.handler = async () => NextResponse.json({ error: 'Something else.', code: 'VALIDATION', details: { tieOut: { ok: true, difference: '0.00' } } }, { status: 400 });
    const tied = await run(op('import'), { body: rowsBody() }, 'dry_run');
    expect(tied.outcome).toBe('error');
    h.handler = tieOut400;
    const other = await run(op('estimates.create'), { body: estimateBody() }, 'dry_run');
    expect(other.outcome).toBe('error');
  });
});

describe('a scope that will not open is an internal refusal, never a crash', () => {
  it('a run started inside another agent request', async () => {
    h.handler = async () => {
      throw new Error('must not run');
    };
    const before = await fingerprint();
    const r = await runWithServiceContext(agentBase, { path: '/api/estimates', method: 'POST' }, () =>
      run(op('estimates.create'), { body: estimateBody() }, 'dry_run'),
    );
    h.handler = null;
    expect(r.outcome).toBe('error');
    expect(r.httpStatus).toBe(0);
    expect(r.error).toEqual({
      message: 'Ironbooks did not run this request, and nothing was changed: one agent request cannot run inside another.',
      code: 'INTERNAL',
      details: { notRun: true },
    });
    expect(await fingerprint()).toEqual(before);
  });

  it('a context that cannot be checked while it runs', async () => {
    h.handler = async () => {
      throw new Error('must not run');
    };
    const odd = { ...bookkeeping, extra: BigInt(1) } as unknown as EffectiveAccess;
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { access: odd });
    h.handler = null;
    expect(r.outcome).toBe('error');
    expect(r.error!.code).toBe('INTERNAL');
    expect(r.error!.message).toMatch(/^Ironbooks did not run this request, and nothing was changed: an agent request needs a context that can be checked/);
  });
});

describe("files are looked at only inside the agent's folders, and saved only where they were checked", () => {
  const sender = vi.fn(async () => ({ messageId: 'x' }));
  const linkFolder = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

  it('a folder outside them is refused without the bridge or effects.writeFile looking at it on the disk', async () => {
    const allowed = path.join(outbox, 'looked-allowed');
    fs.mkdirSync(allowed, { recursive: true });
    const outside = path.join(outbox, 'never-looked-at', 'deep', 'er');
    // Every way the disk is looked at: lstat (the walk), stat (writeFile's own look, which follows
    // links and opens shares), realpath (resolving a folder).
    const spies = [vi.spyOn(fs.promises, 'lstat'), vi.spyOn(fs.promises, 'stat'), vi.spyOn(fs.promises, 'realpath')];
    try {
      for (const mode of ['dry_run', 'commit'] as const) {
        h.handler = async () => {
          await effects.writeFile({ dir: outside, name: 'x.txt', bytes: 'x' });
          return NextResponse.json({ ok: true }, { status: 201 });
        };
        const r = await run(op('estimates.create'), { body: estimateBody() }, mode, { folders: [allowed] });
        expect(r.error!.code, mode).toBe('FOLDER_NOT_ALLOWED');
      }
      expect(spies[0]).toHaveBeenCalled(); // the allowed folder itself is looked at
      const looked = spies.flatMap((s) => s.mock.calls.map(([p]) => String(p)));
      expect(looked.filter((p) => p.includes('never-looked-at'))).toEqual([]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(fs.existsSync(path.join(outbox, 'never-looked-at'))).toBe(false);
  });

  it('a file the work asks for while the folders are being checked is checked too, and refused outside them', async () => {
    const allowed = path.join(outbox, 'late-allowed');
    const outside = path.join(outbox, 'late-outside');
    fs.mkdirSync(allowed, { recursive: true });
    let startLate!: () => void;
    const lateGo = new Promise<void>((r) => (startLate = r));
    // The first look at a folder (the first round of checks) lets the work's background save go.
    const realAllowed = (await vi.importActual<typeof import('./files')>('./files')).allowedFolder;
    vi.mocked(allowedFolder).mockImplementationOnce(async (list, folder) => {
      startLate();
      await sleep(20);
      return realAllowed(list, folder);
    });
    h.handler = async () => {
      await effects.writeFile({ dir: allowed, name: 'a.txt', bytes: 'a' });
      void lateGo.then(() => effects.writeFile({ dir: outside, name: 'b.txt', bytes: 'b' })).catch(() => undefined);
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatchObject({ code: 'FOLDER_NOT_ALLOWED', details: { folder: outside } });
    expect(fs.existsSync(path.join(allowed, 'a.txt'))).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a link made inside an allowed folder after the check cannot lead the save elsewhere', async () => {
    const allowed = path.join(outbox, 'pin-allowed');
    const out = path.join(allowed, 'out');
    const elsewhere = path.join(outbox, 'pin-elsewhere');
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    sender.mockClear();
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID() });
      await effects.writeFile({ dir: out, name: 'rows.txt', bytes: 'every customer' });
      await effects.email({ to: 'ap@acme.test', subject: 'Done' }, sender);
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 201, headers: { 'content-type': 'application/pdf' } });
    };
    // Staging the answer runs after the check and before the commit: the folder is swapped for a
    // link to another folder right then.
    const realFiles = await vi.importActual<typeof import('./files')>('./files');
    vi.mocked(stageFile).mockImplementationOnce(async (owner, file) => {
      fs.rmSync(out, { recursive: true, force: true });
      linkFolder(elsewhere, out);
      return realFiles.stageFile(owner, file);
    });
    const r = await run(op('estimates.create'), { body: estimateBody() }, 'commit', { folders: [allowed] });
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.effects).toEqual([
      expect.objectContaining({ effect: expect.objectContaining({ kind: 'file' }), status: 'failed', error: PINNED_FOLDER_CHANGED }),
      expect.objectContaining({ effect: expect.objectContaining({ kind: 'email' }), status: 'sent' }),
    ]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(sender).toHaveBeenCalledTimes(1);
  });
});

describe('a commit of work that cannot be undone (dryRun none) has a time limit of its own', () => {
  const sender = vi.fn(async () => ({ messageId: 'x' }));
  beforeEach(() => sender.mockClear());

  it("is not held to an entry's ten seconds", async () => {
    h.limitMs = 50;
    h.handler = async () => {
      await sleep(300);
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    const r = await run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'commit');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
  });

  it('past IRREVERSIBLE_COMMIT_TIME_LIMIT_MS (10 minutes) it says the work may still finish, and what it queued is never sent', async () => {
    expect(IRREVERSIBLE_COMMIT_TIME_LIMIT_MS).toBe(10 * 60 * 1000);
    let reached!: () => void;
    const atHandler = new Promise<void>((r) => (reached = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let finished = false;
    h.handler = async () => {
      reached();
      await gate;
      await effects.email({ to: 'ap@acme.test', subject: 'Late' }, sender);
      finished = true;
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    let r: Awaited<ReturnType<typeof runOperation>>;
    try {
      const pending = run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'commit');
      await atHandler;
      await vi.advanceTimersByTimeAsync(IRREVERSIBLE_COMMIT_TIME_LIMIT_MS + 1_000);
      r = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(r.outcome).toBe('error');
    expect(r.error).toMatchObject({ code: 'TIMEOUT', details: { seconds: 600, mayStillFinish: true } });
    expect(r.error!.message).toMatch(/longer than 10 minutes/);
    expect(r.error!.message).toMatch(/may still finish/);
    finish();
    for (let i = 0; i < 50 && !finished; i++) await sleep(10);
    await sleep(50);
    expect(finished).toBe(true);
    expect(sender).not.toHaveBeenCalled();
  });

  it('work that has not started when the limit passes (still waiting to count its grant) never starts', async () => {
    let reached!: () => void;
    const atGrant = new Promise<void>((r) => (reached = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    // The wait the limit exists for: the grant's count stuck on a lock.
    vi.mocked(useGrant).mockImplementationOnce((async () => {
      reached();
      await gate;
    }) as unknown as typeof useGrant);
    let started = false;
    h.handler = async () => {
      started = true;
      await effects.email({ to: 'ap@acme.test', subject: 'Should never go' }, sender);
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    let r: Awaited<ReturnType<typeof runOperation>>;
    try {
      const pending = run(edited('estimates.create', { dryRun: 'none' }), { body: estimateBody() }, 'commit', {
        approval: { approvedBy: null, requestId: null, grantId: randomUUID() },
      });
      await atGrant;
      await vi.advanceTimersByTimeAsync(IRREVERSIBLE_COMMIT_TIME_LIMIT_MS + 1_000);
      r = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(r.error).toMatchObject({ code: 'TIMEOUT', details: { mayStillFinish: true } });
    finish();
    await sleep(300);
    expect(started).toBe(false);
    expect(sender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave 4
// ---------------------------------------------------------------------------

/** A class of the company, inserted as `db` is (the bridge's transaction inside a handler). */
async function insertClass(on: DB, companyId: string, name: string): Promise<string> {
  const res = (await on.execute(sql`insert into classes (company_id, name) values (${companyId}, ${name}) returning id::text as id`)) as unknown as {
    rows: Array<{ id: string }>;
  };
  return res.rows[0].id;
}

describe('the staleness key leaves out what the run assigns to itself, and still moves when the books do', () => {
  const invoiceBody = () => ({
    customerId: rich.customerId,
    date: '2026-03-02',
    lines: [{ accountId: rich.acct['4000'], description: 'Consulting', quantity: '1', rate: '120.00' }],
  });
  const keyOf = async (id: string, body: unknown) => {
    const r = await run(op(id), { body }, 'dry_run');
    expect(r.outcome, `${id}: ${JSON.stringify(r.error)}`).toBe('ok');
    expect(r.stalenessKey, id).toMatch(/^[0-9a-f]{64}$/);
    return r.stalenessKey!;
  };

  it('two waiting requests that each take "the next number" do not make each other stale (estimate, purchase order, invoice, check, journal entry)', async () => {
    const checkBody = {
      vendorId: rich.vendorId,
      date: '2026-03-02',
      method: 'check',
      paymentAccountId: rich.acct['1000'],
      lines: [{ accountId: rich.acct['6300'], amount: '45.00' }],
    };
    const cases: Array<[string, unknown]> = [
      ['estimates.create', estimateBody()],
      ['purchase-orders.create', poBody()],
      ['invoices.create', invoiceBody()],
      // A check with no number takes the account's next check number (its `reference`, and its entry's).
      [operationForRoute('POST', '/api/expenses')!.id, checkBody],
      ['journal-entries.create', journalBody()],
    ];
    for (const [id, body] of cases) {
      const asked = await keyOf(id, body);
      // The other request is approved first: it takes the number this one would have taken.
      const first = await run(op(id), { body }, 'commit');
      expect(first.outcome, `${id}: ${JSON.stringify(first.error)}`).toBe('ok');
      expect(await keyOf(id, body), `${id}: the key moved with the next number`).toBe(asked);
    }
  });

  it("a posting elsewhere that touches none of the request's records changes nothing", async () => {
    const asked = await keyOf('journal-entries.create', journalBody());
    await postJournalEntry(admin, {
      date: new Date('2026-03-04'),
      description: 'Petty cash for postage',
      lines: [
        { accountId: rich.acct['6400'], debit: '12.00' },
        { accountId: rich.acct['1010'], credit: '12.00' },
      ],
    });
    expect(await keyOf('journal-entries.create', journalBody())).toBe(asked);
  });

  it('ids the run makes, wherever they show (a value, a source, a reference cut to 8 digits, a second kind on one id), do not move it', async () => {
    const probe = async () => {
      const ctx = await getServerContext();
      // A row the run inserts with no audit row of its own (an application, a first-use account).
      const rowId = await insertClass(ctx.db, ctx.companyId, 'Made by the run');
      const made = randomUUID();
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: made, newValues: { note: 'made', refNumber: 'P-0042' } });
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe_billing', entityId: made, newValues: { note: 'a second kind on the same id' } });
      await writeAudit(ctx, {
        action: 'update',
        entityType: 'customer',
        entityId: rich.customerId,
        oldValues: { phone: null },
        newValues: { phone: '555-0100', applicationId: rowId, source: `assembly_build:${randomUUID()}` },
      });
      await postJournalEntry(ctx, {
        date: new Date('2026-03-05'),
        description: `Probe P-0042 for ${made.slice(0, 8)}`,
        reference: made.slice(0, 8),
        sourceRef: `bridge_probe:${made}`,
        lines: [
          { accountId: rich.acct['6300'], debit: '40.00', memo: `Line of ${rowId}` },
          { accountId: rich.acct['1000'], credit: '40.00' },
        ],
      });
      return NextResponse.json({ id: made, rowId }, { status: 201 });
    };
    const keyed = async () => {
      h.handler = probe;
      const r = await run(op('journal-entries.create'), { body: { customerId: rich.customerId } }, 'dry_run');
      expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      return r.stalenessKey;
    };
    const a = await keyed();
    expect(await keyed()).toBe(a);

    // The record the run changes (and its input names), changed by someone else in between: another key.
    await db.execute(sql`update customers set updated_at = updated_at + interval '1 second' where id = ${rich.customerId}`);
    expect(await keyed()).not.toBe(a);
  });

  it('a row the run made that its created_at cannot tell is new (dated back, as FIFO\'s opening layer is) counts as made when an audit "create" names it', async () => {
    const probe = async () => {
      const ctx = await getServerContext();
      const id = await insertClass(ctx.db, ctx.companyId, 'Dated back');
      await ctx.db.execute(sql`update classes set created_at = created_at - interval '1 millisecond' where id = ${id}`);
      await writeAudit(ctx, { action: 'create', entityType: 'bridge_layer', entityId: id, newValues: { layers: [{ id, quantity: '1.0000' }] } });
      return NextResponse.json({ id }, { status: 201 });
    };
    const keys: Array<string | null> = [];
    for (let i = 0; i < 2; i++) {
      h.handler = probe;
      const r = await run(op('journal-entries.create'), { body: {} }, 'dry_run');
      expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      keys.push(r.stalenessKey);
    }
    expect(keys[1]).toBe(keys[0]);
  });

  /** The key of a dry run whose work is `probe` (a handler of its own). */
  const probeKey = async (probe: () => Promise<Response>) => {
    h.handler = probe;
    const r = await run(op('journal-entries.create'), { body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    return r.stalenessKey!;
  };
  /** A check the run makes (an audit 'create' with its number as `reference`) and its entry. */
  const checkProbe = (o: { number: string; entryReference: string; accountNumber?: string }) => async () => {
    const ctx = await getServerContext();
    const id = randomUUID();
    await writeAudit(ctx, {
      action: 'create',
      entityType: 'bridge_check',
      entityId: id,
      newValues: { reference: o.number, accountNumber: o.accountNumber ?? '000123456789', amount: '40.00' },
    });
    await postJournalEntry(ctx, {
      date: new Date('2026-03-05'),
      description: `Check ${o.number}`,
      reference: o.entryReference,
      sourceRef: `bridge_check:${id}`,
      lines: [
        { accountId: rich.acct['6300'], debit: '40.00' },
        { accountId: rich.acct['1000'], credit: '40.00' },
      ],
    });
    return NextResponse.json({ id }, { status: 201 });
  };

  it("the check number a run takes goes from its entry's reference too; a reference it copies, or a number it does not take, stays", async () => {
    // The next check number, on the check and its entry: another number, the same key.
    const took = await probeKey(checkProbe({ number: '1001', entryReference: '1001' }));
    expect(await probeKey(checkProbe({ number: '1002', entryReference: '1002' }))).toBe(took);
    // A reference the run copied from somewhere else (a bank line's check number): another one, another key.
    const copied = await probeKey(checkProbe({ number: '1001', entryReference: 'BANK-501' }));
    expect(await probeKey(checkProbe({ number: '1001', entryReference: 'BANK-502' }))).not.toBe(copied);
    // An account number the run copies onto what it makes is not a number it took: it counts.
    expect(await probeKey(checkProbe({ number: '1001', entryReference: '1001', accountNumber: '000999999999' }))).not.toBe(took);
  });

  it("times: the run's own time goes everywhere; a date on what it makes counts by its day; a time of a record that was there before counts as it is", async () => {
    const stamp = (values: { made?: Record<string, unknown>; existing?: Record<string, unknown> }) => async () => {
      const ctx = await getServerContext();
      if (values.made) await writeAudit(ctx, { action: 'create', entityType: 'bridge_probe', entityId: randomUUID(), newValues: values.made });
      if (values.existing) await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: rich.customerId, oldValues: {}, newValues: values.existing });
      return NextResponse.json({ ok: true });
    };
    const now = () => new Date().toISOString();
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    // The moment of the run itself, on a record that was there before (no "…At" key): no difference.
    const own = await probeKey(stamp({ existing: { lastStatementOn: now() } }));
    await sleep(15);
    expect(await probeKey(stamp({ existing: { lastStatementOn: now() } }))).toBe(own);
    // A time of a record that was there before, from before the run: it counts as it is.
    const before = await probeKey(stamp({ existing: { lastStatementOn: '2026-01-05T10:00:00.000Z' } }));
    expect(await probeKey(stamp({ existing: { lastStatementOn: '2026-01-05T10:00:01.000Z' } }))).not.toBe(before);
    // A due date the run works out from today, on what it makes: by its day, the same all day.
    const due = await probeKey(stamp({ made: { dueOn: inDays(30) } }));
    await sleep(15);
    expect(await probeKey(stamp({ made: { dueOn: inDays(30) } }))).toBe(due);
    // Another day on what it makes: another key.
    expect(await probeKey(stamp({ made: { dueOn: '2026-05-02T04:00:00.000Z' } }))).not.toBe(await probeKey(stamp({ made: { dueOn: '2026-05-01T04:00:00.000Z' } })));
  });

  it('an id of a row that was there before the run stays as it is: pointing at another one gives another key', async () => {
    const x = await insertClass(db, rich.ctx.companyId, 'Existing X');
    const y = await insertClass(db, rich.ctx.companyId, 'Existing Y');
    const linking = (classId: string) => async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: rich.customerId, oldValues: { classId: null }, newValues: { classId } });
      return NextResponse.json({ ok: true });
    };
    h.handler = linking(x);
    const toX = await run(op('customers.update'), { params: { id: rich.customerId }, body: {} }, 'dry_run');
    h.handler = linking(y);
    const toY = await run(op('customers.update'), { params: { id: rich.customerId }, body: {} }, 'dry_run');
    expect(toX.outcome, JSON.stringify(toX.error)).toBe('ok');
    expect(toY.outcome, JSON.stringify(toY.error)).toBe('ok');
    expect(toY.stalenessKey).not.toBe(toX.stalenessKey);
  });
});

describe('the amount, wave 4 rules', () => {
  const entry = async (amount: string, sourceRef: string) =>
    (
      await postJournalEntry(admin, {
        date: new Date('2026-03-06'),
        description: `Document ${sourceRef}`,
        sourceRef,
        lines: [
          { accountId: rich.acct['6300'], debit: amount },
          { accountId: rich.acct['1000'], credit: amount },
        ],
      })
    ).id;

  it('voiding one entry while posting an unrelated one counts both; an edit that re-posts the same document counts once', async () => {
    const { voidJournalEntry } = await import('@/lib/services/posting');
    const source = `probe_doc:${randomUUID()}`;
    const old = await entry('500.00', source);
    const voidAndPost = (sourceRef: string) => async () => {
      const ctx = await getServerContext();
      await voidJournalEntry(ctx, old);
      await postJournalEntry(ctx, {
        date: new Date('2026-03-06'),
        description: 'Posted by the run',
        sourceRef,
        lines: [
          { accountId: rich.acct['6300'], debit: '300.00' },
          { accountId: rich.acct['1000'], credit: '300.00' },
        ],
      });
      return NextResponse.json({ ok: true });
    };
    h.handler = voidAndPost(`probe_doc:${randomUUID()}`);
    const mixed = await run(op('journal-entries.update'), { params: { id: old }, body: {} }, 'dry_run');
    expect(mixed.outcome, JSON.stringify(mixed.error)).toBe('ok');
    expect(mixed.facts.amount).toBe('800.00');
    h.handler = voidAndPost(source);
    const edit = await run(op('journal-entries.update'), { params: { id: old }, body: {} }, 'dry_run');
    expect(edit.outcome, JSON.stringify(edit.error)).toBe('ok');
    expect(edit.facts.amount).toBe('500.00');
  });

  it('with an amount field too: a mixed run counts both sides; an edit of its own document, or a plain posting, the larger of the field and its largest entry', async () => {
    const { voidJournalEntry } = await import('@/lib/services/posting');
    const deposit = operationForRoute('PATCH', '/api/deposits/[id]')!;
    expect(deposit.amountField).toBe('total');
    const source = `probe_doc:${randomUUID()}`;
    const work = (o: { void: string | null; sourceRef: string }) => async () => {
      const ctx = await getServerContext();
      if (o.void) await voidJournalEntry(ctx, o.void);
      await postJournalEntry(ctx, {
        date: new Date('2026-03-06'),
        description: 'Posted by the run',
        sourceRef: o.sourceRef,
        lines: [
          { accountId: rich.acct['6300'], debit: '300.00' },
          { accountId: rich.acct['1000'], credit: '300.00' },
        ],
      });
      return NextResponse.json({ total: '100.00' });
    };
    const amountOf = async (handler: () => Promise<Response>, id: string) => {
      h.handler = handler;
      const r = await run(deposit, { params: { id }, body: { total: '100.00' } }, 'dry_run');
      expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
      return r.facts.amount;
    };
    const old = await entry('500.00', source);
    // Voids $500 of one document and posts $300 for another: $800.
    expect(await amountOf(work({ void: old, sourceRef: `probe_doc:${randomUUID()}` }), old)).toBe('800.00');
    // Voids its own document's $500 entry and re-posts it at $300: counted once, $500.
    expect(await amountOf(work({ void: old, sourceRef: source }), old)).toBe('500.00');
    // Posts $300 and voids nothing: the larger of the field ($100) and the entry, $300.
    expect(await amountOf(work({ void: null, sourceRef: `probe_doc:${randomUUID()}` }), old)).toBe('300.00');
  });

  it('a run that edits a record that existed and touches no entry has an unknown amount; one that only makes records has 0.00', async () => {
    const changed = await run(op('customers.update'), { params: { id: rich.customerId }, body: { phone: '555-0142' } }, 'dry_run');
    expect(changed.outcome, JSON.stringify(changed.error)).toBe('ok');
    expect(changed.preview!.ledger!.entries).toEqual([]);
    expect(changed.facts.amount).toBeNull();
    const madeOnly = await run(op('time-entries.create'), { body: timeBody() }, 'dry_run');
    expect(madeOnly.facts.amount).toBe('0.00');
  });

  it('an entry only named by an audit row of the run, and not written, is not shown as changed (an applied credit)', async () => {
    const id = await entry('75.00', `probe_doc:${randomUUID()}`);
    h.handler = async () => {
      const ctx = await getServerContext();
      const applicationId = await insertClass(ctx.db, ctx.companyId, 'An application');
      await writeAudit(ctx, { action: 'update', entityType: 'journal_entry', entityId: id, newValues: { action: 'apply_credit', applicationId } });
      return NextResponse.json({ ok: true });
    };
    const r = await run(op('journal-entries.update'), { params: { id }, body: {} }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(r.preview!.ledger!.entries).toEqual([]);
    // It changed what the entry's credit is applied to, with no entry to show its money: unknown.
    expect(r.facts.amount).toBeNull();
  });
});

describe("the preview carries the warnings the agent's flags accepted (plan §5.6)", () => {
  it('a dry run sent with a flag shows the warning the route gives without it, and keeps nothing', async () => {
    const ref = `W-${Date.now()}`;
    const first = await run(op('estimates.create'), { body: estimateBody(ref) }, 'commit');
    expect(first.outcome, JSON.stringify(first.error)).toBe('ok');
    const before = await fingerprint();
    const dry = await run(op('estimates.create'), { body: estimateBody(ref), confirm: ['allowDuplicateNumber'] }, 'dry_run');
    expect(dry.outcome, JSON.stringify(dry.error)).toBe('ok');
    expect(dry.preview!.warnings).toEqual([{ flag: 'allowDuplicateNumber', message: expect.stringMatching(/already used/i) }]);
    // The flag written into the body by the agent is the same yes.
    const inBody = await run(op('estimates.create'), { body: { ...estimateBody(ref), allowDuplicateNumber: true } }, 'dry_run');
    expect(inBody.outcome, JSON.stringify(inBody.error)).toBe('ok');
    expect(inBody.preview!.warnings.map((w) => w.flag)).toEqual(['allowDuplicateNumber']);
    expect(await fingerprint()).toEqual(before);
    // A flag the route did not need: no warning.
    const unneeded = await run(op('estimates.create'), { body: estimateBody(`W2-${Date.now()}`), confirm: ['allowDuplicateNumber'] }, 'dry_run');
    expect(unneeded.outcome, JSON.stringify(unneeded.error)).toBe('ok');
    expect(unneeded.preview!.warnings).toEqual([]);
  });
});

describe('the version the agent last read goes to the route (OperationInput.expectedUpdatedAt)', () => {
  const versionOf = async () => {
    const [c] = await db.select({ updatedAt: customers.updatedAt }).from(customers).where(eq(customers.id, rich.customerId));
    return c.updatedAt.toISOString();
  };

  it("as x-expected-updated-at on the handler's request and in the scope; an unreadable one is refused before anything runs", async () => {
    const seen: Out[] = [];
    h.handler = async (req) => {
      seen.push({ request: req.headers.get('x-expected-updated-at'), scope: (await requestHeaders()).get('x-expected-updated-at') });
      return NextResponse.json({ ok: true });
    };
    const v = '2026-11-22T14:05:09.123Z';
    const r = await run(op('customers.update'), { params: { id: rich.customerId }, body: { phone: '555-0150' }, expectedUpdatedAt: v }, 'dry_run');
    expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
    expect(seen).toEqual([{ request: v, scope: v }]);
    for (const bad of ['yesterday', '2026-11-22T14:05:09.123Z\r\nx-closing-password: 1', 42]) {
      h.handler = async () => NextResponse.json({ ok: true });
      const refused = await run(op('customers.update'), { params: { id: rich.customerId }, body: {}, expectedUpdatedAt: bad } as unknown as OperationInput, 'dry_run');
      expect(refused.outcome).toBe('error');
      expect(refused.error!.code).toBe('VALIDATION');
      expect(refused.httpStatus).toBe(0);
    }
    expect(seen).toHaveLength(1);
  });

  it("the route compares it inside the committing transaction: a person's edit in between answers 409, never an overwrite", async () => {
    const read = await versionOf();
    // A person edits the customer after the agent read it.
    await db.execute(sql`update customers set phone = '555-0177', updated_at = updated_at + interval '2 seconds' where id = ${rich.customerId}`);
    const stale = await run(op('customers.update'), { params: { id: rich.customerId }, body: { phone: '555-0199' }, expectedUpdatedAt: read }, 'commit');
    expect(stale.outcome).toBe('error');
    expect(stale.httpStatus).toBe(409);
    expect(stale.error!.code).toBe('CONFLICT');
    const [c] = await db.select({ phone: customers.phone }).from(customers).where(eq(customers.id, rich.customerId));
    expect(c.phone).toBe('555-0177');
    const fresh = await run(op('customers.update'), { params: { id: rich.customerId }, body: { phone: '555-0199' }, expectedUpdatedAt: await versionOf() }, 'commit');
    expect(fresh.outcome, JSON.stringify(fresh.error)).toBe('ok');
  });
});

describe("a run a person approved at the host computer counts as this computer's own for the route (the launch pass)", () => {
  const PASS = 'launch-pass-of-this-run-0123456789abcdef';

  it("only with an approval given at the host: the handler's request carries the pass, the scope never does, and nothing answered holds it", async () => {
    const { isRemoteRequest } = await import('@/lib/net/hostOnly');
    const owner = rich.ctx.userId!;
    const seen: Out[] = [];
    const spy = async (req: Request) => {
      seen.push({
        remote: isRemoteRequest(req as NextRequest),
        pass: req.headers.get('x-bka-launch'),
        scope: [...(await requestHeaders()).keys()],
        scopeRemote: (await getRequestOrigin()).remote,
      });
      return NextResponse.json({ ok: true });
    };
    process.env.BKA_LAUNCH_PASS = PASS;
    try {
      const approved = { userId: owner, approval: { approvedBy: owner, requestId: randomUUID(), grantId: null } };
      const cases: Array<Partial<BridgeActor>> = [{ ...approved, atHost: true }, { ...approved, atHost: false }, { atHost: true }];
      for (const over of cases) {
        h.handler = spy;
        const r = await run(op('customers.update'), { params: { id: rich.customerId }, body: {} }, 'dry_run', over);
        expect(r.outcome, JSON.stringify(r.error)).toBe('ok');
        expect(JSON.stringify(r)).not.toContain(PASS);
      }
    } finally {
      delete process.env.BKA_LAUNCH_PASS;
    }
    expect(seen.map((s) => [s.remote, s.pass])).toEqual([
      [false, PASS],
      [true, null],
      [true, null],
    ]);
    for (const s of seen) {
      expect(s.scope).not.toContain('x-bka-launch');
      expect(s.scopeRemote).toBe(true);
    }
  });
});

describe('ledger lines name who they are for and their class', () => {
  it('on the entries a run makes and on the ones it voids', async () => {
    const [cust] = await db.select({ name: customers.displayName }).from(customers).where(eq(customers.id, rich.customerId));
    const classId = await insertClass(db, rich.ctx.companyId, 'East Office');
    const lines = [
      { accountId: rich.acct['6300'], debit: '64.00', entityType: 'customer' as const, entityId: rich.customerId, classId },
      { accountId: rich.acct['1000'], credit: '64.00' },
    ];
    h.handler = async () => {
      const ctx = await getServerContext();
      const e = await postJournalEntry(ctx, { date: new Date('2026-03-07'), description: 'Named lines', lines });
      return NextResponse.json({ id: e.id }, { status: 201 });
    };
    const made = await run(op('journal-entries.create'), { body: {} }, 'dry_run');
    expect(made.outcome, JSON.stringify(made.error)).toBe('ok');
    expect(made.preview!.ledger!.entries[0].lines).toEqual([
      expect.objectContaining({ debit: '64.00', entityName: cust.name, entityType: 'customer', className: 'East Office' }),
      expect.objectContaining({ credit: '64.00', entityName: null, className: null }),
    ]);

    const existing = await postJournalEntry(admin, { date: new Date('2026-03-07'), description: 'Named lines to void', lines });
    const voided = await run(op('journal-entries.delete'), { params: { id: existing.id } }, 'dry_run');
    expect(voided.outcome, JSON.stringify(voided.error)).toBe('ok');
    const touched = voided.preview!.ledger!.entries.find((e) => e.journalEntryId === existing.id)!;
    expect(touched.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ debit: '64.00', entityName: cust.name, entityType: 'customer', className: 'East Office' })]),
    );
  });
});

describe('no agent may change or delete a role an agent holds (plan §4.6, D9)', () => {
  it('refused on a dry run and a commit, approved or not; a role no agent holds goes on', async () => {
    const everything = { access: fullAccess(), role: 'admin' as const };
    const owner = rich.ctx.userId!;
    const make = async (name: string) =>
      (
        (await db.execute(
          sql`insert into company_roles (company_id, name, permissions, flags) values (${rich.ctx.companyId}, ${name}, '{}'::jsonb, '{}'::jsonb) returning id::text as id`,
        )) as unknown as { rows: Array<{ id: string }> }
      ).rows[0].id;
    const held = await make('Held by an agent');
    const free = await make('Held by nobody');
    const holder = await createAgent(admin, { name: 'Role Holder', roleKeys: ['full_access'], preset: 'read_only' });
    await db.update(agents).set({ roleKeys: ['full_access', held] }).where(eq(agents.id, holder.agent.id));
    let ran = 0;
    const spy = async () => {
      ran++;
      return NextResponse.json({ ok: true });
    };
    const approved = { ...everything, userId: owner, approval: { approvedBy: owner, requestId: randomUUID(), grantId: null } };
    const ways: Array<['dry_run' | 'commit', Partial<BridgeActor>]> = [
      ['dry_run', everything],
      ['commit', everything],
      ['commit', approved],
    ];
    const asks: Array<[string, OperationInput]> = [
      ['roles.update', { params: { id: held }, body: { name: 'Wider' } }],
      ['roles.delete', { params: { id: held } }],
    ];
    for (const [id, input] of asks) {
      for (const [mode, over] of ways) {
        h.handler = spy;
        const r = await run(op(id), input, mode, over);
        expect(r.outcome, `${id} ${mode}`).toBe('error');
        expect(r.error!.code).toBe('FORBIDDEN');
        expect(r.error!.message).toMatch(/No agent may change or delete the role "Held by an agent": an agent holds it/);
        expect(r.error!.details).toMatchObject({ hardFloor: true });
      }
    }
    expect(ran).toBe(0);

    // The role route reads the id as a uuid, which takes upper case, braces and no hyphens alike:
    // each of them names the same held role, and is refused the same way.
    for (const written of [held.toUpperCase(), `{${held}}`, held.replace(/-/g, ''), `{${held.replace(/-/g, '').toUpperCase()}}`]) {
      for (const id of ['roles.update', 'roles.delete']) {
        h.handler = spy;
        const r = await run(op(id), { params: { id: written }, ...(id === 'roles.update' ? { body: { name: 'Wider' } } : {}) }, 'commit', approved);
        expect(r.outcome, `${id} ${written}`).toBe('error');
        expect(r.error!.code, `${id} ${written}`).toBe('FORBIDDEN');
        expect(r.error!.message).toMatch(/No agent may change or delete the role "Held by an agent": an agent holds it/);
        expect(r.error!.details).toMatchObject({ hardFloor: true, roleHeldByAgent: held.toLowerCase() });
      }
    }
    // A key stored in another case is the same role too.
    await db.update(agents).set({ roleKeys: ['full_access', held.toUpperCase()] }).where(eq(agents.id, holder.agent.id));
    h.handler = spy;
    const stored = await run(op('roles.delete'), { params: { id: held } }, 'commit', approved);
    expect(stored.error?.details).toMatchObject({ hardFloor: true });
    expect(ran).toBe(0);

    h.handler = spy;
    const other = await run(op('roles.update'), { params: { id: free }, body: { name: 'Fine' } }, 'commit', everything);
    expect(other.outcome, JSON.stringify(other.error)).toBe('ok');
    expect(ran).toBe(1);
  });
});
