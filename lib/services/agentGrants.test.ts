/**
 * Agent full access: standing permission (lib/services/agentGrants.ts; plan 4.4, 4.5, 11.2; D3, D5).
 *
 * On a real company database:
 *  - only a signed-in person gives a grant, never an agent; only for classes that may have one,
 *    never longer than the class allows (end of the company's day, or 30 minutes), only by someone
 *    whose own role may do it, for outside sends only by an Admin, and for bulk work only with a
 *    count limit within the agent's own. Every refusal stores nothing. A grant is audited.
 *  - the limits are stored cleaned (known keys only, one shape) and the policy engine reads them;
 *  - a live grant is unexpired, unrevoked, not used up, its agent neither removed nor paused, and
 *    its giver still an active member whose role allows the work (an Admin, for outside sends);
 *  - a use is counted inside the run's transaction: a rolled-back run gives it back, and two runs
 *    racing for the last use cannot both have it (PGlite runs transactions one after another, so
 *    this shows the outcome, not the locking; Ironbooks runs on PGlite);
 *  - only the giver, or someone who may manage agents, takes a grant back; never an agent, nor
 *    anything running inside an agent's bridged run.
 *
 * The agent's bulk count limit comes from the real policy store (lib/services/agentPolicies.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-grants');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-grants-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

import { getDb, closeDb, type DB } from '@/lib/db';
import {
  agentGrants,
  agentPermissionRequests,
  agents,
  auditLogs,
  companies,
  companyRoles,
  userCompanies,
  userRoleAssignments,
  users,
} from '@/lib/db/schema';
import { builtinRole, fullAccess, unionRoles, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import { allOperations, operationById } from '@/lib/agent/operations/registry';
import { DEFAULT_BULK_CAP, grantCovers, roleAllows } from '@/lib/agent/policy';
import { GRANTABLE, type Operation, type RequestFacts } from '@/lib/agent/operations/types';
import { runWithServiceContext } from '@/lib/serviceScope';
import { createCompany } from './company';
import { ServiceError, inTransaction, type ServiceContext } from './_base';
import { createGrant, grantMinutesFor, listGrants, liveGrants, revokeGrant, useGrant } from './agentGrants';

let db: DB;
let companyId: string;
let otherCompanyId: string;
let admin: ServiceContext;
let bookkeeper: ServiceContext;
let apClerk: ServiceContext;
let usersManager: ServiceContext;
let agentManager: ServiceContext;
let rolesEditor: ServiceContext;
let secondAdmin: ServiceContext;
let otherAdmin: ServiceContext;
let adminId: string;
let bookkeeperId: string;
let secondAdminId: string;
let agentId: string;
let secondAgentId: string;
let otherCompanyAgentId: string;
let agentCtx: ServiceContext;

const FACTS: RequestFacts = {
  confirm: [],
  reveal: false,
  amount: '200.00',
  count: null,
  entityIds: [],
  accountIds: [],
  date: '2026-11-20',
  closedPeriod: false,
};
const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({ ...FACTS, ...over });

const CUSTOMER = '6f1c2a54-0a9e-4c43-9a51-3c3a1d2b7e10';
const CUSTOMER_2 = '0b3e5d2c-7f61-4a9d-8e2b-5a4c3d2e1f00';

function op(id: string): Operation {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
}

function pick(what: string, pred: (o: Operation) => boolean): Operation {
  const found = allOperations().find(pred);
  if (!found) throw new Error(`no operation that is ${what}`);
  return found;
}

const usable = (o: Operation) => o.availability === 'agent' && o.classified && !o.alwaysAsk && !o.hostOnly && !o.fileAdmin;

let ENTER: Operation;
let OUTSIDE: Operation;
let READ: Operation;
let REMOVE: Operation;
let BULK: Operation;
let ALWAYS_ASKS: Operation;
let HOST_ONLY: Operation;
let HARD_FLOOR: Operation;
let PERSON_ONLY: Operation;

async function expectError(p: Promise<unknown>, code: string, message?: RegExp): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code, (e as Error).message).toBe(code);
    if (message) expect((e as ServiceError).message).toMatch(message);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

async function grantCount(): Promise<number> {
  return (await db.select({ id: agentGrants.id }).from(agentGrants)).length;
}

async function row(id: string) {
  const [r] = await db.select().from(agentGrants).where(eq(agentGrants.id, id));
  return r;
}

async function addAgent(company: string, name: string): Promise<string> {
  const [a] = await db
    .insert(agents)
    .values({ companyId: company, name, roleKeys: ['bookkeeper'], tokenHash: randomBytes(32).toString('hex'), tokenPrefix: 'ibka_test' })
    .returning();
  return a.id;
}

function person(userId: string, access: EffectiveAccess, company = companyId): ServiceContext {
  return { db, companyId: company, userId, role: access.isAdmin ? 'owner' : 'accountant', access };
}

/** A plain enter grant from the Admin, for the tests that use or list one. */
async function enterGrant(over: { minutes?: number; constraints?: Record<string, unknown>; agent?: string; by?: ServiceContext } = {}) {
  return createGrant(over.by ?? admin, facts(), {
    agentId: over.agent ?? agentId,
    operation: ENTER.id,
    constraints: (over.constraints ?? {}) as never,
    minutes: over.minutes ?? 60,
    requestId: null,
  });
}

