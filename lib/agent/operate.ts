/**
 * Agent full access: the agent's door (plan §4, §5, §5.6, §6.1, §7.4 and §11; contract §9).
 *
 * Every generic request an agent sends to POST /api/agent/actions (`{ verb, ...args }`) comes here.
 * This is the one place where the policy, standing permission (grants), the route bridge and
 * permission requests meet, so the order below is the whole of what an agent can do:
 *
 *  1. The operation is looked up in the registry. An unknown id is refused, never guessed at.
 *  2. What an agent may never send is taken out of its input (lib/agent/guards.ts), or the request
 *     is refused outright.
 *  3. The policy decides with what the body says (lib/agent/policy.ts `decide`): refuse, run or ask.
 *     Then the door's own refusals: a role an agent holds is never changed or deleted, and a
 *     desktop operation's paths must lie in the agent's folders (firstLook). Nobody is asked about
 *     what could only be refused.
 *  4. A read runs at once, on the read-only path, with the agent's own access.
 *  5. A dry run really runs and is rolled back. The answer says whether the real thing would run or
 *     would ask a person.
 *  6. Anything else needs a request id. Asking again with it gives the first answer, never a second
 *     change (table agent_requests, as lib/agent/actions.ts does for the curated actions).
 *  7. Before a change runs, or is put to a person, it is tried in a rolled-back run where the
 *     operation allows, and the policy decides AGAIN with what that run showed: the true amount,
 *     count and date. That second answer is the one followed, so two-person approval, the bulk cap
 *     and a grant's limits apply to the real figures, not to what the body claimed. When the real
 *     figures cannot be seen ahead (the work cannot be tried, or it is dated in a closed period, or
 *     the agent's own masked rights could not try it), the amount counts as unknown: above any
 *     two-person limit, and outside any grant's amount.
 *  8. What the policy says to ask about becomes a permission request: the agent's reason (its own
 *     words, required), a summary built from the operation (never from the agent's text) and the
 *     preview. Nothing more happens until a person approves it in their own window; that run is
 *     `runApproved`, which tries it again with the approver's rights first (closed-period work with
 *     the closing-date password they typed, so it too is judged on its real figures) and puts it
 *     back to the person (a "the books changed" answer) when it would do more than they were shown.
 *
 * Who a run is for:
 *  - What an agent runs on its own (Allow) runs with its role's access, masked: no full SSNs or
 *    account numbers and no closed-period right (those always ask a person). No person, no
 *    secrets, no reveal.
 *  - A run under standing permission (a grant) runs with the access of the person who gave it
 *    INTERSECTED with the agent's role, masked the same way (plan §4.5): the grant was only ever
 *    theirs to lend. When that person is gone or no longer has the right, the grant does not apply
 *    and the request is asked.
 *  - An approved request runs with the approver's access INTERSECTED with the agent's role, so
 *    approving never widens either side, as the approver, with the secrets they typed on the card.
 *    Desktop and file actions (saving a staged file included) go to lib/agent/shell.ts, the one
 *    place that carries them out.
 *
 * An agent that sends too much is slowed down (plan §11.3): at most AGENT_CALLS_PER_MINUTE calls
 * a minute and AGENT_RUNS_AT_ONCE operations at a time, because the company file answers one
 * transaction at a time and a person is using it too. A call is counted before anything of the
 * policy or the books is read, and every refusal says how long to wait. A verb (handleVerb, which
 * the curated actions of lib/agent/actions.ts go through too) is refused with AgentRateLimited,
 * which the route answers as 429 with a Retry-After header; `operate` itself, called directly,
 * answers a 'refused' with the wait in retryAfterSeconds, which the route answers as 429 too.
 * doorRun and doorDecision give the curated actions the same count, run places and first look, so
 * one action is one call however many times it goes through the door.
 *
 * A paused agent (or every agent, with Integrated Applications switched off) is refused every verb,
 * checked once per call: a context taken just before the pause does no better than a new one.
 *
 * Nothing here changes agents, policies, grants or approvals: those operations are on the hard
 * floor of the registry, and `decide` refuses them before anything else is looked at. A role an
 * agent holds is part of that agent (plan §4.6, D9): changing or deleting one is refused here on
 * every path, and again when a person approves.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { AGENT_PAUSED_MESSAGE } from '@/lib/agentContext';
import { AGENTS_BLOCKED_MESSAGE, agentsBlockedFor } from '@/lib/services/agents';
import { agentPermissionRequests, agentRequests, agents, companies, companyRoles, userCompanies, userSessions, users } from '@/lib/db/schema';
import { ACTIVITIES, VIEW_BALANCE, activitiesOf, supportedActions, type ActivityDef } from '@/lib/permissions/activities';
import {
  ACTIONS,
  AREA_KEYS,
  FLAGS,
  canActivity,
  emptyActivitySet,
  emptyPermissionSet,
  builtinRole,
  legacyRoleFor,
  type ActivityKey,
  type Area,
  type EffectiveAccess,
  type Flag,
} from '@/lib/permissions/model';
import { maskedForAgent } from '@/lib/permissions/agentAccess';
import { Money } from '@/lib/money';
import { type ServiceContext, type ServiceErrorCode, ServiceError, validation } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { resolveAccess } from '@/lib/services/access';
import { agentCeiling, loadAgentPolicy } from '@/lib/services/agentPolicies';
import { liveGrants } from '@/lib/services/agentGrants';
import { cancelAgentRequest, createAgentRequest, listRequestsForAgent, requestForAgent } from '@/lib/services/agentRequests';
import { listActiveSessions } from '@/lib/services/sessions';
import { effects, pinFile, runWithEffects } from '@/lib/effects';
import { REQUEST_ID_MESSAGE, agentInputHash, type ChangePreview } from '@/lib/agent/actions';
import { EXPECTED_VERSION_MESSAGE, REVEAL_FILE_ENDED, revealFileEnded as stagedRevealEnded, runOperation, type CommitCheck } from '@/lib/agent/bridge';
import { guardInput, plainIsoTime, runnableNameProblem } from '@/lib/agent/guards';
import { TEMPLATE_AMOUNT, factsOf, withLedgerAccounts } from '@/lib/agent/facts';
import { describeRequest, type DescribeNames } from '@/lib/agent/describe';
import { allowedFolder, overlapsAppData, readStagedFile, readStagedFileForSave, stagedFileInfo, uploadChunk } from '@/lib/agent/files';
import { AGENT_OUTBOX_NAME, defaultAgentFolders, runShellOperation } from '@/lib/agent/shell';
import { findOperations, operationById, operationForRoute } from '@/lib/agent/operations/registry';
import { describeSchemas, examplesOf, type OperationExample } from '@/lib/agent/operations/schemas';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { SHORT_GRANT_MINUTES, approvalNeeds, baseClass, decide, flagsNeeded, isPaused, needsTwoPerson, roleProblem } from '@/lib/agent/policy';
import {
  GRANTABLE,
  REQUEST_STATUSES,
  RISK_CLASSES,
  RISK_CLASS_LABELS,
  type AgentGrant,
  type AgentPolicy,
  type ApprovalNeeds,
  type EffectPreview,
  type GrantConstraints,
  type Operation,
  type PolicyDecision,
  type RequestFacts,
  type RiskClass,
  type SecretKind,
  type WarningPreview,
} from '@/lib/agent/operations/types';
import {
  AGENT_VERBS,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
  type AgentOperationAnswer,
  type AgentRequestKind,
  type AgentRequestView,
  type AgentVerb,
  type BridgeActor,
  type BridgeResult,
  type FileOwner,
  type HandleVerb,
  type MyPermissions,
  type NewAgentRequest,
  type Operate,
  type OperationDescription,
  type OperationInput,
  type OperationPreview,
  type OperationSummary,
  type RunApproved,
  type RunOperationRequest,
  type ShellOperationDef,
} from '@/lib/agent/contract';

type Role = NonNullable<ServiceContext['role']>;
type AgentOfContext = NonNullable<ServiceContext['agent']>;

// ---------------------------------------------------------------------------
// Words the agent reads
// ---------------------------------------------------------------------------

export const NO_REASON_NOTE = 'Say why you are asking in reason and send it again.';
const NOT_FOR_PEOPLE = 'This is for agents.';
const APPROVER_ONLY =
  'An approval comes only from a person signed in to Ironbooks in their own window, never from an agent or a program.';
const NOTHING_KEPT = 'Nothing was kept.';
const NOT_TRIED = 'This cannot be tried without really doing it, so nothing was run.';
const FILE_GONE = 'There is no file with that id. Staged files are kept for 24 hours; upload it again with upload_file.';
const RESTARTING_NOTE = 'Ironbooks is restarting or changing company file. Connect again in a minute.';
/** Added to a refusal for want of a View flag, on an operation whose values can be revealed. */
const REVEAL_HINT =
  'If it needs the full values, send it again with reveal: true and a reason: a person who may see them is then asked to approve it.';
/** Why a request is put to a person without a preview. */
const UNTRIED_CLOSING =
  'It could not be tried ahead of time, because it is dated on or before the closing date, so the person approving it sees no preview and its amount counts as unknown.';
const UNTRIED_ACCESS =
  "It could not be tried with this agent's own rights (protected values are off limits to agents), so the person approving it sees no preview and its amount counts as unknown.";
/** For the approval card (a person reads it) when a request is put back because its figures could not be checked. */
const UNCHECKED_FOR_PERSON =
  'Ironbooks could not try this ahead of time, so its real amount is not known until it runs. Because of the two-person limit set for this agent, two different people must approve it.';
/**
 * For the approval card, when the try at approval found the work dated on or before the closing
 * date, which the request did not show. The next approval's try takes the closing-date password the
 * person types (runApproved, dryRunSecrets), so it is judged on its real figures before it runs.
 */
const CLOSED_FOR_PERSON =
  'Ironbooks found that this is dated on or before the closing date, which the request did not show when it was asked. If it is still right, approve it again and type the closing-date password. Ironbooks then tries it first on its real figures: if they are more than this request showed, you see them before anything is done.';
/** For the approval card, when the real figures could only be seen in a try with the protected values shown. */
const REVEALED_MORE_FOR_PERSON =
  'Ironbooks tried this with the full protected values, and it would do more than the request showed: the amount and the number of records here are what it would really do. Its preview is not shown, because it holds those protected values. If it is still right, approve it again.';
const REVEALED_TWO_FOR_PERSON =
  'Ironbooks tried this with the full protected values. Because of the amount it would really move (shown here) and the two-person limit set for this agent, two different people must approve it. Its preview is not shown, because it holds those protected values.';
/** A context of an agent that has been removed since (or of no agent at all). */
const GONE_NOTE = 'This agent has been removed, so it can no longer do anything in this company file.';

/** The longest piece of a value the agent sent that a note repeats. */
const NOTE_VALUE_MAX = 80;

function shownValue(v: unknown): string {
  const s = String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  return s.length > NOTE_VALUE_MAX ? `${s.slice(0, NOTE_VALUE_MAX - 1)}…` : s;
}

/**
 * Changing or deleting a role an agent holds (plan §4.6, D9): the hard floor, on every path. The
 * role is named as a person knows it (its name, read by summaryNames), or by the id the agent sent
 * when no name is found.
 */
function roleHeldNote(id: unknown, name?: string | null): string {
  const shown = name && name.trim() ? shownValue(name) : shownValue(id);
  return (
    `No agent may change or delete role "${shown}", because an agent holds it: changing the role would change what that agent may do. ` +
    'A person can change it in Ironbooks, under Users & Roles.'
  );
}
const ROLE_GRANT_NOTE =
  'Standing permission cannot be given for changing or deleting roles: no agent may change a role an agent holds, and standing permission could not tell those roles apart. Send each change with run_operation instead.';
/** Standing permission that the grants service refuses for everyone, Admins included (lib/services/agentGrants.ts). */
const HOST_ONLY_GRANT_NOTE =
  'This can only be approved at the computer that holds the company file, one request at a time, so nobody can give standing permission for it. Send each with run_operation instead.';
const FILE_ADMIN_GRANT_NOTE =
  "This is company-file work, which the company file's Admin approves one request at a time, so nobody can give standing permission for it. Send each with run_operation instead.";
/** Standing permission that could never let a request run (grantNeverCovers). */
const AMOUNT_NEVER_KNOWN_NOTE =
  'Standing permission limited by amount could never cover this: it cannot be tried ahead of time, so the amount of each request is not known until it runs. Ask again without constraints.max_amount, or send each with run_operation.';
const COUNT_NEVER_KNOWN_NOTE =
  'Standing permission for this is limited by the number of records, and this operation never says ahead of time how many it changes, so such permission could never cover a request. Send each with run_operation instead.';
function twoPersonAlwaysNote(over: string | null): string {
  return (
    `Standing permission could never cover this while the two-person limit${over ? ` (${over})` : ''} is set: it cannot be tried ahead of time, ` +
    'so the amount of each request counts as unknown, and two different people must approve each one. Send each with run_operation instead.'
  );
}

const SECRET_WORDS: Record<SecretKind, string> = {
  closing_password: 'the closing-date password',
  file_password: "the company file's password",
  backup_password: "the backup file's password",
  archive_credentials: "the protected archive's password",
  new_user_password: 'the new password',
  mail_password: 'the mail server password',
  portal_password: 'the portal password',
  recovery_key: 'the recovery key',
  file_key: 'the file key',
  capability_link: 'the sharing link',
};

function unknownOperationNote(id: string): string {
  return `There is no operation "${id}". Use find_operations to look for the right one, then describe_operation to see what it takes.`;
}

function flagLabel(flag: Flag): string {
  return FLAGS.find((f) => f.key === flag)?.label ?? flag;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Who must approve, in one or a few plain sentences, from what the policy says the approver needs. */
export function approvalWords(needs: ApprovalNeeds | null | undefined): string {
  if (!needs) return 'A person has to approve it in Ironbooks.';
  const who = needs.fileAdmin ? "The company file's Admin" : needs.admin ? 'An Admin' : 'A person who may do this themselves';
  const out = [`${who} has to approve it in Ironbooks${needs.hostOnly ? ', at the computer that holds the company file' : ''}.`];
  if (needs.twoPerson) out.push('Because of the amount, two different people must approve it.');
  const flags = needs.flags?.length ? needs.flags : needs.flag ? [needs.flag] : [];
  if (flags.length) out.push(`They also need ${joinWords(flags.map((f) => `"${flagLabel(f)}"`))}.`);
  const secrets = (needs.secrets ?? []).map((s) => SECRET_WORDS[s] ?? 'a password');
  if (secrets.length) out.push(`They type ${joinWords(secrets)} on the approval card; never send it yourself.`);
  return out.join(' ');
}

/** What the real request would meet, for the answer to a dry run. */
function wouldNote(decision: PolicyDecision): string {
  if (decision.outcome === 'run') {
    return `Sent without dry_run and with a request_id, it would be done straight away${decision.grantId ? ', under standing permission a person gave' : ''}.`;
  }
  if (decision.outcome === 'ask') {
    return `Sent without dry_run, it would ask a person first. ${approvalWords(decision.needs)} Send it with a request_id and a reason (one line saying why it is needed).`;
  }
  return `Sent for real, it would be refused: ${decision.message}`;
}

// ---------------------------------------------------------------------------
// Access: the agent's own runs, and approved runs
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<Role, number> = { viewer: 0, accountant: 1, admin: 2, owner: 3 };

function roleRank(role: unknown): number {
  return typeof role === 'string' && Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role as Role] : 0;
}

/** The lower of two roles. Anything that is not a known role counts as view-only (fail closed). */
export function lowerRole(a: Role | null | undefined, b: Role | null | undefined): Role {
  const ra = roleRank(a);
  const rb = roleRank(b);
  const rank = Math.min(ra, rb);
  return (Object.keys(ROLE_RANK) as Role[]).find((r) => ROLE_RANK[r] === rank) ?? 'viewer';
}

/**
 * What both accesses allow, and nothing more: every area action, activity right and flag must be
 * in both, and Admin only when both are Admin. The coarse area set keeps an action only when an
 * activity of the area still has it in both (or no activity of the area has that right at all), so
 * "may use some part of this area" cannot be true of a part neither side shares.
 */
export function intersectAccess(a: EffectiveAccess, b: EffectiveAccess): EffectiveAccess {
  const activities = emptyActivitySet();
  for (const def of ACTIVITIES as readonly ActivityDef[]) {
    const k = def.key as ActivityKey;
    activities[k] = supportedActions(def).filter((x) => canActivity(a, k, x) && canActivity(b, k, x));
  }
  const permissions = emptyPermissionSet();
  for (const area of AREA_KEYS) {
    const inA = a.permissions?.[area] ?? [];
    const inB = b.permissions?.[area] ?? [];
    permissions[area] = ACTIONS.filter((x) => {
      if (!inA.includes(x) || !inB.includes(x)) return false;
      const holders = activitiesOf(area).filter((d) => supportedActions(d).includes(x));
      if (holders.length === 0) return true;
      return holders.some((d) => {
        const kept = activities[d.key as ActivityKey];
        return kept.includes(x) || (x === 'view' && kept.includes(VIEW_BALANCE));
      });
    });
  }
  const flags = {} as Record<Flag, boolean>;
  for (const f of FLAGS) flags[f.key] = a.flags?.[f.key] === true && b.flags?.[f.key] === true;
  const bKeys = b.roleKeys ?? [];
  return {
    roleKeys: (a.roleKeys ?? []).filter((k) => bKeys.includes(k)),
    permissions,
    activities,
    flags,
    isAdmin: a.isAdmin === true && b.isAdmin === true,
  };
}

/**
 * The access a run without a person at the screen has (Allow: the role's; a grant: the giver's
 * within the role), masked (maskedForAgent). The View flags are off, so answers stay masked, and
 * so is the closed-period right: work on or before the closing date always asks a person, so a run
 * without one never needs it.
 */
function ownRunAccess(access: EffectiveAccess): EffectiveAccess {
  return maskedForAgent(access);
}

// ---------------------------------------------------------------------------
// What the door loads once per request
// ---------------------------------------------------------------------------

interface Door {
  agent: AgentOfContext;
  policy: AgentPolicy;
  ceiling: { access: EffectiveAccess; role: Role; roleNames: string[] };
  grants: AgentGrant[];
  closingDate: string | null;
  now: string;
  /** The people who gave grants, each looked up once per request (giverWithin). */
  givers: Map<string, Promise<Awaited<ReturnType<typeof resolveAccess>> | null>>;
  /**
   * The names the one-line summary shows for the records the request names by id (summaryNames):
   * in what the agent alone reads, and on the request a person is shown (NamesShown).
   */
  names?: { agent?: DescribeNames; person?: DescribeNames };
  /**
   * The folders the Admin added that this agent may use now (usableFolders), worked out once per
   * door, when a run or a check first needs them: never for a read.
   */
  folders?: Promise<string[]>;
}

function requireAgent(ctx: ServiceContext): AgentOfContext {
  if (!ctx?.agent) throw new ServiceError('FORBIDDEN', NOT_FOR_PEOPLE);
  return ctx.agent;
}

/** The company's closing date (settings.closingDate). Only the date: nothing else of the settings leaves here. */
async function closingDateOf(ctx: ServiceContext): Promise<string | null> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const date = (row?.settings as { closingDate?: unknown } | null | undefined)?.closingDate;
  return typeof date === 'string' && date ? date : null;
}

