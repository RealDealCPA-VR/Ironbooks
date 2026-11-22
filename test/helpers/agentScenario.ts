/**
 * Agent full access: a shared scenario for end-to-end tests that run IN PROCESS, with no HTTP
 * server and no Electron. Not a test file (vitest picks up *.test.ts only).
 *
 * What it builds, all through the app's own code:
 *  - a real PGlite company with lists, documents and payments (lib/services/companyFile.fixture.ts),
 *    in its own data folder under .bookkeeper-data/<name>;
 *  - an Admin (the company's owner, "Ada Admin") and a second person ("Ben Second", Full Access,
 *    not an Admin), each with a signed-in person's context built the way lib/context.ts builds one
 *    (resolveAccess, then the role it implies);
 *  - agents made with a preset by the Admin (lib/services/agents.ts createAgent), each with its
 *    token;
 *  - an "as agent" caller: every call builds the agent's context from its token exactly as
 *    POST /api/agent/actions gets it (lib/agentContext.ts getAgentContext, the stamped path and
 *    method of that route), then calls the door (lib/agent/operate.ts handleVerb);
 *  - an "as person" caller over lib/services/agentRequests.ts (list, approve, deny, batch approve)
 *    with the person's context, from the host computer's own window.
 *
 * Nothing of the app is mocked. Two things are set that a real run sets elsewhere:
 *  - a person signing in is noted for this data folder (lib/agent/endpointFile.ts
 *    notePersonSignedIn, what lib/context.ts does on a verified sign-in), because agents only
 *    work in books a person opened;
 *  - the company's time zone is set to one where it is the middle of the day right now, so that
 *    "approve similar for an hour" never meets the end of the company's day (createGrant caps a
 *    window there) whenever the tests happen to run. That is a company preference, not a clock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { agentPermissionRequests, auditLogs, companies, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import { legacyRoleFor } from '@/lib/permissions/model';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { notePersonSignedIn, resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { getAgentContext } from '@/lib/agentContext';
import { handleVerb, resetAgentRateLimits } from '@/lib/agent/operate';
import type {
  AgentOperationAnswer,
  AgentRequestForPerson,
  AgentVerb,
  AgentVerbs,
  ApproveInput,
  ApproveResult,
  RunOperationRequest,
} from '@/lib/agent/contract';
import type { AgentPreset } from '@/lib/agent/operations/types';
import { resolveAccess } from '@/lib/services/access';
import { createAgent } from '@/lib/services/agents';
import { approveAgentRequest, batchApprove, denyAgentRequest, listRequestsForPerson } from '@/lib/services/agentRequests';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { forgetUserName, readAllTransactionLog, type TransactionLogRecord } from '@/lib/services/transactionLog';
import type { ServiceContext } from '@/lib/services/_base';

/** The route an agent's generic verbs arrive on (app/api/agent/actions/route.ts). */
export const AGENT_ACTIONS_PATH = '/api/agent/actions';

export interface PersonCtxOptions {
  /**
   * The window sent the right closing-date password with this request (the x-closing-password
   * header, which lib/context.ts verifies). As there, it unlocks closed periods only for a person
   * whose roles allow work on or before the closing date. Without it, closed periods stay shut.
   */
  closingPasswordAccepted?: boolean;
}

export interface ScenarioPerson {
  id: string;
  name: string;
  /** A fresh signed-in context for this person (one per request, as each window request gets). */
  ctx(opts?: PersonCtxOptions): Promise<ServiceContext>;
  /** The approval center's list (status 'pending' unless asked otherwise), from the host's own window. */
  requests(opts?: Parameters<typeof listRequestsForPerson>[1]): Promise<AgentRequestForPerson[]>;
  /** One request as this person's list shows it (throws when it is not there). */
  request(id: string): Promise<AgentRequestForPerson>;
  approve(id: string, input?: ApproveInput, opts?: { atHost?: boolean }): Promise<ApproveResult>;
  deny(id: string, note: string | null): Promise<AgentRequestForPerson>;
  batch(ids: string[], opts?: { atHost?: boolean }): Promise<ApproveResult[]>;
}

export interface ScenarioAgent {
  id: string;
  name: string;
  preset: AgentPreset;
  token: string;
  /** The agent's own context, from its token, as POST /api/agent/actions gets it. */
  ctx(): Promise<ServiceContext>;
  /** One verb of POST /api/agent/actions (`{ verb, ...args }`), through the door. */
  verb<V extends AgentVerb>(verb: V, args: AgentVerbs[V]['args']): Promise<AgentVerbs[V]['answer']>;
  /** run_operation. */
  run(args: RunOperationRequest): Promise<AgentOperationAnswer>;
}