/** Fix the clock (Date only: PGlite's own timers keep running). */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

async function setCompanySettings(id: string, settings: Record<string, unknown>) {
  await db.update(companies).set({ settings }).where(eq(companies.id, id));
}

function customRole(key: string, permissions: PermissionGrant) {
  return unionRoles([{ key, name: key, description: '', builtin: false, permissions, flags: {} }]);
}

/** A member of the test company in the file, with these built-in roles (what resolveAccess reads). */
async function addMember(userId: string, roleKeys: string[]) {
  await db.insert(userCompanies).values({ userId, companyId });
  await setRoles(userId, roleKeys);
}

async function setRoles(userId: string, roleKeys: string[]) {
  const mine = and(eq(userRoleAssignments.userId, userId), eq(userRoleAssignments.companyId, companyId));
  await db.delete(userRoleAssignments).where(mine);
  if (roleKeys.length) await db.insert(userRoleAssignments).values(roleKeys.map((roleKey) => ({ userId, companyId, roleKey })));
}

async function setActive(userId: string, isActive: boolean) {
  await db.update(userCompanies).set({ isActive }).where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)));
}

/** The agent's own context, for using its grants. */
function agentContext(id: string, name: string): ServiceContext {
  return { ...agentCtx, agent: { ...agentCtx.agent!, id, name } };
}

/** The limits on the agent's row that the real policy store reads. */
async function setAgentLimits(id: string, limits: { preset?: string; bulkCap?: number | null }) {
  await db.update(agents).set(limits).where(eq(agents.id, id));
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const mk = async (email: string, name: string) => (await db.insert(users).values({ email, name, passwordHash: 'x' }).returning())[0];
  const owner = await mk('admin@grants.test', 'Ada Admin');
  const bk = await mk('bk@grants.test', 'Bo Bookkeeper');
  const ap = await mk('ap@grants.test', 'Al Payables');
  const um = await mk('um@grants.test', 'Uma Users');
  const am = await mk('am@grants.test', 'Mo Manager');
  const re = await mk('re@grants.test', 'Rae Roles');
  const a2 = await mk('a2@grants.test', 'Di Second');
  const other = await mk('other@grants.test', 'Otto Other');
  adminId = owner.id;
  bookkeeperId = bk.id;
  secondAdminId = a2.id;
  const company = await createCompany(db, { name: 'Grants Co', ownerId: owner.id, settings: { timezone: 'America/New_York' } });
  companyId = company.id;
  const otherCompany = await createCompany(db, { name: 'Other Co', ownerId: other.id, settings: { timezone: 'America/New_York' } });
  otherCompanyId = otherCompany.id;
  // Members in the file too, as the sign-in reads them: a grant stands only while its giver is one.
  await addMember(bk.id, ['bookkeeper']);
  await addMember(ap.id, ['ap_clerk']);
  await addMember(a2.id, ['admin']);

  admin = person(owner.id, fullAccess());
  bookkeeper = person(bk.id, unionRoles([builtinRole('bookkeeper')!]));
  apClerk = person(ap.id, unionRoles([builtinRole('ap_clerk')!]));
  secondAdmin = person(a2.id, fullAccess());
  // Not an Admin, but may change all of Users & Roles.
  usersManager = person(um.id, customRole('users-manager', { users: ['full'] }));
  // May manage users and agents (pause, remove), but not edit roles.
  agentManager = person(am.id, customRole('agent-manager', { 'users.users': ['full'] }));
  // May edit roles, but not manage users or agents.
  rolesEditor = person(re.id, customRole('roles-editor', { 'users.roles': ['full'] }));
  otherAdmin = person(other.id, fullAccess(), otherCompanyId);

  agentId = await addAgent(companyId, 'Month-end helper');
  secondAgentId = await addAgent(companyId, 'Second helper');
  otherCompanyAgentId = await addAgent(otherCompanyId, 'Other helper');
  agentCtx = {
    db,
    companyId,
    userId: null,
    role: 'accountant',
    access: unionRoles([builtinRole('bookkeeper')!]),
    agent: { id: agentId, name: 'Month-end helper', mode: 'post', preset: 'trusted_bookkeeper', onBehalfOf: adminId },
  };

  ENTER = op('invoices.create');
  OUTSIDE = op('invoices.email');
  READ = op('invoices.list');
  HARD_FLOOR = op('agents.create');
  PERSON_ONLY = op('auth.login');
  REMOVE = pick('removing for good', (o) => o.class === 'remove' && usable(o));
  BULK = pick('bulk work', (o) => o.class === 'bulk' && usable(o));
  ALWAYS_ASKS = pick('always asking', (o) => o.alwaysAsk && o.availability === 'agent' && o.classified && GRANTABLE[o.class] !== 'no' && !o.hostOnly);
  HOST_ONLY = pick('host only', (o) => o.hostOnly && o.availability === 'agent' && o.classified && !o.alwaysAsk && GRANTABLE[o.class] !== 'no');
});