async function openDoor(ctx: ServiceContext, agent: AgentOfContext): Promise<Door> {
  const now = new Date();
  const policy = await loadAgentPolicy(ctx, agent.id);
  const ceiling = await agentCeiling(ctx, agent.id);
  const grants = await liveGrants(ctx, agent.id, now);
  const closingDate = await closingDateOf(ctx);
  return { agent, policy, ceiling, grants, closingDate, now: now.toISOString(), givers: new Map() };
}

/**
 * The policy's answer, with one rule of the door's own: a desktop or server action never runs on
 * an agent's own say-so, even under a grant, because the shell acts only on a person's approval.
 */
function decideFor(door: Door, operation: Operation, facts: RequestFacts): PolicyDecision {
  const d = decide({ access: door.ceiling.access, policy: door.policy, operation, facts, grants: door.grants, now: door.now });
  if (d.outcome === 'run' && operation.kind === 'shell') {
    return { outcome: 'ask', effectiveClass: d.effectiveClass, needs: approvalNeeds(operation, d.effectiveClass, facts, door.policy) };
  }
  return d;
}

// ---------------------------------------------------------------------------
// What is refused before anything else: a stopped agent, a role an agent holds, a path outside
// the agent's folders
// ---------------------------------------------------------------------------

/**
 * Why this agent may do nothing at all right now, or null: it was removed, a person paused it, or
 * Integrated Applications is switched off for the company. Read fresh on every call (two small
 * reads), so a context taken before the pause, or a call already under way when a person paused
 * it, does no better than a new request, which the way in (lib/agentContext.ts) refuses.
 */
async function stoppedNote(ctx: ServiceContext, agentId: string): Promise<string | null> {
  if (!UUID_RE.test(agentId)) return GONE_NOTE;
  const [row] = await ctx.db
    .select({ companyId: agents.companyId, pausedAt: agents.pausedAt, revokedAt: agents.revokedAt })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row || row.revokedAt || row.companyId !== ctx.companyId) return GONE_NOTE;
  if (isPaused(row.pausedAt)) return AGENT_PAUSED_MESSAGE;
  if (await agentsBlockedFor(ctx.db, ctx.companyId)) return AGENTS_BLOCKED_MESSAGE;
  return null;
}

/**
 * What changes or removes one role: anything but a read of /api/roles/[id] (today PATCH and
 * DELETE: lib/services/users.ts updateRole, deleteRole). The bridge refuses the same at its end.
 */
function changesRole(operation: Pick<Operation, 'kind' | 'method' | 'route'>): boolean {
  return operation.kind === 'route' && operation.route === '/api/roles/[id]' && operation.method !== 'GET';
}

/**
 * A role key as the database compares it. A custom role's key is its uuid, and the database reads
 * a uuid in other spellings too (capitals, braces, hyphens left out or moved), so every spelling of
 * one id comes out the same here. A built-in role's key ("bookkeeper") is compared as written,
 * ignoring case.
 */
function roleKeyOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  const hex = t.replace(/[{}-]/g, '');
  return /^[0-9a-f]{32}$/.test(hex) ? hex : t;
}

/** Every role an agent of this company holds (every agent not removed), as roleKeyOf spells them. */
async function rolesAgentsHold(db: ServiceContext['db'], companyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ roleKeys: agents.roleKeys })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.revokedAt)));
  const held = new Set<string>();
  for (const r of rows) {
    for (const k of Array.isArray(r.roleKeys) ? (r.roleKeys as unknown[]) : []) {
      const key = roleKeyOf(k);
      if (key) held.add(key);
    }
  }
  return held;
}

/**
 * The hard floor of plan §4.6 (D9) for roles: the refusal when this request would change or delete
 * a role ANY agent holds (the asking agent's own included), otherwise null. Agents' access is read
 * live from their roles (lib/services/agents.ts agentAccess), so such a change would change that
 * agent, which no agent may do. Asked of the database each time: a role can become held between an
 * ask and its approval. `shown` says whose names the note may give its reader (NamesShown): the
 * agent's note at the door names only what the agent may read itself, a person's at approval all.
 */
async function roleHeldRefusal(
  db: ServiceContext['db'],
  companyId: string,
  operation: Operation,
  input: OperationInput,
  shown: NamesShown,
): Promise<string | null> {
  if (!changesRole(operation)) return null;
  const named = input?.params?.id;
  const key = roleKeyOf(named);
  // Nothing named: the route has no role to change (the bridge refuses a missing path value).
  if (key === null) return null;
  if (!(await rolesAgentsHold(db, companyId)).has(key)) return null;
  // The role's name, as a summary shows it to the same reader. A role spelled other than its stored
  // id (the database reads a uuid in other spellings) has no name here, so the id sent is shown.
  const names = await summaryNames(db, companyId, operation, input, shown);
  return roleHeldNote(named, typeof named === 'string' ? names?.[named.trim()] : null);
}

/** Whether `userId` is a person of this company: a member (active or not), or its owner. */
async function personOfCompany(db: ServiceContext['db'], companyId: string, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ userId: userCompanies.userId })
    .from(userCompanies)
    .where(and(eq(userCompanies.companyId, companyId), eq(userCompanies.userId, userId)));
  if (member) return true;
  const [company] = await db.select({ ownerId: companies.ownerId }).from(companies).where(eq(companies.id, companyId));
  return company?.ownerId === userId;
}

/** The name of a person of this company, by their user id; null for anyone else. */
async function personName(db: ServiceContext['db'], companyId: string, userId: string): Promise<string | null> {
  if (!UUID_RE.test(userId) || !(await personOfCompany(db, companyId, userId))) return null;
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return typeof row?.name === 'string' && row.name.trim() ? row.name : null;
}

/**
 * Whose names a one-line summary, or the hard-floor note, may give its reader (summaryNames).
 *  - A line a person is shown (personLine) names every record it can: whoever approves must know
 *    what they approve. The agent reads that same line once it has asked, as the request a person
 *    is shown, with its reason, in the approval center.
 *  - What only the agent reads, with nothing asked or kept (a dry run, a refusal, a warning, the
 *    answer of a run: agentLine), names this company's own roles, people, agents and sign-ins only
 *    where the agent could read them itself without asking. Otherwise a dry run would turn an id it
 *    holds into a name with nobody asked: Users & Roles reads are class 'admin', asked each time.
 * Built-in roles are always named (their names are the product's own, the same in every company
 * file), and so are the roles the agent itself holds (get_my_permissions shows it their names).
 */
interface NamesShown {
  roles: boolean;
  people: boolean;
  agents: boolean;
  /** Whose sign-in a session is: only an Admin sees whose sessions are whose (GET /api/sessions). */
  sessions: boolean;
  /** The agent the line is about: the roles it holds are named whatever `roles` says. */
  agentId: string | null;
}

/** Every name, for a line a person is shown; whose sign-in a session is only when `sessions` (the agent reads the line too). */
function personLine(agentId: string | null, sessions: boolean): NamesShown {
  return { roles: true, people: true, agents: true, sessions, agentId };
}

/**
 * The names the agent may read itself without asking: those of a list (the roles, the users, the
 * agents, the sign-ins) whose read its policy runs on its own, judged as describe_operation judges
 * it (typicalFacts), standing permission aside. The users and the roles are class 'admin', which is
 * never Allow, and the agents are never an agent's to read, so for those the agent reads back the
 * id it sent. Who is signed in is a plain read, whose names only an Admin role sees.
 */
function agentLine(door: Door): NamesShown {
  const readsAlone = (route: string): boolean => {
    try {
      const read = operationForRoute('GET', route);
      if (!read || read.availability !== 'agent') return false;
      return decideFor({ ...door, grants: [] }, read, typicalFacts(read)).outcome === 'run';
    } catch {
      return false;
    }
  };
  return {
    roles: readsAlone('/api/roles'),
    people: readsAlone('/api/users'),
    agents: readsAlone('/api/agents'),
    sessions: door.ceiling.access.isAdmin === true && readsAlone('/api/sessions'),
    agentId: door.agent.id,
  };
}

/** Whether this agent of the company holds the role `roleId` (compared as roleKeyOf spells keys). */
async function agentHoldsRole(db: ServiceContext['db'], companyId: string, agentId: string | null, roleId: string): Promise<boolean> {
  if (!agentId || !UUID_RE.test(agentId)) return false;
  const want = roleKeyOf(roleId);
  const [row] = await db
    .select({ roleKeys: agents.roleKeys })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  const keys = Array.isArray(row?.roleKeys) ? (row.roleKeys as unknown[]) : [];
  return want !== null && keys.some((k) => roleKeyOf(k) === want);
}

/**
 * The names a person knows the records of a request by, for its one-line summary
 * (lib/agent/describe.ts DescribeNames), by the id the request names in its path, as far as
 * `shown` lets its reader see them (NamesShown):
 *  - a role's name for /api/roles/[id], so the card reads "Delete role Clerk", not a uuid;
 *  - a person's name for /api/users/[id] and what lies under it ("Set a new password for user Pat
 *    Lee"), only for a person of this company;
 *  - an agent's name for /api/agents/[id] and what lies under it (no agent reaches those: the
 *    hard floor; named all the same, should a line ever be built for one);
 *  - whose sign-in it is for /api/sessions/[id] ("Sign out session of Pat Lee").
 * Read from this company's own records; nothing when the id names none of them.
 */
async function summaryNames(
  db: ServiceContext['db'],
  companyId: string,
  operation: Operation,
  input: OperationInput,
  shown: NamesShown,
): Promise<DescribeNames | undefined> {
  return pathNames(db, companyId, operation, input, shown);
}

/** A role's, a person's, an agent's or a sign-in's name for the record the request's path names. */
async function pathNames(
  db: ServiceContext['db'],
  companyId: string,
  operation: Operation,
  input: OperationInput,
  shown: NamesShown,
): Promise<DescribeNames | undefined> {
  if (operation.kind !== 'route') return undefined;
  const raw = input?.params?.id;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const id = raw.trim();
  const route = operation.route;
  const named = (name: string | null | undefined): DescribeNames | undefined => (typeof name === 'string' && name.trim() ? { [id]: name } : undefined);

  if (route.startsWith('/api/roles/[id]')) {
    const builtin = builtinRole(id);
    if (builtin?.name) return named(builtin.name);
    if (!UUID_RE.test(id)) return undefined;
    if (!shown.roles && !(await agentHoldsRole(db, companyId, shown.agentId, id))) return undefined;
    const [row] = await db
      .select({ name: companyRoles.name })
      .from(companyRoles)
      .where(and(eq(companyRoles.id, id), eq(companyRoles.companyId, companyId)));
    return named(row?.name);
  }
  if (!UUID_RE.test(id)) return undefined;
  if (route.startsWith('/api/users/[id]')) return shown.people ? named(await personName(db, companyId, id)) : undefined;
  if (route.startsWith('/api/agents/[id]')) {
    if (!shown.agents) return undefined;
    const [row] = await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId)));
    return named(row?.name);
  }
  if (route === '/api/sessions/[id]' && shown.sessions) {
    const [row] = await db.select({ userId: userSessions.userId }).from(userSessions).where(eq(userSessions.id, id));
    const whose = typeof row?.userId === 'string' ? await personName(db, companyId, row.userId) : null;
    return whose ? named(`of ${whose}`) : undefined;
  }
  return undefined;
}

/**
 * The names the one-line summary of an agent's request shows a person (summaryNames, personLine),
 * for whoever rebuilds that line later (lib/services/agentRequests.ts, when the books changed under
 * an approval or the request is settled, and the words of a reveal), so it keeps naming the records
 * the way the door named them on the request. `ctx` is the person's or the agent's own; the agent's
 * role decides whether a session is named, as at the door (the agent reads the line too).
 */
export async function requestNames(ctx: ServiceContext, agentId: string, operation: Operation, input: OperationInput): Promise<DescribeNames | undefined> {
  try {
    let sessionsShown = false;
    if (operation.kind === 'route' && operation.route === '/api/sessions/[id]' && UUID_RE.test(agentId)) {
      sessionsShown = (await agentCeiling(ctx, agentId)).access.isAdmin === true;
    }
    return await summaryNames(ctx.db, ctx.companyId, operation, input ?? {}, personLine(agentId, sessionsShown));
  } catch {
    // Only words: the line shows the ids instead.
    return undefined;
  }
}

/**
 * The request's one line, with the names the door read for it (summaryNames): for the agent alone
 * (the default) only those it may read itself, for the request a person is shown every one.
 */
function summaryOf(door: Door, operation: Operation, input: OperationInput, answer?: unknown, reader: 'agent' | 'person' = 'agent'): string {
  const names = reader === 'person' ? door.names?.person : door.names?.agent;
  if (names) return describeRequest(operation, input, answer, names);
  return answer === undefined ? describeRequest(operation, input) : describeRequest(operation, input, answer);
}

/** The path fields of a desktop operation (lib/agent/operations/shell.ts): each names a file its flow opens or writes. */
function shellPathFields(operation: Operation): Array<{ field: string; required: boolean }> {
  if (operation.kind !== 'shell' || operation.id === SAVE_FILE_OPERATION) return [];
  const def = SHELL_OPERATIONS.find((d) => d.id === operation.id);
  if (!def) return [];
  return Object.entries(def.input)
    .filter(([, f]) => f.type === 'path')
    .map(([field, f]) => ({ field, required: f.required === true }));
}

function pathNotAllowed(field: string, added: readonly string[]): string {
  const theirs = added.length ? `, or a folder the Admin added for this agent (${added.join('; ')})` : ', or a folder an Admin adds for this agent in Users & Roles > Agents';
  return (
    `"${field}" must be the full path of a file in a folder this agent may use, and that folder must already exist. ` +
    `Use the company file's folder, Documents\\Ironbooks or Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}${theirs}. Nobody was asked.`
  );
}

/**
 * A desktop operation's paths are checked before a person is asked, by the rule the desktop shell
 * itself applies after the approval (electron/agentShell.js pathProblem): each is a file in a folder
 * agents may use, which saveStagedFile uses too (saveFolders, allowedFolder: links resolved, never
 * the top of a drive or share, never a share this computer serves). The shell checks again when it
 * runs; this only spares a person a question whose answer could only fail. A folder that does not
 * exist yet is refused here (the shell would accept a new one spelled exactly), which only ever
 * refuses more. files.save checks its folder in savePreview.
 */
async function shellPathRefusal(door: Door, operation: Operation, input: OperationInput): Promise<string | null> {
  const fields = shellPathFields(operation);
  if (!fields.length) return null;
  const b = bodyFields(input.body);
  const folders = await saveFolders(door);
  for (const { field, required } of fields) {
    const v = b[field];
    if ((v === undefined || v === null) && !required) continue;
    // As the shell reads it: a whole path, with nothing around it.
    if (typeof v !== 'string' || !v || v !== v.trim() || !path.isAbsolute(v)) return pathNotAllowed(field, folders.added);
    if (!(await allowedFolder(folders.all, path.dirname(path.resolve(v))))) return pathNotAllowed(field, folders.added);
  }
  return null;
}

/** What the door's first look found: the input it uses, the facts, and the decision on what the request itself says. */
interface FirstLook {
  input: OperationInput;
  /** Dotted paths the guards took out of the agent's input. */
  stripped: string[];
  /** Null when the guards refused the request outright: nothing was read. */
  door: Door | null;
  facts: RequestFacts;
  decision: PolicyDecision;
}

/**
 * The door's first look at one request, the same for run_operation, a dry run, a curated action
 * (doorDecision) and a run under standing permission: what the guards refuse outright; then the
 * policy on what the request itself says (a pause first); then the hard floor for a role an agent
 * holds, which comes before a refusal of the role or the policy, as the hard floor does in
 * `decide`; then a desktop operation's paths. Nothing of the record the request names is read.
 */
async function firstLook(ctx: ServiceContext, agent: AgentOfContext, operation: Operation, given: OperationInput): Promise<FirstLook> {
  const guarded = guardInput(operation, given);
  if (guarded.refused) {
    return {
      input: guarded.input,
      stripped: [],
      door: null,
      facts: emptyFacts(given),
      decision: { outcome: 'refuse', code: 'hard_floor', message: guarded.refused, effectiveClass: baseClass(operation) },
    };
  }
  const input = withVersion(guarded.input, given);
  const door = await openDoor(ctx, agent);
  const facts = factsOf(operation, input, { closingDate: door.closingDate });
  let decision = decideFor(door, operation, facts);
  if (!(decision.outcome === 'refuse' && (decision.code === 'paused' || decision.code === 'hard_floor'))) {
    // The note goes to the agent alone: it names the role only as the agent may read it (agentLine).
    const held = await roleHeldRefusal(ctx.db, ctx.companyId, operation, input, agentLine(door));
    if (held) decision = { outcome: 'refuse', code: 'hard_floor', message: held, effectiveClass: decision.effectiveClass };
  }
  if (decision.outcome !== 'refuse') {
    const outside = await shellPathRefusal(door, operation, input);
    // The folders are the agent's settings (AgentPolicy.folders): a path outside them is one the
    // Admin did not allow.
    if (outside) decision = { outcome: 'refuse', code: 'never', message: outside, effectiveClass: decision.effectiveClass };
  }
  if (decision.outcome !== 'refuse') {
    // A staged file a desktop or server action names, of a reveal whose time is up: never put to a person.
    const ended = await revealFileRefusal(ctx, agent.id, operation, input);
    if (ended) decision = { outcome: 'refuse', code: 'never', message: ended, effectiveClass: decision.effectiveClass };
  }
  return { input, stripped: guarded.stripped, door, facts, decision };
}

/**
 * Who an agent's own run is for (contract §4). Never a person, never a secret, never a reveal.
 * `folders` are the folders it may save in (doorFolders); a read saves nothing and gets none.
 */
function ownActor(door: Door, grantId: string | null, folders: readonly string[]): BridgeActor {
  return {
    agent: { id: door.agent.id, name: door.agent.name, preset: door.policy.preset, onBehalfOf: door.agent.onBehalfOf ?? null },
    access: ownRunAccess(door.ceiling.access),
    role: door.ceiling.role,
    userId: null,
    approval: { approvedBy: null, requestId: null, grantId },
    reveal: false,
    secrets: {},
    folders: [...folders],
    atHost: false,
  };
}

/**
 * The access of the person who gave a grant, within the agent's role (plan §4.5), or null when
 * the grant cannot stand on it: that person is no longer an active member of the company, or what
 * they and the agent both have no longer allows the operation (with the flags the request needs).
 * liveGrants (lib/services/agentGrants.ts) already left out a giver whose own role lost the right;
 * this also catches a right that only the two together lack.
 */
async function giverWithin(ctx: ServiceContext, door: Door, operation: Operation, facts: RequestFacts, grant: AgentGrant): Promise<{ access: EffectiveAccess; role: Role } | null> {
  if (typeof grant.givenBy !== 'string' || !grant.givenBy) return null;
  let looked = door.givers.get(grant.givenBy);
  if (!looked) {
    looked = resolveAccess(ctx.db, ctx.companyId, grant.givenBy).catch(() => null);
    door.givers.set(grant.givenBy, looked);
  }
  const giver = await looked;
  if (!giver?.member || !giver.active || !giver.access) return null;
  const both = intersectAccess(giver.access, door.ceiling.access);
  if (roleProblem(both, operation)) return null;
  if (flagsNeeded(operation, facts).some((f) => both.flags?.[f] !== true)) return null;
  return { access: both, role: lowerRole(legacyRoleFor(giver.access, giver.isOwner === true), door.ceiling.role) };
}

