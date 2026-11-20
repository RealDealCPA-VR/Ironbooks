/**
 * Agent full access: standing permission for agents (plan §4.4 and §4.5; decisions D3 and D5).
 *
 * A grant is what a person gives while approving one request: "this and similar ones until ...".
 * It covers ONE operation, within the limits the person ticked (GrantConstraints), until it
 * expires, is used up or is taken back. Whether a live grant covers a request is the policy
 * engine's question (lib/agent/policy.ts grantCovers); this module keeps the grants:
 *
 *  - createGrant: only a signed-in person gives one, never an agent. Only for the classes that may
 *    have one (GRANTABLE: everyday entry and change; bulk work with a count limit; outside sends and
 *    printing for a short window), never for longer than the class allows (the end of the company's
 *    day, or 30 minutes), only by someone whose own role may do the operation, and for outside
 *    sends only by an Admin (D5). The limits are cleaned before they are stored, so the engine only
 *    ever reads known keys in one shape.
 *  - liveGrants: what the agent's door hands the policy engine. A removed or paused agent, or a
 *    company whose Integrated Applications switch is off, has none. Nor does a grant whose giver
 *    has left the company, been deactivated, or may no longer do the work themselves (for outside
 *    sends: is no longer an Admin), since approving never widens anything (plan 4.5).
 *  - useGrant: counts one use in the run's own transaction with ONE update that checks everything
 *    again, so a run that rolls back gives the use back, and two runs racing for the last use cannot
 *    both have it.
 *  - revokeGrant: the person who gave it, or anyone who may manage agents (Users & Roles > Users,
 *    modify: the same right that pauses or removes one). Never an agent.
 *
 * Every grant given or taken back is written to the audit trail under the person who did it.
 */
