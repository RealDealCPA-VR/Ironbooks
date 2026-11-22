/**
 * Agent full access: an agent's policy as stored, and the Agents tab's view of one agent (plan
 * §4.1, §4.2, §4.6, §7.1, §12; contract §6 and §11).
 *
 * What an agent may do without asking is its preset (agents.preset) with an Admin's adjustments
 * on top (agent_policies: one Allow / Ask / Never per class, everywhere or within one area), and
 * the limits kept on the agents row: the bulk cap, the two-person amount, how long a request
 * waits, the folders it may use, the email notice and whether it is paused. lib/agent/policy.ts
 * turns those into one AgentPolicy (resolvePolicy); this module reads and writes them.
 *
 * Who may do what here:
 *  - Reading an agent's policy or ceiling for a decision (loadAgentPolicy, agentCeiling) is
 *    plumbing for the agent's door, the bridge and the approval center: any context of the
 *    company may, except that an agent only ever reads its own.
 *  - The Agents tab's screens (getAgentPolicyView, getAgentDetail, listAgentActivity) are for a
 *    person who may see Users & Roles.
 *  - Changing anything (saveAgentPolicy, pauseAgent, pauseAllAgents) is for a person signed in to
 *    Ironbooks whose own access may modify Users & Roles > Users. A context that carries an agent,
 *    and any work running inside an agent's bridged run (lib/serviceScope.ts), is refused whatever
 *    else it holds: an agent never changes an agent, its own settings included (plan 4.6, D9).
 *  - Letting an agent do more is for an Admin (plan 4.4: "Always allow this class here" changes the
 *    policy, and only an Admin can do it). A save by anyone else that loosens anything is refused
 *    whole: a higher preset, a cell moved toward Allow, a higher or removed bulk cap, a folder it
 *    could not reach before, a higher or removed two-person amount, a longer wait for its requests,
 *    or the email notice turned on (an outside send). Tightening stays open to everyone who may
 *    manage agents, whatever the agent's own access: it can only take room away.
 *  - Anyone who may manage agents may pause one: stopping is never held back. As for people
 *    (lib/services/users.ts), a person who is not an Admin may not turn back on an agent whose
 *    access reaches beyond their own.
 *
 * Every change is one transaction and one audit row naming what changed, with the person as the
 * one who did it. "Pause all agents" is the company's Integrated Applications switch and goes
 * through the same code path as Preferences (lib/services/company.ts updateCompany).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { resolveDataDir } from '@/lib/db';
import { agentGrants, agentPermissionRequests, agentPolicies, agents, auditLogs, companies, users } from '@/lib/db/schema';
import { AREA_KEYS, areaLabel, canActivity, isSubset, legacyRoleFor, type Area, type EffectiveAccess } from '@/lib/permissions/model';
import { includesAdminRole } from '@/lib/permissions/agentAccess';
import {
  DEFAULT_BULK_CAP,
  canBeAllowed,
  isAgentPreset,
  isPaused,
  isPolicySetting,
  policyProblems,
  resolvePolicy,
  settingFor,
  type PolicyLimits,
} from '@/lib/agent/policy';
import {
  ADMIN_APPROVAL_CLASSES,
  AGENT_PRESETS,
  AGENT_PRESET_LABELS,
  NEVER_ALLOW_CLASSES,
  REQUEST_STATUSES,
  RISK_CLASSES,
  RISK_CLASS_LABELS,
  isRiskClass,
  type AgentPolicy,
  type AgentPreset,
  type PolicyOverride,
  type PolicySetting,
  type RequestStatus,
  type RiskClass,
} from '@/lib/agent/operations/types';
import { Money } from '@/lib/money';
import type {
  AgentActivityRow,
  AgentCeiling,
  AgentDetail,
  AgentPolicyInput,
  AgentPolicyView,
  GetAgentPolicyView,
  LoadAgentPolicy,
  PauseAgent,
  PauseAllAgents,
  SaveAgentPolicy,
} from '@/lib/agent/contract';
import { allowedFolder, appDataPlaces, isThisComputerShare, overlapsAppData, stagedFilesRoot } from '@/lib/agent/files';
import { endpointDir } from '@/lib/agent/endpointFile';
// The scope module, not lib/context.ts: it holds no database or service imports, so the agent's
// door can import this module without a cycle through lib/context.ts.
import { inServiceScope } from '@/lib/serviceScope';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { listRoleDefinitions, permissionDenied, resolveAccess } from './access';
import { agentAccess, agentsBlockedFor, lastUsedOf, modeForPreset, presetOfRow } from './agents';
import { backupFoldersHere, preOpFolder } from './backupHistory';
import { updateCompany } from './company';

type AgentRow = typeof agents.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIN = process.platform === 'win32';

/** The Users & Roles activity the agents routes are mapped to (lib/permissions/routeActivities.ts). */
const MANAGE_AGENTS = 'users.users';

/** Largest bulk cap, longest wait, most folders, largest two-person amount (decimal(15, 2)). */
const BULK_CAP_MAX = 100_000;
const EXPIRY_DAYS_MAX = 365;
const FOLDERS_MAX = 50;
const TWO_PERSON_MAX = new Decimal('9999999999999.99');
/** One override per class, everywhere and in each area. */
const OVERRIDES_MAX = RISK_CLASSES.length * (AREA_KEYS.length + 1);
/** Most rows the activity list shows (plan 7.1). */
const ACTIVITY_MAX = 200;

const AGENT_NEVER =
  "An agent can never change an agent's settings, its own included. A person can do it in Users & Roles > Agents.";
const AGENT_NO_VIEW =
  'An agent cannot open the Agents tab. It can read its own permissions with get_my_permissions.';
const SIGN_IN_FIRST = 'Only a person signed in to Ironbooks can change what an agent may do.';
const NO_ACCESS = 'You do not have access to this company.';
const REMOVED = 'This agent has been removed, so its settings can no longer be changed.';
const MORE_THAN_YOU_RESUME = 'Only an Admin can turn back on an agent that has more access than you.';
const ADMIN_AGENT_RESUME = 'Only an Admin can turn back on an agent that holds the Admin role.';
/** Most loosened settings a refusal names; the rest are counted. */
const LOOSER_SHOWN = 3;
const PAUSE_ALL_FOR_ADMIN =
  'Only an Admin can pause or resume every agent at once. You can pause one agent at a time in Users & Roles > Agents.';
const PRESET_CHOICE =
  'Choose what the agent may do: Read only, Ask for every change, Trusted bookkeeper or Full, with asks.';
const SAY_PAUSED = 'Say whether to pause (true) or turn back on (false).';
const FOLDERS_CHANGED =
  "This agent's folders were changed by someone else while you were saving. Open the agent again and save once more.";

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/** An agent's own context, or work inside an agent's bridged run, whatever context it was handed. */
function refuseAgents(ctx: ServiceContext, message: string): void {
  if (ctx.agent || inServiceScope()) throw new ServiceError('FORBIDDEN', message);
}

/** The person's own access: the request's, or read from the company file for a context built without it. */
async function accessOfPerson(ctx: ServiceContext, userId: string): Promise<EffectiveAccess> {
  if (ctx.access) return ctx.access;
  const r = await resolveAccess(ctx.db, ctx.companyId, userId);
  if (!r.member || !r.active) throw new ServiceError('FORBIDDEN', NO_ACCESS);
  return r.access;
}

/**
 * The access of the person changing an agent's settings: signed in (a user id: a trusted context
 * with nobody behind it changes nothing here), not an agent, and allowed to modify Users & Roles.
 */
async function personWhoManagesAgents(ctx: ServiceContext): Promise<EffectiveAccess> {
  refuseAgents(ctx, AGENT_NEVER);
  if (typeof ctx.userId !== 'string' || !ctx.userId) throw new ServiceError('FORBIDDEN', SIGN_IN_FIRST);
  const access = await accessOfPerson(ctx, ctx.userId);
  if (!canActivity(access, MANAGE_AGENTS, 'modify')) throw permissionDenied('users', 'modify', MANAGE_AGENTS);
  return access;
}