/** What a grant lends a run under it: the giver's access within the agent's role, masked (grantLent). */
interface GrantLent {
  grantId: string;
  access: EffectiveAccess;
  role: Role;
}

/**
 * What a run under a grant gets: the giver's access within the agent's role, masked like any run
 * without a person at the screen, recorded under the grant (runActor). Null when the grant cannot
 * stand (giverWithin).
 */
async function grantLent(ctx: ServiceContext, door: Door, operation: Operation, facts: RequestFacts, grantId: string): Promise<GrantLent | null> {
  const grant = door.grants.find((g) => g.id === grantId);
  if (!grant) return null;
  const within = await giverWithin(ctx, door, operation, facts, grant);
  if (!within) return null;
  return { grantId, access: ownRunAccess(within.access), role: within.role };
}

/**
 * Who a run the door settled on is for: the agent's own (ownActor), or, under a grant, the agent
 * with what the grant lends it (no reveal, no secrets, nobody signed in either way).
 */
async function runActor(door: Door, lent: GrantLent | null): Promise<BridgeActor> {
  const own = ownActor(door, lent?.grantId ?? null, await doorFolders(door));
  return lent ? { ...own, access: lent.access, role: lent.role } : own;
}

/** At most this many grants are tried for one request before it is simply asked. */
const GRANT_TRIES = 10;

/**
 * The decision with the grant it names checked against its giver (grantLent). A grant that cannot
 * stand is set aside and the policy decides again without it, so another grant may answer, or the
 * request is asked. Returns the decision followed and, when it is 'run' under a grant, what that
 * grant lends the run (runActor builds its actor).
 */
async function settleGrant(
  ctx: ServiceContext,
  door: Door,
  operation: Operation,
  facts: RequestFacts,
  first: PolicyDecision,
): Promise<{ decision: PolicyDecision; lent: GrantLent | null }> {
  let decision = first;
  let grants = door.grants;
  for (let i = 0; decision.outcome === 'run' && decision.grantId; i++) {
    const grantId: string = decision.grantId;
    const lent = i < GRANT_TRIES ? await grantLent(ctx, { ...door, grants }, operation, facts, grantId) : null;
    if (lent) return { decision, lent };
    grants = i < GRANT_TRIES ? grants.filter((g) => g.id !== grantId) : [];
    decision = decideFor({ ...door, grants }, operation, facts);
  }
  return { decision, lent: null };
}

function emptyFacts(input: OperationInput = {}): RequestFacts {
  return {
    confirm: [...(input.confirm ?? [])],
    reveal: input.reveal === true,
    amount: null,
    count: null,
    entityIds: [],
    accountIds: [],
    date: null,
    closedPeriod: false,
  };
}

/**
 * The facts as the policy judges them when the real figures could not be seen ahead: the amount
 * is unknown, so it counts as above any two-person limit (policy.ts needsTwoPerson) and outside a
 * grant's amount. Everything else stands as the request gave it.
 */
function unchecked(facts: RequestFacts): RequestFacts {
  return { ...facts, amount: null };
}

/**
 * Whether the door can see what a request of this operation would really do before it runs it: a
 * route it can roll back, needing nothing only the approver types. For any other operation a
 * real request's amount always counts as unknown (change: `known` is never true for it).
 */
function figuresSeenAhead(operation: Operation): boolean {
  return operation.kind === 'route' && operation.dryRun === 'transaction' && (operation.needsSecret ?? []).length === 0;
}

/**
 * An ordinary request of this operation, for saying how the policy treats it before anything is
 * sent (find_operations, describe_operation): an amount of nothing where its real amount is seen
 * ahead (the two-person limit is told apart in words), unknown where it never is (as every real
 * request of it is judged), one record when it changes a list of them, no reveal, no closed period.
 */
function typicalFacts(operation: Operation): RequestFacts {
  return { ...emptyFacts(), amount: figuresSeenAhead(operation) ? '0.00' : null, count: operation.countField ? 1 : null };
}

/**
 * A dry run that went all the way: its ledger was read back inside the rolled-back run, so its
 * figures are what the real run would do. One stopped at a call to another computer, or only
 * described (an operation that cannot be rolled back), has no ledger and shows nothing certain.
 */
function figuresKnown(dry: BridgeResult): boolean {
  return dry.outcome === 'ok' && dry.mode === 'dry_run' && !!dry.preview && dry.preview.ledger !== null && dry.preview.ledger !== undefined;
}

/**
 * How a ledger preview entry came about (lib/agent/bridge.ts TouchedPostingEntry): 'made' by the
 * run, or an entry that was there before which it 'voided', 'deleted' or 'changed'. Anything else
 * written there is read as made: money (fail closed).
 */
type EntryHow = 'made' | 'voided' | 'deleted' | 'changed';

function entryHow(entry: unknown): EntryHow {
  const t = plainObject(entry) ? entry.touched : undefined;
  return t === 'voided' || t === 'deleted' || t === 'changed' ? t : 'made';
}

function entriesOf(p: OperationPreview | null | undefined): ChangePreview['entries'] {
  return Array.isArray(p?.ledger?.entries) ? p.ledger.entries : [];
}

/** The amount is a known zero. */
function zeroAmount(amount: string | null | undefined): boolean {
  if (amount === null || amount === undefined) return false;
  try {
    return Money.isZero(amount);
  } catch {
    return false;
  }
}

/**
 * Whether an entry the run only changed moved money, as the bridge marks it, or null when the entry
 * does not say. The mark is `counted`, as lib/agent/bridge.ts TouchedEntry.counted holds it: the
 * entry's total when the run rewrote its lines or posted it from a draft, null when it only gave it
 * a new title, number, link or line memo. TouchedPostingEntry does not carry it yet (asked of the
 * bridge's owner); until it does, every entry reads as "does not say". A mark that cannot be read
 * is money (fail closed).
 */
function changedEntryMoved(entry: unknown): boolean | null {
  if (!plainObject(entry) || !Object.hasOwn(entry, 'counted')) return null;
  const counted = entry.counted;
  if (counted === null) return false;
  if (typeof counted !== 'string' && typeof counted !== 'number') return true;
  return !zeroAmount(String(counted));
}

/**
 * Whether a run posted to the ledger (the agent's 'posted' rather than 'done'): it made, voided or
 * deleted an entry (a void is never "nothing"). An entry it only changed (a new title, number, link
 * or line memo) is not money. When every entry it touched was only changed, the bridge's mark on
 * each says whether it moved money (changedEntryMoved). Where an entry has no mark, the amount
 * decides: a known "0.00" did not post; an amount that is unknown, or more than nothing, did. For
 * an operation with no amount field that amount is what the ledger moved (the bridge counts a
 * changed entry only when its lines were rewritten or a draft was posted), so it is exact; for one
 * with an amount field it is that field's figure, so a run that only retitled an entry of such a
 * document reads as posted (errs toward "posted") until the bridge marks its entries.
 */
function postedToLedger(p: OperationPreview | null | undefined, amount: string | null | undefined): boolean {
  const entries = entriesOf(p);
  if (entries.length === 0) return false;
  if (entries.some((e) => entryHow(e) !== 'changed')) return true;
  const marks = entries.map(changedEntryMoved);
  // A preview that was cut may have left out an entry the run voided or deleted: the amount decides.
  if (!p?.truncated && marks.every((m) => m !== null)) return marks.some((m) => m === true);
  return !zeroAmount(amount);
}

/**
 * Nothing in the run moves money: nothing was cut from the preview, it made, voided or deleted no
 * ledger entry, and every other record it touched is a new one (an edit, a void or a delete of
 * something that exists may move money without posting a new entry, so those are never counted as
 * nothing). An entry it only changed (a new title, number, link or memo), with that entry's own
 * change in the audit trail, is not money.
 */
function movesNoMoney(p: OperationPreview | null | undefined): boolean {
  if (!p || !p.ledger || p.truncated) return false;
  const entries = entriesOf(p);
  if (entries.some((e) => entryHow(e) !== 'changed')) return false;
  const changedEntries = new Set(entries.map((e) => String(e?.journalEntryId ?? '').toLowerCase()));
  const nothing = (r: { action?: unknown; kind?: unknown; id?: unknown } | null | undefined) =>
    r?.action === 'create' || (r?.action === 'update' && r?.kind === 'journal_entry' && changedEntries.has(String(r?.id ?? '').toLowerCase()));
  return (p.ledger.changes ?? []).every(nothing) && (p.records ?? []).every(nothing);
}

/**
 * The run touched no ledger entry at all, yet voided, deleted or changed a record that was there
 * before (a payroll adjustment entered without its accounts, a customer's details), or the preview
 * was cut so that this cannot be ruled out. Such a run may still move money outside the ledger
 * (year-to-date wages on the W-2, 941 and 940, an open balance), so its amount is never "nothing".
 */
function changedOutsideLedger(p: OperationPreview | null | undefined): boolean {
  if (!p || !p.ledger || entriesOf(p).length > 0) return false;
  if (p.truncated) return true;
  const existing = (r: { action?: unknown } | null | undefined) => r?.action !== 'create';
  return (p.ledger.changes ?? []).some(existing) || (p.records ?? []).some(existing);
}

/**
 * The facts of a successful dry run (the bridge's, with the amount the run showed). Two rules of
 * the door's own for an operation that names no amount field, as decided for the whole feature,
 * once the run went all the way: a run that only made new records and moved no money has the
 * amount "0.00", not unknown; a run that voided, deleted or changed a record that was there before
 * and touched no ledger entry has an UNKNOWN amount, whatever figure came with it (fail closed). An
 * amount field that could not be read stays unknown.
 */
function dryRunFacts(operation: Operation, dry: BridgeResult, before: RequestFacts): RequestFacts {
  const facts = dry.facts ?? before;
  if (operation.amountField || !figuresKnown(dry)) return facts;
  if (changedOutsideLedger(dry.preview)) return { ...facts, amount: null };
  if (facts.amount !== null && facts.amount !== undefined) return facts;
  return movesNoMoney(dry.preview) ? { ...facts, amount: '0.00' } : facts;
}

const READ_CLASSES: readonly RiskClass[] = ['read', 'read_sensitive'];

/**
 * Whether the bridge can show what a request would do. A route with a rolled-back run or its own
 * preview, that changes something, and that needs nothing only the approver can type (a request
 * that needs the closing-date password cannot run without it, so its preview could only fail).
 */
function bridgePreviewable(operation: Operation, decision: PolicyDecision): boolean {
  if (operation.kind !== 'route' || operation.dryRun === 'none') return false;
  if (READ_CLASSES.includes(baseClass(operation))) return false;
  if (decision.outcome === 'ask' && (decision.needs.secrets ?? []).length > 0) return false;
  return true;
}

/** Whether a change is tried in a rolled-back run before the real one (plan §5.2 and step 7 above). */
function dryRunFirst(operation: Operation, decision: PolicyDecision): boolean {
  if (decision.outcome === 'run') return operation.kind === 'route' && operation.dryRun === 'transaction';
  if (decision.outcome === 'ask') return bridgePreviewable(operation, decision);
  return false;
}

/** The dry run failed only because the request is dated on or before the closing date. */
function closingDateFailure(r: BridgeResult): boolean {
  return r.outcome === 'error' && r.error?.code === 'PERIOD_CLOSED';
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Marks in a refusal's details of something no approval changes: the agent itself (removed,
 * paused, blocked), the company (single-user mode, a file not open yet), a feature switched off,
 * the Accountant's Copy rule, the host computer, a rate limit, and a right of the role itself
 * (lib/services/access.ts permissionDenied names the area and action: what the agent and every
 * approver of its requests share, since an approved run is never wider than the agent's role).
 */
const UNLIFTABLE_MARKS: readonly string[] = [
  'agent',
  'singleUserMode',
  'notReady',
  'featureOff',
  'accountantCopy',
  'hostOnly',
  'rateLimited',
  'personOnly',
  'agentOnly',
  'area',
];

/** A refusal the handler gave (status 403 or code FORBIDDEN) with none of the marks above. */
function plainForbidden(r: BridgeResult): boolean {
  if (r.outcome !== 'error' || (r.error?.code !== 'FORBIDDEN' && r.httpStatus !== 403)) return false;
  // Status 0: the bridge's own gates refused before the handler ran (an archived company, the
  // route map, a feature switched off, the Accountant's Copy rule, single-user mode, the agent).
  if (r.httpStatus === 0) return false;
  const given = r.error?.details;
  const d: Record<string, unknown> = plainObject(given) ? given : {};
  return !UNLIFTABLE_MARKS.some((k) => d[k] !== undefined && d[k] !== null && d[k] !== false);
}

/**
 * The View flag an approved run of this request would hold and the agent's own run does not: an
 * approved run is the approver's access within the agent's role, and the bridge (runAccess) turns
 * the View flags on only for an approved reveal of that very kind. Null when an approval adds no
 * flag at all (no reveal asked, nothing to reveal, or the role itself lacks it).
 */
function flagAnApprovalAdds(ceiling: EffectiveAccess, operation: Operation, input: OperationInput): Flag | null {
  if (input.reveal !== true || !operation.reveal) return null;
  const flag: Flag = operation.reveal === 'account_numbers' ? 'fullAccountNumbers' : 'sensitivePayroll';
  return ceiling.flags?.[flag] === true ? flag : null;
}

/**
 * The agent's own run was refused for want of a right that an approved run would have: the only
 * difference between the two is the View flag of an approved reveal (flagAnApprovalAdds). Any
 * other refusal (an archived company, a feature switched off, the Accountant's Copy rule, the
 * route map, a right the role lacks) is the same for every approver, so it is said, never asked.
 */
function accessRefusal(door: Door, operation: Operation, input: OperationInput, r: BridgeResult): boolean {
  return plainForbidden(r) && flagAnApprovalAdds(door.ceiling.access, operation, input) !== null;
}

const SERVICE_ERROR_CODES: readonly ServiceErrorCode[] = ['NOT_FOUND', 'VALIDATION', 'UNBALANCED', 'FORBIDDEN', 'CONFLICT', 'PERIOD_CLOSED', 'INTERNAL'];

/**
 * The bridge's own refusals (lib/agent/bridge.ts), which come with status 0 because the handler
 * never answered. Each is said as what it is: an agent's own mistake is never an internal error.
 */
const BRIDGE_CODES: Readonly<Record<string, ServiceErrorCode>> = {
  UNKNOWN_CONFIRM_FLAG: 'VALIDATION',
  TOO_MANY_FILES: 'VALIDATION',
  NOT_A_READ: 'VALIDATION',
  NOT_A_ROUTE: 'VALIDATION',
  REFUSED: 'FORBIDDEN',
  HOST_ONLY: 'FORBIDDEN',
  SECRET_NEEDED: 'FORBIDDEN',
  NOT_AVAILABLE: 'FORBIDDEN',
  FOLDER_NOT_ALLOWED: 'FORBIDDEN',
  PAUSED: 'FORBIDDEN',
  SANDBOX: 'FORBIDDEN',
  // Stopped for taking too long (nothing saved), or the file not open yet: try again later.
  TIMEOUT: 'CONFLICT',
  NOT_READY: 'CONFLICT',
};

/** The app's own error, as the route would have answered a person. A code of the bridge's own stays in details.code. */
function appError(r: BridgeResult): ServiceError {
  const e = r.error;
  const given = e?.details;
  const raw = typeof e?.code === 'string' && e.code ? e.code : null;
  const own = raw && (SERVICE_ERROR_CODES as readonly string[]).includes(raw) ? (raw as ServiceErrorCode) : null;
  const code: ServiceErrorCode =
    own ??
    (raw && Object.hasOwn(BRIDGE_CODES, raw)
      ? BRIDGE_CODES[raw]
      : r.httpStatus === 404
        ? 'NOT_FOUND'
        : r.httpStatus === 401 || r.httpStatus === 403
          ? 'FORBIDDEN'
          : r.httpStatus === 409
            ? 'CONFLICT'
            : r.httpStatus >= 400 && r.httpStatus < 500
              ? 'VALIDATION'
              : 'INTERNAL');
  const details =
    own || !raw
      ? (given ?? undefined)
      : plainObject(given)
        ? { ...given, code: raw }
        : { code: raw, ...(given !== null && given !== undefined ? { details: given } : {}) };
  return new ServiceError(code, e?.message || 'Ironbooks could not do this.', details);
}

/**
 * appError for a dry run the agent's own rights could not get through. When the handler refused
 * it on an operation whose protected values can be revealed, and the agent did not ask for them,
 * it is told how to ask a person.
 */
function dryRunError(operation: Operation, input: OperationInput, r: BridgeResult): ServiceError {
  const err = appError(r);
  if (operation.reveal && input.reveal !== true && plainForbidden(r)) {
    return new ServiceError(err.code, `${err.message} ${REVEAL_HINT}`, err.details, err.fixes);
  }
  return err;
}

function previewOf(list: EffectPreview[]): OperationPreview {
  return { ledger: null, records: [], effects: list, warnings: [], loss: null, routePreview: null, truncated: false };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function refused(operation: string, note: string, extra: Partial<AgentOperationAnswer> = {}): AgentOperationAnswer {
  return { operation, outcome: 'refused', ...extra, note };
}

function withStripped(answer: AgentOperationAnswer, stripped: string[]): AgentOperationAnswer {
  if (!stripped.length) return answer;
  const left = `Left out of your input, because only a person may set them: ${stripped.join(', ')}.`;
  return { ...answer, note: answer.note ? `${answer.note} ${left}` : left };
}

/** A 409 warning the agent may accept with a flag, but only a flag the operation lists (plan §5.6). */
function needsConfirmationAnswer(operation: Operation, r: BridgeResult, summary: string): AgentOperationAnswer {
  const warnings: WarningPreview[] = r.warnings?.length ? r.warnings : (r.preview?.warnings ?? []);
  const flags = [...new Set(warnings.map((w) => w.flag))];
  const acceptable = flags.length > 0 && flags.every((f) => operation.confirmFlags.includes(f));
  const note = acceptable
    ? `Nothing was done. Read the warning. To go ahead anyway, send the same request again with confirm: ${JSON.stringify(flags)}. A person may then be asked to approve it.`
    : 'Nothing was done. This warning cannot be accepted with a flag here: change the request instead.';
  return { operation: operation.id, outcome: 'needs_confirmation', summary, warnings, ...(r.preview ? { preview: r.preview } : {}), note };
}

/**
 * The same warning, on work that is not undone when it stops (needs_confirmation from an operation
 * whose service keeps what it did, or after something already left the computer): part of it may
 * have been done, so the request id stays used with this answer and is never run a second time.
 */
function keptWarningAnswer(operation: Operation, r: BridgeResult, summary: string, grantId: string | null): AgentOperationAnswer {
  const warned = needsConfirmationAnswer(operation, r, summary);
  const flags = [...new Set((warned.warnings ?? []).map((w) => w.flag))];
  const acceptable = flags.length > 0 && flags.every((f) => operation.confirmFlags.includes(f));
  const sent = (r.effects ?? []).length > 0;
  const next = acceptable
    ? `To go ahead anyway, send it with a new request_id and confirm: ${JSON.stringify(flags)}. A person may then be asked to approve it.`
    : 'This warning cannot be accepted with a flag here: change the request instead, and send it with a new request_id.';
  return {
    ...warned,
    ...(sent ? { effects: r.effects } : {}),
    ...(grantId ? { grantId } : {}),
    note:
      `Ironbooks raised a warning, but this kind of request is not undone when it stops, so part of it may already have been done` +
      `${sent ? ' (effects lists what already went out)' : ''}. Read the warning and check the books before you go on. ${next} ` +
      'Sending this request_id again gives this same answer; it is never run a second time.',
  };
}

function askedAnswer(operation: string, view: AgentRequestView, replayed: boolean, extra: string | null = null): AgentOperationAnswer {
  const waiting =
    view.status === 'approved'
      ? 'A person approved it; it is waiting for a second person or for Ironbooks to carry it out.'
      : `Nothing is done yet. ${approvalWords(view.needs)}`;
  return {
    operation,
    outcome: 'asked',
    summary: view.summary,
    requestId: view.id,
    status: view.status,
    ...(view.needs ? { needs: view.needs } : {}),
    ...(view.preview ? { preview: view.preview } : {}),
    ...(replayed ? { replayed: true } : {}),
    note: `${waiting}${extra ? ` ${extra}` : ''} Use wait_for_decision or list_my_requests to see what they decide.`,
  };
}

/**
 * Whether an executed request posted to the ledger: what the run itself posted, as the requests
 * service records it (AgentRequestView.posted); for a row from before that, the preview the
 * request holds (the last one a person saw) with its amount, by the same rule as a run's own answer.
 */
function executedPosted(view: AgentRequestView): boolean {
  if (typeof view.posted === 'boolean') return view.posted;
  return postedToLedger(view.preview, view.amount);
}

/** What became of a permission request, as the answer to asking again with its request id. */
function presentState(operation: string, view: AgentRequestView, replayed = true, extra: string | null = null): AgentOperationAnswer {
  const base = { operation, summary: view.summary, requestId: view.id, status: view.status, ...(replayed ? { replayed: true } : {}) };
  // A grant request is done once it is approved: the standing permission exists from then on.
  if (view.kind === 'grant' && (view.status === 'approved' || view.status === 'executed')) {
    return { ...base, outcome: 'done', ...(view.grantId ? { grantId: view.grantId } : {}), note: 'A person gave the standing permission you asked for. See it with get_my_permissions.' };
  }
  switch (view.status) {
    case 'pending':
    case 'approved':
      return askedAnswer(operation, view, replayed, extra);
    case 'executed': {
      // A read (a reveal, mostly) answers as a read. The request's class cannot tell: a reveal on a
      // write is judged as read_sensitive. Posted or done is what the run itself posted.
      const op = operationById(view.operation);
      const read = op ? READ_CLASSES.includes(baseClass(op)) : false;
      return {
        ...base,
        outcome: read ? 'read' : executedPosted(view) ? 'posted' : 'done',
        result: view.result,
        ...(view.file ? { file: view.file } : {}),
        ...(view.grantId ? { grantId: view.grantId } : {}),
        note: 'A person approved it and it was done.',
      };
    }
    case 'denied':
      return { ...base, outcome: 'refused', note: view.note ? `A person said no: "${view.note}"` : 'A person said no to this request.' };
    case 'expired':
      return { ...base, outcome: 'refused', note: 'Nobody answered this request in time, so it expired. If it is still needed, ask again with a new request_id.' };
    case 'failed':
      return {
        ...base,
        outcome: 'refused',
        note: `A person approved it, but it did not work: ${view.error || 'Ironbooks gave no reason.'} Fix the request and send it again with a new request_id.`,
      };
    case 'cancelled':
    default:
      return { ...base, outcome: 'refused', note: 'This request was withdrawn. If it is still needed, ask again with a new request_id.' };
  }
}

// ---------------------------------------------------------------------------
// Request ids (mirrors lib/agent/actions.ts: requireRequestId, earlierAnswer)
// ---------------------------------------------------------------------------

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,119}$/;
/** agent_requests.outcome while the first try is still under way (or never said how it ended). */
const RUNNING = 'running';
const ASKED = 'asked';
/** A first try that failed after it may have done part of the work (see commit). */
const FAILED = 'failed';
/** A first try that raised a warning after it may have done part of the work (keptWarningAnswer). */
const WARNED = 'warned';
const MAYBE_PART_DONE =
  'Part of it may already have been done, because this kind of request is not undone when it fails. Check before you send it again with a new request_id.';
/** A first try older than this that never recorded its end is not "still running" any more. */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * The request id a change needs. Its absence is told apart from every other validation error by
 * details.fields.requestId (as lib/agent/actions.ts says it), so a connector can tell "ask with a
 * request id" from a body the route refused without matching the words.
 */
function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId.trim())) {
    throw validation(REQUEST_ID_MESSAGE, { fields: { requestId: 'give a request_id of your own, unique to this change' } });
  }
  return requestId.trim();
}