import Decimal from 'decimal.js';
import { and, desc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { agentGrants, agentPermissionRequests, agents, companies, userCompanies, users } from '@/lib/db/schema';
import { canActivity, type EffectiveAccess } from '@/lib/permissions/model';
import { operationById } from '@/lib/agent/operations/registry';
import {
  DEFAULT_BULK_CAP,
  SHORT_GRANT_MINUTES,
  approvalNeeds,
  baseClass,
  effectiveClass,
  grantNeedsAdmin,
  isPaused,
  maxGrantMinutes,
  minutesToEndOfDay,
  requestClasses,
  roleAllows,
  roleProblem,
} from '@/lib/agent/policy';
import {
  GRANTABLE,
  RISK_CLASS_LABELS,
  isRiskClass,
  type AgentGrant,
  type GrantConstraints,
  type Operation,
  type RequestFacts,
  type RiskClass,
} from '@/lib/agent/operations/types';
import type { AgentGrantView, CreateGrant, ListGrants, LiveGrants, RevokeGrant, UseGrant } from '@/lib/agent/contract';
// The scope module, not lib/context.ts: it holds no database or service imports (no cycle).
import { inServiceScope } from '@/lib/serviceScope';
import { loadAgentPolicy } from './agentPolicies';
import { resolveAccess, type ResolvedAccess } from './access';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** What the audit trail calls a grant. */
const AUDIT_ENTITY = 'agent_grant';

/**
 * The Users & Roles activity the agents routes are mapped to (lib/permissions/routeActivities.ts):
 * whoever may manage agents (agentPolicies.ts uses the same one) may take any grant back.
 */
const MANAGE_AGENTS = 'users.users';

/** A request with nothing raised: a grant only ever covers requests judged at the operation's own class. */
const PLAIN_FACTS: RequestFacts = {
  confirm: [],
  reveal: false,
  amount: null,
  count: null,
  entityIds: [],
  accountIds: [],
  date: null,
  closedPeriod: false,
};

/** Most names or accounts one grant may list (more than any approval card offers). */
const MAX_IDS = 1000;

type GrantRow = typeof agentGrants.$inferSelect;

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * An agent's own context, or any work running inside an agent's bridged run (lib/serviceScope.ts)
 * whatever context it was handed: neither ever gives or takes back a grant (plan 4.6, D9). The
 * bridge always sets ctx.agent today; the scope check holds even if a handler builds its own.
 */
function isAgentWork(ctx: ServiceContext): boolean {
  return Boolean(ctx.agent) || inServiceScope();
}

/**
 * The person giving standing permission. An agent never gives, changes or takes back a grant
 * (plan 4.6), and a context without a person, or without the person's permissions, cannot show who
 * approved, so it gives nothing (fail closed).
 */
function assertPerson(ctx: ServiceContext, doing: string): { userId: string; access: EffectiveAccess } {
  if (isAgentWork(ctx)) throw new ServiceError('FORBIDDEN', `An agent can never ${doing}. A person does this in Ironbooks.`);
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', `Only a signed-in person can ${doing}. Sign in to Ironbooks and try again.`);
  if (!ctx.access) {
    throw new ServiceError('FORBIDDEN', `Ironbooks could not read your permissions, so it did not ${doing}. Sign in again and try again.`);
  }
  return { userId: ctx.userId, access: ctx.access };
}

/** An agent's context may only read its own grants. */
function assertOwnAgent(ctx: ServiceContext, agentId: unknown): void {
  if (ctx.agent && ctx.agent.id !== agentId) {
    throw new ServiceError('FORBIDDEN', 'An agent can only see its own standing permission.');
  }
}

// ---------------------------------------------------------------------------
// The company's day and its pause switch
// ---------------------------------------------------------------------------

interface CompanyState {
  /** Preferences > Company > Time zone, or null for this computer's zone. */
  timeZone: string | null;
  /** Preferences > Integrated Applications is off: every agent is paused (lib/services/agents.ts). */
  agentsBlocked: boolean;
}

async function companyState(ctx: ServiceContext): Promise<CompanyState> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const s = row?.settings && typeof row.settings === 'object' ? (row.settings as Record<string, unknown>) : {};
  return {
    timeZone: typeof s.timezone === 'string' && s.timezone.trim() ? s.timezone.trim() : null,
    // The same test the agent's door makes (agents.ts applicationsBlocked).
    agentsBlocked: s.integratedAppsBlocked === true,
  };
}

/**
 * The zone's offset from UTC at `now`, in minutes (east positive), as minutesToEndOfDay wants it.
 * No zone, or one the runtime does not know: this computer's, which is also the day
 * todayInTimeZone (lib/preferences.ts) calls "today" then.
 */