// 10:00 in New York, so no test meets the end of the company's day unless it means to.
beforeEach(() => at('2026-11-20T15:00:00.000Z'));

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the operations these tests stand on', () => {
  it('are what the registry says', () => {
    expect(ENTER).toMatchObject({ class: 'enter', availability: 'agent', classified: true, alwaysAsk: false, hostOnly: false });
    expect(OUTSIDE).toMatchObject({ class: 'outside', availability: 'agent', hostOnly: false });
    expect(READ.class).toBe('read');
    expect(HARD_FLOOR.availability).toBe('hard_floor');
    expect(PERSON_ONLY.availability).toBe('person_only');
    expect(roleAllows(bookkeeper.access!, ENTER)).toBe(true);
    expect(roleAllows(apClerk.access!, ENTER)).toBe(false);
    expect(roleAllows(admin.access!, BULK)).toBe(true);
  });
});

describe('giving standing permission', () => {
  it('stores the grant with its limits cleaned, and audits it under the person', async () => {
    const before = Date.now();
    const g = await createGrant(bookkeeper, facts({ entityIds: [CUSTOMER] }), {
      agentId,
      operation: ENTER.id,
      constraints: {
        entityIds: [CUSTOMER.toUpperCase(), CUSTOMER],
        maxAmount: 250,
        dateFrom: '2026-11-01',
        dateTo: '2026-11-30T12:00:00Z',
        maxUses: 3,
        accountIds: null,
        // Not a limit Ironbooks knows: the card never showed it, so it is not stored.
        customerName: 'Acme',
      } as never,
      minutes: 60,
      requestId: null,
    });
    expect(g).toMatchObject({ agentId, operation: ENTER.id, givenBy: bookkeeperId, revokedAt: null, uses: 0 });
    expect(Date.parse(g.expiresAt) - before).toBe(60 * 60_000);
    expect(g.constraints).toEqual({
      entityIds: [CUSTOMER],
      maxAmount: '250.00',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      maxUses: 3,
    });

    const stored = await row(g.id);
    expect(stored).toMatchObject({ companyId, class: 'enter', givenBy: bookkeeperId, requestId: null, uses: 0, revokedAt: null });
    expect(stored.constraints).toEqual(g.constraints);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'agent_grant'), eq(auditLogs.entityId, g.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'create', userId: bookkeeperId, agentId: null, companyId });
    expect(audit[0].newValues).toMatchObject({ agentId, agentName: 'Month-end helper', operation: ENTER.id, class: 'enter', minutes: 60 });

    // The engine reads what was stored: a request within the limits is covered, one outside is not.
    const now = new Date().toISOString();
    expect(grantCovers(g, ENTER, facts({ entityIds: [CUSTOMER] }), now)).toBe(true);
    expect(grantCovers(g, ENTER, facts({ entityIds: [CUSTOMER_2] }), now)).toBe(false);
    expect(grantCovers(g, ENTER, facts({ entityIds: [CUSTOMER], amount: '250.01' }), now)).toBe(false);
  });

  it('keeps the request it was given with, when it is this agent’s request for this operation', async () => {
    const mkRequest = async (agent: string, operation: string) =>
      (
        await db
          .insert(agentPermissionRequests)
          .values({
            companyId,
            agentId: agent,
            requestKey: randomBytes(8).toString('hex'),
            operation,
            class: 'enter',
            summary: 'Enter an invoice',
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .returning()
      )[0].id;
    const mine = await mkRequest(agentId, ENTER.id);
    const g = await createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 30, requestId: mine });
    expect((await row(g.id)).requestId).toBe(mine);

    const count = await grantCount();
    const someoneElses = await mkRequest(secondAgentId, ENTER.id);
    await expectError(
      createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 30, requestId: someoneElses }),
      'VALIDATION',
      /was not found for this agent/,
    );
    const otherWork = await mkRequest(agentId, OUTSIDE.id);
    await expectError(
      createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 30, requestId: otherWork }),
      'VALIDATION',
    );
    await expectError(
      createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 30, requestId: 'not-a-request' }),
      'VALIDATION',
    );
    expect(await grantCount()).toBe(count);
  });

  describe('refuses, and stores nothing', () => {
    let count: number;
    beforeEach(async () => {
      count = await grantCount();
    });
    afterEach(async () => {
      expect(await grantCount()).toBe(count);
    });
    const give = (ctx: ServiceContext, operation: Operation, over: Partial<{ minutes: number; constraints: unknown; agentId: string }> = {}, f = facts()) =>
      createGrant(ctx, f, {
        agentId: over.agentId ?? agentId,
        operation: operation.id,
        constraints: (over.constraints ?? {}) as never,
        minutes: over.minutes ?? 30,
        requestId: null,
      });

    it('an agent, even for itself', async () => {
      await expectError(give(agentCtx, ENTER), 'FORBIDDEN', /An agent can never give standing permission/);
    });

    it('a context with no signed-in person, or without the person’s permissions', async () => {
      await expectError(give({ ...admin, userId: null }, ENTER), 'FORBIDDEN', /signed-in person/);
      await expectError(give({ ...admin, access: undefined }, ENTER), 'FORBIDDEN', /could not read your permissions/);
    });

    it('work Ironbooks does not know, or that agents can never do', async () => {
      await expectError(createGrant(admin, facts(), { agentId, operation: 'no.such.thing', constraints: {}, minutes: 30, requestId: null }), 'VALIDATION');
      await expectError(give(admin, HARD_FLOOR), 'FORBIDDEN', /Agents can never do this/);
      await expectError(give(admin, PERSON_ONLY), 'FORBIDDEN', /Agents can never do this/);
    });

    it('classes that are asked one by one (D3)', async () => {
      await expectError(give(admin, READ), 'FORBIDDEN', /"Read" work/);
      await expectError(give(admin, REMOVE), 'FORBIDDEN', /"Delete for good" work/);
      // A request raised to a class that is never standing: closed-period work, a reveal (D6).
      await expectError(give(admin, ENTER, {}, facts({ closedPeriod: true })), 'FORBIDDEN', /"Closed-period work"/);
      await expectError(give(admin, ENTER, {}, facts({ reveal: true })), 'FORBIDDEN', /one request at a time/);
      await expectError(give(admin, ALWAYS_ASKS), 'FORBIDDEN', /always asks a person/);
      await expectError(give(admin, HOST_ONLY), 'FORBIDDEN', /computer that holds the company file/);
    });

    it('outside sends from anyone but an Admin (D5)', async () => {
      await expectError(give(bookkeeper, OUTSIDE), 'FORBIDDEN', /Only an Admin/);
    });

    it('a person whose own role does not allow the work', async () => {
      await expectError(give(apClerk, ENTER), 'FORBIDDEN', /Your own role does not allow this/);
    });

    it('a time that is not whole minutes, or longer than the class allows', async () => {
      for (const minutes of [0, -5, 1.5, Number.NaN, '30' as unknown as number]) {
        await expectError(give(admin, ENTER, { minutes }), 'VALIDATION', /whole minutes/);
      }
      // 10:00: fourteen hours to the end of the day; an outside send gets 30 minutes at most.
      await expectError(give(admin, ENTER, { minutes: 14 * 60 + 1 }), 'VALIDATION', /at most 840 minutes from now \(until the end of the day\)/);
      await expectError(give(admin, OUTSIDE, { minutes: 31 }), 'VALIDATION', /at most 30 minutes from now\. /);
    });

    it('bulk work without a count limit, or with one above the agent’s', async () => {
      try {
        await setAgentLimits(agentId, { bulkCap: 50 });
        await expectError(give(admin, BULK), 'VALIDATION', /how many records one request may change/);
        await expectError(give(admin, BULK, { constraints: { maxCount: 51 } }), 'VALIDATION', /at most 50 records/);
        // An agent with no limit of its own (its preset does not allow bulk work) is held to the default one.
        await setAgentLimits(agentId, { bulkCap: null });
        await expectError(give(admin, BULK, { constraints: { maxCount: DEFAULT_BULK_CAP + 1 } }), 'VALIDATION', new RegExp(`at most ${DEFAULT_BULK_CAP} records`));
        // "Full, with asks" allows bulk work, so the policy store gives it the default limit.
        await setAgentLimits(agentId, { preset: 'full_with_asks', bulkCap: null });
        await expectError(give(admin, BULK, { constraints: { maxCount: DEFAULT_BULK_CAP + 1 } }), 'VALIDATION', new RegExp(`at most ${DEFAULT_BULK_CAP} records`));
      } finally {
        await setAgentLimits(agentId, { preset: 'ask_every_change', bulkCap: null });
      }
    });

    it('anything running inside an agent’s bridged run, whatever context it was handed', async () => {
      await expectError(
        runWithServiceContext(agentCtx, { path: '/api/agents', method: 'POST' }, () => give(admin, ENTER)),
        'FORBIDDEN',
        /An agent can never give standing permission/,
      );
      expect(await runWithServiceContext(agentCtx, { path: '/api/agents', method: 'GET' }, () => grantMinutesFor(admin, ENTER.id, facts()))).toBe(0);
    });

    it('limits that cannot be read', async () => {
      const bad: Array<[unknown, RegExp]> = [
        ['everything', /could not be read/],
        [{ entityIds: CUSTOMER }, /list of record ids/],
        [{ entityIds: ['acme'] }, /list of record ids/],
        [{ entityIds: [] }, /at least one customer/],
        [{ accountIds: [42] }, /list of account ids/],
        [{ maxAmount: '-1' }, /largest amount/],
        [{ maxAmount: '1e5' }, /largest amount/],
        [{ maxAmount: '10.005' }, /largest amount/],
        [{ maxAmount: Number.POSITIVE_INFINITY }, /largest amount/],
        [{ dateFrom: '2026-02-30' }, /first date/],
        [{ dateTo: 'tomorrow' }, /last date/],
        [{ dateFrom: '2026-12-01', dateTo: '2026-11-30' }, /Swap them/],
        [{ maxUses: 0 }, /whole number, 1 or more/],
        [{ maxUses: 2.5 }, /whole number, 1 or more/],
        [{ maxCount: -1 }, /whole number, 1 or more/],
      ];
      for (const [constraints, message] of bad) {
        await expectError(give(admin, ENTER, { constraints }), 'VALIDATION', message);
      }
    });

    it('an agent that is unknown, of another company, or removed', async () => {
      await expectError(give(admin, ENTER, { agentId: '00000000-0000-4000-8000-000000000000' }), 'NOT_FOUND');
      await expectError(give(admin, ENTER, { agentId: 'agent-1' }), 'NOT_FOUND');
      await expectError(give(admin, ENTER, { agentId: otherCompanyAgentId }), 'NOT_FOUND');
      const removed = await addAgent(companyId, 'Removed helper');
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, removed));
      count = await grantCount();
      await expectError(give(admin, ENTER, { agentId: removed }), 'VALIDATION', /has been removed/);
    });
  });

  it('gives bulk work a count limit within the agent’s own', async () => {
    const bulk = (maxCount: number) =>
      createGrant(admin, facts({ count: 20 }), { agentId, operation: BULK.id, constraints: { maxCount }, minutes: 60, requestId: null });
    try {
      await setAgentLimits(agentId, { bulkCap: 50 });
      const g = await bulk(50);
      expect(g.constraints).toEqual({ maxCount: 50 });
      expect((await row(g.id)).class).toBe('bulk');
      await setAgentLimits(agentId, { preset: 'full_with_asks', bulkCap: null });
      expect((await bulk(DEFAULT_BULK_CAP)).constraints.maxCount).toBe(DEFAULT_BULK_CAP);
      // A paused agent can still be given one (it runs nothing until it is turned back on).
      await setAgentLimits(agentId, { bulkCap: 75 });
      await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, agentId));
      expect((await bulk(75)).constraints.maxCount).toBe(75);
    } finally {
      await db.update(agents).set({ pausedAt: null, preset: 'ask_every_change', bulkCap: null }).where(eq(agents.id, agentId));
    }
  });

  it('is stored under the operation’s own class, the only one it ever covers', async () => {
    // Approving a request resent with a "yes, I am sure" flag (judged as a change).
    const g = await createGrant(admin, facts({ confirm: ['allowDuplicateNumber'] }), {
      agentId,
      operation: ENTER.id,
      constraints: {},
      minutes: 60,
      requestId: null,
    });
    expect((await row(g.id)).class).toBe('enter');
    const now = new Date().toISOString();
    expect(grantCovers(g, ENTER, facts(), now)).toBe(true);
    expect(grantCovers(g, ENTER, facts({ confirm: ['allowDuplicateNumber'] }), now)).toBe(false);
  });

  it('lets an Admin give outside sends a short window', async () => {
    const g = await createGrant(admin, facts(), { agentId, operation: OUTSIDE.id, constraints: {}, minutes: 30, requestId: null });
    expect((await row(g.id)).class).toBe('outside');
    expect(Date.parse(g.expiresAt) - Date.now()).toBe(30 * 60_000);
  });
});