/** The Agents tab's screens: a person who may see Users & Roles. A trusted internal context passes. */
async function assertMaySeeAgents(ctx: ServiceContext): Promise<void> {
  refuseAgents(ctx, AGENT_NO_VIEW);
  if (!ctx.access && !ctx.userId) return;
  const access = await accessOfPerson(ctx, ctx.userId ?? '');
  if (!canActivity(access, MANAGE_AGENTS, 'view')) throw permissionDenied('users', 'view', MANAGE_AGENTS);
}

/**
 * A person who is not an Admin may turn back on only an agent whose ceiling is within their own
 * access, and never one that holds the Admin role (as lib/services/users.ts holds user managers).
 * (A save needs no such check: a non-Admin's save may only tighten, see loosenings.)
 */
async function assertWithinYourAccess(
  ctx: ServiceContext,
  person: EffectiveAccess,
  row: AgentRow,
  messages: { admin: string; more: string },
): Promise<void> {
  if (person.isAdmin) return;
  const roleKeys = roleKeysOf(row);
  if (includesAdminRole(roleKeys)) throw new ServiceError('FORBIDDEN', messages.admin);
  const ceiling = await agentAccess(ctx.db, { companyId: ctx.companyId, roleKeys });
  if (ceiling.isAdmin || !isSubset(ceiling, person)) throw new ServiceError('FORBIDDEN', messages.more);
}

/**
 * Whether this person may use "Pause all agents" (the title bar asks, AgentRequestCount.canPauseAll):
 * a person who may manage agents and is an Admin, since the switch is the company's Integrated
 * Applications setting, which only an Admin changes. False for an agent and on any doubt.
 */
export async function mayPauseAllAgents(ctx: ServiceContext): Promise<boolean> {
  try {
    return (await personWhoManagesAgents(ctx)).isAdmin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function roleKeysOf(row: AgentRow): string[] {
  return Array.isArray(row.roleKeys) ? row.roleKeys.filter((k): k is string => typeof k === 'string' && k !== '') : [];
}

/** The agent in this company, removed or not, or null. */
async function agentRowFor(ctx: ServiceContext, agentId: string): Promise<AgentRow | null> {
  if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) return null;
  const [row] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, ctx.companyId)));
  return row ?? null;
}

/**
 * The agent a decision is about: in this company and not removed. An agent's own context only
 * ever finds itself: another agent is "not found", the same answer as one that does not exist.
 */
async function liveAgent(ctx: ServiceContext, agentId: string): Promise<AgentRow> {
  if (ctx.agent && ctx.agent.id !== agentId) throw notFound('Agent');
  const row = await agentRowFor(ctx, agentId);
  if (!row || row.revokedAt) throw notFound('Agent');
  return row;
}

const isArea = (v: unknown): v is Area => typeof v === 'string' && (AREA_KEYS as string[]).includes(v);

/** An override the engine understands (a stored row that is not one is ignored by it, never loosened). */
function understood(o: PolicyOverride): boolean {
  return isRiskClass(o.class) && (o.area === null || isArea(o.area)) && isPolicySetting(o.setting);
}

/** Classes in the grid's order, the class everywhere before its areas. */
function sortOverrides(list: PolicyOverride[]): PolicyOverride[] {
  const rank = (o: PolicyOverride) => (RISK_CLASSES as readonly string[]).indexOf(o.class);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.area ?? '').localeCompare(b.area ?? ''));
}

/** The agent's stored overrides, as stored: resolvePolicy reads them strictly. */
async function storedOverrides(ctx: ServiceContext, agentId: string): Promise<PolicyOverride[]> {
  const rows = await ctx.db
    .select({ class: agentPolicies.class, area: agentPolicies.area, setting: agentPolicies.setting })
    .from(agentPolicies)
    .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.companyId, ctx.companyId)));
  return sortOverrides(
    rows.map((r) => ({ class: r.class as RiskClass, area: (r.area ?? null) as Area | null, setting: r.setting as PolicySetting })),
  );
}

/** The limits on the agents row, as the engine takes them. */
function limitsOf(row: AgentRow): PolicyLimits {
  return {
    bulkCap: row.bulkCap ?? null,
    twoPersonOver: row.twoPersonOver ?? null,
    requestExpiryDays: row.requestExpiryDays,
    folders: Array.isArray(row.folders) ? row.folders : [],
    notifyEmail: row.notifyEmail === true,
    pausedAt: row.pausedAt ?? null,
  };
}

/**
 * When Integrated Applications was switched off for the company ("Don't allow any applications"),
 * or null while applications are allowed. The same test the agent's door makes (agentsBlockedFor
 * in ./agents).
 *
 * The time is that of the company save that switched it: Preferences and "Pause all agents" both
 * go through updateCompany, whose audit row holds what the save set and what it was before (a
 * later save that sends the switch again unchanged, or changes something else, is not one). Never
 * the company's last change (companies.updated_at), which any later Preferences save moves. A file
 * with no such row (switched by an older version, or by hand) cannot say when, so it gives a time
 * nothing moves: when the company was made, the earliest the switch can have been turned. Only
 * "paused" matters to every decision (isPaused); the time is for showing.
 */
