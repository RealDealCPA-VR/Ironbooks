/**
 * Agent access (AGENT_ACCESS.md): an Admin lets an AI agent into ONE company of this file.
 *
 * An agent is not a user. It has no password and cannot sign in; it is never counted where people
 * are counted (seats, the last-Admin rule, password reset, file protection); and a service that
 * re-checks access from a user id finds none and refuses. It has:
 *
 *  - a name, shown wherever its work is listed;
 *  - the role keys an Admin gave it: the same roles people have, Admin included (D1 of the full
 *    access plan). Its access is those roles' access with the agent limits on top
 *    (lib/permissions/agentAccess.ts): its ceiling. An Admin role is a ceiling only; the policy
 *    never lets Admin, company-file or password work run without a person's yes;
 *  - a preset: what it may do without asking (lib/agent/policy.ts; the Admin adjusts it in the
 *    Agents tab, lib/services/agentPolicies.ts). A new agent asks for every change (D2). The older
 *    mode (Read only / Propose / Post) is kept in step with the preset for code that still reads it;
 *  - an access token, shown ONCE when the agent is made. Only a digest is stored.
 *
 * The digest is keyed with this computer's device secret when it has one (the secret that seals
 * saved AI and mail keys, lib/ai/keyVault.ts) and always includes the company file's id. A copy of
 * the file on another computer, or a file someone sends you with agents already in it, therefore
 * holds no agent that works: on a computer with a device secret only digests keyed by THAT secret
 * are accepted.
 *
 * Making and removing agents is for an Admin, at the computer that holds the company file (the
 * routes refuse other computers), and both are written to the audit trail with the Admin as the
 * one who did it. The list is for anyone who may see Users & Roles, the same people who may open an
 * agent's page (lib/services/agentPolicies.ts). An agent, and any work running inside an agent's
 * bridged run, never makes, lists or removes agents (plan 4.6, D9). Restoring a backup removes
 * every agent's access (revokeAllAgents, and
 * endAgentAccessInRestoredBooks in lib/services/portableFile.ts), so a token that was taken away
 * cannot come back with an older copy of the books.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { resolveDataDir, type DB } from '@/lib/db';
import { agentGrants, agentPolicies, agents, companies, users } from '@/lib/db/schema';
import { companyFileId } from '@/lib/auth';
import { deviceKey } from '@/lib/ai/keyVault';
import { AGENT_TOKEN_RE } from '@/lib/net/agentToken';
import { canActivity, unionRoles, type EffectiveAccess } from '@/lib/permissions/model';
import { AGENT_MODES, AGENT_MODE_LABELS, clampForAgent, isAgentMode, type AgentMode } from '@/lib/permissions/agentAccess';
import { DEFAULT_PRESET, isAgentPreset, presetBulkCap, presetForMode } from '@/lib/agent/policy';
import { AGENT_PRESET_LABELS, type AgentPreset } from '@/lib/agent/operations/types';
import { endpointPublished, personSignedIn, publishEndpoint, withdrawEndpoint } from '@/lib/agent/endpointFile';
// The scope module, not lib/context.ts: it holds no database or service imports (no cycle).
import { inServiceScope } from '@/lib/serviceScope';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { definitionsFor, listRoleDefinitions, permissionDenied, resolveAccess } from './access';
import { SIMPLE_LIST_KEYS, ensureSeeded } from './lists/simpleLists';
import { getFileLockStatus } from './fileLock';

export { AGENT_MODES, type AgentMode };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_LABEL = 'ironbooks/agent-token';
const TAG_LABEL = 'ironbooks/agent-file-tag';

export const AGENTS_BLOCKED_MESSAGE =
  'Applications are not allowed to access this company file (Preferences > Integrated Applications).';

export interface AgentView {
  id: string;
  name: string;
  roleKeys: string[];
  /** Role names for display; a role that no longer exists is left out. */
  roleNames: string[];
  /** What it may do without asking (lib/agent/policy.ts). */
  preset: AgentPreset;
  /** The older word for the same choice, kept in step with the preset. */
  mode: AgentMode;
  /** ISO time a person paused it, or null. */
  pausedAt: string | null;
  /** The first characters of the token, to tell agents apart. Never the token. */
  tokenPrefix: string;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked';
  /** May work while nobody is signed in (never in a file with passwords or a file password). */
  unattended: boolean;
  /**
   * How many adjustments it has on top of its preset (stored agent_policies rows), so the list can
   * say "adjusted" next to the preset's name (contract section 11, GET /api/agents).
   */
  overrideCount: number;
}