describe('the end of the company’s day', () => {
  it('limits every window, in the company’s own time zone', async () => {
    at('2026-11-20T04:30:00.000Z'); // 23:30 on the 19th in New York, 13:30 in Tokyo
    expect(await grantMinutesFor(admin, ENTER.id, facts())).toBe(30);
    expect(await grantMinutesFor(admin, OUTSIDE.id, facts())).toBe(30);
    await expectError(
      createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 31, requestId: null }),
      'VALIDATION',
      /at most 30 minutes from now \(until the end of the day\)/,
    );
    const g = await createGrant(admin, facts(), { agentId, operation: ENTER.id, constraints: {}, minutes: 30, requestId: null });
    expect(g.expiresAt).toBe('2026-11-20T05:00:00.000Z');

    await setCompanySettings(companyId, { timezone: 'Asia/Tokyo' });
    try {
      expect(await grantMinutesFor(admin, ENTER.id, facts())).toBe(630);
      expect(await grantMinutesFor(admin, OUTSIDE.id, facts())).toBe(30);
    } finally {
      await setCompanySettings(companyId, { timezone: 'America/New_York' });
    }
  });

  it('offers nothing to an agent, a person who may not, or a class asked one by one', async () => {
    at('2026-11-20T15:00:00.000Z');
    expect(await grantMinutesFor(admin, ENTER.id, facts())).toBe(14 * 60);
    expect(await grantMinutesFor(agentCtx, ENTER.id, facts())).toBe(0);
    expect(await grantMinutesFor(apClerk, ENTER.id, facts())).toBe(0);
    expect(await grantMinutesFor(bookkeeper, OUTSIDE.id, facts())).toBe(0);
    expect(await grantMinutesFor(admin, REMOVE.id, facts())).toBe(0);
    expect(await grantMinutesFor(admin, ENTER.id, facts({ reveal: true }))).toBe(0);
  });
});