async function appsBlockedSince(ctx: ServiceContext): Promise<string | null> {
  const [c] = await ctx.db
    .select({ settings: companies.settings, createdAt: companies.createdAt })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const s = c?.settings && typeof c.settings === 'object' ? (c.settings as Record<string, unknown>) : null;
  if (s?.integratedAppsBlocked !== true) return null;
  const [switched] = await ctx.db
    .select({ at: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'company'),
        eq(auditLogs.entityId, ctx.companyId),
        sql`${auditLogs.newValues} -> 'settings' -> 'integratedAppsBlocked' = 'true'::jsonb`,
        sql`coalesce(${auditLogs.oldValues} -> 'settings' -> 'integratedAppsBlocked', 'false'::jsonb) <> 'true'::jsonb`,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  // Not `new Date()` either when nothing is found: the time would move on every read.
  return (switched?.at ?? c?.createdAt ?? new Date(0)).toISOString();
}

/**
 * An agent's policy for a decision: its preset, its stored overrides and the limits on its row,
 * through resolvePolicy. While the company's Integrated Applications switch is off every agent is
 * paused, so the policy says paused then too: an approval given meanwhile must not run either.
 * Unknown, removed, or (for an agent's context) another agent: NOT_FOUND.
 */
export const loadAgentPolicy: LoadAgentPolicy = async (ctx, agentId) => {
  const row = await liveAgent(ctx, agentId);
  const limits = limitsOf(row);
  if (!isPaused(limits.pausedAt)) {
    const blockedAt = await appsBlockedSince(ctx);
    if (blockedAt) limits.pausedAt = blockedAt;
  }
  return resolvePolicy(row.preset as AgentPreset, await storedOverrides(ctx, row.id), limits);
};

/**
 * Locked cells of the policy grid, with the reason in plain words: the classes that can never be
 * Allow (plan 4.2), and who approves them instead.
 */
function lockedCells(): AgentPolicyView['locked'] {
  return NEVER_ALLOW_CLASSES.filter((cls) => !canBeAllowed(cls)).map((cls) => ({
    class: cls,
    setting: 'allow' as const,
    reason: ADMIN_APPROVAL_CLASSES.includes(cls)
      ? `"${RISK_CLASS_LABELS[cls]}" can never be Allow for an agent: only an Admin can approve this work.`
      : `"${RISK_CLASS_LABELS[cls]}" can never be Allow for an agent: a person approves this work.`,
  }));
}

/** The grid's view of a stored policy (a removed agent's too, shown as it was). */
async function policyViewOf(ctx: ServiceContext, row: AgentRow): Promise<AgentPolicyView> {
  const stored = await storedOverrides(ctx, row.id);
  const policy = resolvePolicy(row.preset as AgentPreset, stored, limitsOf(row));
  return { agentId: row.id, preset: policy.preset, overrides: stored.filter(understood), policy, locked: lockedCells() };
}

/** The policy grid of one agent: its preset, its stored overrides, the policy they make and the locked cells. */
export const getAgentPolicyView: GetAgentPolicyView = async (ctx, agentId) => {
  await assertMaySeeAgents(ctx);
  const row = await agentRowFor(ctx, agentId);
  if (!row) throw notFound('Agent');
  return policyViewOf(ctx, row);
};

/**
 * The agent's ceiling: the access of its roles through the agent limits (agentAccess in ./agents,
 * clampForAgent), the role word a context built for it needs (as lib/agent/actions.ts writeContext
 * derives it) and the names of its roles that still exist.
 */
export const agentCeiling: AgentCeiling = async (ctx, agentId) => {
  const row = await liveAgent(ctx, agentId);
  const roleKeys = roleKeysOf(row);
  const access = await agentAccess(ctx.db, { companyId: ctx.companyId, roleKeys });
  return { access, role: legacyRoleFor(access, false), roleNames: await roleNamesOf(ctx, roleKeys) };
};

async function roleNamesOf(ctx: ServiceContext, roleKeys: string[]): Promise<string[]> {
  const names = new Map((await listRoleDefinitions(ctx.db, ctx.companyId)).map((r) => [r.key, r.name]));
  return roleKeys.map((k) => names.get(k)).filter((n): n is string => Boolean(n));
}

/** The Agents tab's detail page (GET /api/agents/[id]). A removed agent is shown as it was. */
export async function getAgentDetail(ctx: ServiceContext, agentId: string): Promise<AgentDetail> {
  await assertMaySeeAgents(ctx);
  const row = await agentRowFor(ctx, agentId);
  if (!row) throw notFound('Agent');
  const roleKeys = roleKeysOf(row);
  const lastUsed = lastUsedOf(row);
  return {
    id: row.id,
    name: row.name,
    roleKeys,
    roleNames: await roleNamesOf(ctx, roleKeys),
    unattended: row.unattended === true,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: lastUsed ? lastUsed.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    paused: isPaused(row.pausedAt),
    policy: await policyViewOf(ctx, row),
    allPaused: await agentsBlockedFor(ctx.db, ctx.companyId),
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const AUDIT_VERB: Record<string, string> = {
  create: 'Added',
  update: 'Changed',
  delete: 'Deleted',
  void: 'Voided',
  llm_correction: 'Corrected',
};

/** "Added invoice", "Changed bank rule": the audit row in plain words (its values stay in the audit trail). */
function auditSummary(action: string, entityType: string): string {
  const what = entityType.replace(/[_-]+/g, ' ').trim() || 'record';
  return `${AUDIT_VERB[action] ?? 'Changed'} ${what}`;
}

/** Statuses where the decider said yes (a failed request failed after it was approved). */
const APPROVED: readonly string[] = ['approved', 'executed', 'failed'];

function requestStatusOf(v: string): RequestStatus {
  return (REQUEST_STATUSES as readonly string[]).includes(v) ? (v as RequestStatus) : 'failed';
}

function both(a: string | null, b: string | null): string | null {
  if (a && b && a !== b) return `${a} and ${b}`;
  return a ?? b;
}

/**
 * The agent's last operations (audit rows carrying its id) and requests, newest first, at most
 * 200, each with who approved it: the approver of a run, the person who gave the standing
 * permission it ran under, or the people who approved a request.
 */
export async function listAgentActivity(ctx: ServiceContext, agentId: string, limit = ACTIVITY_MAX): Promise<AgentActivityRow[]> {
  await assertMaySeeAgents(ctx);
  const row = await agentRowFor(ctx, agentId);
  if (!row) throw notFound('Agent');
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), ACTIVITY_MAX) : ACTIVITY_MAX;

  const audits = await ctx.db
    .select({
      id: auditLogs.id,
      at: auditLogs.createdAt,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      approvedBy: auditLogs.approvedBy,
      requestId: auditLogs.agentRequestId,
      grantId: auditLogs.agentGrantId,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.agentId, row.id)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(n);

  const requests = await ctx.db
    .select({
      id: agentPermissionRequests.id,
      at: agentPermissionRequests.createdAt,
      operation: agentPermissionRequests.operation,
      class: agentPermissionRequests.class,
      summary: agentPermissionRequests.summary,
      status: agentPermissionRequests.status,
      decidedBy: agentPermissionRequests.decidedBy,
      secondApprover: agentPermissionRequests.secondApprover,
    })
    .from(agentPermissionRequests)
    .where(and(eq(agentPermissionRequests.companyId, ctx.companyId), eq(agentPermissionRequests.agentId, row.id)))
    .orderBy(desc(agentPermissionRequests.createdAt))
    .limit(n);

  // The request and the grant an operation ran under, for its operation id, class and approver.
  const reqIds = [...new Set(audits.map((a) => a.requestId).filter((id): id is string => !!id))];
  const linked = new Map<string, { operation: string; class: string }>();
  for (const r of requests) linked.set(r.id, { operation: r.operation, class: r.class });
  const missing = reqIds.filter((id) => !linked.has(id));
  if (missing.length) {
    const more = await ctx.db
      .select({ id: agentPermissionRequests.id, operation: agentPermissionRequests.operation, class: agentPermissionRequests.class })
      .from(agentPermissionRequests)
      .where(and(eq(agentPermissionRequests.companyId, ctx.companyId), inArray(agentPermissionRequests.id, missing)));
    for (const r of more) linked.set(r.id, { operation: r.operation, class: r.class });
  }
  const grantIds = [...new Set(audits.map((a) => a.grantId).filter((id): id is string => !!id))];
  const givers = new Map<string, string>();
  if (grantIds.length) {
    const rows = await ctx.db
      .select({ id: agentGrants.id, givenBy: agentGrants.givenBy })
      .from(agentGrants)
      .where(and(eq(agentGrants.companyId, ctx.companyId), inArray(agentGrants.id, grantIds)));
    for (const g of rows) givers.set(g.id, g.givenBy);
  }

  const people = await peopleNames(ctx, [
    ...audits.map((a) => a.approvedBy),
    ...[...givers.values()],
    ...requests.flatMap((r) => [r.decidedBy, r.secondApprover]),
  ]);
  const nameOf = (id: string | null | undefined) => (id ? people.get(id) ?? null : null);

  const out: Array<AgentActivityRow & { sortAt: number }> = [];
  for (const a of audits) {
    const req = a.requestId ? linked.get(a.requestId) : undefined;
    out.push({
      sortAt: a.at.getTime(),
      at: a.at.toISOString(),
      kind: 'operation',
      operation: req?.operation ?? `${a.entityType}.${a.action}`,
      summary: auditSummary(a.action, a.entityType),
      class: req && isRiskClass(req.class) ? req.class : null,
      status: 'done',
      approvedByName: nameOf(a.approvedBy) ?? nameOf(a.grantId ? givers.get(a.grantId) : null),
      auditId: a.id,
      requestId: a.requestId ?? null,
    });
  }
  for (const r of requests) {
    const status = requestStatusOf(r.status);
    out.push({
      sortAt: r.at.getTime(),
      at: r.at.toISOString(),
      kind: 'request',
      operation: r.operation,
      summary: r.summary,
      class: isRiskClass(r.class) ? r.class : null,
      status,
      approvedByName: APPROVED.includes(status) ? both(nameOf(r.decidedBy), nameOf(r.secondApprover)) : null,
      auditId: null,
      requestId: r.id,
    });
  }
  out.sort((x, y) => y.sortAt - x.sortAt || (x.kind === y.kind ? 0 : x.kind === 'request' ? 1 : -1));
  return out.slice(0, n).map(({ sortAt: _sortAt, ...rest }) => rest);
}

async function peopleNames(ctx: ServiceContext, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** What a save asked for, checked and in stored form. Left out: unchanged. */
interface AskedPolicy {
  preset?: AgentPreset;
  overrides?: PolicyOverride[];
  bulkCap?: number | null;
  twoPersonOver?: string | null;
  requestExpiryDays?: number;
  folders?: string[];
  notifyEmail?: boolean;
}

/** A value from the input, shortened and on one line, for a message. */
function shown(v: unknown, max = 60): string {
  const s = String(v).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cellWords(cls: RiskClass, area: Area | null): string {
  return area ? `"${RISK_CLASS_LABELS[cls]}" in ${areaLabel(area)}` : `"${RISK_CLASS_LABELS[cls]}"`;
}

/** Decimal text with two places, or null for "off". Throws when it is not an amount. */
function readAmount(v: unknown): string | null {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const bad = () =>
    validation('The amount above which two people must approve must be an amount like 5000.00, or empty to turn it off.');
  if (typeof v !== 'string' && typeof v !== 'number') throw bad();
  let d: Decimal;
  try {
    d = new Decimal(typeof v === 'string' ? v.trim() : v);
  } catch {
    throw bad();
  }
  if (!d.isFinite() || d.isNegative() || d.decimalPlaces() > 2 || d.greaterThan(TWO_PERSON_MAX)) throw bad();
  return d.toFixed(2);
}

/** Check the shape of a save. Every refusal says what to change; nothing is guessed. */
function readPolicyInput(input: AgentPolicyInput): AskedPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validation('Nothing to save was sent.');
  const out: AskedPolicy = {};

  if (input.preset !== undefined) {
    if (!isAgentPreset(input.preset)) throw validation(PRESET_CHOICE);
    out.preset = input.preset;
  }

  if (input.overrides !== undefined) {
    if (!Array.isArray(input.overrides)) throw validation('The Allow, Ask and Never settings must be sent as a list.');
    if (input.overrides.length > OVERRIDES_MAX) {
      throw validation(`At most ${OVERRIDES_MAX} settings can be saved: one per kind of work, everywhere and in each area.`);
    }
    const seen = new Set<string>();
    const list: PolicyOverride[] = [];
    for (const raw of input.overrides as unknown[]) {
      const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      if (!o) throw validation('One of the Allow, Ask and Never settings is empty. Remove it and save again.');
      const cls = o.class;
      if (!isRiskClass(cls)) throw validation(`One of the settings names a kind of work Ironbooks does not know ("${shown(cls)}").`);
      const area = o.area === undefined || o.area === null ? null : o.area;
      if (area !== null && !isArea(area)) {
        throw validation(`The setting for "${RISK_CLASS_LABELS[cls]}" names an area Ironbooks does not know ("${shown(area)}").`);
      }
      const where = cellWords(cls, area);
      if (!isPolicySetting(o.setting)) throw validation(`${where} must be Allow, Ask or Never.`);
      if (o.setting === 'allow' && !canBeAllowed(cls)) throw validation(`${where} can never be Allow for an agent. Set it to Ask or Never.`);
      const key = `${cls}|${area ?? ''}`;
      if (seen.has(key)) throw validation(`${where} is set twice. Keep one setting for it.`);
      seen.add(key);
      list.push({ class: cls, area, setting: o.setting });
    }
    out.overrides = sortOverrides(list);
  }

  if (input.bulkCap !== undefined) {
    const v = input.bulkCap;
    if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= BULK_CAP_MAX)) {
      throw validation(
        `The most records one request may change must be a whole number from 1 to ${BULK_CAP_MAX.toLocaleString('en-US')}, or empty for no limit.`,
      );
    }
    out.bulkCap = v;
  }

  if (input.twoPersonOver !== undefined) out.twoPersonOver = readAmount(input.twoPersonOver);

  if (input.requestExpiryDays !== undefined) {
    const v = input.requestExpiryDays;
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= EXPIRY_DAYS_MAX)) {
      throw validation(`Days a request waits for an answer must be a whole number from 1 to ${EXPIRY_DAYS_MAX}.`);
    }
    out.requestExpiryDays = v;
  }

  if (input.folders !== undefined) {
    if (!Array.isArray(input.folders) || input.folders.some((f) => typeof f !== 'string')) {
      throw validation('The folders must be sent as a list of folder paths.');
    }
    if (input.folders.length > FOLDERS_MAX) throw validation(`An agent can have at most ${FOLDERS_MAX} folders.`);
    if (input.folders.some((f) => f.trim() === '')) throw validation('One of the folders is empty. Remove it or type its full path.');
    out.folders = input.folders.map((f) => f.trim());
  }

  if (input.notifyEmail !== undefined) {
    if (typeof input.notifyEmail !== 'boolean') throw validation('The email notice must be on or off (true or false).');
    out.notifyEmail = input.notifyEmail;
  }
  return out;
}