function zoneOffsetMinutes(timeZone: string | null, now: Date): number {
  if (timeZone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
      const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      const offset = Math.round((wall - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
      if (Number.isFinite(offset)) return offset;
    } catch {
      /* an unknown zone: this computer's, below */
    }
  }
  return -now.getTimezoneOffset();
}

/** Whole minutes from `now` to the end of the company's day. */
function minutesLeftToday(state: CompanyState, now: Date): number {
  return minutesToEndOfDay(now.toISOString(), zoneOffsetMinutes(state.timeZone, now));
}

// ---------------------------------------------------------------------------
// What may be given
// ---------------------------------------------------------------------------

interface GrantRules {
  operation: Operation;
  /**
   * The operation's own class: the only class a grant ever covers (grantCovers skips a request
   * raised above it), so it is what the grant is stored and listed under. The window is still set
   * by the strictest class this request fell under.
   */
  cls: RiskClass;
  /** Bulk work: every grant carries a count limit. */
  capped: boolean;
  /** Longest window in minutes from now; 0 when none can be given right now. */
  maxMinutes: number;
  /** The window is limited by the end of the company's day rather than by the class. */
  endOfDay: boolean;
}

function minutesWord(n: number): string {
  return n === 1 ? '1 minute' : `${n} minutes`;
}

/**
 * Whether this person may give standing permission for this request at all, and for how long.
 * Throws a ServiceError saying why not. The same rules the policy engine applies when a grant is
 * used (grantCovers), so a grant given here is never one the engine would ignore.
 */
function grantRules(ctx: ServiceContext, operationId: unknown, facts: RequestFacts, minutesLeft: number): GrantRules {
  const { access } = assertPerson(ctx, 'give standing permission');
  if (!facts || typeof facts !== 'object') {
    throw validation('The details of the request are missing, so standing permission was not given. Open the request again.');
  }

  const operation = typeof operationId === 'string' && operationId ? operationById(operationId) : null;
  if (!operation) {
    throw validation('Ironbooks does not know this kind of work, so standing permission cannot be given for it.');
  }
  if (operation.availability !== 'agent') {
    throw new ServiceError('FORBIDDEN', 'Agents can never do this, so standing permission cannot be given for it.');
  }

  const cls = effectiveClass(operation, facts);
  // approvalNeeds is the engine's own answer to "may the approver give standing permission": the
  // strictest over every class the request falls under, and never for a reveal, an operation that
  // always asks, or one nobody classified. The two-person amount plays no part in it.
  const needs = approvalNeeds(operation, cls, facts, { twoPersonOver: null });
  if (needs.grantable === 'no') {
    if (facts.reveal) {
      throw new ServiceError('FORBIDDEN', 'Seeing protected data is approved one request at a time, so standing permission cannot be given for it.');
    }
    if (operation.alwaysAsk) {
      throw new ServiceError('FORBIDDEN', 'This always asks a person, every time, so standing permission cannot be given for it.');
    }
    if (!operation.classified) {
      throw new ServiceError('FORBIDDEN', 'Ironbooks asks about this kind of work one request at a time, so standing permission cannot be given for it.');
    }
    const blocking = requestClasses(operation, facts).find((c) => GRANTABLE[c] === 'no') ?? cls;
    throw new ServiceError(
      'FORBIDDEN',
      `Standing permission cannot be given for "${RISK_CLASS_LABELS[blocking]}" work: each request is approved on its own.`,
    );
  }
  // Approvable only at the host's own window, or only by the file's Admin: a grant would let later
  // requests run with no such approval, and nothing here can show where the person is.
  if (operation.hostOnly || operation.fileAdmin) {
    throw new ServiceError(
      'FORBIDDEN',
      'This can only be approved at the computer that holds the company file, one request at a time, so standing permission cannot be given for it.',
    );
  }
  if (grantNeedsAdmin(operation, facts) && !access.isAdmin) {
    throw new ServiceError(
      'FORBIDDEN',
      'Only an Admin can give standing permission for sending things outside this computer. Approve this request on its own, or ask an Admin.',
    );
  }
  // Approving never widens anything (plan 4.5): the person must be allowed to do it themselves.
  const missing = roleProblem(access, operation);
  if (missing) {
    throw new ServiceError(
      'FORBIDDEN',
      `Your own role does not allow this (it needs ${missing}), so you cannot give an agent standing permission for it.`,
    );
  }

  const left = Number.isFinite(minutesLeft) ? Math.max(0, Math.floor(minutesLeft)) : 0;
  let maxMinutes = maxGrantMinutes(cls, left);
  if (needs.grantable === 'short') maxMinutes = Math.min(maxMinutes, SHORT_GRANT_MINUTES, left);
  const own = baseClass(operation);
  return {
    operation,
    cls: own,
    capped: needs.grantable === 'capped' || GRANTABLE[own] === 'capped',
    maxMinutes,
    endOfDay: maxMinutes === left,
  };
}

/**
 * The longest standing permission (in minutes) this person may give while approving this request;
 * 0 when they may give none. It applies every rule createGrant applies (the company's own day,
 * host-only and file-Admin work, the Admin rule for outside sends, the person's own role), so the
 * approval card (AgentRequestForPerson.grantMinutesMax) should take its window from here to never
 * offer one createGrant would refuse. The count limit of bulk work is checked when the grant is given.
 */
export async function grantMinutesFor(
  ctx: ServiceContext,
  operationId: string,
  facts: RequestFacts,
  now: Date = new Date(),
): Promise<number> {
  try {
    const state = await companyState(ctx);
    return grantRules(ctx, operationId, facts, minutesLeftToday(state, now)).maxMinutes;
  } catch (e) {
    if (e instanceof ServiceError) return 0;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cleaning the limits
// ---------------------------------------------------------------------------

const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;

function own(r: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(r, key) ? r[key] : undefined;
}

function cleanIds(v: unknown, notList: string, empty: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_IDS || !v.every(isUuid)) throw validation(notList);
  // Stored the way the database writes ids (lower case), each once.
  const ids = [...new Set(v.map((id) => id.toLowerCase()))];
  if (!ids.length) throw validation(empty);
  return ids;
}

function cleanAmount(v: unknown): string {
  const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  if (!AMOUNT_RE.test(text)) {
    throw validation('The largest amount must be an amount of zero or more with at most 2 decimals, such as 250.00.');
  }
  return new Decimal(text).toFixed(2);
}

/** "2026-11-30" from a date or an ISO date and time (its own calendar day, as the engine reads it). */
function isoDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (!m) return null;
  if (s.length > 10 && !Number.isFinite(Date.parse(s))) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const probe = new Date(Date.UTC(y, mo, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo || probe.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function cleanCount(v: unknown, message: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw validation(message);
  return v;
}

/**
 * The limits as they are stored: only the known keys, ids as lower-case uuid text, amounts as
 * decimal text, dates as "YYYY-MM-DD", counts as whole numbers. A key that is missing or null is
 * a limit the person did not tick. Keys nobody knows are left out: the card never showed them.
 * A value that cannot be read is refused rather than dropped, because dropping a limit would
 * give more than the person meant.
 */
function cleanConstraints(raw: unknown): GrantConstraints {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw validation('The limits of the standing permission could not be read. Choose them again.');
  }
  const r = raw as Record<string, unknown>;
  const given = (key: keyof GrantConstraints) => {
    const v = own(r, key);
    return v === null || v === undefined ? undefined : v;
  };
  const out: GrantConstraints = {};

  const entityIds = given('entityIds');
  if (entityIds !== undefined) {
    out.entityIds = cleanIds(
      entityIds,
      'The customers, vendors or other names it may use must be a list of record ids.',
      'Choose at least one customer, vendor or other name, or leave that limit off.',
    );
  }
  const accountIds = given('accountIds');
  if (accountIds !== undefined) {
    out.accountIds = cleanIds(
      accountIds,
      'The accounts it may use must be a list of account ids.',
      'Choose at least one account, or leave that limit off.',
    );
  }
  const maxAmount = given('maxAmount');
  if (maxAmount !== undefined) out.maxAmount = cleanAmount(maxAmount);

  const dateFrom = given('dateFrom');
  if (dateFrom !== undefined) {
    const day = isoDay(dateFrom);
    if (!day) throw validation('The first date must be a date such as 2026-11-01.');
    out.dateFrom = day;
  }
  const dateTo = given('dateTo');
  if (dateTo !== undefined) {
    const day = isoDay(dateTo);
    if (!day) throw validation('The last date must be a date such as 2026-11-30.');
    out.dateTo = day;
  }
  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) {
    throw validation('The first date is after the last date. Swap them and try again.');
  }

  const maxUses = given('maxUses');
  if (maxUses !== undefined) out.maxUses = cleanCount(maxUses, 'The number of times it may be used must be a whole number, 1 or more.');
  const maxCount = given('maxCount');
  if (maxCount !== undefined) out.maxCount = cleanCount(maxCount, 'The most records per request must be a whole number, 1 or more.');
  return out;
}

// ---------------------------------------------------------------------------
// Reading grants
// ---------------------------------------------------------------------------

/** The stored limits, or null when they are not an object (such a grant covers nothing). */
function storedConstraints(v: unknown): GrantConstraints | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as GrantConstraints) : null;
}