/** agent_requests.action holds at most 60 characters; the hash covers the full key anyway. */
function actionKey(key: string): string {
  return key.slice(0, 60);
}

/** The input as it identifies a request: confirmation flags in any order are the same request. */
function hashInput(input: OperationInput): unknown {
  return { ...input, ...(input.confirm ? { confirm: [...input.confirm].sort() } : {}) };
}

/**
 * The answer of an earlier request with this request id, or null when there is none. The same id
 * with other input is refused. An earlier ask answers what has become of it since.
 */
async function earlierAnswer(ctx: ServiceContext, agentId: string, requestKey: string, action: string, hash: string, operation: string): Promise<AgentOperationAnswer | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(agentRequests)
    .where(and(eq(agentRequests.agentId, agentId), eq(agentRequests.requestKey, requestKey)));
  if (!row) return null;
  if (row.action !== actionKey(action) || row.inputHash !== hash) {
    throw new ServiceError(
      'CONFLICT',
      `The request_id "${requestKey}" was already used for a different request. Use a new request_id for a new request; reuse one only to repeat the very same request.`,
      { requestId: requestKey },
    );
  }
  if (row.outcome === ASKED) {
    const id = (row.result as { requestId?: unknown } | null)?.requestId;
    const view = typeof id === 'string' ? await requestForAgent(ctx, id) : null;
    if (!view) {
      throw new ServiceError('NOT_FOUND', 'That request can no longer be found. If it is still needed, ask again with a new request_id.', { requestId: requestKey });
    }
    return presentState(operation, view);
  }
  if (row.outcome === FAILED) {
    // The same failure again, never a second try under the same id.
    const f = (row.result as { failed?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.failed;
    const code = typeof f?.code === 'string' && (SERVICE_ERROR_CODES as readonly string[]).includes(f.code) ? (f.code as ServiceErrorCode) : 'CONFLICT';
    const said = typeof f?.message === 'string' && f.message ? f.message : `It did not work. ${MAYBE_PART_DONE}`;
    throw new ServiceError(code, said, { requestId: requestKey, replayed: true, ...(f?.details !== undefined && f?.details !== null ? { details: f.details } : {}) });
  }
  if (row.outcome === RUNNING || row.result === null || row.result === undefined) {
    const age = Date.now() - new Date(row.createdAt).getTime();
    if (age < CLAIM_STALE_MS) {
      throw new ServiceError('CONFLICT', 'That request is still being carried out. Ask again in a moment with the same request_id.', { requestId: requestKey });
    }
    throw new ServiceError(
      'CONFLICT',
      'Ironbooks started this request but cannot tell how it ended. Check the books, or list_my_requests, before you send it again with a new request_id.',
      { requestId: requestKey },
    );
  }
  return { ...(row.result as AgentOperationAnswer), replayed: true };
}

/** Claim the request id before the work starts. Null when another try claimed it first. */
async function claimRequestId(ctx: ServiceContext, agentId: string, requestKey: string, action: string, hash: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .insert(agentRequests)
    .values({ companyId: ctx.companyId, agentId, requestKey, action: actionKey(action), inputHash: hash, outcome: RUNNING })
    .onConflictDoNothing()
    .returning({ id: agentRequests.id });
  return rows[0]?.id ?? null;
}

async function finishClaim(claimId: string, outcome: string, result: unknown): Promise<void> {
  const db = await getDb();
  await db.update(agentRequests).set({ outcome, result: result as Record<string, unknown> }).where(eq(agentRequests.id, claimId));
}

/** Nothing was kept, so the request id is free again (as a rolled-back change frees it in actions.ts). */
async function releaseClaim(claimId: string): Promise<void> {
  const db = await getDb();
  await db.delete(agentRequests).where(eq(agentRequests.id, claimId));
}

/**
 * The bridge's refusals given before the handler ran (lib/agent/bridge.ts steps 1 to 3 and the
 * request's files): nothing at all was done.
 */
const REFUSED_BEFORE_THE_RUN: readonly string[] = [
  'NOT_A_ROUTE',
  'NOT_AVAILABLE',
  'NOT_A_READ',
  'HOST_ONLY',
  'UNKNOWN_CONFIRM_FLAG',
  'REFUSED',
  'SECRET_NEEDED',
  'TOO_MANY_FILES',
  'NOT_READY',
  'SANDBOX',
  'PAUSED',
];

/**
 * Whether a failed commit certainly kept nothing, so that its request id may be used again. The
 * bridge commits every operation in one transaction except those whose dryRun is 'none' (their
 * service opens its own database handle): a failure there may have kept part of the work, so
 * only a refusal before the handler ran counts. Anything reported as sent or tried outside the
 * books (a call to another computer) happened either way.
 */
function nothingKept(operation: Operation, r: BridgeResult): boolean {
  if ((r.effects ?? []).length > 0) return false;
  if (operation.dryRun !== 'none') return true;
  return r.httpStatus === 0 && REFUSED_BEFORE_THE_RUN.includes(r.error?.code ?? '');
}

/**
 * The run failed and part of it may have been kept: the request id stays used, with this failure
 * as its answer, so asking again with it never does the work a second time. Returns the error to
 * throw. If even that cannot be written, the claim stays "running", and asking again says
 * Ironbooks cannot tell how it ended: still never a second run.
 */
async function keepFailure(claimId: string, err: ServiceError): Promise<ServiceError> {
  const said = new ServiceError(err.code, `${err.message} ${MAYBE_PART_DONE}`, err.details);
  try {
    await finishClaim(claimId, FAILED, { failed: { code: said.code, message: said.message, details: said.details ?? null } });
  } catch {
    // See above.
  }
  return said;
}

// ---------------------------------------------------------------------------
// Arguments (checked here: the route only knows it is a JSON object)
// ---------------------------------------------------------------------------

const REASON_MAX = 500;
const FIND_LIMIT = 30;
const CHUNK_BASE64_MAX = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 4;
const SAVE_FILE_OPERATION = 'files.save';

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const body = zodErrorBody(parsed.error);
    throw validation(body.error, { fields: body.fields });
  }
  return parsed.data;
}

const runOperationArgs = z
  .object({
    operation: z.string().trim().min(1).max(160),
    params: z.record(z.string().max(500)).optional(),
    query: z.record(z.union([z.string().max(2000), z.array(z.string().max(2000)).max(100)])).optional(),
    body: z.unknown().optional(),
    confirm: z.array(z.string().min(1).max(80)).max(20).optional(),
    reveal: z.boolean().optional(),
    // The record's updatedAt as the agent last read it (OperationInput.expectedUpdatedAt): the
    // bridge checks it and sends it to the route, whose own version check compares it.
    expectedUpdatedAt: z.string().max(64).optional(),
    dryRun: z.boolean().optional(),
    requestId: z.string().max(200).optional(),
    reason: z.string().max(REASON_MAX, `can be at most ${REASON_MAX} characters`).optional(),
  })
  .strict();