const EXAMPLE_FOLDER = WIN ? 'C:\\Users\\you\\Documents\\Receipts' : '/Users/you/Documents/Receipts';

/** A full path: a drive letter or a network share on Windows, a path from the root elsewhere. */
function looksAbsolute(p: string): boolean {
  return WIN ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : path.isAbsolute(p);
}

function samePathKey(p: string): string {
  const r = path.resolve(p);
  return WIN ? r.toLowerCase() : r;
}

/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  const c = samePathKey(child);
  const p = samePathKey(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Each path as written and, where it exists, with links resolved. A network path is kept as
 * written only: looking at it would offer this person's sign-in to that server (a backup folder
 * chosen on a share, say), and its words are what a folder is compared with.
 */
function withLinks(list: string[]): string[] {
  const out = [...list];
  for (const p of list) {
    if (isSharePath(p)) continue;
    try {
      out.push(fs.realpathSync.native(p));
    } catch {
      /* not there (yet): the path as written is checked */
    }
  }
  return out;
}

/**
 * Where the books themselves are: the database folder, the open company file's working folder
 * and the company file. An agent's folder may be none of them, inside none of them and hold none
 * of them: reading there would hand it the whole database unmasked, and saving there could damage
 * the books.
 */
function booksPlaces(): string[] {
  return withLinks(booksPlacesAsWritten());
}

/** booksPlaces as written, nothing looked at on the disk (for a folder judged by its words: keptFolderRefusal). */
function booksPlacesAsWritten(): string[] {
  const out = [resolveDataDir()];
  const state = process.env.BKA_COMPANY_STATE;
  if (state) out.push(path.dirname(path.resolve(state)));
  const file = process.env.BKA_COMPANY_FILE;
  if (file) out.push(path.resolve(file));
  return out;
}

/**
 * The names Ironbooks' settings folder has had (electron/main.js): the product name, the package
 * name a development run uses, and the two names from before the rename.
 */
const APP_FOLDER_NAMES = ['Ironbooks', 'ironbooks', 'BookKeeper AI', 'bookkeeper-ai'];

/**
 * Ironbooks' own folders on this computer: where agents' staged files are kept (lib/agent/files.ts,
 * every agent's, reports included), the agent connection files (lib/agent/endpointFile.ts), the
 * desktop app's settings folder (its userData: older companies' folders, quit-time backups, the
 * sealed device secret), its local folder (working copies of company files, sandboxes) and the
 * backup folders this computer writes to. Each holds a copy of the books, another agent's files or
 * the app's own state, so an agent's folder may be none of them, inside none of them and hold none
 * of them, as for the books. Every place lib/agent/files.ts appDataPlaces names is one of them too
 * (the copies Ironbooks writes beside the books and the company file, the real books while a
 * practice copy is open), so this list and its overlapsAppData never disagree about a stored folder.
 */
function ironbooksPlaces(): string[] {
  // Where staged files really are (lib/agent/files.ts decides: the open file's working folder, or
  // this computer's local app data). Null when that setup is refused and nothing is kept; the
  // usual places are in the rest either way.
  const staged = stagedFilesRoot();
  return withLinks([...(staged ? [staged] : []), ...ironbooksPlacesAsWritten()]);
}

/**
 * ironbooksPlaces as written, nothing looked at on the disk (for a folder judged by its words:
 * keptFolderRefusal). Where staged files really are is left out, since finding it looks at the
 * disk; appDataPlaces names every place it can be, by the words.
 */