export interface CreateAgentInput {
  name: string;
  roleKeys: string[];
  /**
   * What the agent may do without asking. Left out: the preset of `mode` when one is given (the
   * older form), otherwise "Ask for every change" (DEFAULT_PRESET, D2).
   */
  preset?: AgentPreset;
  /** The older choice. Sent with a preset, it must be that preset's own (modeForPreset). */
  mode?: AgentMode;
  /** May work while Ironbooks has the file open but nobody is signed in. Off unless asked for. */
  unattended?: boolean;
}

type AgentRow = typeof agents.$inferSelect;

/**
 * The older mode that goes with a preset, for code that still reads `agents.mode`
 * (lib/agent/actions.ts): Read only stays Read only, "Ask for every change" proposes, and both
 * presets that enter work themselves post. The reverse of presetForMode (lib/agent/policy.ts).
 */
export function modeForPreset(preset: AgentPreset): AgentMode {
  if (preset === 'read_only') return 'read_only';
  if (preset === 'ask_every_change') return 'propose';
  return 'post';
}

/**
 * The stored preset. One Ironbooks does not know (only a hand-edited file holds one) is read as
 * the default, the same way the policy engine reads it (resolvePolicy), so a screen never shows
 * another preset than the one the decisions use.
 */
export function presetOfRow(row: Pick<AgentRow, 'preset'>): AgentPreset {
  return isAgentPreset(row.preset) ? row.preset : DEFAULT_PRESET;
}

const PRESET_CHOICE =
  'Choose what the agent may do: Read only, Ask for every change, Trusted bookkeeper or Full, with asks.';

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** The public 8-character tag naming this company file inside a token (not a secret). */
export function agentFileTag(fileId: string = companyFileId()): string {
  return createHash('sha256').update(`${TAG_LABEL}\n${fileId}`).digest('hex').slice(0, 8);
}

interface TokenDigest {
  hash: string;
  /** The device secret's id when the digest is keyed with it, else null. */
  keyId: string | null;
}

/**
 * The stored form of a token on THIS computer: keyed with the device secret when there is one,
 * a plain SHA-256 otherwise (no desktop shell: `next dev`, tests). Always bound to the file id.
 */
export function agentTokenDigest(token: string, fileId: string = companyFileId()): TokenDigest {
  const text = `${TOKEN_LABEL}\n${fileId}\n${token}`;
  const dk = deviceKey();
  if (dk) return { hash: createHmac('sha256', Buffer.from(dk.secret, 'hex')).update(text).digest('hex'), keyId: dk.keyId };
  return { hash: createHash('sha256').update(text).digest('hex'), keyId: null };
}