const constraintsArgs = z
  .object({
    entityIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    accountIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    maxAmount: z.union([z.string().max(32), z.number()]).transform((v) => String(v).trim()).optional(),
    dateFrom: z.string().max(10).optional(),
    dateTo: z.string().max(10).optional(),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    maxCount: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const verbArgs = {
  find_operations: z
    .object({
      query: z.string().max(200).optional(),
      area: z.enum(AREA_KEYS as [Area, ...Area[]]).optional(),
      class: z.enum(RISK_CLASSES).optional(),
      limit: z.number().int().min(1).optional(),
    })
    .strict(),
  describe_operation: z.object({ operation: z.string().trim().min(1).max(160) }).strict(),
  list_my_requests: z.object({ status: z.enum(REQUEST_STATUSES).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  cancel_request: z.object({ requestId: z.string().trim().min(1).max(200) }).strict(),
  get_my_permissions: z.object({}).strict(),
  ask_for_permission: z
    .object({
      operation: z.string().trim().min(1).max(160),
      constraints: constraintsArgs.optional(),
      minutes: z.number().int().min(1).max(24 * 60).optional(),
      reason: z.string().max(REASON_MAX, `can be at most ${REASON_MAX} characters`),
      requestId: z.string().max(200),
    })
    .strict(),
  upload_file: z
    .object({
      uploadId: z.string().min(1).max(64).optional(),
      name: z.string().min(1).max(255),
      type: z.string().max(200),
      chunkBase64: z.string().max(CHUNK_BASE64_MAX, 'is larger than one upload chunk (4 MB)'),
      last: z.boolean(),
    })
    .strict(),
  get_file: z.object({ fileId: z.string().trim().min(1).max(64) }).strict(),
  save_file: z
    .object({
      fileId: z.string().trim().min(1).max(64),
      folder: z.string().min(1).max(1000),
      name: z.string().trim().min(1).max(255).optional(),
      requestId: z.string().max(200),
      reason: z.string().max(REASON_MAX, `can be at most ${REASON_MAX} characters`).optional(),
    })
    .strict(),
} as const;

export function isAgentVerb(v: unknown): v is AgentVerb {
  return typeof v === 'string' && (AGENT_VERBS as readonly string[]).includes(v);
}

/** The refusal of a verb that does not exist, with the ones that do. */
export function unknownVerb(verb: unknown): ServiceError {
  return validation(`There is no verb "${String(verb)}". Use one of: ${AGENT_VERBS.join(', ')}.`, { verbs: AGENT_VERBS });
}

// ---------------------------------------------------------------------------
// The rate limit (plan §5.2 item 6, §11)
// ---------------------------------------------------------------------------

/** Most calls one agent may make in a minute: PGlite runs one transaction at a time. */
export const AGENT_CALLS_PER_MINUTE = 120;
/**
 * Most operations one agent may have under way at once. Each one holds the company file while it
 * runs (a dry run or a change is a transaction, and the file answers one at a time), so an agent
 * sending many in parallel would keep the people using Ironbooks waiting however few it sends a
 * minute.
 */
export const AGENT_RUNS_AT_ONCE = 4;
const RATE_WINDOW_MS = 60_000;
/** How long an agent told it has too many operations under way waits before it sends again. */
const BUSY_RETRY_SECONDS = 2;

// Process-wide, like the open databases (Next.js may load a module once per route bundle).
const rateHolder = globalThis as typeof globalThis & { __bkaAgentDoorRate?: Map<string, number[]>; __bkaAgentDoorRuns?: Map<string, number> };
const rateState = (rateHolder.__bkaAgentDoorRate ??= new Map<string, number[]>());
const runState = (rateHolder.__bkaAgentDoorRuns ??= new Map<string, number>());

interface Limited {
  message: string;
  retryAfterSeconds: number;
}

/**
 * The door's own "slow down" (too many calls a minute, too many at once). The route answers it as
 * 429 with a Retry-After header (app/api/agent/actions/route.ts); `details` says the same for a
 * caller that reads the body.
 */
export class AgentRateLimited extends ServiceError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super('FORBIDDEN', message, { rateLimited: true, perAgent: true, retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The seconds to wait when `err` is the door's own "slow down", otherwise null. */
export function agentRetryAfter(err: unknown): number | null {
  if (err instanceof AgentRateLimited) return err.retryAfterSeconds;
  // The same error built by another copy of this module (one per route bundle).
  if (!(err instanceof ServiceError) || !plainObject(err.details)) return null;
  const d = err.details;
  if (d.rateLimited !== true || d.perAgent !== true) return null;
  const secs = Number(d.retryAfterSeconds);
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : BUSY_RETRY_SECONDS;
}

function seconds(n: number): string {
  return `${n} second${n === 1 ? '' : 's'}`;
}

/** Null when the agent may go on; otherwise why not and how long to wait. Counts the call when allowed. */
function rateLimited(agentId: string, now = Date.now()): Limited | null {
  const recent = (rateState.get(agentId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= AGENT_CALLS_PER_MINUTE) {
    rateState.set(agentId, recent);
    const wait = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000));
    return {
      message: `This agent has sent more than ${AGENT_CALLS_PER_MINUTE} requests in the last minute, which slows Ironbooks down for everyone. Wait about ${seconds(wait)}, then carry on.`,
      retryAfterSeconds: wait,
    };
  }
  recent.push(now);
  rateState.set(agentId, recent);
  return null;
}

const BUSY: Limited = {
  message: `This agent already has ${AGENT_RUNS_AT_ONCE} requests under way, and the company file does one piece of work at a time. Wait about ${seconds(BUSY_RETRY_SECONDS)} for one to finish, then send this again.`,
  retryAfterSeconds: BUSY_RETRY_SECONDS,
};

/**
 * Run one operation of the agent within AGENT_RUNS_AT_ONCE, or answer null at once when it already
 * has that many under way. The place is given back however the run ends, an error included.
 */
async function inRunSlot<T>(agentId: string, run: () => Promise<T>): Promise<{ value: T } | null> {
  const open = runState.get(agentId) ?? 0;
  if (open >= AGENT_RUNS_AT_ONCE) return null;
  runState.set(agentId, open + 1);
  try {
    return { value: await run() };
  } finally {
    const left = (runState.get(agentId) ?? 1) - 1;
    if (left > 0) runState.set(agentId, left);
    else runState.delete(agentId);
  }
}

/** Forget every agent's recent calls and runs under way (tests). */
export function resetAgentRateLimits(): void {
  rateState.clear();
  runState.clear();
}

/**
 * The agent call under way in this piece of async work: already counted against
 * AGENT_CALLS_PER_MINUTE, and holding one of the agent's run places when `placed`. Set only by this
 * module (doorRun, and a run in a place), never from anything an agent sends. A door call made
 * inside it for the same agent (a curated action's own check, then its run through handleVerb) is
 * neither counted again nor given a second place: one action is one call.
 */
interface CallMark {
  agentId: string;
  placed: boolean;
}
// Process-wide like the counters: Next.js may load this module once per route bundle.
const callHolder = globalThis as typeof globalThis & { __bkaAgentDoorCall?: AsyncLocalStorage<CallMark> };
const callStore = (callHolder.__bkaAgentDoorCall ??= new AsyncLocalStorage<CallMark>());

function callMark(agentId: string): CallMark | null {
  const mark = callStore.getStore();
  return mark && mark.agentId === agentId ? mark : null;
}

/** Count one call of the agent, unless this work is already one; too many is thrown as AgentRateLimited. */
function countCall(agentId: string): void {
  if (callMark(agentId)) return;
  const limited = rateLimited(agentId);
  if (limited) throw new AgentRateLimited(limited.message, limited.retryAfterSeconds);
}

/**
 * Run in one of the agent's AGENT_RUNS_AT_ONCE places (or in the one this work already holds).
 * Too many under way is thrown as AgentRateLimited. The place comes back however the run ends.
 */
async function inPlace<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  if (callMark(agentId)?.placed) return run();
  const ran = await inRunSlot(agentId, () => callStore.run({ agentId, placed: true }, run));
  if (!ran) throw new AgentRateLimited(BUSY.message, BUSY.retryAfterSeconds);
  return ran.value;
}

/**
 * One call of the agent behind `ctx` that does work of its own (a curated action of
 * lib/agent/actions.ts): counted against AGENT_CALLS_PER_MINUTE first, before anything is read,
 * and run in one of its AGENT_RUNS_AT_ONCE places. Too many of either is thrown as
 * AgentRateLimited (the route answers 429 with Retry-After). Whatever `run` sends through the door
 * for the same agent (handleVerb, operate, doorDecision) counts as this same call, in this same
 * place.
 */
export async function doorRun<T>(ctx: ServiceContext, run: () => Promise<T>): Promise<T> {
  const agent = requireAgent(ctx);
  countCall(agent.id);
  return inPlace(agent.id, run);
}

/** What the door's first look decides for one request (doorDecision). */
export interface DoorDecision {
  /** The registry's own operation (never the caller's copy of it). */
  operation: Operation;
  /** The input as the door uses it: what the agent may never send is taken out. */
  input: OperationInput;
  /** Dotted paths taken out of it, because only a person may set them. */
  stripped: string[];
  /** The facts the decision was made on: what the request itself says, before any dry run. */
  facts: RequestFacts;
  /**
   * The door's decision on those facts: refuse, run (now, or under standing permission, before the
   * giver is checked) or ask. A refusal here is final and in the door's own words; a run or an ask
   * may still change once the door tries the request and decides again on what it really does.
   */
  decision: PolicyDecision;
}

/**
 * The door's first look at one request of the agent behind `ctx`, and nothing more: nothing runs,
 * nothing is asked, nothing of the record the request names is read. Exactly what run_operation
 * would decide before it tries the request: the guards, a pause, the hard floor (a role an agent
 * holds included), the role, the policy and a desktop operation's folders. Counted as a call first,
 * unless it is part of one already (doorRun); too many is thrown as AgentRateLimited.
 */
export async function doorDecision(ctx: ServiceContext, operation: Operation | string, input: OperationInput = {}): Promise<DoorDecision> {
  const agent = requireAgent(ctx);
  countCall(agent.id);
  const id = typeof operation === 'string' ? operation : operation?.id;
  const registered = typeof id === 'string' ? operationById(id) : null;
  if (!registered) throw validation(unknownOperationNote(String(id ?? '')));
  const look = await firstLook(ctx, agent, registered, input ?? {});
  return { operation: registered, input: look.input, stripped: look.stripped, facts: look.facts, decision: look.decision };
}

// ---------------------------------------------------------------------------
// Saving a staged file (the server's own operation "files.save")
// ---------------------------------------------------------------------------

function bodyFields(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The folders an agent may save in, by the same rule as the save itself (lib/agent/shell.ts
 * saveStagedFile): the company file's folder, Documents\Ironbooks and its Agent Outbox, and the
 * folders the Admin added for this agent.
 */
async function saveFolders(door: Door): Promise<{ all: string[]; added: string[] }> {
  const added = await doorFolders(door);
  return { all: [...defaultAgentFolders(), ...added], added };
}

/** usableFolders for this door, worked out once, when first needed (Door.folders). */
function doorFolders(door: Door): Promise<string[]> {
  door.folders ??= usableFolders(door.policy);
  return door.folders;
}

/**
 * The folders the Admin added for this agent (AgentPolicy.folders) that it may still use. Saving
 * the list refused any folder holding Ironbooks' own data (lib/services/agentPolicies.ts), but a
 * folder can come to hold it later (the books or their backups moved into it): judged again here,
 * each time one is used, by the same rule (lib/agent/files.ts overlapsAppData), and left out when it
 * does, or when it cannot be judged. Every run the door hands on (the bridge, the desktop shell)
 * gets only these.
 *
 * overlapsAppData looks at the disk while the server waits (it must judge the folder as the disk
 * has it), so each folder's disk is first asked without holding anyone up (folderAnswers). One that
 * does not answer in time (a mapped network drive that is offline, say) is left out for now: judged
 * then, it would hold up every person using Ironbooks until the network gave up.
 */
async function usableFolders(policy: Pick<AgentPolicy, 'folders'>): Promise<string[]> {
  const out: string[] = [];
  for (const f of policy.folders ?? []) {
    if (typeof f !== 'string') continue;
    // A share or device path is judged by its words alone (overlapsAppData never looks at one, so
    // that Windows offers nobody's sign-in to another computer): it is not looked at here either.
    if (!SHARE_OR_DEVICE_RE.test(f.trim()) && !(await folderAnswers(f))) continue;
    try {
      if (!overlapsAppData(f)) out.push(f);
    } catch {
      // Cannot be judged: left out.
    }
  }
  return out;
}

/** A path that names a share (\\server\share) or a device (\\?\, \\.\) rather than a drive's folder. */
const SHARE_OR_DEVICE_RE = /^[\\/]{2}/;
/** How long the door waits for a folder's disk to answer before it leaves the folder out for now. */
const FOLDER_ANSWER_MS = 2_000;
/** A look at a folder's disk still under way: one at a time per folder, so a disk that does not answer ties up one of Node's file threads, never all of them. */
const folderLooks = new Map<string, Promise<void>>();

/**
 * Whether the disk that holds `folder` answers within FOLDER_ANSWER_MS: whatever it says (there,
 * not there, no access), it answered, and looking at it again while the server waits is then quick.
 * The look runs on Node's file threads, so the wait holds up no one else.
 */
async function folderAnswers(folder: string): Promise<boolean> {
  let look = folderLooks.get(folder);
  if (!look) {
    const started = fsp.lstat(folder).then(
      () => undefined,
      () => undefined,
    );
    look = started;
    folderLooks.set(folder, started);
    void started.then(() => {
      if (folderLooks.get(folder) === started) folderLooks.delete(folder);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), FOLDER_ANSWER_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([look.then(() => true as const), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function folderNotAllowed(added: readonly string[]): string {
  const theirs = added.length ? `, or a folder the Admin added for this agent (${added.join('; ')})` : ', or a folder an Admin adds for this agent in Users & Roles > Agents';
  return `That folder is not one this agent may save to, or it does not exist. Use the company file's folder, Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}${theirs}.`;
}

/**
 * The staged file is the answer of an approved reveal whose time is up (D6): the door hands it over
 * no more, nor saves or prints it (bridge.ts revealFileEnded, which also refuses it as a FileRef in
 * a request's body, an approved one included). A reveal whose end cannot be read counts as over.
 */
function revealFileEnded(ctx: ServiceContext, agentId: string, fileId: string): Promise<boolean> {
  return stagedRevealEnded(ctx.db, ctx.companyId, agentId, fileId);
}

/** The staged files a desktop or server action names: the values of its 'fileId' fields (lib/agent/operations/shell.ts). */
function shellFileIds(operation: Pick<Operation, 'id' | 'kind'>, input: OperationInput): string[] {
  if (operation.kind !== 'shell') return [];
  const def = SHELL_OPERATIONS.find((d) => d.id === operation.id);
  if (!def) return [];
  const b = bodyFields(input.body);
  return Object.entries(def.input)
    .filter(([, f]) => f.type === 'fileId')
    .map(([field]) => text(b[field]))
    .filter((id) => id !== '');
}

/**
 * REVEAL_FILE_ENDED when a desktop or server action (a save, a print) names a staged file whose
 * reveal is over (revealFileEnded): looked at before a person is asked, and again when a person
 * approves, since the time may run out in between. Null otherwise.
 */
async function revealFileRefusal(ctx: ServiceContext, agentId: string, operation: Pick<Operation, 'id' | 'kind'>, input: OperationInput): Promise<string | null> {
  for (const fileId of shellFileIds(operation, input)) {
    if (await revealFileEnded(ctx, agentId, fileId)) return REVEAL_FILE_ENDED;
  }
  return null;
}

function alreadyThere(name: string): string {
  return `There is already a file called "${name}" in that folder. Choose another name: Ironbooks never replaces a file for an agent.`;
}

/**
 * What saving would do (where, how big), without saving anything. Refused when a file of that name
 * is already there: the save never replaces one, so asking a person to approve it would be idle.
 * The save itself looks again when it runs (the folder may have changed meanwhile).
 */
async function savePreview(ctx: ServiceContext, door: Door, input: OperationInput): Promise<{ preview: OperationPreview } | { refused: string }> {
  const b = bodyFields(input.body);
  if (await revealFileEnded(ctx, door.agent.id, text(b.fileId))) return { refused: REVEAL_FILE_ENDED };
  // The save's own reader: a whole copy of the company file (person-only) may be saved, never read.
  const staged = await readStagedFileForSave({ companyId: ctx.companyId, agentId: door.agent.id }, text(b.fileId));
  if (!staged) throw new ServiceError('NOT_FOUND', FILE_GONE);
  const folders = await saveFolders(door);
  const dir = await allowedFolder(folders.all, text(b.folder));
  if (!dir) return { refused: folderNotAllowed(folders.added) };
  const name = text(b.name) || staged.file.name;
  const runnable = runnableNameProblem(name);
  if (runnable) return { refused: runnable };
  // The name is checked first (writeFile refuses separators and the like), so looking for the
  // file never reaches outside the allowed folder. The folder is checked above, so the save is
  // pinned to it ({ pinFiles }): the disk is looked at only there, as the bridge does.
  const run = await runWithEffects(
    'capture',
    async () => {
      const w = await effects.writeFile({ dir, name, bytes: staged.bytes });
      await pinFile(w.effect, dir);
      return w;
    },
    { pinFiles: true },
  );
  const there = await fsp.lstat(path.join(dir, name)).then(
    () => true,
    () => false,
  );
  if (there || run.value.replaces || run.value.effect?.detail?.replaces === true) return { refused: alreadyThere(name) };
  return { preview: previewOf(run.effects) };
}

// ---------------------------------------------------------------------------
// operate
// ---------------------------------------------------------------------------

function inputOf(req: z.infer<typeof runOperationArgs>): OperationInput {
  return {
    ...(req.params !== undefined ? { params: req.params } : {}),
    ...(req.query !== undefined ? { query: req.query } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(req.confirm !== undefined ? { confirm: req.confirm } : {}),
    ...(req.reveal !== undefined ? { reveal: req.reveal } : {}),
    ...(req.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: req.expectedUpdatedAt } : {}),
  };
}

/**
 * The guarded input with the version of the record the agent last read put back
 * (OperationInput.expectedUpdatedAt): the guards keep only the parts they know, and this one is
 * neither a secret nor anything only a person sets. The bridge checks its form and sends it to the
 * route, whose own version check compares it inside the committing transaction, so a person's
 * edit made in between is a 409, never overwritten. An approved run carries it too. A version that
 * is not a plain ISO time with its zone (guards.ts plainIsoTime) is refused: one with no zone would
 * be read in this computer's own time zone.
 */
function withVersion(guarded: OperationInput, given: OperationInput | null | undefined): OperationInput {
  const v = (given as { expectedUpdatedAt?: unknown } | null | undefined)?.expectedUpdatedAt;
  if (v === undefined || v === null || v === '') return guarded;
  const plain = plainIsoTime(v);
  if (plain === null) throw validation(EXPECTED_VERSION_MESSAGE, { fields: { expectedUpdatedAt: 'a time with its zone, as Ironbooks answered it' } });
  return { ...guarded, expectedUpdatedAt: plain };
}

/**
 * Policy, grants, bridge and requests in one place: the only way an agent's operation runs. Too
 * many calls (a minute, or at once) is answered as a refusal that says how long to wait, in words
 * and in retryAfterSeconds (the route answers it as 429 with Retry-After); the verbs of the route
 * throw it instead (handleVerb). Inside a call already counted (doorRun) it is not counted again.
 */
export const operate: Operate = async (ctx, req) => {
  const agent = requireAgent(ctx);
  const named = typeof req?.operation === 'string' ? req.operation : '';
  if (!callMark(agent.id)) {
    const limited = rateLimited(agent.id);
    if (limited) return refused(named, limited.message, { retryAfterSeconds: limited.retryAfterSeconds });
  }
  try {
    return await inPlace(agent.id, () => operateOnce(ctx, agent, req));
  } catch (err) {
    if (err instanceof AgentRateLimited) return refused(named, err.message, { retryAfterSeconds: err.retryAfterSeconds });
    throw err;
  }
};

async function operateOnce(ctx: ServiceContext, agent: AgentOfContext, raw: RunOperationRequest | unknown): Promise<AgentOperationAnswer> {
  const req = parseArgs(runOperationArgs, raw);
  const operation = operationById(req.operation);
  if (!operation) return refused(req.operation, unknownOperationNote(req.operation));

  const look = await firstLook(ctx, agent, operation, inputOf(req));
  const { input, facts, decision } = look;
  if (decision.outcome === 'refuse') return withStripped(refused(operation.id, decision.message), look.stripped);
  // Null only when the guards refused it, which is a refusal.
  const door = look.door as Door;
  const reads = decision.outcome === 'run' && decision.effectiveClass === 'read';
  // What the agent alone reads names only what it may read itself; a request put to a person (only
  // a real change is) names every record it can (NamesShown).
  door.names = {
    agent: await summaryNames(ctx.db, ctx.companyId, operation, input, agentLine(door)),
    person: reads || req.dryRun === true ? undefined : await summaryNames(ctx.db, ctx.companyId, operation, input, personLine(agent.id, door.ceiling.access.isAdmin === true)),
  };

  let answer: AgentOperationAnswer;
  if (reads) {
    answer = await readNow(ctx, door, operation, input);
  } else if (req.dryRun === true) {
    answer = await tryOnly(ctx, door, operation, input, facts, decision);
  } else {
    answer = await change(ctx, door, operation, input, facts, decision, req);
  }
  return withStripped(answer, look.stripped);
}

async function readNow(ctx: ServiceContext, door: Door, operation: Operation, input: OperationInput): Promise<AgentOperationAnswer> {
  // A read saves nothing: no folders, and no look at their disks.
  const r = await runOperation(ctx, operation, input, 'read', ownActor(door, null, []));
  if (r.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, r, summaryOf(door, operation, input, r.result));
  if (r.outcome === 'error') throw appError(r);
  return { operation: operation.id, outcome: 'read', result: r.result, ...(r.file ? { file: r.file } : {}) };
}

/**
 * What the real request would meet, judged on `facts` as the real request would be: the policy,
 * then the grant it names checked against its giver.
 */
async function wouldMeet(ctx: ServiceContext, door: Door, operation: Operation, facts: RequestFacts): Promise<string> {
  const { decision } = await settleGrant(ctx, door, operation, facts, decideFor(door, operation, facts));
  return wouldNote(decision);
}

/** dryRun: true. Nothing is kept, no request id is needed, nothing is asked. */
async function tryOnly(
  ctx: ServiceContext,
  door: Door,
  operation: Operation,
  input: OperationInput,
  facts: RequestFacts,
  decision: PolicyDecision,
): Promise<AgentOperationAnswer> {
  const summary = summaryOf(door, operation, input);
  if (!bridgePreviewable(operation, decision)) {
    let preview: OperationPreview | null = null;
    if (operation.id === SAVE_FILE_OPERATION) {
      const p = await savePreview(ctx, door, input);
      if ('refused' in p) return refused(operation.id, p.refused, { summary });
      preview = p.preview;
    }
    // Nothing shows the real figures ahead, so the real request is judged on the worst of them.
    return {
      operation: operation.id,
      outcome: 'dry_run',
      summary,
      ...(preview ? { preview } : {}),
      note: `${preview ? NOTHING_KEPT : NOT_TRIED} ${await wouldMeet(ctx, door, operation, unchecked(facts))}`,
    };
  }
  const dry = await runOperation(ctx, operation, input, 'dry_run', ownActor(door, null, await doorFolders(door)));
  if (dry.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, dry, summary);
  if (dry.outcome === 'error') {
    if (closingDateFailure(dry)) {
      const would = await wouldMeet(ctx, door, operation, unchecked({ ...facts, closedPeriod: true }));
      return {
        operation: operation.id,
        outcome: 'dry_run',
        summary,
        note: `It could not be tried, because it is dated on or before the closing date. ${would}`,
      };
    }
    if (decision.outcome === 'ask' && accessRefusal(door, operation, input, dry)) {
      return {
        operation: operation.id,
        outcome: 'dry_run',
        summary,
        note: `It could not be tried with this agent's own rights (protected values are off limits to agents). ${await wouldMeet(ctx, door, operation, unchecked(facts))}`,
      };
    }
    throw dryRunError(operation, input, dry);
  }
  const real = dryRunFacts(operation, dry, facts);
  const again = await wouldMeet(ctx, door, operation, figuresKnown(dry) ? real : unchecked(real));
  return {
    operation: operation.id,
    outcome: 'dry_run',
    summary: summaryOf(door, operation, input, dry.result),
    result: dry.result,
    ...(dry.file ? { file: dry.file } : {}),
    ...(dry.preview ? { preview: dry.preview } : {}),
    ...(dry.preview?.ledger ? { ledger: dry.preview.ledger } : {}),
    ...(dry.warnings?.length ? { warnings: dry.warnings } : {}),
    note: `${NOTHING_KEPT} ${again}`,
  };
}

/** Most tries without the agent's confirmation flags, one for each warning a route raises in turn. */
const SILENCED_TRIES = 5;

/**
 * The warnings the agent's confirmation flags silenced (plan §5.6), so that the approval card asks
 * the person the question the agent answered: the request tried again without its flags, rolled
 * back, as `actor`. A route raises one warning at a time, so each warning found is accepted for the
 * next try, until the route raises none, or one the agent did not accept. Only warnings of flags
 * the agent sent; nothing else of these tries is kept. None when the request has no flags, and none
 * when the tries cannot be made (the card then shows the flags it was sent with, as before).
 */
async function silencedWarnings(base: ServiceContext, operation: Operation, input: OperationInput, actor: BridgeActor): Promise<WarningPreview[]> {
  const sent = [...new Set((input.confirm ?? []).filter((f): f is string => typeof f === 'string'))];
  if (!sent.length || operation.kind !== 'route' || operation.dryRun === 'none') return [];
  const without: OperationInput = { ...input };
  delete without.confirm;
  const accepted: string[] = [];
  const found: WarningPreview[] = [];
  try {
    for (let i = 0; i < Math.min(sent.length, SILENCED_TRIES); i++) {
      const tried = await runOperation(base, operation, { ...without, ...(accepted.length ? { confirm: [...accepted] } : {}) }, 'dry_run', actor);
      if (tried.outcome !== 'needs_confirmation') break;
      const raised = tried.warnings?.length ? tried.warnings : (tried.preview?.warnings ?? []);
      const fresh = raised.filter((w) => w && typeof w.flag === 'string' && sent.includes(w.flag) && !accepted.includes(w.flag));
      if (!fresh.length) break;
      for (const w of fresh) {
        found.push({ flag: w.flag, message: typeof w.message === 'string' ? w.message : '' });
        accepted.push(w.flag);
      }
    }
  } catch {
    // Informational only: the request stands on the preview it has.
  }
  return found;
}

/** The preview with the silenced warnings added (each flag once). */
function withWarnings(preview: OperationPreview, warnings: WarningPreview[]): OperationPreview {
  if (!warnings.length) return preview;
  const had = preview.warnings ?? [];
  const add = warnings.filter((w) => !had.some((h) => h?.flag === w.flag));
  return add.length ? { ...preview, warnings: [...had, ...add] } : preview;
}

/** A real request: run it, or ask a person. Needs a request id. */
async function change(
  ctx: ServiceContext,
  door: Door,
  operation: Operation,
  input: OperationInput,
  firstFacts: RequestFacts,
  firstDecision: PolicyDecision,
  req: z.infer<typeof runOperationArgs>,
): Promise<AgentOperationAnswer> {
  const requestKey = requireRequestId(req.requestId);
  const hash = agentInputHash(operation.id, hashInput(input));
  const earlier = await earlierAnswer(ctx, door.agent.id, requestKey, operation.id, hash, operation.id);
  if (earlier) return earlier;

  let facts = firstFacts;
  // The real figures were seen: a dry run went all the way (figuresKnown).
  let known = false;
  // Why the request goes to a person without a preview, when it does.
  let untried: string | null = null;
  let preview: OperationPreview | null = null;
  let stalenessKey: string | null = null;
  let answerSoFar: unknown;
  // The bridge tried it and it went through: the preview is that run's.
  let tried = false;

  if (dryRunFirst(operation, firstDecision)) {
    const dry = await runOperation(ctx, operation, input, 'dry_run', ownActor(door, null, await doorFolders(door)));
    if (dry.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, dry, summaryOf(door, operation, input));
    if (dry.outcome === 'error') {
      if (closingDateFailure(dry)) {
        // Dated on or before the closing date where the body did not show it: closed-period work.
        facts = { ...facts, closedPeriod: true };
        untried = UNTRIED_CLOSING;
      } else if (firstDecision.outcome === 'ask' && accessRefusal(door, operation, input, dry)) {
        // The agent's masked access could not even try it, and only the View flag an approved
        // reveal adds would get it through. A person is being asked anyway: ask without a preview,
        // as for the closing date.
        untried = UNTRIED_ACCESS;
      } else {
        throw dryRunError(operation, input, dry);
      }
    } else {
      facts = dryRunFacts(operation, dry, facts);
      known = figuresKnown(dry);
      preview = dry.preview;
      stalenessKey = dry.stalenessKey;
      answerSoFar = dry.result;
      tried = true;
    }
  } else if (firstDecision.outcome === 'ask' && operation.id === SAVE_FILE_OPERATION) {
    const p = await savePreview(ctx, door, input);
    if ('refused' in p) return refused(operation.id, p.refused);
    preview = p.preview;
  } else if (firstDecision.outcome === 'ask' && facts.closedPeriod && operation.kind === 'route' && operation.dryRun !== 'none') {
    // Dated in a closed period by the body itself: it cannot be tried without the closing-date
    // password, which only the approver types.
    untried = UNTRIED_CLOSING;
  }

  // Decided again, on what the run would really do, whichever way it points (plan §4.3; policy.ts
  // needsTwoPerson). When nothing showed the real figures, on the worst of them: the amount counts
  // as unknown, so the two-person rule and a grant's amount never rest on the body's own figures.
  const judged = known ? facts : unchecked(facts);
  // With no ledger seen, which accounts the work posts to is not known either: no grant limited to
  // accounts covers it (an item line posts to the item's own account, which no body field names).
  const forRun = known ? judged : withLedgerAccounts(judged, null);
  const { decision, lent } = await settleGrant(ctx, door, operation, forRun, decideFor(door, operation, forRun));

  const summary = summaryOf(door, operation, input, answerSoFar);
  if (decision.outcome === 'refuse') return refused(operation.id, decision.message, { summary });
  if (decision.outcome === 'ask') {
    const reason = (req.reason ?? '').trim();
    // Never put a request to a person without the agent saying why.
    if (!reason) return refused(operation.id, NO_REASON_NOTE, { summary, ...(preview ? { preview } : {}) });
    // The warnings the agent's confirmation flags silenced, for the card (plan §5.6): the same
    // question the person would have answered in the window, with the agent's yes beside it.
    if (preview && tried) preview = withWarnings(preview, await silencedWarnings(ctx, operation, input, ownActor(door, null, await doorFolders(door))));
    return askPerson(ctx, door, {
      kind: 'operation',
      requestKey,
      operation,
      input,
      reason,
      // The line a person is shown: every record by the name they know it by (NamesShown).
      summary: summaryOf(door, operation, input, answerSoFar, 'person'),
      effectiveClass: decision.effectiveClass,
      needs: decision.needs,
      // The figures the person is shown are the ones the policy judged on: what the dry run
      // showed, or, when nothing showed the real figures, the amount as unknown. The agent's own
      // figure is never put on the card as the amount (runApproved still compares the real
      // figures with it, since the summary line may show it).
      facts: judged,
      preview,
      stalenessKey,
      grantAsked: null,
      action: operation.id,
      hash,
      note: untried,
    });
  }
  return commit(ctx, door, operation, input, await runActor(door, lent), requestKey, hash, stillRuns(door, operation, known, judged, lent?.grantId ?? null));
}

/** Why a commit that was judged on its dry run is refused when what it really did is not covered (stillRuns). */
export const CHANGED_SINCE_TRIED =
  'The books changed after this was tried, and what it would do now is not something this agent may do on its own. Nothing was done. Send it again to have it judged on what it would do now.';

/**
 * The check a commit under a grant or under Allow makes inside its own transaction (bridge.ts
 * RunOptions.commitCheck): what it really did is judged again, by the same rules as its dry run,
 * against the policy and only the grant it runs under. A record changed between the two (a
 * teammate's edit, or another of the agent's own requests: a new customer or a larger total) can
 * take it out of the grant, or over the two-person amount; then nothing is kept.
 */
function stillRuns(door: Door, operation: Operation, known: boolean, before: RequestFacts, grantId: string | null): CommitCheck {
  return (committed) => {
    const seen = dryRunFacts(operation, { ...committed, mode: 'dry_run' }, before);
    const facts = known ? seen : withLedgerAccounts(unchecked(seen), null);
    const grants = grantId ? door.grants.filter((g) => g.id === grantId) : [];
    return decideFor({ ...door, grants }, operation, facts).outcome === 'run' ? null : CHANGED_SINCE_TRIED;
  };
}

async function commit(
  ctx: ServiceContext,
  door: Door,
  operation: Operation,
  input: OperationInput,
  actor: BridgeActor,
  requestKey: string,
  hash: string,
  check?: CommitCheck,
): Promise<AgentOperationAnswer> {
  const grantId = actor.approval.grantId;
  const claimId = await claimRequestId(ctx, door.agent.id, requestKey, operation.id, hash);
  if (!claimId) {
    const again = await earlierAnswer(ctx, door.agent.id, requestKey, operation.id, hash, operation.id);
    if (again) return again;
    throw new ServiceError('CONFLICT', 'That request is already being carried out. Ask again in a moment with the same request_id.');
  }
  let r: BridgeResult;
  try {
    r = check ? await runOperation(ctx, operation, input, 'commit', actor, { commitCheck: check }) : await runOperation(ctx, operation, input, 'commit', actor);
  } catch (err) {
    if (operation.dryRun !== 'none') {
      await releaseClaim(claimId);
      throw err;
    }
    const said = err instanceof ServiceError ? err : new ServiceError('INTERNAL', 'Something went wrong while doing this.');
    throw await keepFailure(claimId, said);
  }
  if (r.outcome === 'needs_confirmation') {
    const summary = summaryOf(door, operation, input, r.result);
    if (nothingKept(operation, r)) {
      // A warning the agent may accept comes before anything is done (plan §5.6): the same request
      // id may be sent again with the flag.
      await releaseClaim(claimId);
      return needsConfirmationAnswer(operation, r, summary);
    }
    // Work that is not undone when it stops (its service keeps what it did), or that already sent
    // something out: part of it may have been done. The request id stays used with this answer,
    // as for a failure, so sending the same id again never runs the work a second time.
    const kept = keptWarningAnswer(operation, r, summary, grantId);
    try {
      await finishClaim(claimId, WARNED, kept);
    } catch {
      // The claim stays "running": asking again says Ironbooks cannot tell how it ended.
    }
    return kept;
  }
  if (r.outcome !== 'ok') {
    if (nothingKept(operation, r)) {
      await releaseClaim(claimId);
      throw appError(r);
    }
    throw await keepFailure(claimId, appError(r));
  }
  const answer: AgentOperationAnswer = {
    operation: operation.id,
    outcome: postedToLedger(r.preview, r.facts?.amount) ? 'posted' : 'done',
    summary: summaryOf(door, operation, input, r.result),
    result: r.result,
    ...(r.file ? { file: r.file } : {}),
    ...(r.preview ? { preview: r.preview } : {}),
    ...(r.preview?.ledger ? { ledger: r.preview.ledger } : {}),
    ...(r.warnings?.length ? { warnings: r.warnings } : {}),
    ...(r.effects?.length ? { effects: r.effects } : {}),
    ...(grantId ? { grantId } : {}),
  };
  try {
    await finishClaim(claimId, answer.outcome, answer);
  } catch {
    // The change is kept either way, so the agent gets its answer. The claim stays "running", and
    // asking again says Ironbooks cannot tell how it ended: enough to stop a second change.
  }
  return answer;
}

interface AskInput extends NewAgentRequest {
  /** agent_requests.action: the operation id, or "grant:<id>" for a grant request. */
  action: string;
  hash: string;
  /** Added to the answer's note (why there is no preview, say). */
  note?: string | null;
}

/** Put a request to a person. The request id is claimed first, so asking twice asks once. */
async function askPerson(ctx: ServiceContext, door: Door, ask: AskInput): Promise<AgentOperationAnswer> {
  const { action, hash, note, ...newRequest } = ask;
  const operationId = newRequest.operation.id;
  const claimId = await claimRequestId(ctx, door.agent.id, newRequest.requestKey, action, hash);
  if (!claimId) {
    const again = await earlierAnswer(ctx, door.agent.id, newRequest.requestKey, action, hash, operationId);
    if (again) return again;
    throw new ServiceError('CONFLICT', 'That request is already being asked. Ask again in a moment with the same request_id.');
  }
  let view: AgentRequestView;
  try {
    view = await createAgentRequest(ctx, newRequest);
  } catch (err) {
    await releaseClaim(claimId);
    throw err;
  }
  await finishClaim(claimId, ASKED, { requestId: view.id });
  return presentState(operationId, view, false, note ?? null);
}

// ---------------------------------------------------------------------------
// runApproved: the run of a request a person approved
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertPerson(approver: ServiceContext): asserts approver is ServiceContext & { userId: string; access: EffectiveAccess; role: Role } {
  if (!approver || approver.agent || !approver.userId || !approver.access || !approver.role) {
    throw new ServiceError('FORBIDDEN', APPROVER_ONLY);
  }
}

/** The agent, when it still exists and agents may still work in this company. */
async function approvedAgent(approver: ServiceContext, agentId: string): Promise<{ id: string; name: string }> {
  const [row] = UUID_RE.test(agentId)
    ? await approver.db
        .select({ id: agents.id, name: agents.name, revokedAt: agents.revokedAt })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, approver.companyId)))
    : [];
  if (!row || row.revokedAt) throw new ServiceError('FORBIDDEN', 'This agent has been removed, so its requests can no longer be carried out.');
  const [company] = await approver.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, approver.companyId));
  if ((company?.settings as { integratedAppsBlocked?: unknown } | null | undefined)?.integratedAppsBlocked === true) {
    throw new ServiceError('FORBIDDEN', 'Integrated Applications is switched off, so no agent request can be carried out. Turn it back on first.');
  }
  return { id: row.id, name: row.name };
}

/** What the stored request says about what the person was shown (the contract's request shape has none of it). */
interface StoredAsk {
  /** The staleness key of the preview the person was shown; null when it was asked without one. */
  stalenessKey: string | null;
  /**
   * The figures the person was shown: the requests service keeps the request's facts in
   * needs.request.facts (lib/services/agentRequests.ts RequestMeta). Null when they cannot be
   * read, which counts as "nothing was shown" (any real figure is more).
   */
  shown: RequestFacts | null;
  /** The request already needs two different people. Read fail-closed: anything but false is yes. */
  twoPerson: boolean;
}

/** Facts as stored, or null when they cannot be read. */
function readFacts(raw: unknown): RequestFacts | null {
  if (!plainObject(raw)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  let amount: string | null;
  if (raw.amount === null || raw.amount === undefined) amount = null;
  else if (typeof raw.amount === 'string' && raw.amount.trim()) amount = raw.amount.trim();
  else if (typeof raw.amount === 'number' && Number.isFinite(raw.amount)) amount = String(raw.amount);
  else return null;
  let count: number | null;
  if (raw.count === null || raw.count === undefined) count = null;
  else if (typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count >= 0) count = raw.count;
  else return null;
  return {
    confirm: strings(raw.confirm),
    reveal: raw.reveal === true,
    amount,
    count,
    entityIds: strings(raw.entityIds),
    accountIds: strings(raw.accountIds),
    date: typeof raw.date === 'string' ? raw.date : null,
    closedPeriod: raw.closedPeriod === true,
  };
}

async function storedAsk(approver: ServiceContext, requestId: string, agentId: string): Promise<StoredAsk> {
  const none: StoredAsk = { stalenessKey: null, shown: null, twoPerson: true };
  if (!UUID_RE.test(requestId)) return none;
  const [row] = await approver.db
    .select({ stalenessKey: agentPermissionRequests.stalenessKey, needs: agentPermissionRequests.needs })
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.id, requestId),
        eq(agentPermissionRequests.companyId, approver.companyId),
        eq(agentPermissionRequests.agentId, agentId),
      ),
    );
  if (!row) return none;
  const needs: Record<string, unknown> = plainObject(row.needs) ? (row.needs as unknown as Record<string, unknown>) : {};
  const meta = plainObject(needs.request) ? needs.request : {};
  return {
    stalenessKey: typeof row.stalenessKey === 'string' && row.stalenessKey ? row.stalenessKey : null,
    shown: readFacts(meta.facts),
    twoPerson: needs.twoPerson !== false,
  };
}

/**
 * What the person read on the card, as figures: the request's own, and where the card had the
 * amount (or the count) as unknown, the agent's own figure from its input, because the summary
 * line may show it ("Enter an invoice for 10.00"). Null when the stored figures cannot be read.
 */
function readOnCard(shown: RequestFacts | null, operation: Operation, input: OperationInput): RequestFacts | null {
  if (!shown) return null;
  let claimed: RequestFacts;
  try {
    claimed = factsOf(operation, input, { closingDate: null });
  } catch {
    return shown;
  }
  return { ...shown, amount: shown.amount ?? claimed?.amount ?? null, count: shown.count ?? claimed?.count ?? null };
}

/**
 * The real figures are more than the person was shown (readOnCard): a larger amount, more records,
 * or a date on or before the closing date where none was shown. A figure the person was shown as
 * unknown, with no figure of the agent's beside it, is never "more" (they approved not knowing it,
 * and the two-person rule already counted it as above its limit); one shown as known that is now
 * unknown is.
 */
function exceedsShown(real: RequestFacts, shown: RequestFacts | null): boolean {
  if (!shown) return true;
  if (real.closedPeriod && !shown.closedPeriod) return true;
  if (shown.amount !== null) {
    if (real.amount === null) return true;
    try {
      if (Money.gt(Money.abs(real.amount), Money.abs(shown.amount))) return true;
    } catch {
      return true;
    }
  }
  if (shown.count !== null && (real.count === null || real.count > shown.count)) return true;
  return false;
}

/**
 * A route that can be tried with the approver's rights before it runs: rolled back or previewed
 * by the route itself, and needing nothing typed on the card as part of the request itself. (A dry
 * run gets none of those; the closing-date password it may get, dryRunSecrets, is the period's,
 * not the request's.)
 */
function canTryAhead(operation: Operation): boolean {
  return operation.kind === 'route' && operation.dryRun !== 'none' && (operation.needsSecret ?? []).length === 0;
}

/**
 * The approval-time dry run was refused only for the View flag of an approved reveal, which the
 * real run has and that dry run does not (lib/agent/bridge.ts runAccess, on a dry run kept without
 * the reveal so that its preview, stored where the agent reads it, stays masked).
 */
function revealGetsThrough(access: EffectiveAccess, operation: Operation, input: OperationInput, dry: BridgeResult): boolean {
  return plainForbidden(dry) && flagAnApprovalAdds(access, operation, input) !== null;
}

/**
 * Of what the approver typed on the card, the one secret an approval-time dry run takes: the
 * closing-date password (lib/agent/bridge.ts takes it on a rolled-back run too, and checks it
 * through the closing-date password's own limiter). It is sent as a header, never in the body, so
 * it is in no preview or answer. Every other secret is the commit's alone.
 */
function dryRunSecrets(secrets: BridgeActor['secrets'] | null | undefined): BridgeActor['secrets'] {
  const typed = secrets?.closing_password;
  return typeof typed === 'string' && typed !== '' ? { closing_password: typed } : {};
}

/**
 * The approval-time dry run stopped at the closing-date password itself: it is not the right one
 * (lib/agent/bridge.ts CLOSING_PASSWORD_WRONG_MESSAGE), or there were too many wrong ones. Only
 * when one was typed: without one, the bridge never looks.
 */
function closingPasswordStopped(r: BridgeResult, sent: BridgeActor['secrets']): boolean {
  if (!sent.closing_password || r.outcome !== 'error' || !plainObject(r.error?.details)) return false;
  const d = r.error.details;
  return d.closingPassword === 'wrong' || d.rateLimited === true;
}

/**
 * The real figures of a request the masked dry run could not try: tried again WITH the approved
 * reveal, as the approver, with no typed secret but the closing-date password (dryRunSecrets), and
 * rolled back. Only its figures are kept (amount, count, date): its answer and preview hold the
 * protected values in full, so they go nowhere. Null when that try did not go all the way either.
 */
async function figuresWithReveal(approver: ServiceContext, operation: Operation, input: OperationInput, actor: BridgeActor, shown: RequestFacts): Promise<RequestFacts | null> {
  try {
    const seen = await runOperation(approver, operation, input, 'dry_run', { ...actor, secrets: dryRunSecrets(actor.secrets) });
    return figuresKnown(seen) ? dryRunFacts(operation, seen, shown) : null;
  } catch {
    // Seen nothing: the request is judged as before, with its amount unknown.
    return null;
  }
}

/**
 * The agent's policy as it is now still holds for an approved request: a class an Admin has set to
 * Never since it was asked, a count over the agent's limit, or a flag its role no longer holds, is
 * refused even with approval (the policy decides on what the run would really do).
 */
function refuseOverPolicy(ceiling: EffectiveAccess, policy: AgentPolicy, operation: Operation, facts: RequestFacts): void {
  const d = decide({ access: ceiling, policy, operation, facts, grants: [], now: new Date().toISOString() });
  if (d.outcome === 'refuse') throw new ServiceError('FORBIDDEN', `Nothing was done. ${d.message}`);
}

/** Run an approved request (called by approveAgentRequest), as the approver, within the agent's role. */
export const runApproved: RunApproved = async (approver, request, approve, opts) => {
  assertPerson(approver);
  const operation = operationById(request.operation);
  if (!operation) throw validation('This request names something Ironbooks can no longer do. Deny it and ask the agent to send it again.');
  if (operation.availability !== 'agent') {
    throw new ServiceError('FORBIDDEN', "Agents can never do this, even with a person's approval. A person can do it in Ironbooks.");
  }
  // The role may have become one an agent holds since the agent asked: looked at again now.
  // A person reads this note: the role by its name.
  const held = await roleHeldRefusal(approver.db, approver.companyId, operation, request.input ?? {}, personLine(request.agentId, true));
  if (held) throw new ServiceError('FORBIDDEN', `Nothing was done. ${held}`);
  if (operation.hostOnly && !opts.atHost) {
    throw new ServiceError('FORBIDDEN', 'This can only be approved at the computer that holds the company file.');
  }
  const agent = await approvedAgent(approver, request.agentId);
  const policy = await loadAgentPolicy(approver, request.agentId);
  if (isPaused(policy.pausedAt)) {
    throw new ServiceError('FORBIDDEN', 'This agent is paused. Turn it back on in Users & Roles > Agents before approving its requests.');
  }
  const ceiling = await agentCeiling(approver, request.agentId);
  const access = intersectAccess(approver.access, ceiling.access);
  const missing = roleProblem(access, operation);
  if (missing) {
    throw new ServiceError('FORBIDDEN', `This cannot be carried out with the rights you and the agent both have: it needs ${missing}.`);
  }
  const stored: OperationInput = request.input ?? {};
  const guarded = guardInput(operation, stored);
  if (guarded.refused) throw new ServiceError('FORBIDDEN', guarded.refused);
  // The version the agent last read goes with the approved run too: a person's edit since is a 409.
  guarded.input = withVersion(guarded.input, stored);

  const actor: BridgeActor = {
    agent: { id: agent.id, name: agent.name, preset: policy.preset, onBehalfOf: approver.userId },
    access,
    role: lowerRole(approver.role, ceiling.role),
    userId: approver.userId,
    approval: { approvedBy: approver.userId, requestId: request.id, grantId: null },
    reveal: stored.reveal === true,
    secrets: { ...(approve?.secrets ?? {}) },
    folders: await usableFolders(policy),
    atHost: opts.atHost === true,
  };

  const ask = await storedAsk(approver, request.id, request.agentId);
  // What the person was shown, with what the input itself says (a reveal, confirmation flags).
  const shownFacts: RequestFacts = {
    ...(ask.shown ?? emptyFacts(guarded.input)),
    reveal: guarded.input.reveal === true,
    confirm: [...(guarded.input.confirm ?? [])],
  };

  if (operation.kind === 'shell') {
    refuseOverPolicy(ceiling.access, policy, operation, shownFacts);
    return runShellApproved(approver, operation, request, guarded.input, approve?.answers ?? {}, actor);
  }

  // An approved read (a reveal, mostly) reads: on the read-only path, never in a writable transaction.
  if (READ_CLASSES.includes(baseClass(operation))) {
    refuseOverPolicy(ceiling.access, policy, operation, shownFacts);
    return runOperation(approver, operation, guarded.input, 'read', actor);
  }

  // Tried first with the approver's rights (plan §7.4), and the stored staleness key compared
  // every time: ApproveInput.acceptStale is never read here. When the person is shown a new
  // preview, the approval service stores its key in place of the old one and decides who was
  // shown it, so their next yes matches it; if the books changed yet again, they see that too. A
  // yes only ever covers a preview the person saw. The dry run's preview may be stored on the
  // request, where the agent reads it, so it runs without the reveal (figuresWithReveal is the one
  // try that holds the reveal, and only its figures are kept), and of the typed secrets with the
  // closing-date password alone (dryRunSecrets): closing-date work is then judged on its real
  // figures before it commits, and a wrong password stops here, before anything is done. A right
  // one is checked again by the commit, which is harmless; every other secret only the real run gets.
  let real: RequestFacts | null = null;
  if (canTryAhead(operation)) {
    const dryActor: BridgeActor = { ...actor, reveal: false, secrets: dryRunSecrets(actor.secrets) };
    const dry = await runOperation(approver, operation, guarded.input, 'dry_run', dryActor);
    // The password itself was refused (wrong, or too many wrong ones): the request ends with the
    // bridge's own words, never as "the books changed".
    if (closingPasswordStopped(dry, dryActor.secrets)) {
      const err = appError(dry);
      throw new ServiceError(err.code, err.message, err.details);
    }
    // A new preview the person is shown carries the warnings the agent's flags silenced, as the
    // first one did (change).
    const shownAgain = async (r: BridgeResult): Promise<BridgeResult> =>
      r.outcome === 'ok' && r.preview ? { ...r, preview: withWarnings(r.preview, await silencedWarnings(approver, operation, guarded.input, dryActor)) } : r;
    if (closingDateFailure(dry)) {
      // Dated on or before the closing date, and the dry run did not get past it: no closing-date
      // password was typed, or the rights the approver and the agent both have lack the
      // closed-period right. The request is judged as closed-period work, whatever it was shown
      // as, and its amount stays unknown.
      const closed: RequestFacts = { ...shownFacts, closedPeriod: true };
      refuseOverPolicy(ceiling.access, policy, operation, closed);
      // Shown as open-period work (the closing date moved since it was asked): back to the person,
      // who now needs the closed-period right and the closing-date password, and sees why.
      if (!shownFacts.closedPeriod) return personRound(unchecked(closed), CLOSED_FOR_PERSON);
      // A preview was shown that this run cannot be compared with: never run on it.
      if (ask.stalenessKey) return dry;
    } else if (ask.stalenessKey) {
      // The books changed since the person's preview: what would happen now is shown instead.
      if (dry.stalenessKey !== ask.stalenessKey) return shownAgain(dry);
      if (figuresKnown(dry)) real = dryRunFacts(operation, dry, shownFacts);
    } else if (dry.outcome === 'ok') {
      // Asked without a preview (the agent's masked rights, an older request, closing-date work
      // since let through): never committed on the body's own figures. What the run would really
      // do is judged against what the person read, and shown to them first when it is more.
      if (figuresKnown(dry)) {
        real = dryRunFacts(operation, dry, shownFacts);
        if (exceedsShown(real, readOnCard(ask.shown, operation, guarded.input))) return shownAgain(dry);
      }
    } else if (dry.outcome === 'needs_confirmation') {
      // It would stop at the same warning: the request ends with it, and the agent can send it
      // again with the flag.
      return dry;
    } else if (revealGetsThrough(access, operation, guarded.input, dry)) {
      // Only the approved reveal gets it through: its real figures are seen in a second try that
      // holds the reveal. When they are more than the person read, or need two people where the
      // request did not, the person is asked again with those figures and no preview.
      real = await figuresWithReveal(approver, operation, guarded.input, actor, shownFacts);
      if (real && exceedsShown(real, readOnCard(ask.shown, operation, guarded.input))) return personRound(real, REVEALED_MORE_FOR_PERSON);
      if (real && !ask.twoPerson && needsTwoPerson(policy, real, operation)) return personRound(real, REVEALED_TWO_FOR_PERSON);
    } else {
      const err = appError(dry);
      throw new ServiceError(err.code, `${err.message} It was tried before running and would not go through, so nothing was done.`, err.details);
    }
    // The real figures need two people where the request did not (a limit set since, say): the
    // person sees this preview again and a second person approves too.
    if (real && dry.outcome === 'ok' && !ask.twoPerson && needsTwoPerson(policy, real, operation)) return shownAgain(dry);
  }
  // Nothing showed the real figures (it cannot be tried, or no try could get through): the amount
  // counts as unknown. A request that did not already need two people for that goes back to the
  // person, saying why, and a second person approves too.
  if (!real && !ask.twoPerson && needsTwoPerson(policy, unchecked(shownFacts), operation)) return notTriedRound(shownFacts);
  refuseOverPolicy(ceiling.access, policy, operation, real ?? shownFacts);
  return runOperation(approver, operation, guarded.input, 'commit', actor);
};

/**
 * Back to the person without running anything: a new round (the requests service treats a dry run
 * that is ok as one) with these figures, no preview to run and no staleness key, and `note` on the
 * card saying why. The facts become the request's figures, so the needs follow them.
 */
function personRound(facts: RequestFacts, note: string): BridgeResult {
  return {
    mode: 'dry_run',
    httpStatus: 0,
    outcome: 'ok',
    result: null,
    file: null,
    preview: { ledger: null, records: [], effects: [], warnings: [], loss: null, routePreview: { ran: false, note }, truncated: false },
    warnings: [],
    error: null,
    effects: [],
    facts,
    stalenessKey: null,
    produced: [],
  };
}

/** "Not tried, so the amount is unknown": the figures it was asked with, its amount unknown, so the two-person rule applies to it. */
function notTriedRound(shown: RequestFacts): BridgeResult {
  return personRound(unchecked(shown), UNCHECKED_FOR_PERSON);
}

function shellResult(
  input: OperationInput,
  r: { ok: boolean; result?: unknown; error?: string | null; preview?: OperationPreview | null; effects?: BridgeResult['effects'] },
): BridgeResult {
  return {
    mode: 'commit',
    httpStatus: r.ok ? 200 : 0,
    outcome: r.ok ? 'ok' : 'error',
    result: r.ok ? (r.result ?? null) : null,
    file: null,
    preview: r.preview ?? null,
    warnings: [],
    error: r.ok ? null : { message: r.error || 'It did not work.', code: null, details: null },
    effects: r.effects ?? [],
    facts: emptyFacts(input),
    stalenessKey: null,
    produced: [],
  };
}

function secretsForShell(secrets: BridgeActor['secrets']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function runShellApproved(
  approver: ServiceContext,
  operation: Operation,
  request: { id: string; agentId: string },
  input: OperationInput,
  answers: Record<string, unknown>,
  actor: BridgeActor,
): Promise<BridgeResult> {
  const def: ShellOperationDef | undefined = SHELL_OPERATIONS.find((d) => d.id === operation.id);
  if (!def) return shellResult(input, { ok: false, error: 'Ironbooks does not know how to do this here.' });
  if (def.hostOnly && !actor.atHost) return shellResult(input, { ok: false, error: 'This can only be approved at the computer that holds the company file.' });
  // A revealed file whose time ran out since the agent asked is saved or printed nowhere, even in
  // the moment before the requests service removes it (revealFileRefusal).
  const ended = await revealFileRefusal(approver, request.agentId, operation, input);
  if (ended) return shellResult(input, { ok: false, error: ended });

  // One implementation of each: the desktop flows and the server's own "files.save" (which never
  // saves over a file that is already there, in the same folders the ask was checked against)
  // are both lib/agent/shell.ts runShellOperation. The shell makes and checks its own approval
  // ticket (lib/agent/shellTicket.ts): it holds the per-launch key, so this passes none.
  const r = await runShellOperation(
    approver,
    def,
    { id: request.id, agentId: request.agentId, input: bodyFields(input.body) },
    answers,
    secretsForShell(actor.secrets),
  );
  if (!r.ok) return shellResult(input, { ok: false, error: r.error });
  const result = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? { ...(r.result as Record<string, unknown>) } : { value: r.result ?? null };
  return shellResult(input, { ok: true, result: r.restarting ? { ...result, restarting: true, note: RESTARTING_NOTE } : result });
}

// ---------------------------------------------------------------------------
// handleVerb: the verbs of POST /api/agent/actions
// ---------------------------------------------------------------------------

/**
 * What changes how an ordinary request is treated, in words: the two-person limit (an amount above
 * it, or one that cannot be told ahead), the record limit, and asking for protected values.
 */
function limitWords(policy: AgentPolicy, operation: Operation, d: PolicyDecision): string[] {
  if (d.outcome === 'refuse') return [];
  const out: string[] = [];
  const twoAlready = d.outcome === 'ask' && d.needs.twoPerson;
  const limitSet = policy.twoPersonOver !== null && policy.twoPersonOver !== undefined;
  if (limitSet && twoAlready && !figuresSeenAhead(operation)) {
    // Judged as every real request of it is: its amount unknown (typicalFacts).
    out.push('It cannot be tried ahead of time, so its amount counts as unknown: above the two-person limit, and outside the amount of standing permission.');
  } else if (limitSet && !twoAlready && needsTwoPerson(policy, unchecked(typicalFacts(operation)), operation)) {
    out.push(`Above ${policy.twoPersonOver}, or when its amount cannot be told ahead of time, two different people must approve it.`);
  }
  if (typeof policy.bulkCap === 'number' && operation.countField) {
    out.push(`At most ${policy.bulkCap} records in one request; a larger one is refused, so split it.`);
  }
  if (operation.reveal) out.push('Asking for the full protected values (reveal: true) always asks a person.');
  return out;
}

/**
 * How the agent's policy treats an operation right now (plan §6.1), judged on an ordinary request
 * of it (typicalFacts), with why: the refusal, who must approve, or the standing permission it
 * would run under (checked against the person who gave it), and what changes that.
 */
async function summaryFor(ctx: ServiceContext, door: Door, operation: Operation): Promise<OperationSummary> {
  const facts = typicalFacts(operation);
  const { decision: d } = await settleGrant(ctx, door, operation, facts, decideFor(door, operation, facts));
  const grant = d.outcome === 'run' && d.grantId ? door.grants.find((g) => g.id === d.grantId) : undefined;
  const limits = limitWords(door.policy, operation, d);
  const said =
    d.outcome === 'refuse'
      ? d.message
      : d.outcome === 'ask'
        ? `Asks a person first. ${approvalWords(d.needs)}`
        : grant
          ? `Runs under standing permission a person gave, until ${grant.expiresAt}.`
          : null;
  const why = [said, ...limits].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' ');
  return {
    id: operation.id,
    describe: operation.describe,
    class: baseClass(operation),
    area: operation.area,
    method: operation.method,
    route: operation.route,
    treatment: d.outcome === 'refuse' ? 'refused' : d.outcome,
    why: why || null,
  };
}

/**
 * Operations whose amount field only marks the amount as unknown (lib/agent/operations/classes/
 * payroll.ts: no figure of a payroll adjustment is right for every one, so amountField names a
 * list, which is never read as an amount). Their notes say so, not where the amount is read from.
 */
const AMOUNT_NEVER_KNOWN: ReadonlySet<string> = new Set(['payroll.adjustments.create']);

/**
 * The notes of describe_operation: how it is tried, and what that means for how it is judged. They
 * follow the door's own rules (bridgePreviewable, figuresSeenAhead), so a note never promises a
 * try the door will not make: a route that needs something only the approver types (a password, a
 * key) is never tried ahead, whatever its dry run kind.
 */
function notesFor(operation: Operation): string[] {
  const notes: string[] = [];
  const read = READ_CLASSES.includes(baseClass(operation));
  const typed = (operation.needsSecret ?? []).length > 0;
  if (read) notes.push('A read: it changes nothing.');
  else if (typed && operation.kind === 'route' && operation.dryRun !== 'none') {
    notes.push(
      `This cannot be tried ahead of time, because it needs ${joinWords(operation.needsSecret.map((s) => SECRET_WORDS[s] ?? 'a password'))}, which only the person approving it types: a dry run only describes it.`,
    );
  } else if (operation.dryRun === 'transaction') notes.push('Send it with dry_run: true first to see exactly what it would do; nothing is kept.');
  else if (operation.dryRun === 'preview') notes.push("A dry run uses the app's own preview of this request.");
  else notes.push('This cannot be tried without really doing it: a dry run only describes it.');
  if (!read) {
    notes.push(
      figuresSeenAhead(operation)
        ? 'Before it runs or asks, it is tried and the policy decides again on what it would really do: the true amount, number of records and date.'
        : 'Because it cannot be tried ahead of time, its amount counts as unknown: above any two-person limit, and outside the amount of standing permission.',
    );
  }
  if (AMOUNT_NEVER_KNOWN.has(operation.id)) {
    notes.push('Its amount is not known, before a dry run or after it: it counts as over every two-person limit, and the approval card says the amount is unknown.');
  } else if (operation.amountField === TEMPLATE_AMOUNT) {
    notes.push("The amount is what one run would enter: the template's line amounts (quantity × rate for a line without one), or a journal entry's debits.");
  } else if (operation.amountField) {
    notes.push(`The amount is read from "${operation.amountField}", and from the answer of a dry run when that is larger.`);
  }
  if (operation.countField) notes.push(`The number of records it changes is the length of "${operation.countField}".`);
  if (operation.confirmFlags.length) {
    notes.push(`If it answers needs_confirmation, read the warning; to go ahead anyway resend with the flag in confirm (${operation.confirmFlags.join(', ')}).`);
  }
  if (operation.reveal) notes.push('Protected values come back masked. Send reveal: true to ask a person to show them in full, one call at a time.');
  if (operation.needsSecret.length) notes.push(`A person types ${joinWords(operation.needsSecret.map((s) => SECRET_WORDS[s] ?? 'a password'))} on the approval card. Never send it yourself.`);
  if (operation.effects.length) notes.push('It sends, saves or prints something outside the books, so a person approves it.');
  if (operation.alwaysAsk) notes.push('A person always approves this, whatever the policy says.');
  if (operation.hostOnly) notes.push('It can only be approved at the computer that holds the company file.');
  if (operation.output === 'pdf' || operation.output === 'file') notes.push('The answer is a file: fetch it with get_file, or save it with save_file.');
  if (operation.body === 'bytes' || operation.body === 'multipart') notes.push('Upload the file first with upload_file and put { "fileId": ... } where the file goes.');
  return notes;
}

function grantFacts(c: GrantConstraints): RequestFacts {
  return {
    confirm: [],
    reveal: false,
    amount: c.maxAmount ?? null,
    count: c.maxCount ?? null,
    entityIds: c.entityIds ?? [],
    accountIds: c.accountIds ?? [],
    date: c.dateTo ?? c.dateFrom ?? null,
    closedPeriod: false,
  };
}

/**
 * The approval card's one line for a grant request: built from the operation and the limits, never
 * from the agent's words. When standing permission may never cover some of this work (the
 * two-person limit, on work whose amount may stay unknown: amountMayStayUnknown), the person reads
 * that too, as the agent does, before saying yes to something that may never be used.
 */
function grantSummary(operation: Operation, cls: RiskClass, c: GrantConstraints, minutes: number, policy: AgentPolicy): string {
  const line = grantLimitsLine(operation, cls, c, minutes);
  return twoPersonLimitSet(policy) && amountMayStayUnknown(operation) ? `${line} ${UNKNOWN_AMOUNT_GRANT_CARD_NOTE}` : line;
}

/** grantSummary's warning, for the person reading the card. */
const UNKNOWN_AMOUNT_GRANT_CARD_NOTE =
  'While the two-person limit is set, it never covers a change to an existing record that posts nothing to the ledger: two people still approve each of those.';

function grantLimitsLine(operation: Operation, cls: RiskClass, c: GrantConstraints, minutes: number): string {
  const limits: string[] = [];
  const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (c.maxAmount) limits.push(`amounts up to ${c.maxAmount}`);
  if (c.entityIds?.length) limits.push(`only ${many(c.entityIds.length, 'chosen name')}`);
  if (c.accountIds?.length) limits.push(`only ${many(c.accountIds.length, 'chosen account')}`);
  if (c.dateFrom || c.dateTo) limits.push(`dated ${c.dateFrom ?? 'any time'} to ${c.dateTo ?? 'any time'}`);
  if (c.maxCount) limits.push(`at most ${many(c.maxCount, 'record')} per request`);
  if (c.maxUses) limits.push(`at most ${many(c.maxUses, 'use')}`);
  return (
    `Standing permission for "${operation.id}" (${RISK_CLASS_LABELS[cls]}) for up to ${many(minutes, 'minute')}` +
    (limits.length ? `: ${limits.join(', ')}.` : ', with no other limits.')
  );
}

/**
 * Why standing permission for this operation, with these limits, could never let a request of it
 * run, or null when it could. A grant limited by records needs a count, and an operation that names
 * no list of records never has one. Every real request of an operation whose figures are never seen
 * ahead is judged with its amount unknown (change): while the two-person limit applies to an
 * unknown amount, no grant covers one at all (decide never lets a grant answer what needs two
 * people), and otherwise a grant limited by amount never covers one. The two-person reason is
 * given first: the other one says to ask again without max_amount, which would not help then.
 */
function grantNeverCovers(policy: AgentPolicy, operation: Operation, c: GrantConstraints): string | null {
  if (GRANTABLE[baseClass(operation)] === 'capped' && !operation.countField) return COUNT_NEVER_KNOWN_NOTE;
  if (figuresSeenAhead(operation)) return null;
  if (needsTwoPerson(policy, unchecked(typicalFacts(operation)), operation)) return twoPersonAlwaysNote(policy.twoPersonOver);
  if (c.maxAmount !== undefined && c.maxAmount !== null) return AMOUNT_NEVER_KNOWN_NOTE;
  return null;
}

/**
 * Whether a request of this operation may have an amount that is never known, even after it is
 * tried: one that names no amount field and does more than make new records. Such a run that
 * changes, voids or deletes a record that was there before and touches no ledger entry has an
 * UNKNOWN amount (dryRunFacts), so with the two-person limit set no grant covers it, whatever its
 * max_amount. Which requests post nothing is only known from each one's dry run, so this can only
 * warn.
 */
function amountMayStayUnknown(operation: Operation): boolean {
  return !operation.amountField && baseClass(operation) !== 'enter';
}

/** amountMayStayUnknown, in words, for an agent asking for standing permission while the two-person limit is set. */
const UNKNOWN_AMOUNT_GRANT_NOTE =
  'While the two-person limit is set, standing permission for this covers only requests whose dry run shows the amount they move. A change to a record ' +
  "that is already there that posts nothing to the ledger (a name's details, say) has no amount that can be checked, so each such request still needs " +
  'two people, and standing permission never covers it. If that is all this work does, send each with run_operation instead.';

function twoPersonLimitSet(policy: AgentPolicy): boolean {
  return policy.twoPersonOver !== null && policy.twoPersonOver !== undefined;
}

/** What the agent is told to do when standing permission would need two people (askForPermission). */
function twoPersonGrantNote(policy: AgentPolicy, operation: Operation): string {
  const words = [
    `Standing permission only covers what one person may approve. Set constraints.max_amount at or below ${policy.twoPersonOver ?? 'the two-person limit'} and send it again.`,
  ];
  if (twoPersonLimitSet(policy) && amountMayStayUnknown(operation)) words.push(UNKNOWN_AMOUNT_GRANT_NOTE);
  return words.join(' ');
}

async function askForPermission(ctx: ServiceContext, agent: AgentOfContext, args: z.infer<typeof verbArgs.ask_for_permission>): Promise<AgentOperationAnswer> {
  const operation = operationById(args.operation);
  if (!operation) return refused(args.operation, unknownOperationNote(args.operation));
  const cls = baseClass(operation);
  const constraints: GrantConstraints = { ...(args.constraints ?? {}) };
  // The hard floor for roles an agent holds (plan §4.6): a grant names no role, so it could cover one.
  if (changesRole(operation)) return refused(operation.id, ROLE_GRANT_NOTE);
  if (operation.kind === 'shell') {
    // A desktop or file action never runs on an agent's own say-so (decideFor), so standing
    // permission for one would do nothing: a person approves each.
    return refused(
      operation.id,
      'A person approves each desktop or file action on its own, so standing permission cannot be given for it. Send each with run_operation (or save_file) instead.',
    );
  }
  // Refused for everyone by the grants service, Admins included (lib/services/agentGrants.ts).
  if (operation.hostOnly) return refused(operation.id, HOST_ONLY_GRANT_NOTE);
  if (operation.fileAdmin) return refused(operation.id, FILE_ADMIN_GRANT_NOTE);
  if (GRANTABLE[cls] === 'no' || operation.alwaysAsk || !operation.classified) {
    return refused(
      operation.id,
      `A person cannot give standing permission for this (${RISK_CLASS_LABELS[cls]}): each one is asked on its own. Send each with run_operation instead.`,
    );
  }
  if (GRANTABLE[cls] === 'capped' && !operation.countField) return refused(operation.id, COUNT_NEVER_KNOWN_NOTE);
  if (GRANTABLE[cls] === 'capped' && constraints.maxCount === undefined) {
    return refused(operation.id, 'Say the most records one request may change, in constraints.max_count, and send it again.');
  }
  // Asking again with the same request id answers what became of the first ask (a grant given
  // since then included), before anything is decided anew. The request is what the agent sent.
  const requestKey = requireRequestId(args.requestId);
  const action = `grant:${operation.id}`;
  const hash = agentInputHash(action, { constraints, minutes: args.minutes ?? null });
  const earlier = await earlierAnswer(ctx, agent.id, requestKey, action, hash, operation.id);
  if (earlier) return earlier;

  const door = await openDoor(ctx, agent);
  // Limited by amount, on work whose amount is never known ahead: it could never be used. Looked at
  // before the policy decides, which would take the limit for the request's amount. With the
  // two-person limit set, that is the reason given (grantNeverCovers): asking again without
  // max_amount would be refused too.
  if (!figuresSeenAhead(operation) && constraints.maxAmount !== undefined) {
    return refused(operation.id, grantNeverCovers(door.policy, operation, constraints) ?? AMOUNT_NEVER_KNOWN_NOTE);
  }
  const facts = grantFacts(constraints);
  // A grant already given covers it only when its giver still could give it (settleGrant).
  const { decision: d } = await settleGrant(ctx, door, operation, facts, decideFor(door, operation, facts));
  if (d.outcome === 'refuse') return refused(operation.id, d.message);
  if (d.outcome === 'run') {
    return { operation: operation.id, outcome: 'done', note: 'Nothing to ask: this agent may already do this without asking a person.' };
  }
  if (d.needs.grantable === 'no') {
    return refused(operation.id, 'A person cannot give standing permission for requests like this: each one is asked on its own. Send each with run_operation instead.');
  }
  // A grant that could never let a request run is never put to a person (the two-person limit on
  // work whose amount is never known ahead, most of all: lowering max_amount would not help).
  const never = grantNeverCovers(door.policy, operation, constraints);
  if (never) return refused(operation.id, never);
  if (d.needs.twoPerson) return refused(operation.id, twoPersonGrantNote(door.policy, operation));
  const most = d.needs.grantable === 'short' ? SHORT_GRANT_MINUTES : 24 * 60;
  const minutes = Math.min(args.minutes ?? Math.min(60, most), most);
  const reason = args.reason.trim();
  if (!reason) return refused(operation.id, NO_REASON_NOTE);
  const kind: AgentRequestKind = 'grant';
  return askPerson(ctx, door, {
    kind,
    requestKey,
    operation,
    input: {},
    reason,
    summary: grantSummary(operation, cls, constraints, minutes, door.policy),
    effectiveClass: d.effectiveClass,
    needs: d.needs,
    facts,
    preview: null,
    stalenessKey: null,
    grantAsked: { constraints, minutes },
    action,
    hash,
    // Asked, but it may still never cover the requests this agent has in mind: it is told so.
    note: twoPersonLimitSet(door.policy) && amountMayStayUnknown(operation) ? UNKNOWN_AMOUNT_GRANT_NOTE : null,
  });
}

function sessionUsers(sessions: Array<{ userId?: unknown } | null | undefined> | null | undefined): string[] {
  const ids = (sessions ?? []).map((s) => s?.userId).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
  return [...new Set(ids)];
}

/**
 * Whether a person of this company is signed in right now to answer a request: a session that is
 * still in use, of an active member of the company, read as lib/services/access.ts resolveAccess
 * reads membership. Only this company's members are listed (people signed in to other company
 * files on the same computer are not looked at), then their membership is checked in one query.
 * The company's owner, who may have no membership row, is looked for on their own.
 */
async function someoneSignedIn(ctx: ServiceContext): Promise<boolean> {
  try {
    const members = sessionUsers(await listActiveSessions(ctx.db, { companyId: ctx.companyId }));
    if (members.length) {
      const rows = await ctx.db
        .select({ isActive: userCompanies.isActive })
        .from(userCompanies)
        .where(and(eq(userCompanies.companyId, ctx.companyId), inArray(userCompanies.userId, members)));
      if (rows.some((r) => r.isActive !== false)) return true;
    }
    const [company] = await ctx.db.select({ ownerId: companies.ownerId }).from(companies).where(eq(companies.id, ctx.companyId));
    const ownerId = company?.ownerId;
    if (!ownerId || members.includes(ownerId)) return false;
    if (!sessionUsers(await listActiveSessions(ctx.db)).includes(ownerId)) return false;
    const owner = await resolveAccess(ctx.db, ctx.companyId, ownerId);
    return owner.member && owner.active;
  } catch {
    return false;
  }
}

/**
 * The grant's limits as they really hold: an amount above the agent's two-person limit is never
 * covered by standing permission (it needs two people), so the limit is the lower of the two; and
 * the agent's record limit holds under a grant too.
 */
function realLimits(c: GrantConstraints, policy: AgentPolicy, operation: Operation): GrantConstraints {
  const out: GrantConstraints = { ...c };
  const over = policy.twoPersonOver;
  // An operation that cannot be tried ahead never has a known amount, so the two-person limit
  // never caps it by amount: it either needs two people every time (grantsInEffect leaves its
  // grants out) or none at all.
  if (over !== null && over !== undefined && figuresSeenAhead(operation)) {
    let lower = over;
    if (c.maxAmount !== undefined) {
      try {
        if (Money.lte(Money.abs(c.maxAmount), Money.abs(over))) lower = c.maxAmount;
      } catch {
        // An amount that cannot be read: the two-person limit is what holds.
      }
    }
    out.maxAmount = lower;
  }
  if (typeof policy.bulkCap === 'number' && (c.maxCount !== undefined || operation.countField)) {
    out.maxCount = Math.min(c.maxCount ?? policy.bulkCap, policy.bulkCap);
  }
  return out;
}

/**
 * The live grants that would really let something run (their giver still could give them, within
 * the agent's role), with their real limits. Left out: a grant on a desktop or file action (a
 * person approves each, decideFor), on a role change (the hard floor for roles an agent holds),
 * and any grant that could never cover a request (grantNeverCovers: on an operation that cannot be
 * tried ahead, one limited by amount or one whose unknown amount needs two people; one limited by
 * records on an operation that never counts them).
 */
async function grantsInEffect(ctx: ServiceContext, door: Door): Promise<AgentGrant[]> {
  const out: AgentGrant[] = [];
  for (const g of door.grants) {
    const operation = operationById(g.operation);
    if (!operation || operation.kind === 'shell' || changesRole(operation)) continue;
    if (grantNeverCovers(door.policy, operation, g.constraints ?? {})) continue;
    if (!(await giverWithin(ctx, door, operation, typicalFacts(operation), g))) continue;
    out.push({ ...g, constraints: realLimits(g.constraints ?? {}, door.policy, operation) });
  }
  return out;
}

/** Verbs that run an operation: they hold the company file while they run (AGENT_RUNS_AT_ONCE). */
async function runVerb(agentId: string, run: () => Promise<AgentOperationAnswer>): Promise<AgentOperationAnswer> {
  return inPlace(agentId, run);
}

/** find_operations for an agent that may do nothing right now: every operation refused, with why. */
function stoppedSummary(operation: Operation, note: string): OperationSummary {
  return {
    id: operation.id,
    describe: operation.describe,
    class: baseClass(operation),
    area: operation.area,
    method: operation.method,
    route: operation.route,
    treatment: 'refused',
    why: note,
  };
}

/**
 * One verb of POST /api/agent/actions (`{ verb, ...args }`). Arguments are checked here. Too many
 * calls is an error for every verb (AgentRateLimited: the route answers 429 with Retry-After), so
 * an agent never reads "slow down" as a refusal of the work itself. The call is counted first,
 * before anything is read. Then, once per call, whether the agent may do anything at all (removed,
 * paused, every agent switched off): if not, every verb is refused (FORBIDDEN) except
 * find_operations, which reads only the list of operations and answers each one as refused, with
 * why.
 */
export const handleVerb: HandleVerb = async (ctx, verb, args) => {
  const agent = requireAgent(ctx);
  if (!isAgentVerb(verb)) throw unknownVerb(verb);
  countCall(agent.id);
  const stopped = await stoppedNote(ctx, agent.id);
  if (stopped && verb !== 'find_operations') {
    throw new ServiceError('FORBIDDEN', stopped, { agent: true, ...(stopped === AGENT_PAUSED_MESSAGE ? { paused: true } : {}) });
  }
  const owner: FileOwner = { companyId: ctx.companyId, agentId: agent.id };

  switch (verb) {
    case 'find_operations': {
      const a = parseArgs(verbArgs.find_operations, args);
      const limit = Math.min(a.limit ?? FIND_LIMIT, FIND_LIMIT);
      const found = findOperations({ query: a.query, area: a.area, class: a.class, limit: limit + 1 });
      if (stopped) return { operations: found.slice(0, limit).map((op) => stoppedSummary(op, stopped)), more: found.length > limit };
      const door = await openDoor(ctx, agent);
      const operations: OperationSummary[] = [];
      for (const op of found.slice(0, limit)) operations.push(await summaryFor(ctx, door, op));
      return { operations, more: found.length > limit };
    }
    case 'describe_operation': {
      const a = parseArgs(verbArgs.describe_operation, args);
      const operation = operationById(a.operation);
      if (!operation) throw new ServiceError('NOT_FOUND', unknownOperationNote(a.operation));
      const door = await openDoor(ctx, agent);
      const notes = notesFor(operation);
      let schemas: { body: unknown; query: unknown } = { body: null, query: null };
      try {
        schemas = (await describeSchemas(operation)) ?? schemas;
      } catch {
        notes.push('The list of fields could not be loaded just now. A dry run shows what the app expects.');
      }
      // Examples where the operation, its desktop flow or its classification has them (plan §6.1).
      let examples: OperationExample[] = [];
      try {
        examples = examplesOf(operation);
      } catch {
        // Written wrong: the registry test names it. The rest of the description stands.
      }
      if (examples.length) {
        // run_operation's arguments are checked strictly, so the words beside an example must not
        // go with it (lib/agent/operations/schemas.ts OperationExample: title and note are not sent).
        notes.push(
          'Each of examples is a request as run_operation takes it: send its params, query, body, confirm and reveal as shown. Its title and note only explain it: leave them out when you send it.',
        );
      }
      const description: OperationDescription = {
        ...(await summaryFor(ctx, door, operation)),
        params: [...operation.params],
        bodySchema: schemas.body ?? null,
        ...(schemas.body == null && operation.bodyFields?.length ? { bodyFields: [...operation.bodyFields] } : {}),
        ...(schemas.body == null && operation.bodyDoc ? { bodyDoc: operation.bodyDoc } : {}),
        querySchema: schemas.query ?? null,
        body: operation.body,
        output: operation.output,
        dryRun: operation.dryRun,
        confirmFlags: [...operation.confirmFlags],
        reveal: operation.reveal,
        needsSecret: [...operation.needsSecret],
        effects: [...operation.effects],
        examples,
        notes,
      };
      return description;
    }
    case 'run_operation':
      return runVerb(agent.id, () => operateOnce(ctx, agent, args));
    case 'list_my_requests': {
      const a = parseArgs(verbArgs.list_my_requests, args);
      return { requests: await listRequestsForAgent(ctx, { ...(a.status ? { status: a.status } : {}), ...(a.limit ? { limit: a.limit } : {}) }) };
    }
    case 'cancel_request': {
      const a = parseArgs(verbArgs.cancel_request, args);
      // By the request's own id or by the request id the agent chose.
      const view = await requestForAgent(ctx, a.requestId);
      if (!view) throw new ServiceError('NOT_FOUND', 'There is no request of this agent with that id. list_my_requests shows them.');
      return { request: await cancelAgentRequest(ctx, view.id) };
    }
    case 'get_my_permissions': {
      parseArgs(verbArgs.get_my_permissions, args);
      const door = await openDoor(ctx, agent);
      const p = door.policy;
      const answer: MyPermissions = {
        agent: { id: agent.id, name: agent.name },
        roles: [...door.ceiling.roleNames],
        preset: p.preset,
        classes: p.classes,
        areas: p.areas,
        bulkCap: p.bulkCap,
        twoPersonOver: p.twoPersonOver,
        requestExpiryDays: p.requestExpiryDays,
        // Only the folders it may really use now (usableFolders), as with the grants below.
        folders: await doorFolders(door),
        paused: isPaused(p.pausedAt),
        // Only the standing permission that would really let something run, with its real limits.
        grants: await grantsInEffect(ctx, door),
        someoneSignedIn: await someoneSignedIn(ctx),
      };
      return answer;
    }
    case 'ask_for_permission':
      return askForPermission(ctx, agent, parseArgs(verbArgs.ask_for_permission, args));
    case 'upload_file': {
      const a = parseArgs(verbArgs.upload_file, args);
      return uploadChunk(owner, { ...(a.uploadId ? { uploadId: a.uploadId } : {}), name: a.name, type: a.type, chunkBase64: a.chunkBase64, last: a.last });
    }
    case 'get_file': {
      const a = parseArgs(verbArgs.get_file, args);
      if (await revealFileEnded(ctx, agent.id, a.fileId)) throw new ServiceError('NOT_FOUND', REVEAL_FILE_ENDED);
      const info = await stagedFileInfo(owner, a.fileId);
      if (!info) throw new ServiceError('NOT_FOUND', FILE_GONE);
      if (info.size > UPLOAD_MAX_BYTES) {
        throw validation('This file is larger than 50 MB, too large to send here. Save it to a folder with save_file instead.');
      }
      const staged = await readStagedFile(owner, a.fileId);
      if (!staged) throw new ServiceError('NOT_FOUND', FILE_GONE);
      return { file: staged.file, base64: Buffer.from(staged.bytes).toString('base64') };
    }
    case 'save_file': {
      const a = parseArgs(verbArgs.save_file, args);
      return runVerb(agent.id, () =>
        operateOnce(ctx, agent, {
          operation: SAVE_FILE_OPERATION,
          body: { fileId: a.fileId, folder: a.folder, ...(a.name ? { name: a.name } : {}) },
          requestId: a.requestId,
          ...(a.reason !== undefined ? { reason: a.reason } : {}),
        }),
      );
    }
    default:
      throw unknownVerb(verb);
  }
};