function ironbooksPlacesAsWritten(): string[] {
  const env = process.env;
  const home = os.homedir();
  const out: string[] = [];
  out.push(endpointDir());
  if (env.IRONBOOKS_USER_DATA) out.push(path.resolve(env.IRONBOOKS_USER_DATA));
  if (env.BKA_SANDBOX_ROOT) out.push(path.resolve(env.BKA_SANDBOX_ROOT));
  // Practice copies (whole plain copies of the books) where lib/services/sandbox.ts sandboxRoot keeps
  // them when the shell names no folder: beside the real books' data folder (the browser version).
  // Not imported from there: that module loads the company-file and protection code.
  for (const dataDir of [resolveDataDir(), env.BKA_SANDBOX_REAL_DIR?.trim() || null]) {
    if (dataDir) out.push(path.join(path.dirname(path.resolve(dataDir)), 'Ironbooks Sandboxes'));
  }
  out.push(...appDataPlaces());
  // Every company file's working folder, not only the open one's: they all sit in one folder
  // (electron/companySession.js workingRoot), the one that holds the open file's working folder.
  const state = env.BKA_COMPANY_STATE?.trim();
  if (state) out.push(path.dirname(path.dirname(path.resolve(state))));
  // Where Electron keeps the settings folder (app.getPath('appData')), and the local folder beside it.
  let settingsParent: string;
  if (WIN) {
    out.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ironbooks'));
    settingsParent = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    // workingRoot's fallback when the shell names no settings folder.
    out.push(path.join(home, '.ironbooks'));
    settingsParent = path.join(home, 'Library', 'Application Support');
  } else {
    out.push(path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ironbooks'));
    out.push(path.join(home, '.ironbooks'));
    settingsParent = env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  for (const name of APP_FOLDER_NAMES) out.push(path.join(settingsParent, name));
  out.push(...backupFoldersHere(), preOpFolder());
  return out;
}

/**
 * A whole drive (C:\, /), a network share (\\server\share) or another volume mounted as a folder
 * (/Volumes/USB, a disk mounted into a folder): never an agent's folder. It holds everything on
 * it, the books and Ironbooks' own folders included when they are on it, and other people's
 * files when it is a share.
 */
function isDriveOrShareRoot(real: string): boolean {
  return isRootByWords(real) || isMountedVolume(real) === true;
}

/** A whole drive ("C:\", "/") or a share's own folder ("\\server\share"), by the words alone. */
function isRootByWords(p: string): boolean {
  const r = path.resolve(p);
  // Compared without the trailing separator: "C:\" and "C:", "\\server\share\" and "\\server\share".
  const key = (s: string) => (WIN ? s.replace(/[\\/]+$/, '').toLowerCase() : s.replace(/\/+$/, ''));
  if (key(r) === key(path.parse(r).root)) return true;
  // A share's own folder, with or without the trailing separator.
  return WIN && /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]*$/.test(r);
}

/**
 * Mounted somewhere inside another drive: the folder is on another device than the folder it sits
 * in. Null when the disk will not say (the folder or its parent cannot be read).
 */
function isMountedVolume(p: string): boolean | null {
  try {
    const r = path.resolve(p);
    const here = fs.statSync(r);
    const parent = fs.statSync(path.dirname(r));
    return Boolean(here.dev && parent.dev && here.dev !== parent.dev);
  } catch {
    return null;
  }
}

/** A network path (\\server\share\...): never looked at again here, only by the words. */
function isSharePath(p: string): boolean {
  return WIN && /^[\\/]{2}/.test(p);
}

/** No link anywhere along `p`, each part looked at without following it (false when one cannot be read). */
function noLinksAlong(p: string): boolean {
  const r = path.resolve(p);
  const { root } = path.parse(r);
  let current = root;
  for (const part of r.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function wholeDriveRefusal(typed: string): ServiceError {
  return validation(`"${shown(typed, 200)}" is a whole drive or network share. Choose a folder on it for the agent, like ${EXAMPLE_FOLDER}.`);
}

/** `folder` is one of the books' or Ironbooks' own folders, inside one, or holds one. */
function touchesOwnPlaces(folder: string, places: string[]): boolean {
  return places.some((b) => within(folder, b) || within(b, folder));
}

/**
 * A stored folder (`had`) really lets the agent at `chosen`, a folder the person has just chosen
 * that sits inside it by the words: it is a full path, not a whole drive or share, not one of the
 * books' or Ironbooks' own folders (`places`), and the save check itself lets the agent at
 * `chosen` through it (allowedFolder, which also skips a mounted volume and a link that leads off to
 * another share). Fails closed: a folder the disk will not answer for reaches nothing.
 * The words are judged first, so the disk is asked only of a folder that holds `chosen`: the only
 * network share it can look at is the one `chosen` is on, which the folder check has just looked
 * at for the person who typed it.
 */
async function storedFolderReaches(had: string, chosen: string, places: string[]): Promise<boolean> {
  if (!looksAbsolute(had) || isRootByWords(had) || !within(chosen, had)) return false;
  if (touchesOwnPlaces(had, places)) return false;
  return (await allowedFolder([had], chosen)) !== null;
}

/** The key of "`had` holds `chosen` and really reaches it" in heldBy. */
function holdsKey(chosen: string, had: string): string {
  return `${samePathKey(chosen)}\n${samePathKey(had)}`;
}

/**
 * Which folders the agent has (`had`) really hold which of the folders a person has just chosen
 * (`chosen`, as checkFolders returns them), by holdsKey. Asked of the disk before the save's
 * transaction, and only for a chosen folder that is new: one the agent already has is never looked
 * at again, whatever the disk says of it today (deleted, an unplugged drive, a share offline), and
 * neither is a stored folder that holds no chosen one.
 */
async function heldBy(chosen: readonly string[], had: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const kept = new Set(had.map(samePathKey));
  let places: string[] | null = null;
  for (const folder of chosen) {
    if (kept.has(samePathKey(folder))) continue;
    for (const h of had) {
      if (samePathKey(h) === samePathKey(folder) || !within(folder, h)) continue;
      places ??= [...booksPlaces(), ...ironbooksPlaces()];
      if (await storedFolderReaches(h, folder, places)) out.add(holdsKey(folder, h));
    }
  }
  return out;
}

/** The folders on an agent's row as the engine reads them (resolvePolicy). */
function storedFolders(row: AgentRow): string[] {
  return Array.isArray(row.folders) ? row.folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
}

/** A share of this very computer (\\localhost\c$\…, its own name or address): say what to type instead. */
function thisComputerShareRefusal(typed: string): ServiceError {
  return validation(
    `"${shown(typed, 200)}": that folder is on this computer, reached as a network share. Type its own path on this computer instead, like ${EXAMPLE_FOLDER}.`,
  );
}

/**
 * A local-looking path that the disk answers as a share of this very computer (a drive letter
 * mapped to \\localhost\c$): allowedFolder refuses it, and the person should hear why rather than
 * "not found". Asked only of a path with no link along it (see checkFolders).
 */
function reachedAsThisComputerShare(p: string): boolean {
  try {
    return isThisComputerShare(fs.realpathSync.native(p));
  } catch {
    return false;
  }
}

function booksFolderRefusal(typed: string): ServiceError {
  return validation(
    `The folder "${shown(typed, 200)}" holds the company file or its working data, or is inside them. Choose another folder for the agent.`,
  );
}

function ownFolderRefusal(typed: string): ServiceError {
  return validation(
    `The folder "${shown(typed, 200)}" is one of the folders Ironbooks keeps its own data in (settings, working copies, backups or agents' files), or is inside or holds one. Choose another folder for the agent.`,
  );
}

/**
 * A name as Windows compares names: each character in upper case when that is still one character,
 * as NTFS does. Not lower case: lower case keeps apart pairs Windows takes as one ("ſ", the long s,
 * and "s"). A copy of windowsFold in lib/agent/files.ts, which does not export it.
 */
function windowsFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += Array.from(up).length === 1 ? up : ch;
  }
  return out;
}

/**
 * The spellings of a path that may still name the same folder, for a refusal only, in the order
 * mayTouchByWords pairs them: as written and with every name as Windows opens it (trailing dots and
 * spaces dropped: "archives." is "archives"; on every platform, since the folder may be on a disk
 * Windows wrote), and each of those as written, as Windows folds case (windowsFold) and with no case
 * or Unicode form at all (macOS folds both). The near match mayBeWithin in lib/agent/files.ts makes
 * for overlapsAppData, by the words alone. Never used to allow anything.
 */
function nearSpellings(p: string): string[] {
  const r = path.resolve(p);
  const { root } = path.parse(r);
  const trimmed = root + r.slice(root.length).split(/[\\/]/).map((n) => n.replace(/[. ]+$/, '') || n).join(path.sep);
  return [r, trimmed].flatMap((s) => [s, windowsFold(s), s.normalize('NFC').toLowerCase()]);
}

/**
 * `folder` may be, lie inside or hold one of `places`, by the words and in any spelling that may
 * name the same folder (nearSpellings, each compared with the same spelling of the place). Nothing
 * is looked at on the disk. For a refusal only.
 */
function mayTouchByWords(folder: string, places: string[]): boolean {
  const inside = (c: string, p: string) => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  const f = nearSpellings(folder);
  return touchesOwnPlaces(folder, places) || places.some((b) => {
    const k = nearSpellings(b);
    return f.some((s, i) => inside(s, k[i]) || inside(k[i], s));
  });
}

/**
 * Why a folder the agent already has would be refused were it new today, judged by its words
 * alone against the places as written (booksPlacesAsWritten, ironbooksPlacesAsWritten), or null.
 * The disk is never asked about it (see checkFolders): it may be gone, on a drive that is
 * unplugged or behind a link to a share that is offline. So this catches a folder an older
 * version took before a rule existed (the condense archives, the practice copies), and one that has
 * since come to hold the open company file or a chosen backups folder; what it misses through a link
 * is left to where the folder is used. Its places include those overlapsAppData knows
 * (appDataPlaces is one of them) and they are compared the way it compares them by the words, a
 * near match counting (mayTouchByWords: another case, another Unicode form, a name with a trailing
 * dot), since that check itself looks at the disk. A new folder is held to the same near match
 * (checkFolders), so one taken when it is added is not refused at the next save. A folder that is
 * not a full path is left alone: it reaches nothing where folders are used.
 */
function keptFolderRefusal(folder: string, books: string[], own: string[]): ServiceError | null {
  if (!looksAbsolute(folder)) return null;
  if (isThisComputerShare(folder)) return thisComputerShareRefusal(folder);
  if (isRootByWords(folder)) return wholeDriveRefusal(folder);
  if (mayTouchByWords(folder, books)) return booksFolderRefusal(folder);
  if (mayTouchByWords(folder, own)) return ownFolderRefusal(folder);
  return null;
}

/**
 * What checkFolders found: the list to store, which of it the agent already had (taken
 * unlooked-at), and the folders it had that were sent back but are taken away (why: the reason a
 * person would be given), for a person who is not an Admin.
 */
interface CheckedFolders {
  folders: string[];
  kept: string[];
  dropped: Array<{ folder: string; why: string }>;
}

/**
 * The folders as they will be used, each once.
 *
 * A folder the agent already has (one of `had`, the stored list, the same by samePathKey) is kept
 * as it is stored and never looked at again on the disk, whatever it is today: deleted, on a drive
 * that is unplugged, a share that is offline. Keeping a folder lets the agent do nothing more, and a
 * person who only takes folders away must never be stopped by, or told to make, one they kept. Its
 * words are still held to the rules below (keptFolderRefusal): one an older version took before a
 * rule existed, or that has since come to hold the books or Ironbooks' own data, is not written back
 * unremarked. An Admin is told, as for a new folder, and removes it; for anyone else it is taken
 * away (a tightening, which anyone who manages agents may make) and the audit row says so, so a
 * person who is only tightening is never blocked by it. (What a kept folder still reaches is decided
 * when it is used: allowedFolder skips a whole drive, a share of this computer and a folder that is
 * gone.)
 *
 * Every other folder is new in this save. It must be the full path of a folder that exists on this
 * computer, and is taken with links resolved the way the save check resolves them (allowedFolder in
 * lib/agent/files.ts). It is refused, with what to do instead, when it is a share of this very
 * computer (isThisComputerShare: even its own folder, \\localhost\c$, is told to type the path on
 * this computer), a whole drive or share, or when it is, lies inside or holds one of the books' or
 * Ironbooks' own folders: the company file and its working data (booksPlaces), and every place
 * Ironbooks keeps its own data or copies of the books (ironbooksPlaces, and overlapsAppData of
 * lib/agent/files.ts, the same check the other units make): reading there would hand the agent the
 * whole books unmasked, another agent's files or the app's own state. Those places are compared as a
 * kept folder's are, a near match counting (mayTouchByWords).
 */
async function checkFolders(list: string[], had: readonly string[], isAdmin: boolean): Promise<CheckedFolders> {
  const stored = new Map(had.map((h) => [samePathKey(h), h]));
  // Worked out at the first folder that needs them only. The places with links resolved look at
  // the disk, so a save that sends only folders the agent already has (judged against the places
  // as written) looks at nothing there.
  let books: string[] | null = null;
  let own: string[] | null = null;
  let booksWords: string[] | null = null;
  let ownWords: string[] | null = null;
  const out: CheckedFolders = { folders: [], kept: [], dropped: [] };
  const seen = new Set<string>();
  const add = (p: string): boolean => {
    const key = samePathKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    out.folders.push(p);
    return true;
  };
  for (const typed of list) {
    const already = stored.get(samePathKey(typed));
    if (already !== undefined) {
      booksWords ??= booksPlacesAsWritten();
      ownWords ??= ironbooksPlacesAsWritten();
      const refusal = keptFolderRefusal(already, booksWords, ownWords);
      if (refusal && isAdmin) throw refusal;
      if (refusal) {
        if (!out.dropped.some((d) => samePathKey(d.folder) === samePathKey(already))) out.dropped.push({ folder: already, why: refusal.message });
        continue;
      }
      if (add(already)) out.kept.push(already);
      continue;
    }
    if (!looksAbsolute(typed)) {
      throw validation(`"${shown(typed, 200)}" is not a full folder path. Type the whole path, like ${EXAMPLE_FOLDER}.`);
    }
    // By the words first: allowedFolder never takes a share of this computer, nor a whole drive or
    // share, and answers null for one, as for a folder that is not there, so the person would be
    // told the wrong thing. A share of this computer is never looked at at all, and is told to type
    // the path on this computer even when it is the share's own folder (\\localhost\c$): "choose a
    // folder on it" would lead to \\localhost\c$\..., refused in turn.
    if (isThisComputerShare(typed)) throw thisComputerShareRefusal(typed);
    if (isRootByWords(typed)) throw wholeDriveRefusal(typed);
    const real = await allowedFolder([typed], typed);
    if (!real) {
      // A volume mounted as a folder (/Volumes/USB), and a drive mapped to a share of this computer,
      // are skipped by allowedFolder too: say what it is. Asked only of a local path with no link
      // along it, so the disk is the only thing looked at (looking at a network path, or a link to
      // one, is a sign-in to that server).
      if (!isSharePath(typed) && noLinksAlong(typed)) {
        if (isMountedVolume(typed) === true) throw wholeDriveRefusal(typed);
        if (reachedAsThisComputerShare(typed)) throw thisComputerShareRefusal(typed);
      }
      // `"<folder>" was not found` is read by the Agents screen (app/users/agents/AgentDetailView.tsx)
      // to add its own hint: keep those words.
      throw validation(`The folder "${shown(typed, 200)}" was not found on this computer. Check the path, make the folder first, or take it off the list.`);
    }
    // The words before the disk: isDriveOrShareRoot looks at the folder, a share's included.
    if (isThisComputerShare(real)) throw thisComputerShareRefusal(typed);
    if (isDriveOrShareRoot(real)) throw wholeDriveRefusal(typed);
    books ??= booksPlaces();
    own ??= ironbooksPlaces();
    // By the same near match a kept folder is judged by (keptFolderRefusal; the places here hold
    // the places as written, and their real paths besides), so a folder taken now is never refused
    // at the next save, an Admin's tightening included. The real path is the one stored.
    if (mayTouchByWords(real, books) || mayTouchByWords(typed, books)) throw booksFolderRefusal(typed);
    // The real path and the path as typed: allowedFolder has just shown that the links along it
    // stay on this computer, so overlapsAppData looks at nothing the person did not name.
    if (mayTouchByWords(real, own) || mayTouchByWords(typed, own) || overlapsAppData(real) || overlapsAppData(typed)) throw ownFolderRefusal(typed);
    add(real);
  }
  return out;
}

/** Whether a policy lets bulk work run unasked anywhere (and so must have a count cap). */
function allowsBulk(preset: AgentPreset, overrides: PolicyOverride[]): boolean {
  const probe = resolvePolicy(preset, overrides, { bulkCap: DEFAULT_BULK_CAP });
  return probe.classes.bulk === 'allow' || AREA_KEYS.some((a) => probe.areas[a]?.bulk === 'allow');
}

function overridesKey(list: PolicyOverride[]): string {
  return JSON.stringify(sortOverrides(list).map((o) => [o.class, o.area ?? null, o.setting]));
}

// ---------------------------------------------------------------------------
// Loosening (an Admin's)
// ---------------------------------------------------------------------------

const STRICTNESS: Record<PolicySetting, number> = { allow: 0, ask: 1, never: 2 };
const SETTING_WORD: Record<PolicySetting, string> = { allow: 'Allow', ask: 'Ask', never: 'Never' };

/** AGENT_PRESETS runs from the least an agent may do to the most (plan 4.2's table, left to right). */
function presetRank(preset: AgentPreset): number {
  return (AGENT_PRESETS as readonly string[]).indexOf(preset);
}

/** A two-person amount for comparing: decimal text, or null when it cannot be read (counts as off). */
function amountOrNull(v: string | null): string | null {
  if (v === null) return null;
  try {
    return Money.of(v).toFixed(2);
  } catch {
    return null;
  }
}

/**
 * Everything a save would let the agent do that it could not before, in plain words, read from
 * the policy before and after as the engine resolves them (so a cell is judged by the setting the
 * decisions really use, its area's own or everywhere's). Empty when the save only tightens or
 * changes nothing. Field by field: the preset, every cell everywhere and in each area, the bulk
 * cap (removing one is more; where there was none, a cap above the usual DEFAULT_BULK_CAP is more),
 * the two-person amount (off is the most), the folders (a new one, not inside a folder it already
 * had that really reaches it: `held`, from heldBy), the days a request waits, and the email notice
 * (an outside send). Nothing here looks at the disk.
 */
function loosenings(before: AgentPolicy, after: AgentPolicy, held: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (presetRank(after.preset) > presetRank(before.preset)) {
    out.push(`move it from "${AGENT_PRESET_LABELS[before.preset]}" to "${AGENT_PRESET_LABELS[after.preset]}"`);
  }
  for (const cls of RISK_CLASSES) {
    const wasAll = settingFor(before, null, cls);
    const nowAll = settingFor(after, null, cls);
    if (STRICTNESS[nowAll] < STRICTNESS[wasAll]) {
      out.push(`set ${cellWords(cls, null)} from ${SETTING_WORD[wasAll]} to ${SETTING_WORD[nowAll]}`);
    }
    for (const area of AREA_KEYS) {
      const was = settingFor(before, area, cls);
      const now = settingFor(after, area, cls);
      if (STRICTNESS[now] >= STRICTNESS[was]) continue;
      // Already said for everywhere: an area that simply follows it is the same change.
      if (was === wasAll && now === nowAll && STRICTNESS[nowAll] < STRICTNESS[wasAll]) continue;
      out.push(`set ${cellWords(cls, area)} from ${SETTING_WORD[was]} to ${SETTING_WORD[now]}`);
    }
  }
  // No cap is not "unlimited" everywhere: a standing permission for bulk work is held to the usual
  // cap then (createGrant in ./agentGrants). So a cap above the usual one, where there was none,
  // lets grants cover more records per request: an Admin's. A cap at or below it only tightens.
  const capWas = before.bulkCap ?? DEFAULT_BULK_CAP;
  if (after.bulkCap === null ? before.bulkCap !== null : after.bulkCap > capWas) {
    out.push(
      after.bulkCap === null
        ? `remove the limit of ${before.bulkCap} records one request may change`
        : before.bulkCap === null
          ? `raise the most records one request may change from the usual ${DEFAULT_BULK_CAP} to ${after.bulkCap}`
          : `raise the most records one request may change from ${before.bulkCap} to ${after.bulkCap}`,
    );
  }
  const twoBefore = amountOrNull(before.twoPersonOver);
  const twoAfter = amountOrNull(after.twoPersonOver);
  if (twoBefore !== null && (twoAfter === null || Money.gt(twoAfter, twoBefore))) {
    out.push(
      twoAfter === null
        ? `turn off two-person approval (now needed above ${twoBefore})`
        : `raise the amount that needs two people from ${twoBefore} to ${twoAfter}`,
    );
  }
  // A folder it already has is not new, whatever the disk says of it today: keeping one that has
  // since been deleted, or sits on a drive that is unplugged, lets the agent do nothing more. A new
  // one is more unless a folder it already had really reaches it (heldBy): a stored whole drive,
  // mounted volume or own folder (an older version's save, a hand edit) gives it nothing. Judged
  // on the stored folders read inside the transaction, so a pair heldBy checked against a list that
  // has changed since counts only while that stored folder is still there.
  const kept = new Set(before.folders.map(samePathKey));
  for (const folder of after.folders) {
    if (kept.has(samePathKey(folder))) continue;
    if (!before.folders.some((had) => held.has(holdsKey(folder, had)))) out.push(`let it use the folder "${shown(folder, 200)}"`);
  }
  if (after.requestExpiryDays > before.requestExpiryDays) {
    out.push(`let its requests wait ${after.requestExpiryDays} days instead of ${before.requestExpiryDays}`);
  }
  if (after.notifyEmail && !before.notifyEmail) out.push('turn on the email notice, which sends email outside this computer');
  return out;
}

/** The refusal a non-Admin gets for a save that loosens anything: what it would loosen, and what they can do. */
function onlyAnAdminLoosens(list: string[]): ServiceError {
  const named = list.slice(0, LOOSER_SHOWN);
  const more = list.length - named.length;
  const what = more > 0 ? `${named.join('; ')}; and ${more} more` : named.join('; ');
  return new ServiceError(
    'FORBIDDEN',
    `Only an Admin can let an agent do more. This change would ${what}. Ask an Admin to make it. You can still tighten this agent's settings or pause it.`,
    { looser: list },
  );
}

/**
 * Save an agent's policy: its preset, its overrides (replacing every stored one when sent) and its
 * limits. Checked against the policy engine's own rules and refused, with what to change, at the
 * first problem: nothing is saved in a form the engine would read differently. A person who is not
 * an Admin may only tighten (loosenings): a save that would let the agent do anything more is
 * refused whole, naming what it would loosen. The older mode is kept in step with the preset. One
 * transaction, one audit row naming what changed.
 */
export const saveAgentPolicy: SaveAgentPolicy = async (ctx, agentId, input) => {
  const person = await personWhoManagesAgents(ctx);
  const before = await agentRowFor(ctx, agentId);
  if (!before) throw notFound('Agent');
  if (before.revokedAt) throw validation(REMOVED);
  const asked = readPolicyInput(input);
  // On the disk, so outside the transaction: the folders sent that are new (checkFolders: one the
  // agent already has is never looked at again on the disk, only held to the rules by its words),
  // and, for a person who may not let the agent do more, which of them a folder it already has
  // really holds (heldBy). A save that sends no folders, or only folders it already has, looks at none.
  const checked = asked.folders === undefined ? undefined : await checkFolders(asked.folders, storedFolders(before), person.isAdmin);
  const folders = checked?.folders;
  const held = folders === undefined || person.isAdmin ? new Set<string>() : await heldBy(folders, storedFolders(before));

  await inTransaction(ctx, async (tx) => {
    const row = await agentRowFor(tx, agentId);
    if (!row) throw notFound('Agent');
    if (row.revokedAt) throw validation(REMOVED);
    // A folder taken as one the agent already had was not looked at. Should someone have taken it
    // away since the read above, it would be new after all, and unchecked: nothing is saved then.
    if (checked?.kept.length) {
      const still = new Set(storedFolders(row).map(samePathKey));
      if (checked.kept.some((f) => !still.has(samePathKey(f)))) throw new ServiceError('CONFLICT', FOLDERS_CHANGED);
    }
    const stored = await storedOverrides(tx, row.id);

    const preset = asked.preset ?? presetOfRow(row);
    const overrides = asked.overrides ?? stored.filter(understood);
    let bulkCap = asked.bulkCap !== undefined ? asked.bulkCap : (row.bulkCap ?? null);
    // Bulk work may run unasked only within a count cap (plan 4.2). A save that allows it and says
    // nothing about the cap gets the usual one, the same the engine would use, written down.
    const bulkAllowed = allowsBulk(preset, overrides);
    if (bulkAllowed && bulkCap === null) {
      if (asked.bulkCap === null) {
        throw validation(
          `"${RISK_CLASS_LABELS.bulk}" is set to Allow, so it needs a limit on the records one request may change (${DEFAULT_BULK_CAP} is usual).`,
        );
      }
      bulkCap = DEFAULT_BULK_CAP;
    }
    const next = {
      preset,
      mode: modeForPreset(preset),
      bulkCap,
      twoPersonOver: asked.twoPersonOver !== undefined ? asked.twoPersonOver : readStoredAmount(row.twoPersonOver),
      requestExpiryDays: asked.requestExpiryDays ?? row.requestExpiryDays,
      folders: folders ?? (Array.isArray(row.folders) ? row.folders : []),
      notifyEmail: asked.notifyEmail ?? row.notifyEmail === true,
    };

    // Letting the agent do more is an Admin's (plan 4.4). Judged on the policy as the engine reads
    // it before and after, from the row read inside this transaction, so a save racing another
    // cannot slip a loosening past the comparison.
    if (!person.isAdmin) {
      const was = resolvePolicy(presetOfRow(row), stored, limitsOf(row));
      const will = resolvePolicy(preset, overrides, {
        bulkCap: next.bulkCap,
        twoPersonOver: next.twoPersonOver,
        requestExpiryDays: next.requestExpiryDays,
        folders: next.folders,
        notifyEmail: next.notifyEmail,
      });
      const looser = loosenings(was, will, held);
      if (looser.length) throw onlyAnAdminLoosens(looser);
    }

    // The engine's own rules have the last word (pause is not part of a save: it is left out).
    // What this save sent was checked above, so what can still fail here is what it keeps from
    // the stored policy: a row or a limit a hand-edited file holds. Nothing is saved over it.
    const problems = policyProblems(preset, overrides, {
      bulkCap: next.bulkCap,
      twoPersonOver: next.twoPersonOver,
      requestExpiryDays: next.requestExpiryDays,
      folders: next.folders,
      notifyEmail: next.notifyEmail,
    });
    if (problems.length) throw validation(`${problems[0]} Fix this setting and save again.`);

    const prev = {
      preset: row.preset,
      mode: row.mode,
      bulkCap: row.bulkCap ?? null,
      twoPersonOver: readStoredAmount(row.twoPersonOver),
      requestExpiryDays: row.requestExpiryDays,
      folders: Array.isArray(row.folders) ? row.folders : [],
      notifyEmail: row.notifyEmail === true,
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
    const overridesChanged = asked.overrides !== undefined && overridesKey(asked.overrides) !== overridesKey(stored);
    if (!changed.length && !overridesChanged) return;

    if (changed.length) {
      await tx.db
        .update(agents)
        .set({
          preset: next.preset,
          mode: next.mode,
          bulkCap: next.bulkCap,
          twoPersonOver: next.twoPersonOver,
          requestExpiryDays: next.requestExpiryDays,
          folders: next.folders,
          notifyEmail: next.notifyEmail,
        })
        .where(and(eq(agents.id, row.id), eq(agents.companyId, tx.companyId)));
    }
    if (overridesChanged) {
      await tx.db.delete(agentPolicies).where(and(eq(agentPolicies.agentId, row.id), eq(agentPolicies.companyId, tx.companyId)));
      if (asked.overrides!.length) {
        await tx.db
          .insert(agentPolicies)
          .values(asked.overrides!.map((o) => ({ companyId: tx.companyId, agentId: row.id, class: o.class, area: o.area, setting: o.setting })));
      }
    }

    const pick = (from: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, from[k]]));
    // Folders it had that this save sent back but Ironbooks took away (checkFolders): the audit row
    // says which, and why, since the person did not take them away themselves.
    const takenAway = checked?.dropped.length ? { foldersTakenAway: checked.dropped } : {};
    await writeAudit(tx, {
      action: 'update',
      entityType: 'agent',
      entityId: row.id,
      oldValues: { name: row.name, ...pick(prev), ...(overridesChanged ? { overrides: stored } : {}) },
      newValues: { name: row.name, ...pick(next), ...(overridesChanged ? { overrides: asked.overrides } : {}), ...takenAway },
    });
  });

  const saved = await agentRowFor(ctx, agentId);
  if (!saved) throw notFound('Agent');
  return policyViewOf(ctx, saved);
};

