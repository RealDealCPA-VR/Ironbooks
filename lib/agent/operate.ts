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
 *  4. A read runs at once, on the read-only path, with the agent's own access.
 *  5. A dry run really runs and is rolled back. The answer says whether the real thing would run or
 *     would ask a person.
 *  6. Anything else needs a request id. Asking again with it gives the first answer, never a second
 *     change (table agent_requests, as lib/agent/actions.ts does for the curated actions).
 *  7. Before a change runs, or is put to a person, it is tried in a rolled-back run where the
 *     operation allows, and the policy decides AGAIN with what that run showed: the true amount
 *     and count. That second answer is the one followed, so two-person approval, the bulk cap and
 *     a grant's limits apply to the real figures, not to what the body claimed.
 *  8. What the policy says to ask about becomes a permission request: the agent's reason (its own
 *     words, required), a summary built from the operation (never from the agent's text) and the
 *     preview. Nothing more happens until a person approves it in their own window; that run is
 *     `runApproved`.
 *
 * Who a run is for:
 *  - What an agent runs on its own (Allow, or under a grant) runs with its role's access, masked:
 *    no full SSNs or account numbers and no closed-period right (those always ask a person). No
 *    person, no secrets, no reveal.
 *  - An approved request runs with the approver's access INTERSECTED with the agent's role, so
 *    approving never widens either side, as the approver, with the secrets they typed on the card.
 *    Desktop and file actions (saving a staged file included) go to lib/agent/shell.ts, the one
 *    place that carries them out.
 *
 * Nothing here changes agents, policies, grants or approvals: those operations are on the hard
 * floor of the registry, and `decide` refuses them before anything else is looked at.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { agentPermissionRequests, agentRequests, agents, companies } from '@/lib/db/schema';
import { ACTIVITIES, VIEW_BALANCE, activitiesOf, supportedActions, type ActivityDef } from '@/lib/permissions/activities';
import {
  ACTIONS,
  AREA_KEYS,
  FLAGS,
  canActivity,
  emptyActivitySet,
  emptyPermissionSet,
  type ActivityKey,
  type Area,
  type EffectiveAccess,
  type Flag,
} from '@/lib/permissions/model';
import { maskedForAgent } from '@/lib/permissions/agentAccess';
import { type ServiceContext, type ServiceErrorCode, ServiceError, validation } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { agentCeiling, loadAgentPolicy } from '@/lib/services/agentPolicies';
import { liveGrants } from '@/lib/services/agentGrants';
import { cancelAgentRequest, createAgentRequest, listRequestsForAgent, requestForAgent } from '@/lib/services/agentRequests';
import { listActiveSessions } from '@/lib/services/sessions';
import { effects, runWithEffects } from '@/lib/effects';
import { REQUEST_ID_MESSAGE, agentInputHash } from '@/lib/agent/actions';
import { runOperation } from '@/lib/agent/bridge';
import { guardInput } from '@/lib/agent/guards';
import { factsOf } from '@/lib/agent/facts';
import { describeRequest } from '@/lib/agent/describe';
import { allowedFolder, readStagedFile, stagedFileInfo, uploadChunk } from '@/lib/agent/files';
import { AGENT_OUTBOX_NAME, defaultAgentFolders, runShellOperation } from '@/lib/agent/shell';
import { findOperations, operationById } from '@/lib/agent/operations/registry';
import { describeSchemas } from '@/lib/agent/operations/schemas';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { SHORT_GRANT_MINUTES, approvalNeeds, baseClass, decide, isPaused, roleProblem } from '@/lib/agent/policy';
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
 * The access an agent's own run (Allow, or a grant) has: its role's, masked (maskedForAgent). The
 * View flags are off, so answers stay masked, and so is the closed-period right: work on or before
 * the closing date always asks a person, so a run without one never needs it.
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
  return { agent, policy, ceiling, grants, closingDate, now: now.toISOString() };
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

/** Who an agent's own run is for (contract §4). Never a person, never a secret, never a reveal. */
function ownActor(door: Door, grantId: string | null): BridgeActor {
  return {
    agent: { id: door.agent.id, name: door.agent.name, preset: door.policy.preset, onBehalfOf: door.agent.onBehalfOf ?? null },
    access: ownRunAccess(door.ceiling.access),
    role: door.ceiling.role,
    userId: null,
    approval: { approvedBy: null, requestId: null, grantId },
    reveal: false,
    secrets: {},
    folders: [...(door.policy.folders ?? [])],
    atHost: false,
  };
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
 * The agent's own run was refused for want of a right (its access is masked: no View flags, no
 * closed-period right), not because of the agent or the company: the bridge marks those refusals
 * (removed, paused, blocked: details.agent; single-user mode: details.singleUserMode).
 */
function accessRefusal(r: BridgeResult): boolean {
  if (r.outcome !== 'error' || (r.error?.code !== 'FORBIDDEN' && r.httpStatus !== 403)) return false;
  const given = r.error?.details;
  const d: Record<string, unknown> = plainObject(given) ? given : {};
  return d.agent !== true && d.singleUserMode !== true;
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

function hasLedger(preview: OperationPreview | null | undefined): boolean {
  return (preview?.ledger?.entries?.length ?? 0) > 0;
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

function askedAnswer(operation: string, view: AgentRequestView, replayed: boolean): AgentOperationAnswer {
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
    note: `${waiting} Use wait_for_decision or list_my_requests to see what they decide.`,
  };
}

/** What became of a permission request, as the answer to asking again with its request id. */
function presentState(operation: string, view: AgentRequestView, replayed = true): AgentOperationAnswer {
  const base = { operation, summary: view.summary, requestId: view.id, status: view.status, ...(replayed ? { replayed: true } : {}) };
  // A grant request is done once it is approved: the standing permission exists from then on.
  if (view.kind === 'grant' && (view.status === 'approved' || view.status === 'executed')) {
    return { ...base, outcome: 'done', ...(view.grantId ? { grantId: view.grantId } : {}), note: 'A person gave the standing permission you asked for. See it with get_my_permissions.' };
  }
  switch (view.status) {
    case 'pending':
    case 'approved':
      return askedAnswer(operation, view, replayed);
    case 'executed': {
      // A read (a reveal, mostly) answers as a read. The request's class cannot tell: a reveal on a
      // write is judged as read_sensitive. Posted or done is told from the preview the request
      // holds, the last one a person saw: the stored request does not say what the run itself posted.
      const op = operationById(view.operation);
      const read = op ? READ_CLASSES.includes(baseClass(op)) : false;
      return {
        ...base,
        outcome: read ? 'read' : hasLedger(view.preview) ? 'posted' : 'done',
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
const MAYBE_PART_DONE =
  'Part of it may already have been done, because this kind of request is not undone when it fails. Check before you send it again with a new request_id.';
/** A first try older than this that never recorded its end is not "still running" any more. */
const CLAIM_STALE_MS = 5 * 60 * 1000;

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId.trim())) throw validation(REQUEST_ID_MESSAGE);
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
const RATE_WINDOW_MS = 60_000;

// Process-wide, like the open databases (Next.js may load a module once per route bundle).
const rateHolder = globalThis as typeof globalThis & { __bkaAgentDoorRate?: Map<string, number[]> };
const rateState = (rateHolder.__bkaAgentDoorRate ??= new Map<string, number[]>());

/** Null when the agent may go on; otherwise the plain message why not. Counts the call when allowed. */
function rateLimited(agentId: string, now = Date.now()): string | null {
  const recent = (rateState.get(agentId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= AGENT_CALLS_PER_MINUTE) {
    rateState.set(agentId, recent);
    const wait = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000));
    return `This agent has sent more than ${AGENT_CALLS_PER_MINUTE} requests in the last minute, which slows Ironbooks down for everyone. Wait about ${wait} seconds, then carry on.`;
  }
  recent.push(now);
  rateState.set(agentId, recent);
  return null;
}

/** Forget every agent's recent calls (tests). */
export function resetAgentRateLimits(): void {
  rateState.clear();
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
function saveFolders(door: Door): { all: string[]; added: string[] } {
  const added = [...(door.policy.folders ?? [])];
  return { all: [...defaultAgentFolders(), ...added], added };
}

function folderNotAllowed(added: readonly string[]): string {
  const theirs = added.length ? `, or a folder the Admin added for this agent (${added.join('; ')})` : ', or a folder an Admin adds for this agent in Users & Roles > Agents';
  return `That folder is not one this agent may save to, or it does not exist. Use the company file's folder, Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}${theirs}.`;
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
  const staged = await readStagedFile({ companyId: ctx.companyId, agentId: door.agent.id }, text(b.fileId));
  if (!staged) throw new ServiceError('NOT_FOUND', FILE_GONE);
  const folders = saveFolders(door);
  const dir = await allowedFolder(folders.all, text(b.folder));
  if (!dir) return { refused: folderNotAllowed(folders.added) };
  const name = text(b.name) || staged.file.name;
  // The name is checked first (writeFile refuses separators and the like), so looking for the
  // file never reaches outside the allowed folder.
  const run = await runWithEffects('capture', () => effects.writeFile({ dir, name, bytes: staged.bytes }));
  const there = await fsp.lstat(path.join(dir, name)).then(
    () => true,
    () => false,
  );
  if (there || run.value.replaces) return { refused: alreadyThere(name) };
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
  };
}

/** Policy, grants, bridge and requests in one place: the only way an agent's operation runs. */
export const operate: Operate = async (ctx, req) => {
  const agent = requireAgent(ctx);
  const limited = rateLimited(agent.id);
  if (limited) return refused(typeof req?.operation === 'string' ? req.operation : '', limited);
  return operateOnce(ctx, agent, req);
};

async function operateOnce(ctx: ServiceContext, agent: AgentOfContext, raw: RunOperationRequest | unknown): Promise<AgentOperationAnswer> {
  const req = parseArgs(runOperationArgs, raw);
  const operation = operationById(req.operation);
  if (!operation) return refused(req.operation, unknownOperationNote(req.operation));

  const guarded = guardInput(operation, inputOf(req));
  if (guarded.refused) return refused(operation.id, guarded.refused);
  const input = guarded.input;

  const door = await openDoor(ctx, agent);
  const facts = factsOf(operation, input, { closingDate: door.closingDate });
  const decision = decideFor(door, operation, facts);
  if (decision.outcome === 'refuse') return withStripped(refused(operation.id, decision.message), guarded.stripped);

  let answer: AgentOperationAnswer;
  if (decision.outcome === 'run' && decision.effectiveClass === 'read') {
    answer = await readNow(ctx, door, operation, input);
  } else if (req.dryRun === true) {
    answer = await tryOnly(ctx, door, operation, input, facts, decision);
  } else {
    answer = await change(ctx, door, operation, input, facts, decision, req);
  }
  return withStripped(answer, guarded.stripped);
}

async function readNow(ctx: ServiceContext, door: Door, operation: Operation, input: OperationInput): Promise<AgentOperationAnswer> {
  const r = await runOperation(ctx, operation, input, 'read', ownActor(door, null));
  if (r.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, r, describeRequest(operation, input, r.result));
  if (r.outcome === 'error') throw appError(r);
  return { operation: operation.id, outcome: 'read', result: r.result, ...(r.file ? { file: r.file } : {}) };
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
  const summary = describeRequest(operation, input);
  if (!bridgePreviewable(operation, decision)) {
    let preview: OperationPreview | null = null;
    if (operation.id === SAVE_FILE_OPERATION) {
      const p = await savePreview(ctx, door, input);
      if ('refused' in p) return refused(operation.id, p.refused, { summary });
      preview = p.preview;
    }
    return {
      operation: operation.id,
      outcome: 'dry_run',
      summary,
      ...(preview ? { preview } : {}),
      note: `${preview ? NOTHING_KEPT : NOT_TRIED} ${wouldNote(decision)}`,
    };
  }
  const dry = await runOperation(ctx, operation, input, 'dry_run', ownActor(door, null));
  if (dry.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, dry, summary);
  if (dry.outcome === 'error') {
    if (closingDateFailure(dry)) {
      const again = decideFor(door, operation, { ...facts, closedPeriod: true });
      return {
        operation: operation.id,
        outcome: 'dry_run',
        summary,
        note: `It could not be tried, because it is dated on or before the closing date. ${wouldNote(again)}`,
      };
    }
    if (decision.outcome === 'ask' && accessRefusal(dry)) {
      return {
        operation: operation.id,
        outcome: 'dry_run',
        summary,
        note: `It could not be tried with this agent's own rights (protected values and closed periods are off limits to agents). ${wouldNote(decision)}`,
      };
    }
    throw appError(dry);
  }
  const again = decideFor(door, operation, dry.facts ?? facts);
  return {
    operation: operation.id,
    outcome: 'dry_run',
    summary: describeRequest(operation, input, dry.result),
    result: dry.result,
    ...(dry.file ? { file: dry.file } : {}),
    ...(dry.preview ? { preview: dry.preview } : {}),
    ...(dry.preview?.ledger ? { ledger: dry.preview.ledger } : {}),
    ...(dry.warnings?.length ? { warnings: dry.warnings } : {}),
    note: `${NOTHING_KEPT} ${wouldNote(again)}`,
  };
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
  let decision = firstDecision;
  let preview: OperationPreview | null = null;
  let stalenessKey: string | null = null;
  let answerSoFar: unknown;

  if (dryRunFirst(operation, decision)) {
    const dry = await runOperation(ctx, operation, input, 'dry_run', ownActor(door, null));
    if (dry.outcome === 'needs_confirmation') return needsConfirmationAnswer(operation, dry, describeRequest(operation, input));
    if (dry.outcome === 'error') {
      if (closingDateFailure(dry)) {
        // Dated on or before the closing date where the body did not show it: closed-period work.
        facts = { ...facts, closedPeriod: true };
      } else if (!(firstDecision.outcome === 'ask' && accessRefusal(dry))) {
        throw appError(dry);
      }
      // Otherwise the agent's masked access could not even try it (a route that needs a View
      // flag, say). A person is being asked anyway, and their run has their own rights: ask
      // without a preview, as for the closing date.
    } else {
      facts = dry.facts ?? facts;
      preview = dry.preview;
      stalenessKey = dry.stalenessKey;
      answerSoFar = dry.result;
    }
    // The real figures decide, whichever way they point (plan §4.3; policy.ts needsTwoPerson).
    decision = decideFor(door, operation, facts);
  } else if (decision.outcome === 'ask' && operation.id === SAVE_FILE_OPERATION) {
    const p = await savePreview(ctx, door, input);
    if ('refused' in p) return refused(operation.id, p.refused);
    preview = p.preview;
  }

  const summary = describeRequest(operation, input, answerSoFar);
  if (decision.outcome === 'refuse') return refused(operation.id, decision.message, { summary });
  if (decision.outcome === 'ask') {
    const reason = (req.reason ?? '').trim();
    // Never put a request to a person without the agent saying why.
    if (!reason) return refused(operation.id, NO_REASON_NOTE, { summary, ...(preview ? { preview } : {}) });
    return askPerson(ctx, door, {
      kind: 'operation',
      requestKey,
      operation,
      input,
      reason,
      summary,
      effectiveClass: decision.effectiveClass,
      needs: decision.needs,
      facts,
      preview,
      stalenessKey,
      grantAsked: null,
      action: operation.id,
      hash,
    });
  }
  return commit(ctx, door, operation, input, decision.grantId, requestKey, hash);
}

async function commit(
  ctx: ServiceContext,
  door: Door,
  operation: Operation,
  input: OperationInput,
  grantId: string | null,
  requestKey: string,
  hash: string,
): Promise<AgentOperationAnswer> {
  const claimId = await claimRequestId(ctx, door.agent.id, requestKey, operation.id, hash);
  if (!claimId) {
    const again = await earlierAnswer(ctx, door.agent.id, requestKey, operation.id, hash, operation.id);
    if (again) return again;
    throw new ServiceError('CONFLICT', 'That request is already being carried out. Ask again in a moment with the same request_id.');
  }
  let r: BridgeResult;
  try {
    r = await runOperation(ctx, operation, input, 'commit', ownActor(door, grantId));
  } catch (err) {
    if (operation.dryRun !== 'none') {
      await releaseClaim(claimId);
      throw err;
    }
    const said = err instanceof ServiceError ? err : new ServiceError('INTERNAL', 'Something went wrong while doing this.');
    throw await keepFailure(claimId, said);
  }
  if (r.outcome === 'needs_confirmation') {
    // A warning the agent may accept comes before anything is done (plan §5.6): the same request
    // id may be sent again with the flag.
    await releaseClaim(claimId);
    return needsConfirmationAnswer(operation, r, describeRequest(operation, input, r.result));
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
    outcome: hasLedger(r.preview) ? 'posted' : 'done',
    summary: describeRequest(operation, input, r.result),
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
}

/** Put a request to a person. The request id is claimed first, so asking twice asks once. */
async function askPerson(ctx: ServiceContext, door: Door, ask: AskInput): Promise<AgentOperationAnswer> {
  const { action, hash, ...newRequest } = ask;
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
  return presentState(operationId, view, false);
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

/** The staleness key stored with the request when it was asked (the contract's request shape has none). */
async function storedStalenessKey(approver: ServiceContext, requestId: string, agentId: string): Promise<string | null> {
  if (!UUID_RE.test(requestId)) return null;
  const [row] = await approver.db
    .select({ stalenessKey: agentPermissionRequests.stalenessKey })
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.id, requestId),
        eq(agentPermissionRequests.companyId, approver.companyId),
        eq(agentPermissionRequests.agentId, agentId),
      ),
    );
  return row?.stalenessKey ?? null;
}

/** Run an approved request (called by approveAgentRequest), as the approver, within the agent's role. */
export const runApproved: RunApproved = async (approver, request, approve, opts) => {
  assertPerson(approver);
  const operation = operationById(request.operation);
  if (!operation) throw validation('This request names something Ironbooks can no longer do. Deny it and ask the agent to send it again.');
  if (operation.availability !== 'agent') {
    throw new ServiceError('FORBIDDEN', "Agents can never do this, even with a person's approval. A person can do it in Ironbooks.");
  }
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

  const actor: BridgeActor = {
    agent: { id: agent.id, name: agent.name, preset: policy.preset, onBehalfOf: approver.userId },
    access,
    role: lowerRole(approver.role, ceiling.role),
    userId: approver.userId,
    approval: { approvedBy: approver.userId, requestId: request.id, grantId: null },
    reveal: stored.reveal === true,
    secrets: { ...(approve?.secrets ?? {}) },
    folders: [...(policy.folders ?? [])],
    atHost: opts.atHost === true,
  };

  if (operation.kind === 'shell') return runShellApproved(approver, operation, request, guarded.input, approve?.answers ?? {}, actor);

  // An approved read (a reveal, mostly) reads: on the read-only path, never in a writable transaction.
  if (READ_CLASSES.includes(baseClass(operation))) return runOperation(approver, operation, guarded.input, 'read', actor);

  // The books may have changed since the agent asked (plan §7.4): show what would happen now.
  // Compared every time with the key stored on the request. When the person is shown the new
  // preview, the approval service stores its key in place of the old one, so their next yes
  // (sent with acceptStale) matches it; if the books changed yet again, they see that too. A yes
  // only ever covers a preview the person saw.
  const storedKey = operation.dryRun === 'none' ? null : await storedStalenessKey(approver, request.id, request.agentId);
  if (storedKey) {
    // Only to compare. Its preview may be stored on the request, where the agent reads it, so it
    // runs without the reveal and without the typed secrets: only the real run needs them.
    const dry = await runOperation(approver, operation, guarded.input, 'dry_run', { ...actor, reveal: false, secrets: {} });
    if (dry.stalenessKey !== storedKey) return dry;
  }
  return runOperation(approver, operation, guarded.input, 'commit', actor);
};

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

/** How the agent's policy treats an operation right now, judged on an empty request. */
function summaryFor(door: Door, operation: Operation): OperationSummary {
  const d = decideFor(door, operation, emptyFacts());
  const grant = d.outcome === 'run' && d.grantId ? door.grants.find((g) => g.id === d.grantId) : undefined;
  return {
    id: operation.id,
    describe: operation.describe,
    class: baseClass(operation),
    area: operation.area,
    method: operation.method,
    route: operation.route,
    treatment: d.outcome === 'refuse' ? 'refused' : d.outcome,
    why:
      d.outcome === 'refuse'
        ? d.message
        : d.outcome === 'ask'
          ? `Asks a person first. ${approvalWords(d.needs)}`
          : grant
            ? `Runs under standing permission a person gave, until ${grant.expiresAt}.`
            : null,
  };
}

function notesFor(operation: Operation): string[] {
  const notes: string[] = [];
  if (READ_CLASSES.includes(baseClass(operation))) notes.push('A read: it changes nothing.');
  else if (operation.dryRun === 'transaction') notes.push('Send it with dry_run: true first to see exactly what it would do; nothing is kept.');
  else if (operation.dryRun === 'preview') notes.push("A dry run uses the app's own preview of this request.");
  else notes.push('This cannot be tried without really doing it: a dry run only describes it.');
  if (operation.amountField) notes.push(`The amount is read from "${operation.amountField}", and from the answer of a dry run when that is larger.`);
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

/** The approval card's one line for a grant request: built from the operation and the limits, never from the agent's words. */
function grantSummary(operation: Operation, cls: RiskClass, c: GrantConstraints, minutes: number): string {
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

async function askForPermission(ctx: ServiceContext, agent: AgentOfContext, args: z.infer<typeof verbArgs.ask_for_permission>): Promise<AgentOperationAnswer> {
  const operation = operationById(args.operation);
  if (!operation) return refused(args.operation, unknownOperationNote(args.operation));
  const cls = baseClass(operation);
  const constraints: GrantConstraints = { ...(args.constraints ?? {}) };
  if (operation.kind === 'shell') {
    // A desktop or file action never runs on an agent's own say-so (decideFor), so standing
    // permission for one would do nothing: a person approves each.
    return refused(
      operation.id,
      'A person approves each desktop or file action on its own, so standing permission cannot be given for it. Send each with run_operation (or save_file) instead.',
    );
  }
  if (GRANTABLE[cls] === 'no' || operation.alwaysAsk || !operation.classified) {
    return refused(
      operation.id,
      `A person cannot give standing permission for this (${RISK_CLASS_LABELS[cls]}): each one is asked on its own. Send each with run_operation instead.`,
    );
  }
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
  const facts = grantFacts(constraints);
  const d = decideFor(door, operation, facts);
  if (d.outcome === 'refuse') return refused(operation.id, d.message);
  if (d.outcome === 'run') {
    return { operation: operation.id, outcome: 'done', note: 'Nothing to ask: this agent may already do this without asking a person.' };
  }
  if (d.needs.grantable === 'no') {
    return refused(operation.id, 'A person cannot give standing permission for requests like this: each one is asked on its own. Send each with run_operation instead.');
  }
  if (d.needs.twoPerson) {
    return refused(
      operation.id,
      `Standing permission only covers what one person may approve. Set constraints.max_amount at or below ${door.policy.twoPersonOver ?? 'the two-person limit'} and send it again.`,
    );
  }
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
    summary: grantSummary(operation, cls, constraints, minutes),
    effectiveClass: d.effectiveClass,
    needs: d.needs,
    facts,
    preview: null,
    stalenessKey: null,
    grantAsked: { constraints, minutes },
    action,
    hash,
  });
}

async function someoneSignedIn(ctx: ServiceContext): Promise<boolean> {
  try {
    return (await listActiveSessions(ctx.db, { companyId: ctx.companyId })).length > 0;
  } catch {
    return false;
  }
}

/** Verbs whose answer is an operation answer: a refusal is an answer there, not an error. */
const OPERATION_VERBS: readonly AgentVerb[] = ['run_operation', 'ask_for_permission', 'save_file'];

/** One verb of POST /api/agent/actions (`{ verb, ...args }`). Arguments are checked here. */
export const handleVerb: HandleVerb = async (ctx, verb, args) => {
  const agent = requireAgent(ctx);
  if (!isAgentVerb(verb)) throw unknownVerb(verb);
  const limited = rateLimited(agent.id);
  if (limited) {
    if (OPERATION_VERBS.includes(verb)) {
      const named = (args as { operation?: unknown } | null)?.operation;
      return refused(verb === 'save_file' ? SAVE_FILE_OPERATION : typeof named === 'string' ? named : '', limited);
    }
    throw new ServiceError('FORBIDDEN', limited, { rateLimited: true });
  }
  const owner: FileOwner = { companyId: ctx.companyId, agentId: agent.id };

  switch (verb) {
    case 'find_operations': {
      const a = parseArgs(verbArgs.find_operations, args);
      const limit = Math.min(a.limit ?? FIND_LIMIT, FIND_LIMIT);
      const found = findOperations({ query: a.query, area: a.area, class: a.class, limit: limit + 1 });
      const door = await openDoor(ctx, agent);
      return { operations: found.slice(0, limit).map((op) => summaryFor(door, op)), more: found.length > limit };
    }
    case 'describe_operation': {
      const a = parseArgs(verbArgs.describe_operation, args);
      const operation = operationById(a.operation);
      if (!operation) throw new ServiceError('NOT_FOUND', unknownOperationNote(a.operation));
      const door = await openDoor(ctx, agent);
      const notes = notesFor(operation);
      let schemas: { body: unknown; query: unknown } = { body: null, query: null };
      try {
        schemas = await describeSchemas(operation);
      } catch {
        notes.push('The list of fields could not be loaded just now. A dry run shows what the app expects.');
      }
      const description: OperationDescription = {
        ...summaryFor(door, operation),
        params: [...operation.params],
        bodySchema: schemas.body ?? null,
        querySchema: schemas.query ?? null,
        body: operation.body,
        output: operation.output,
        dryRun: operation.dryRun,
        confirmFlags: [...operation.confirmFlags],
        reveal: operation.reveal,
        needsSecret: [...operation.needsSecret],
        effects: [...operation.effects],
        notes,
      };
      return description;
    }
    case 'run_operation':
      return operateOnce(ctx, agent, args);
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
        folders: [...(p.folders ?? [])],
        paused: isPaused(p.pausedAt),
        grants: door.grants,
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
      return operateOnce(ctx, agent, {
        operation: SAVE_FILE_OPERATION,
        body: { fileId: a.fileId, folder: a.folder, ...(a.name ? { name: a.name } : {}) },
        requestId: a.requestId,
        ...(a.reason !== undefined ? { reason: a.reason } : {}),
      });
    }
    default:
      throw unknownVerb(verb);
  }
};