describe('live grants', () => {
  it('are unexpired, unrevoked and not used up', async () => {
    const fresh = await enterGrant({ minutes: 60, agent: secondAgentId });
    const usedUp = await enterGrant({ constraints: { maxUses: 1 }, agent: secondAgentId });
    const revoked = await enterGrant({ agent: secondAgentId });
    await inTransaction(admin, (tx) => useGrant(tx, usedUp.id));
    await revokeGrant(admin, revoked.id);

    const ids = (await liveGrants(admin, secondAgentId)).map((g) => g.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(usedUp.id);
    expect(ids).not.toContain(revoked.id);

    // An hour on, the fresh one has expired too.
    const later = new Date(Date.parse(fresh.expiresAt) + 1);
    expect((await liveGrants(admin, secondAgentId, later)).map((g) => g.id)).not.toContain(fresh.id);
    expect(await liveGrants(admin, secondAgentId, new Date(Number.NaN))).toEqual([]);
  });

  it('stop when the agent is removed or paused, or every agent of the company is', async () => {
    const helper = await addAgent(companyId, 'Short-lived helper');
    const g = await enterGrant({ agent: helper });
    expect((await liveGrants(admin, helper)).map((x) => x.id)).toEqual([g.id]);

    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, helper));
    expect(await liveGrants(admin, helper)).toEqual([]);
    await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, helper));

    await setCompanySettings(companyId, { timezone: 'America/New_York', integratedAppsBlocked: true });
    expect(await liveGrants(admin, helper)).toEqual([]);
    await setCompanySettings(companyId, { timezone: 'America/New_York' });
    expect(await liveGrants(admin, helper)).toHaveLength(1);

    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, helper));
    expect(await liveGrants(admin, helper)).toEqual([]);
  });

  it('an agent sees only its own, and another company’s are never seen', async () => {
    const g = await enterGrant();
    expect((await liveGrants(agentCtx, agentId)).map((x) => x.id)).toContain(g.id);
    await expectError(liveGrants(agentCtx, secondAgentId), 'FORBIDDEN', /its own/);
    expect(await liveGrants(otherAdmin, agentId)).toEqual([]);
    expect(await liveGrants(admin, 'not-an-agent')).toEqual([]);
  });
});