/** A stored two-person amount in the form a save writes (two places), or null. */
function readStoredAmount(v: string | null): string | null {
  if (v === null || v === undefined) return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d.toFixed(2) : v;
  } catch {
    return v;
  }
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

/**
 * Pause one agent, or turn it back on. A paused agent is refused everything until a person turns
 * it back on; its token and settings stay. Pausing is open to everyone who may manage agents;
 * turning back on, for a person who is not an Admin, only an agent within their own access
 * (assertWithinYourAccess). Already so: nothing is written.
 */
export const pauseAgent: PauseAgent = async (ctx, agentId, paused) => {
  const person = await personWhoManagesAgents(ctx);
  if (typeof paused !== 'boolean') throw validation(SAY_PAUSED);
  await inTransaction(ctx, async (tx) => {
    const row = await agentRowFor(tx, agentId);
    if (!row) throw notFound('Agent');
    if (row.revokedAt) throw validation(REMOVED);
    const was = isPaused(row.pausedAt);
    if (was === paused) return;
    if (!paused) await assertWithinYourAccess(tx, person, row, { admin: ADMIN_AGENT_RESUME, more: MORE_THAN_YOU_RESUME });
    await tx.db
      .update(agents)
      .set({ pausedAt: paused ? new Date() : null })
      .where(and(eq(agents.id, row.id), eq(agents.companyId, tx.companyId)));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'agent',
      entityId: row.id,
      oldValues: { name: row.name, paused: was },
      newValues: { name: row.name, paused },
    });
  });
};

/**
 * "Pause all agents": the company's Integrated Applications switch ("Don't allow any applications
 * to access this company file"), changed through the same code path as Preferences
 * (updateCompany), which audits it and holds it to an Admin. While it is on, every agent of the
 * company is refused (lib/agentContext.ts) and every policy reads as paused (loadAgentPolicy). It
 * also keeps the employee portal and phone receipts out, as it always has.
 *
 * So it is for an Admin who may manage agents, not for every user manager: the switch is the same
 * one Preferences holds to an Admin, and a second way to it must not be wider. A manager who is not
 * an Admin pauses one agent at a time (pauseAgent); mayPauseAllAgents tells the title bar which.
 */
export const pauseAllAgents: PauseAllAgents = async (ctx, paused) => {
  const person = await personWhoManagesAgents(ctx);
  if (typeof paused !== 'boolean') throw validation(SAY_PAUSED);
  if (!person.isAdmin) throw new ServiceError('FORBIDDEN', PAUSE_ALL_FOR_ADMIN);
  if ((await agentsBlockedFor(ctx.db, ctx.companyId)) === paused) return;
  await updateCompany(ctx, { settings: { integratedAppsBlocked: paused } });
};