function newToken(): string {
  return `ibka_${agentFileTag()}_${randomBytes(32).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** The Users & Roles activity the agents routes are mapped to (lib/permissions/routeActivities.ts). */
const MANAGE_AGENTS = 'users.users';

/**
 * An agent never manages agents (it cannot reach these routes either), whatever context it holds,
 * and neither does work inside an agent's bridged run, even one handed a person's context: the
 * same rule lib/services/agentPolicies.ts keeps for changing an agent (D9).
 */
function refuseAgentWork(ctx: ServiceContext, message: string): void {
  if (ctx.agent || inServiceScope()) throw new ServiceError('FORBIDDEN', message);
}

function assertAdminPerson(ctx: ServiceContext, what: string): void {
  refuseAgentWork(ctx, `${what} is for an Admin.`);
  // No `access` = trusted internal context (tests, system jobs), as everywhere else.
  if (ctx.access && !ctx.access.isAdmin) throw new ServiceError('FORBIDDEN', `${what} is for an Admin.`);
}

/**
 * The list of agents: a person who may see Users & Roles, as for an agent's own page
 * (lib/services/agentPolicies.ts), so a user manager who may open, pause or change an agent can
 * also find it. A context built without access is checked from the company file; a trusted
 * internal context (no access, nobody signed in) passes.
 */
async function assertMaySeeAgents(ctx: ServiceContext): Promise<void> {
  refuseAgentWork(ctx, 'An agent cannot list agents. It can read its own permissions with get_my_permissions.');
  if (!ctx.access && !ctx.userId) return;
  let access = ctx.access;
  if (!access) {
    const r = await resolveAccess(ctx.db, ctx.companyId, ctx.userId ?? '');
    if (!r.member || !r.active) throw new ServiceError('FORBIDDEN', 'You do not have access to this company.');
    access = r.access;
  }
  if (!canActivity(access, MANAGE_AGENTS, 'view')) throw permissionDenied('users', 'view', MANAGE_AGENTS);
}

function applicationsBlocked(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as { integratedAppsBlocked?: unknown }).integratedAppsBlocked === true);
}

/**
 * The preset a new agent gets: the one asked for, else the preset of the older mode when only
 * that was sent (an older Agents tab or script), else "Ask for every change" (D2). A mode sent
 * with a preset must be the preset's own; a mismatch is refused rather than guessed.
 */
function presetOfInput(input: Pick<CreateAgentInput, 'preset' | 'mode'>): AgentPreset {
  const mode = input.mode;
  if (mode !== undefined && mode !== null && !isAgentMode(mode)) throw validation('Choose Read only, Propose or Post.');
  const preset = input.preset;
  if (preset === undefined || preset === null) return mode ? presetForMode(mode) : DEFAULT_PRESET;
  if (!isAgentPreset(preset)) throw validation(PRESET_CHOICE);
  if (mode && modeForPreset(preset) !== mode) {
    throw validation(
      `The mode "${AGENT_MODE_LABELS[mode]}" does not go with "${AGENT_PRESET_LABELS[preset]}". Send the preset alone: the mode follows it.`,
    );
  }
  return preset;
}

/** True when Preferences > Integrated Applications lets nothing but people reach this company. */
export async function agentsBlockedFor(db: DB, companyId: string): Promise<boolean> {
  const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  return applicationsBlocked(c?.settings);
}

// ---------------------------------------------------------------------------
// Create / list / revoke
// ---------------------------------------------------------------------------

function toView(
  row: AgentRow,
  roleNames: Map<string, string>,
  createdByName: string | null,
  lastUsed: Date | null,
  overrideCount: number,
): AgentView {
  const keys = Array.isArray(row.roleKeys) ? row.roleKeys : [];
  return {
    id: row.id,
    name: row.name,
    roleKeys: keys,
    roleNames: keys.map((k) => roleNames.get(k)).filter((n): n is string => Boolean(n)),
    preset: presetOfRow(row),
    mode: isAgentMode(row.mode) ? row.mode : 'read_only',
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    createdByName,
    lastUsedAt: lastUsed ? lastUsed.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: row.revokedAt ? 'revoked' : 'active',
    unattended: row.unattended === true,
    overrideCount,
  };
}

async function roleNameMap(db: DB, companyId: string): Promise<Map<string, string>> {
  return new Map((await listRoleDefinitions(db, companyId)).map((r) => [r.key, r.name]));
}

/** Stored adjustments (agent_policies rows) per agent of this company; an agent with none is absent. */
async function overrideCounts(db: DB, companyId: string, agentId?: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ agentId: agentPolicies.agentId, n: sql<number>`count(*)::int` })
    .from(agentPolicies)
    .where(agentId ? and(eq(agentPolicies.companyId, companyId), eq(agentPolicies.agentId, agentId)) : eq(agentPolicies.companyId, companyId))
    .groupBy(agentPolicies.agentId);
  return new Map(rows.map((r) => [r.agentId, Number(r.n)]));
}

/**
 * Make an agent. Returns its view and the token: the only time the token exists outside the
 * caller's hands. Nothing derived from it but the digest is stored or logged.
 */
export async function createAgent(ctx: ServiceContext, input: CreateAgentInput): Promise<{ agent: AgentView; token: string }> {
  assertAdminPerson(ctx, 'Adding an agent');
  if (await agentsBlockedFor(ctx.db, ctx.companyId)) throw new ServiceError('FORBIDDEN', AGENTS_BLOCKED_MESSAGE);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw validation('Give the agent a name.');
  if (name.length > 100) throw validation('The name can be at most 100 characters.');
  const preset = presetOfInput(input);
  const mode = modeForPreset(preset);

  // Any role a person can have, Admin included (D1): the role is the agent's ceiling, and the
  // policy keeps Admin, company-file and password work on Ask at the most (lib/agent/policy.ts).
  const roleKeys = [...new Set((Array.isArray(input.roleKeys) ? input.roleKeys : []).filter((k) => typeof k === 'string' && k))];
  if (!roleKeys.length) throw validation('Choose at least one role for the agent.');
  const names = await roleNameMap(ctx.db, ctx.companyId);
  const unknown = roleKeys.filter((k) => !names.has(k));
  if (unknown.length) throw validation('One of the chosen roles does not exist in this company.');

  // The defaults of the simple lists (terms, payment methods…) are saved the first time a list is
  // opened. An agent only reads, so they are put in now, under the Admin.
  for (const key of SIMPLE_LIST_KEYS) await ensureSeeded(ctx, key);

  const token = newToken();
  const digest = agentTokenDigest(token);
  const row = await inTransaction(ctx, async (tx) => {
    const [taken] = await tx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, tx.companyId), isNull(agents.revokedAt), sql`lower(${agents.name}) = ${name.toLowerCase()}`));
    if (taken) throw new ServiceError('CONFLICT', `There is already an agent named "${name}".`);
    const [created] = await tx.db
      .insert(agents)
      .values({
        companyId: tx.companyId,
        name,
        roleKeys,
        preset,
        mode,
        // Only "Full, with asks" lets bulk work run unasked, and then always within a count cap;
        // it is written down so the Agents tab shows the number the decisions use.
        bulkCap: presetBulkCap(preset),
        tokenHash: digest.hash,
        tokenPrefix: token.slice(0, 18),
        keyId: digest.keyId,
        createdBy: tx.userId,
        unattended: input.unattended === true,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'agent',
      entityId: created.id,
      newValues: { name, roleKeys, preset, mode, tokenPrefix: created.tokenPrefix, unattended: created.unattended },
    });
    return created;
  });
  syncAgentEndpoint(ctx.db).catch(() => undefined);
  // A new agent has no adjustments yet: its preset is its whole policy.
  return { agent: toView(row, names, null, null, 0), token };
}

/**
 * The company's agents, newest first, for anyone who may see Users & Roles > Users (the same
 * people who may open an agent's page), each with how many adjustments it has. Never the digest.
 */
export async function listAgents(ctx: ServiceContext): Promise<AgentView[]> {
  await assertMaySeeAgents(ctx);
  const rows = await ctx.db
    .select({ agent: agents, createdByName: users.name })
    .from(agents)
    .leftJoin(users, eq(users.id, agents.createdBy))
    .where(eq(agents.companyId, ctx.companyId))
    .orderBy(desc(agents.createdAt));
  const names = await roleNameMap(ctx.db, ctx.companyId);
  const adjusted = await overrideCounts(ctx.db, ctx.companyId);
  return rows.map((r) => toView(r.agent, names, r.createdByName ?? null, lastUsedOf(r.agent), adjusted.get(r.agent.id) ?? 0));
}

/**
 * How many agents of this company are not removed (paused ones count: they can be turned back on).
 * A number only, for the title bar, which shows "Pause all agents" whenever any agent exists.
 */
export async function agentCount(db: DB, companyId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.revokedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Take an agent's access away. Its token stops working with the next request, and the standing
 * permission people gave it (agent_grants still unexpired and not taken back) is taken back in the
 * same step, each audited as taken back with the agent's removal: nothing a person lent it outlives
 * it on the record either. (A removed agent's grants were already refused when used, by liveGrants
 * and useGrant in lib/services/agentGrants.ts.)
 */
export async function revokeAgent(ctx: ServiceContext, id: string): Promise<AgentView> {
  assertAdminPerson(ctx, 'Removing an agent');
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound('Agent');
  const row = await inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, tx.companyId)));
    if (!existing) throw notFound('Agent');
    if (existing.revokedAt) return existing;
    const now = new Date();
    const [updated] = await tx.db
      .update(agents)
      .set({ revokedAt: now, revokedBy: tx.userId })
      .where(eq(agents.id, id))
      .returning();
    const ended = await tx.db
      .update(agentGrants)
      .set({ revokedAt: now, revokedBy: tx.userId })
      .where(
        and(
          eq(agentGrants.companyId, tx.companyId),
          eq(agentGrants.agentId, id),
          isNull(agentGrants.revokedAt),
          gt(agentGrants.expiresAt, now),
        ),
      )
      .returning({ id: agentGrants.id, operation: agentGrants.operation });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'agent',
      entityId: id,
      oldValues: { name: existing.name, revoked: false },
      newValues: { name: existing.name, revoked: true, ...(ended.length ? { grantsTakenBack: ended.length } : {}) },
    });
    // The same audit shape revokeGrant writes, so the grant's own history says it ended.
    for (const g of ended) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'agent_grant',
        entityId: g.id,
        oldValues: { agentId: id, operation: g.operation, revoked: false },
        newValues: { agentId: id, operation: g.operation, revoked: true, reason: 'agent removed' },
      });
    }
    return updated;
  });
  syncAgentEndpoint(ctx.db).catch(() => undefined);
  const adjusted = await overrideCounts(ctx.db, ctx.companyId, row.id);
  return toView(row, await roleNameMap(ctx.db, ctx.companyId), null, lastUsedOf(row), adjusted.get(row.id) ?? 0);
}

/**
 * Take every agent's access away, in every company of the file. Run on restored books
 * (lib/services/backup.ts; a Portable restore uses endAgentAccessInRestoredBooks in
 * lib/services/portableFile.ts, which backup.ts runs too): agent access is given at this computer
 * to the books as they are now, and a restore must not bring back one that was removed.
 */
export async function revokeAllAgents(db: DB): Promise<number> {
  const ended = await db.update(agents).set({ revokedAt: new Date() }).where(isNull(agents.revokedAt)).returning({ id: agents.id });
  return ended.length;
}

// ---------------------------------------------------------------------------
// Use
// ---------------------------------------------------------------------------

export interface ActiveAgent {
  id: string;
  companyId: string;
  name: string;
  roleKeys: string[];
  /** What it may do without asking (lib/agent/policy.ts). */
  preset: AgentPreset;
  mode: AgentMode;
  /**
   * ISO time a person paused it, or null. A paused agent still has its token (so the door can tell
   * it why it is refused); the policy refuses everything it asks (lib/agent/policy.ts decide).
   */
  pausedAt: string | null;
  /** The Admin who let the agent in: the person answerable for what it enters. */
  createdBy: string | null;
  /** May work while the file is open but nobody is signed in. */
  unattended: boolean;
}

/**
 * The active agent a token belongs to, or null (unknown, removed, made on another computer, or
 * not shaped like a token). The digest is looked up by the unique index; nothing compares the
 * token itself.
 */
export async function findAgentByToken(db: DB, token: string): Promise<ActiveAgent | null> {
  if (typeof token !== 'string' || !AGENT_TOKEN_RE.test(token)) return null;
  const digest = agentTokenDigest(token);
  const [row] = await db.select().from(agents).where(eq(agents.tokenHash, digest.hash));
  if (!row || row.revokedAt) return null;
  // The row must have been made the way this computer makes digests now: keyed by this device
  // secret, or unkeyed where there is none. An unkeyed row is never accepted next to a device secret.
  if ((row.keyId ?? null) !== digest.keyId) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    roleKeys: Array.isArray(row.roleKeys) ? row.roleKeys : [],
    preset: presetOfRow(row),
    mode: isAgentMode(row.mode) ? row.mode : 'read_only',
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    createdBy: row.createdBy ?? null,
    unattended: row.unattended === true,
  };
}

/**
 * An agent's access, its ceiling: every role it was given, Admin included (D1), with the agent
 * limits of lib/permissions/agentAccess.ts applied (clampForAgent decides what of an Admin role an
 * agent keeps). A role that no longer exists gives nothing.
 */
export async function agentAccess(db: DB, agent: Pick<ActiveAgent, 'companyId' | 'roleKeys'>): Promise<EffectiveAccess> {
  const keys = (Array.isArray(agent.roleKeys) ? agent.roleKeys : []).filter((k) => typeof k === 'string' && k);
  return clampForAgent(unionRoles(await definitionsFor(db, agent.companyId, keys)));
}

// Last use is kept in memory and saved at most once a day: an agent reading reports must not make
// the company file save itself over and over (the file autosaves whenever the database changes).
const LAST_USED_SAVE_MS = 24 * 60 * 60 * 1000;
const gl = globalThis as typeof globalThis & { __ironbooksAgentLastUsed?: Map<string, Date> };
const lastUsed: Map<string, Date> = (gl.__ironbooksAgentLastUsed ??= new Map());

/** When the agent last worked: the time kept in memory this run, or the saved one if later. */
export function lastUsedOf(row: Pick<AgentRow, 'id' | 'lastUsedAt'>): Date | null {
  const mem = lastUsed.get(row.id) ?? null;
  if (mem && (!row.lastUsedAt || mem > row.lastUsedAt)) return mem;
  return row.lastUsedAt ?? null;
}

/** Note that an agent was used now. Never fails the request it is called from. */
export async function touchAgent(db: DB, agentId: string, now: Date = new Date()): Promise<void> {
  lastUsed.set(agentId, now);
  try {
    const cutoff = new Date(now.getTime() - LAST_USED_SAVE_MS);
    await db
      .update(agents)
      .set({ lastUsedAt: now })
      .where(and(eq(agents.id, agentId), sql`(${agents.lastUsedAt} IS NULL OR ${agents.lastUsedAt} < ${cutoff})`));
  } catch {
    /* the in-memory time is enough */
  }
}

// ---------------------------------------------------------------------------
// The endpoint file
// ---------------------------------------------------------------------------

/**
 * Publish the endpoint file while this company file has an active agent, and take it away when it
 * has none (lib/agent/endpointFile.ts). Called after agents change and the first time a person
 * signs in during a run.
 */
export async function syncAgentEndpoint(db: DB): Promise<boolean> {
  const tag = agentFileTag();
  const [any] = await db.select({ id: agents.id }).from(agents).where(isNull(agents.revokedAt)).limit(1);
  if (!any) {
    if (endpointPublished(tag)) withdrawEndpoint(tag);
    return false;
  }
  // Nothing is published before a person has signed in to this file in this run, unless an Admin
  // allowed an agent to work unattended (and then never past a company-file password).
  if (!personSignedIn(resolveDataDir()) && !(await unattendedAgentsReady(db))) return false;
  return publishEndpoint(tag);
}

/**
 * How many agents may work in this file right now with nobody signed in: active agents an Admin
 * allowed to work unattended, in a file without a company-file password. (A file protected with
 * passwords is not open at all before a person signs in, so this is never asked of one.)
 */
export async function unattendedAgentsReady(db: DB): Promise<number> {
  if ((await getFileLockStatus(db)).enabled) return 0;
  const rows = await db.select({ id: agents.id }).from(agents).where(and(isNull(agents.revokedAt), eq(agents.unattended, true)));
  return rows.length;
}

/** When any agent last worked in this run of the app (in memory), or null. */
export function lastAgentUse(): Date | null {
  let latest: Date | null = null;
  for (const d of lastUsed.values()) if (!latest || d > latest) latest = d;
  return latest;
}

/** Agents by id, for screens that name who did something (id → name). */
export async function agentNames(db: DB, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}