describe('the person who gave it', () => {
  const live = async (agent: string) => (await liveGrants(admin, agent)).map((g) => g.id);
  const uses = async (id: string) => (await row(id)).uses;

  it('takes it with them when deactivated or removed from the company', async () => {
    const helper = await addAgent(companyId, 'Giver helper');
    const helperCtx = agentContext(helper, 'Giver helper');
    const g = await enterGrant({ agent: helper, by: bookkeeper });
    expect(await live(helper)).toEqual([g.id]);
    await inTransaction(helperCtx, (tx) => useGrant(tx, g.id));

    await setActive(bookkeeperId, false);
    try {
      expect(await live(helper)).toEqual([]);
      await expectError(inTransaction(helperCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN', /has ended/);
    } finally {
      await setActive(bookkeeperId, true);
    }
    // Turned back on the same day: it was never taken back, so it stands again.
    expect(await live(helper)).toEqual([g.id]);

    await db.delete(userCompanies).where(and(eq(userCompanies.userId, bookkeeperId), eq(userCompanies.companyId, companyId)));
    try {
      expect(await live(helper)).toEqual([]);
      await expectError(inTransaction(helperCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN', /has ended/);
    } finally {
      await db.insert(userCompanies).values({ userId: bookkeeperId, companyId });
    }
    expect(await uses(g.id)).toBe(1);
    // Still listed, so a person can take it back.
    expect((await listGrants(admin, { agentId: helper, live: true })).map((x) => x.id)).toEqual([g.id]);
  });

  it('takes it with them when their role no longer allows the work', async () => {
    const helper = await addAgent(companyId, 'Role helper');
    const g = await enterGrant({ agent: helper, by: bookkeeper });
    expect(await live(helper)).toEqual([g.id]);
    await setRoles(bookkeeperId, ['ap_clerk']);
    try {
      expect(await live(helper)).toEqual([]);
    } finally {
      await setRoles(bookkeeperId, ['bookkeeper']);
    }
    expect(await live(helper)).toEqual([g.id]);
  });

  it('keeps an outside send standing only while its giver is an Admin (D5)', async () => {
    const helper = await addAgent(companyId, 'Outside helper');
    const g = await createGrant(secondAdmin, facts(), { agentId: helper, operation: OUTSIDE.id, constraints: {}, minutes: 30, requestId: null });
    expect(await live(helper)).toEqual([g.id]);
    // A role that may send the invoice itself, but is not the Admin role.
    const sender = customRole('invoice-sender', { customers: ['full'] });
    expect(roleAllows(sender, OUTSIDE)).toBe(true);
    const [role] = await db
      .insert(companyRoles)
      .values({ companyId, name: 'Invoice sender', description: '', permissions: { customers: ['full'] }, flags: {} })
      .returning();
    await setRoles(secondAdminId, [role.id]);
    try {
      expect(await live(helper)).toEqual([]);
    } finally {
      await setRoles(secondAdminId, ['admin']);
    }
    expect(await live(helper)).toEqual([g.id]);
  });

  it('the company’s owner stands with no membership row, as the sign-in reads it', async () => {
    const helper = await addAgent(companyId, 'Owner helper');
    const g = await enterGrant({ agent: helper });
    const ownerRow = and(eq(userCompanies.userId, adminId), eq(userCompanies.companyId, companyId));
    const [saved] = await db.select().from(userCompanies).where(ownerRow);
    await db.delete(userCompanies).where(ownerRow);
    try {
      expect(await live(helper)).toEqual([g.id]);
      await inTransaction(agentContext(helper, 'Owner helper'), (tx) => useGrant(tx, g.id));
    } finally {
      await db.insert(userCompanies).values(saved);
    }
    expect(await uses(g.id)).toBe(1);
  });
});

describe('using a grant', () => {
  const uses = async (id: string) => (await row(id)).uses;

  it('counts one use in the caller’s transaction', async () => {
    const g = await enterGrant();
    await inTransaction(agentCtx, (tx) => useGrant(tx, g.id));
    await inTransaction(agentCtx, (tx) => useGrant(tx, g.id));
    expect(await uses(g.id)).toBe(2);
  });

  it('gives the use back when the run rolls back', async () => {
    const g = await enterGrant({ constraints: { maxUses: 1 } });
    await expect(
      inTransaction(agentCtx, async (tx) => {
        await useGrant(tx, g.id);
        expect((await tx.db.select().from(agentGrants).where(eq(agentGrants.id, g.id)))[0].uses).toBe(1);
        throw new Error('the run failed');
      }),
    ).rejects.toThrow('the run failed');
    expect(await uses(g.id)).toBe(0);
    // So the one use is still there.
    await inTransaction(agentCtx, (tx) => useGrant(tx, g.id));
    expect(await uses(g.id)).toBe(1);
  });

  it('refuses once the uses are used up', async () => {
    const g = await enterGrant({ constraints: { maxUses: 2 } });
    await inTransaction(agentCtx, (tx) => useGrant(tx, g.id));
    await inTransaction(agentCtx, (tx) => useGrant(tx, g.id));
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN', /used up/);
    expect(await uses(g.id)).toBe(2);
  });

  it('two runs racing for the last use: exactly one has it', async () => {
    const g = await enterGrant({ constraints: { maxUses: 1 } });
    const results = await Promise.allSettled([
      inTransaction(agentCtx, (tx) => useGrant(tx, g.id)),
      inTransaction(agentCtx, (tx) => useGrant(tx, g.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(ServiceError);
    expect(await uses(g.id)).toBe(1);
  });

  it('refuses an expired or revoked grant', async () => {
    const expired = await enterGrant();
    await db.update(agentGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentGrants.id, expired.id));
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, expired.id)), 'FORBIDDEN', /has ended/);
    const revoked = await enterGrant();
    await revokeGrant(admin, revoked.id);
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, revoked.id)), 'FORBIDDEN');
    expect(await uses(expired.id)).toBe(0);
    expect(await uses(revoked.id)).toBe(0);
  });

  it('refuses when the agent is removed or paused, or every agent of the company is', async () => {
    const helper = await addAgent(companyId, 'Paused helper');
    const g = await enterGrant({ agent: helper });
    const helperCtx: ServiceContext = { ...agentCtx, agent: { ...agentCtx.agent!, id: helper, name: 'Paused helper' } };

    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, helper));
    await expectError(inTransaction(helperCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    await db.update(agents).set({ pausedAt: null }).where(eq(agents.id, helper));

    await setCompanySettings(companyId, { timezone: 'America/New_York', integratedAppsBlocked: true });
    await expectError(inTransaction(helperCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    await setCompanySettings(companyId, { timezone: 'America/New_York' });
    await inTransaction(helperCtx, (tx) => useGrant(tx, g.id));

    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, helper));
    await expectError(inTransaction(helperCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    expect(await uses(g.id)).toBe(1);
  });

  it('refuses another agent’s grant, another company’s, and ids that are not grants', async () => {
    const g = await enterGrant({ agent: secondAgentId });
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    await expectError(inTransaction(otherAdmin, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, 'grant-1')), 'FORBIDDEN');
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, '00000000-0000-4000-8000-000000000000')), 'FORBIDDEN');
    expect(await uses(g.id)).toBe(0);
  });

  it('refuses a grant whose stored limits cannot be read', async () => {
    const g = await enterGrant();
    await db.update(agentGrants).set({ constraints: { maxUses: 'lots' } as never }).where(eq(agentGrants.id, g.id));
    await expectError(inTransaction(agentCtx, (tx) => useGrant(tx, g.id)), 'FORBIDDEN');
    expect((await liveGrants(admin, agentId)).map((x) => x.id)).not.toContain(g.id);
  });
});