/** Uses left: no limit, or fewer uses than the limit. A limit that cannot be read is used up. */
function notUsedUp(row: Pick<GrantRow, 'uses' | 'constraints'>): boolean {
  const c = storedConstraints(row.constraints);
  if (!c) return false;
  if (!Object.prototype.hasOwnProperty.call(c, 'maxUses')) return true;
  return typeof c.maxUses === 'number' && Number.isInteger(row.uses) && row.uses < c.maxUses;
}

function toGrant(row: GrantRow): AgentGrant {
  return {
    id: row.id,
    agentId: row.agentId,
    operation: row.operation,
    constraints: storedConstraints(row.constraints) ?? {},
    givenBy: row.givenBy,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    uses: row.uses,
  };
}

/** The operation's describe line with its blanks shown as "…": the grant is for any such request. */
function operationLabel(operationId: string): string {
  const op = operationById(operationId);
  if (!op) return operationId;
  return op.describe.replace(/\{[^{}]*\}/g, '…').replace(/\s+/g, ' ').trim() || operationId;
}

function storedClass(row: GrantRow): RiskClass {
  if (isRiskClass(row.class)) return row.class;
  const op = operationById(row.operation);
  return op ? baseClass(op) : 'admin';
}

/**
 * Whether the person who gave a grant could still give it: an active member of the company (as
 * the sign-in reads membership), whose own role still allows the operation, and still an Admin
 * where only an Admin may give it (D5). Checked when the grant is read for a decision, so a person
 * who is removed, deactivated or loses the right takes their standing permission with them: it was
 * only ever theirs to lend (plan 4.5). Each person is looked up once per call.
 */