export interface Scenario {
  db: DB;
  dir: string;
  companyId: string;
  /** The company's Preferences time zone (middayZone at setup): the clock its records are worded on. */
  zone: string;
  /** Account ids by code, the fixture customer and vendor. */
  rich: RichCompany;
  admin: ScenarioPerson;
  second: ScenarioPerson;
  makeAgent(name: string, preset: AgentPreset, opts?: { roleKeys?: string[] }): Promise<ScenarioAgent>;
  /** Another member of the company with these roles (role keys, built-in or the company's own). */
  addPerson(name: string, roleKeys: string[]): Promise<ScenarioPerson>;
  /** The audit rows a request's approved run wrote about records (its decision row left out). */
  auditOfRequest(requestId: string): Promise<Array<typeof auditLogs.$inferSelect>>;
  /** The audit rows about one record. */
  auditOf(entityId: string): Promise<Array<typeof auditLogs.$inferSelect>>;
  /** How many permission requests an agent has under one request id of its own. */
  requestRows(agentId: string, requestKey: string): Promise<number>;
  /** The running transaction log's records about one record (transactions.bktlg). */
  logOf(entityId: string): TransactionLogRecord[];
  close(): Promise<void>;
}

/**
 * The environment of one scenario's data folder. Call it before setupScenario (each test file
 * runs in its own worker, so the folder is that file's alone).
 */
export function scenarioEnv(name: string): { root: string; dir: string } {
  const root = path.resolve(process.cwd(), '.bookkeeper-data', name);
  const dir = path.join(root, 'data');
  process.env.BKA_DATA_DIR = dir;
  process.env.BKA_AUTH_SECRET = `${name}-secret`;
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(root, 'endpoints');
  process.env.BKA_AGENT_FILES_DIR = path.join(root, 'agent-files');
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_COMPANY_SEALED;
  return { root, dir };
}

/**
 * An IANA zone where it is about midday now ("Etc/GMT-5" is UTC+5: the sign is reversed in those
 * names), so a grant of an hour or two is never cut short by the end of the company's day.
 */