describe('taking a grant back', () => {
  const audits = async (id: string) =>
    db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'agent_grant'), eq(auditLogs.entityId, id), eq(auditLogs.action, 'update')));

  it('an agent never can, not even its own', async () => {
    const g = await enterGrant();
    await expectError(revokeGrant(agentCtx, g.id), 'FORBIDDEN', /An agent can never take back/);
    // Nor anything running inside an agent's bridged run, whatever context it was handed.
    await expectError(
      runWithServiceContext(agentCtx, { path: '/api/agents', method: 'DELETE' }, () => revokeGrant(admin, g.id)),
      'FORBIDDEN',
      /An agent can never take back/,
    );
    expect((await row(g.id)).revokedAt).toBeNull();
  });

  it('only the giver or someone who may manage agents', async () => {
    const g = await enterGrant({ by: bookkeeper });
    await expectError(revokeGrant(apClerk, g.id), 'FORBIDDEN', /Only the person who gave/);
    await expectError(revokeGrant({ ...apClerk, userId: null }, g.id), 'FORBIDDEN', /signed-in person/);
    // Editing roles is not managing agents.
    await expectError(revokeGrant(rolesEditor, g.id), 'FORBIDDEN', /Only the person who gave/);
    // A context built without the person's access reads it from the file: not a member, no.
    await expectError(revokeGrant({ ...usersManager, access: undefined }, g.id), 'FORBIDDEN', /Only the person who gave/);
    expect((await row(g.id)).revokedAt).toBeNull();

    await revokeGrant(bookkeeper, g.id);
    const stored = await row(g.id);
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.revokedBy).toBe(bookkeeperId);
    const a = await audits(g.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ userId: bookkeeperId, agentId: null });
    expect(a[0].newValues).toMatchObject({ revoked: true, operation: ENTER.id });

    // Again: nothing changes and nothing more is written.
    await revokeGrant(bookkeeper, g.id);
    expect(await audits(g.id)).toHaveLength(1);

    const h = await enterGrant({ by: bookkeeper });
    await revokeGrant(usersManager, h.id);
    expect((await row(h.id)).revokedBy).toBe(usersManager.userId);
    const i = await enterGrant({ by: bookkeeper });
    await revokeGrant(admin, i.id);
    expect((await row(i.id)).revokedBy).toBe(adminId);
    // Whoever may pause or remove an agent may take its grants back, without the right to edit roles.
    const j = await enterGrant({ by: bookkeeper });
    await revokeGrant(agentManager, j.id);
    expect((await row(j.id)).revokedBy).toBe(agentManager.userId);
    // The owner, from a context built without the access: read from the file.
    const k = await enterGrant({ by: bookkeeper });
    await revokeGrant({ ...admin, access: undefined }, k.id);
    expect((await row(k.id)).revokedBy).toBe(adminId);
  });

  it('another company’s grant, or one that does not exist, is not found', async () => {
    const g = await enterGrant();
    await expectError(revokeGrant(otherAdmin, g.id), 'NOT_FOUND');
    await expectError(revokeGrant(admin, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    await expectError(revokeGrant(admin, 'grant-1'), 'NOT_FOUND');
    expect((await row(g.id)).revokedAt).toBeNull();
  });
});