async function giverStillMay(ctx: ServiceContext, row: GrantRow, givers: Map<string, ResolvedAccess>): Promise<boolean> {
  const operation = operationById(row.operation);
  if (!operation) return false;
  let giver = givers.get(row.givenBy);
  if (!giver) {
    giver = await resolveAccess(ctx.db, ctx.companyId, row.givenBy);
    givers.set(row.givenBy, giver);
  }
  if (!giver.member || !giver.active) return false;
  if (!roleAllows(giver.access, operation)) return false;
  return !grantNeedsAdmin(operation, PLAIN_FACTS) || giver.access.isAdmin;
}

/**
 * Unexpired, unrevoked, not used up, its agent neither removed nor paused (nor the company's
 * agents), and its giver still able to give it (giverStillMay).
 */
export const liveGrants: LiveGrants = async (ctx, agentId, now = new Date()) => {
  assertOwnAgent(ctx, agentId);
  if (!isUuid(agentId)) return [];
  // A time that cannot be read cannot show a grant is unexpired (fail closed).
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return [];
  if ((await companyState(ctx)).agentsBlocked) return [];
  const rows = await ctx.db
    .select({ grant: agentGrants, agentRevokedAt: agents.revokedAt, agentPausedAt: agents.pausedAt })
    .from(agentGrants)
    .innerJoin(agents, and(eq(agents.id, agentGrants.agentId), eq(agents.companyId, agentGrants.companyId)))
    .where(
      and(
        eq(agentGrants.companyId, ctx.companyId),
        eq(agentGrants.agentId, agentId),
        isNull(agentGrants.revokedAt),
        gt(agentGrants.expiresAt, now),
      ),
    )
    .orderBy(desc(agentGrants.createdAt));
  const givers = new Map<string, ResolvedAccess>();
  const live: AgentGrant[] = [];
  for (const r of rows) {
    if (r.agentRevokedAt || isPaused(r.agentPausedAt) || !notUsedUp(r.grant)) continue;
    if (!(await giverStillMay(ctx, r.grant, givers))) continue;
    live.push(toGrant(r.grant));
  }
  return live;
};