export function middayZone(now: Date = new Date()): string {
  const offset = 12 - now.getUTCHours(); // -11 … 12
  if (offset === 0) return 'Etc/GMT';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

/** The company's own "today" in that zone, YYYY-MM-DD. */
export function companyToday(zone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function setupScenario(name: string): Promise<Scenario> {
  const { root, dir } = scenarioEnv(name);
  fs.rmSync(root, { recursive: true, force: true });
  resetAgentEndpointState();
  resetAgentRateLimits();

  const db = await getDb(dir);
  const rich = await seedRichCompany(db, dir, `${name} Co`);
  const companyId = rich.ctx.companyId;
  const adminId = rich.ctx.userId!;
  await db.update(users).set({ name: 'Ada Admin' }).where(eq(users.id, adminId));
  // The transaction log keeps the names it has written; the seeding above already wrote this one.
  forgetUserName(adminId);

  // The company's day is the middle of the day (see the file header).
  const zone = middayZone();
  const [co] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  const settings = { ...((co?.settings as Record<string, unknown> | null) ?? {}), timezone: zone };
  await db.update(companies).set({ settings }).where(eq(companies.id, companyId));

  let people = 0;
  /** A member of the company with these roles. */
  async function member(personName: string, roleKeys: string[]): Promise<string> {
    people += 1;
    const [u] = await db
      .insert(users)
      .values({ email: `person-${people}-${Date.now()}@scenario.test`, name: personName, passwordHash: 'x' })
      .returning();
    await db.insert(userCompanies).values({ userId: u.id, companyId, role: 'accountant', isActive: true });
    for (const roleKey of roleKeys) await db.insert(userRoleAssignments).values({ companyId, userId: u.id, roleKey });
    return u.id;
  }

  // The second person: Full Access, not an Admin.
  const ben = { id: await member('Ben Second', ['full_access']) };

  /**
   * A signed-in person's context, field for field as lib/context.ts getServerContext builds it, so
   * a test that reuses this helper meets what a real window meets:
   *  - access and role: resolveAccess, then the legacy role it implies;
   *  - closingDateOverride: false, as for a window that sent no closing-date password (the
   *    closed-period right alone never unlocks a closed period); with closingPasswordAccepted, the
   *    person's own closedPeriod right, as when the password was right;
   *  - sessionId: undefined. A real window carries its session's id; nothing in these tests signs
   *    in through lib/auth, so there is no user_sessions row to name. A test of single-user mode or
   *    "Who is logged in" needs a real session and cannot use this helper as it is.
   */
  async function personCtx(userId: string, opts: PersonCtxOptions = {}): Promise<ServiceContext> {
    const r = await resolveAccess(db, companyId, userId);
    if (!r.member || !r.active) throw new Error(`${userId} is not an active member of the scenario company`);
    // A verified sign-in reached this data folder: agents may work from now on (lib/context.ts
    // notePersonAtWork; the endpoint file it then publishes is not needed in process).
    notePersonSignedIn(resolveDataDir());
    const closingDateOverride = opts.closingPasswordAccepted === true && r.access.flags.closedPeriod;
    return {
      db,
      companyId,
      userId,
      role: legacyRoleFor(r.access, r.isOwner),
      closingDateOverride,
      access: r.access,
      sessionId: undefined,
    };
  }

  function person(id: string, personName: string): ScenarioPerson {
    const ctx = (opts?: PersonCtxOptions) => personCtx(id, opts);
    return {
      id,
      name: personName,
      ctx,
      requests: async (opts = {}) => listRequestsForPerson(await ctx(), { status: 'pending', atHost: true, ...opts }),
      request: async (requestId) => {
        const all = await listRequestsForPerson(await ctx(), { status: 'all', atHost: true, limit: 200 });
        const found = all.find((r) => r.id === requestId);
        if (!found) throw new Error(`Request ${requestId} is not in ${personName}'s list`);
        return found;
      },
      approve: async (requestId, input = {}, opts = {}) => approveAgentRequest(await ctx(), requestId, input, { atHost: opts.atHost ?? true }),
      deny: async (requestId, note) => denyAgentRequest(await ctx(), requestId, note),
      batch: async (ids, opts = {}) => batchApprove(await ctx(), ids, { atHost: opts.atHost ?? true }),
    };
  }

  const admin = person(adminId, 'Ada Admin');
  const second = person(ben.id, 'Ben Second');
  // The Admin opens the books: from here on agents may work.
  await admin.ctx();

  async function makeAgent(agentName: string, preset: AgentPreset, opts: { roleKeys?: string[] } = {}): Promise<ScenarioAgent> {
    const made = await createAgent(await admin.ctx(), { name: agentName, roleKeys: opts.roleKeys ?? ['full_access'], preset });
    const token = made.token;
    const ctx = () =>
      getAgentContext(
        new Headers({
          authorization: `Bearer ${token}`,
          [ROUTE_PATH_HEADER]: AGENT_ACTIONS_PATH,
          [ROUTE_METHOD_HEADER]: 'POST',
          host: 'localhost:45123',
        }),
      );
    const verb = async <V extends AgentVerb>(v: V, args: AgentVerbs[V]['args']) =>
      (await handleVerb(await ctx(), v, args)) as AgentVerbs[V]['answer'];
    return {
      id: made.agent.id,
      name: made.agent.name,
      preset,
      token,
      ctx,
      verb,
      run: (args) => verb('run_operation', args),
    };
  }

  return {
    db,
    dir,
    companyId,
    zone,
    rich,
    admin,
    second,
    makeAgent,
    addPerson: async (personName, roleKeys) => person(await member(personName, roleKeys), personName),
    auditOfRequest: async (requestId) =>
      (await db.select().from(auditLogs).where(eq(auditLogs.agentRequestId, requestId))).filter((r) => r.entityType !== 'agent_permission_request'),
    auditOf: async (entityId) => db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId)),
    requestRows: async (agentId, requestKey) =>
      (
        await db
          .select({ id: agentPermissionRequests.id })
          .from(agentPermissionRequests)
          .where(and(eq(agentPermissionRequests.agentId, agentId), eq(agentPermissionRequests.requestKey, requestKey)))
      ).length,
    logOf: (entityId) => readAllTransactionLog(dir).records.filter((r) => r.entityId === entityId),
    close: async () => {
      resetAgentEndpointState();
      await closeDb(dir);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** The id of the record an approved or allowed run created: `id` of the answer (or of its first check). */
export function createdId(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (typeof r.id === 'string') return r.id;
  const checks = r.checks as Array<{ id?: unknown }> | undefined;
  if (Array.isArray(checks) && typeof checks[0]?.id === 'string') return checks[0].id as string;
  throw new Error(`No id in the answer: ${JSON.stringify(result)?.slice(0, 300)}`);
}