describe('listing grants', () => {
  it('names the agent, the person and the work, newest first', async () => {
    const helper = await addAgent(companyId, 'Listing helper');
    const older = await enterGrant({ agent: helper, by: bookkeeper, constraints: { maxUses: 5 } });
    vi.setSystemTime(Date.now() + 60_000);
    const newer = await createGrant(admin, facts(), { agentId: helper, operation: OUTSIDE.id, constraints: {}, minutes: 10, requestId: null });
    const list = await listGrants(admin, { agentId: helper });
    expect(list.map((g) => g.id)).toEqual([newer.id, older.id]);
    expect(list[1]).toMatchObject({
      id: older.id,
      agentId: helper,
      agentName: 'Listing helper',
      givenBy: bookkeeperId,
      givenByName: 'Bo Bookkeeper',
      class: 'enter',
      maxUses: 5,
      uses: 0,
      operationLabel: 'Enter an invoice to customer …',
    });
    expect(Date.parse(list[1].createdAt)).not.toBeNaN();
    expect(list[0]).toMatchObject({ class: 'outside', maxUses: null, operationLabel: 'Email invoice … to …', givenByName: 'Ada Admin' });
    // Nothing of a person's row but the name.
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|grants\.test/);
  });

  it('live lists only what still stands', async () => {
    const helper = await addAgent(companyId, 'Live list helper');
    const standing = await enterGrant({ agent: helper });
    const revoked = await enterGrant({ agent: helper });
    const usedUp = await enterGrant({ agent: helper, constraints: { maxUses: 1 } });
    const expired = await enterGrant({ agent: helper });
    await revokeGrant(admin, revoked.id);
    await inTransaction(admin, (tx) => useGrant(tx, usedUp.id));
    await db.update(agentGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentGrants.id, expired.id));

    expect((await listGrants(admin, { agentId: helper, live: true })).map((g) => g.id)).toEqual([standing.id]);
    expect(await listGrants(admin, { agentId: helper })).toHaveLength(4);

    // A paused agent's grants are still listed, to be taken back; a removed agent's are not live.
    await db.update(agents).set({ pausedAt: new Date() }).where(eq(agents.id, helper));
    expect(await listGrants(admin, { agentId: helper, live: true })).toHaveLength(1);
    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, helper));
    expect(await listGrants(admin, { agentId: helper, live: true })).toEqual([]);
  });

  it('an agent lists only its own; another company sees none', async () => {
    const mine = await listGrants(agentCtx);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((g) => g.agentId === agentId)).toBe(true);
    await expectError(listGrants(agentCtx, { agentId: secondAgentId }), 'FORBIDDEN');
    expect(await listGrants(otherAdmin, { agentId })).toEqual([]);
    await expectError(listGrants(admin, { agentId: 'agent-1' }), 'NOT_FOUND');
  });
});