// ---------------------------------------------------------------------------
// Giving
// ---------------------------------------------------------------------------

/** `ctx` is the approving person. Refuses classes that cannot be granted and windows that are too long. */
export const createGrant: CreateGrant = async (ctx, facts, grant) => {
  const { userId } = assertPerson(ctx, 'give standing permission');
  if (!grant || typeof grant !== 'object') throw validation('Say what the standing permission is for.');
  if (!isUuid(grant.agentId)) throw notFound('Agent');
  const agentId = grant.agentId.toLowerCase();

  const now = new Date();
  const rules = grantRules(ctx, grant.operation, facts, minutesLeftToday(await companyState(ctx), now));

  const minutes = grant.minutes;
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1) {
    throw validation('Give how long the standing permission lasts in whole minutes, 1 or more.');
  }
  if (rules.maxMinutes < 1) {
    throw validation('The day is about to end, so standing permission cannot be given now. Approve this request on its own.');
  }
  if (minutes > rules.maxMinutes) {
    const until = rules.endOfDay ? ' (until the end of the day)' : '';
    throw validation(`Standing permission for this can last at most ${minutesWord(rules.maxMinutes)} from now${until}. Choose a shorter time.`);
  }

  const constraints = cleanConstraints(grant.constraints);
  if (rules.capped && constraints.maxCount === undefined) {
    throw validation(
      'Say how many records one request may change at most. Standing permission for changing many records at once always has that limit.',
    );
  }

  const requestId = grant.requestId ?? null;
  if (requestId !== null && !isUuid(requestId)) {
    throw validation('The request this standing permission goes with was not found.');
  }

  return inTransaction(ctx, async (tx) => {
    const [agent] = await tx.db
      .select({ id: agents.id, name: agents.name, revokedAt: agents.revokedAt })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, tx.companyId)));
    if (!agent) throw notFound('Agent');
    if (agent.revokedAt) throw validation('This agent has been removed, so it cannot be given standing permission.');

    if (constraints.maxCount !== undefined && rules.capped) {
      // Within the agent's own count limit; an agent with none is held to the default one, so a
      // standing permission for bulk work is never unlimited.
      const policy = await loadAgentPolicy(tx, agentId);
      const cap = typeof policy?.bulkCap === 'number' && Number.isInteger(policy.bulkCap) && policy.bulkCap > 0 ? policy.bulkCap : DEFAULT_BULK_CAP;
      if (constraints.maxCount > cap) {
        throw validation(`This agent may change at most ${cap} records in one request, so the limit can be at most ${cap}.`);
      }
    }

    if (requestId !== null) {
      const [req] = await tx.db
        .select({ agentId: agentPermissionRequests.agentId, operation: agentPermissionRequests.operation })
        .from(agentPermissionRequests)
        .where(and(eq(agentPermissionRequests.id, requestId), eq(agentPermissionRequests.companyId, tx.companyId)));
      if (!req || req.agentId !== agentId || req.operation !== rules.operation.id) {
        throw validation('The request this standing permission goes with was not found for this agent and this kind of work.');
      }
    }

    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const [row] = await tx.db
      .insert(agentGrants)
      .values({
        companyId: tx.companyId,
        agentId,
        operation: rules.operation.id,
        class: rules.cls,
        constraints,
        givenBy: userId,
        requestId,
        expiresAt,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      newValues: {
        agentId,
        agentName: agent.name,
        operation: row.operation,
        class: row.class,
        constraints,
        minutes,
        expiresAt: expiresAt.toISOString(),
        requestId,
      },
    });
    return toGrant(row);
  });
};

// ---------------------------------------------------------------------------
// Using
// ---------------------------------------------------------------------------

const GRANT_GONE =
  'The standing permission this request was to run under has ended: it expired, was used up or was taken back. ' +
  'Send the request again to ask a person.';

/**
 * Count one use inside the run's transaction (`tx.db`), so a run that rolls back gives it back.
 * One UPDATE checks everything again at the moment of use: the grant is this company's, unrevoked,
 * unexpired, not used up, its agent is neither removed nor paused, nor every agent of the company,
 * and the person who gave it is still an active member. When the run's context names an agent, the
 * grant must be that agent's. (The giver's role was checked when liveGrants handed the grant to the
 * engine, moments before, in the same request.)
 */
export const useGrant: UseGrant = async (tx, grantId) => {
  if (!isUuid(grantId)) throw new ServiceError('FORBIDDEN', GRANT_GONE);
  const now = new Date();
  const c = agentGrants.constraints;
  const conditions: SQL[] = [
    eq(agentGrants.id, grantId),
    eq(agentGrants.companyId, tx.companyId),
    isNull(agentGrants.revokedAt),
    gt(agentGrants.expiresAt, now),
    // Limits that are not an object cover nothing; a use limit that is not a number is used up.
    sql`jsonb_typeof(${c}) = 'object'`,
    sql`(CASE WHEN ${c} -> 'maxUses' IS NULL THEN true
              WHEN jsonb_typeof(${c} -> 'maxUses') = 'number' THEN ${agentGrants.uses} < (${c} ->> 'maxUses')::numeric
              ELSE false END)`,
    sql`EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${agentGrants.agentId} AND ${agents.companyId} = ${agentGrants.companyId}
              AND ${agents.revokedAt} IS NULL AND ${agents.pausedAt} IS NULL)`,
    sql`NOT EXISTS (SELECT 1 FROM ${companies} WHERE ${companies.id} = ${agentGrants.companyId}
              AND ${companies.settings} -> 'integratedAppsBlocked' = 'true'::jsonb)`,
    // The giver is still an active member, as resolveAccess (lib/services/access.ts) reads it: a
    // membership row that is active (any inactive row counts against: fail closed), or, with no
    // row at all, the company's owner.
    sql`(CASE WHEN EXISTS (SELECT 1 FROM ${userCompanies} WHERE ${userCompanies.userId} = ${agentGrants.givenBy}
                    AND ${userCompanies.companyId} = ${agentGrants.companyId})
              THEN NOT EXISTS (SELECT 1 FROM ${userCompanies} WHERE ${userCompanies.userId} = ${agentGrants.givenBy}
                    AND ${userCompanies.companyId} = ${agentGrants.companyId} AND ${userCompanies.isActive} = false)
              ELSE EXISTS (SELECT 1 FROM ${companies} WHERE ${companies.id} = ${agentGrants.companyId}
                    AND ${companies.ownerId} = ${agentGrants.givenBy}) END)`,
  ];
  if (tx.agent) conditions.push(eq(agentGrants.agentId, tx.agent.id));
  const used = await tx.db
    .update(agentGrants)
    .set({ uses: sql`${agentGrants.uses} + 1` })
    .where(and(...conditions))
    .returning({ id: agentGrants.id });
  if (!used.length) throw new ServiceError('FORBIDDEN', GRANT_GONE);
};

// ---------------------------------------------------------------------------
// Taking back
// ---------------------------------------------------------------------------

/**
 * May this person manage agents? Their request's access, or, for a context built without it, what
 * the company file says about them (an inactive or former member: no).
 */
async function mayManageAgents(ctx: ServiceContext, userId: string): Promise<boolean> {
  if (ctx.access) return canActivity(ctx.access, MANAGE_AGENTS, 'modify');
  const r = await resolveAccess(ctx.db, ctx.companyId, userId);
  return r.member && r.active && canActivity(r.access, MANAGE_AGENTS, 'modify');
}

/**
 * The person who gave it, or anyone who may manage agents: taking permission back is never harder
 * than pausing the agent (agentPolicies.ts checks the same right). Never an agent.
 */
export const revokeGrant: RevokeGrant = async (ctx, grantId) => {
  if (isAgentWork(ctx)) {
    throw new ServiceError('FORBIDDEN', 'An agent can never take back standing permission. A person does this in Users & Roles > Agents.');
  }
  const userId = ctx.userId;
  if (!userId) throw new ServiceError('FORBIDDEN', 'Only a signed-in person can take back standing permission. Sign in to Ironbooks and try again.');
  if (!isUuid(grantId)) throw notFound('Standing permission');

  await inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(agentGrants)
      .where(and(eq(agentGrants.id, grantId), eq(agentGrants.companyId, tx.companyId)));
    if (!row) throw notFound('Standing permission');
    if (row.givenBy !== userId && !(await mayManageAgents(tx, userId))) {
      throw new ServiceError(
        'FORBIDDEN',
        'Only the person who gave this standing permission, or someone who may manage agents in Users & Roles, can take it back.',
      );
    }
    if (row.revokedAt) return; // already taken back: nothing changes
    const [updated] = await tx.db
      .update(agentGrants)
      .set({ revokedAt: new Date(), revokedBy: userId })
      .where(and(eq(agentGrants.id, grantId), isNull(agentGrants.revokedAt)))
      .returning({ id: agentGrants.id });
    if (!updated) return;
    await writeAudit(tx, {
      action: 'update',
      entityType: AUDIT_ENTITY,
      entityId: grantId,
      oldValues: { agentId: row.agentId, operation: row.operation, revoked: false },
      newValues: { agentId: row.agentId, operation: row.operation, revoked: true },
    });
  });
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Grants with the names a screen shows, newest first. `live`: only those still standing (unrevoked,
 * unexpired, not used up, agent not removed); a paused agent's grants are listed, so a person can
 * take them back before turning the agent on again. For the same reason so are grants whose giver
 * may not give them just now (liveGrants leaves those out): they would stand again if the person
 * were turned back on the same day. An agent's context lists only its own.
 */
export const listGrants: ListGrants = async (ctx, opts = {}) => {
  let agentId = opts?.agentId;
  if (ctx.agent) {
    assertOwnAgent(ctx, agentId ?? ctx.agent.id);
    agentId = ctx.agent.id;
  }
  if (agentId !== undefined && !isUuid(agentId)) throw notFound('Agent');
  const live = opts?.live === true;
  const now = new Date();

  const conditions: SQL[] = [eq(agentGrants.companyId, ctx.companyId)];
  if (agentId !== undefined) conditions.push(eq(agentGrants.agentId, agentId));
  if (live) conditions.push(isNull(agentGrants.revokedAt), gt(agentGrants.expiresAt, now));

  const rows = await ctx.db
    .select({
      grant: agentGrants,
      agentName: agents.name,
      agentRevokedAt: agents.revokedAt,
      // Only the name: nothing else of a person's row ever leaves here.
      givenByName: users.name,
    })
    .from(agentGrants)
    .leftJoin(agents, and(eq(agents.id, agentGrants.agentId), eq(agents.companyId, agentGrants.companyId)))
    .leftJoin(users, eq(users.id, agentGrants.givenBy))
    .where(and(...conditions))
    .orderBy(desc(agentGrants.createdAt));

  return rows
    .filter((r) => !live || (r.agentName !== null && !r.agentRevokedAt && notUsedUp(r.grant)))
    .map((r): AgentGrantView => {
      const grant = toGrant(r.grant);
      return {
        ...grant,
        agentName: r.agentName ?? 'An agent that was removed',
        operationLabel: operationLabel(r.grant.operation),
        class: storedClass(r.grant),
        givenByName: r.givenByName ?? 'A person no longer in this file',
        createdAt: r.grant.createdAt.toISOString(),
        maxUses: typeof grant.constraints.maxUses === 'number' ? grant.constraints.maxUses : null,
      };
    });
};
