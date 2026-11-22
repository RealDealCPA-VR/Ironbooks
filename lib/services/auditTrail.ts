/**
 * Audit Trail service — QuickBooks-style "Audit Trail" report.
 *
 * listAuditLogs: paginated, filterable list of audit_logs scoped to the company,
 *   with the acting user's name joined in. Newest-first.
 * getAuditLog: single record with oldValues/newValues for diff display.
 *
 * Both show only the entries the caller may view the record of (lib/services/auditVisibility.ts):
 * the snapshots hold pay rates, W-4s, home addresses and user accounts, and the Audit Trail right
 * alone (Reports — Financial) is held by roles with no payroll access. Hidden entries are left out
 * of the total as well; one asked for by id is "not found", like an entry of another company.
 *
 * An agent's change names the agent and how it was allowed (agent full access, plan §7.3), in the
 * same words as the transaction log (transactionLog.ts agentActorName): "<Agent> (agent)",
 * "<Agent> (agent), approved by <person>", or "<Agent> (agent), under permission from <person>
 * until <time>". Work two people approved (the two-person rule) names both, the first approval
 * first: "<Agent> (agent), approved by <A> and <B>" (read from the request the row ran under,
 * firstApproversOf). The ids behind those words come with each row too.
 *
 * An agent reading the audit trail never sees the entries of Users & Roles or File Utilities, nor
 * the whole log as an Admin would (auditReaderFor). The record of an agent's request or standing
 * permission shows the person's note, the app's message and the grant's limits only to someone
 * who may view the work it was about (auditEntryValuesFor), as the Agent Activity report does.
 *
 * A person's approval of an agent's reveal (plan 5.9, D6) is worded on its entry and in the Agent
 * Activity report: "Revealed <which kinds of values> of "<record or report>" to agent "<name>",
 * approved by <person>." (revealSummary; the words agentRequests.ts writes on the decision's record).
 *
 * The transaction log's records are read by the same rules (logRecordFor, logSummaryFor).
 *
 * agentActivityReport: the "Agent Activity" standard report (Reports > Accountant & Taxes): every
 * permission request an agent made, whatever became of it.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { agentPermissionRequests, agents, auditLogs, users } from '@/lib/db/schema';
import { maskAccountsInText } from '@/lib/agent/guards';
import { AGENT_DOOR_ONLY_AREAS, maskedForAgent } from '@/lib/permissions/agentAccess';
import { areaLabel, canRef, fullAccess, withoutAreas, type Area, type EffectiveAccess } from '@/lib/permissions/model';
import { RISK_CLASS_LABELS, isRiskClass, type RequestStatus } from '@/lib/agent/operations/types';
import { operationById } from '@/lib/agent/operations/registry';
import { localDateTime } from '@/lib/reports/dates';
import type { StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import { ServiceError, type ServiceContext, notFound } from './_base';
import { auditValuesFor, auditVisibilitySql, canSeeAuditEntry } from './auditVisibility';
import { getPreferences } from './company';
import { companyDayBound } from './preferences';
import {
  REMOVED_PERSON,
  agentActorName,
  agentLabel,
  standingPermissionWords,
  type StandingPermissionWords,
} from './transactionLog';

/** How the records name an agent that is no longer on file (removed, or a copy without agents). */
const REMOVED_AGENT = 'Removed agent';

/** What an audit row says about who made the change. */
interface ActorFacts {
  person: string | null;
  agentId: string | null;
  agentName: string | null;
  approvedById: string | null;
  approvedByName: string | null;
  agentGrantId: string | null;
  agentRequestId?: string | null;
}

/**
 * The first of two approvers of work that needed two people, by the request it ran under: the
 * request's decidedBy, when the row's approver is its secondApprover and someone else gave the first
 * yes (lib/services/agentRequests.ts approveRequest stores both). Only for the rows that need it.
 */
type FirstApprovers = Map<string, { secondId: string; firstName: string }>;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const firstApprover = alias(users, 'first_approver');

async function firstApproversOf(ctx: ServiceContext, rows: ActorFacts[]): Promise<FirstApprovers> {
  const ids = [
    ...new Set(
      rows
        .filter((r) => (r.agentId || r.agentName) && r.approvedById && typeof r.agentRequestId === 'string' && UUID_TEXT.test(r.agentRequestId))
        .map((r) => r.agentRequestId!.toLowerCase()),
    ),
  ];
  const out: FirstApprovers = new Map();
  if (!ids.length) return out;
  const found = await ctx.db
    .select({
      id: agentPermissionRequests.id,
      decidedBy: agentPermissionRequests.decidedBy,
      secondApprover: agentPermissionRequests.secondApprover,
      name: firstApprover.name,
      email: firstApprover.email,
    })
    .from(agentPermissionRequests)
    .leftJoin(firstApprover, eq(agentPermissionRequests.decidedBy, firstApprover.id))
    .where(and(eq(agentPermissionRequests.companyId, ctx.companyId), inArray(agentPermissionRequests.id, ids)));
  for (const f of found) {
    if (!f.decidedBy || !f.secondApprover || f.decidedBy === f.secondApprover) continue;
    out.set(String(f.id).toLowerCase(), { secondId: f.secondApprover, firstName: f.name || f.email || REMOVED_PERSON });
  }
  return out;
}

/** "A and B" for a row two people approved, else the row's own approver. */
function approverWords(r: ActorFacts, firsts: FirstApprovers): string {
  const second = r.approvedByName || REMOVED_PERSON;
  const first = r.agentRequestId ? firsts.get(r.agentRequestId.toLowerCase()) : undefined;
  return first && first.secondId === r.approvedById ? `${first.firstName} and ${second}` : second;
}

/** How the Audit Trail names who made a change (the transaction log uses the same words). */
function actorLabel(r: ActorFacts, grants: Map<string, StandingPermissionWords>, firsts: FirstApprovers = new Map()): string | null {
  if (!r.agentId && !r.agentName) return r.person ?? null;
  const actor = agentLabel(r.agentName ?? REMOVED_AGENT);
  if (r.approvedById) return agentActorName(actor, { approvedBy: approverWords(r, firsts) });
  if (r.agentGrantId) return agentActorName(actor, { grant: grants.get(r.agentGrantId) ?? { givenBy: null, until: null } });
  // An agent's proposal approved before agent full access ran in the approver's own context: the
  // person in user_id is the one who approved it.
  return agentActorName(actor, { approvedBy: r.person });
}

/** The standing permissions the rows ran under, worded, for the rows that need them. */
function grantsOf(ctx: ServiceContext, rows: ActorFacts[]): Promise<Map<string, StandingPermissionWords>> {
  const ids = rows.filter((r) => (r.agentId || r.agentName) && !r.approvedById && r.agentGrantId).map((r) => r.agentGrantId!);
  return standingPermissionWords(ctx.db, ctx.companyId, ids);
}

export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string | null;
  actorId: string | null;
  createdAt: string;
  /** undefined when fetched via listAuditLogs (trimmed for list performance). */
  oldValues?: unknown;
  newValues?: unknown;
  llmReasoning?: string | null;
  /** The agent that made the change (audit_logs.agent_id); null for a person's or the system's. */
  agentId: string | null;
  agentName: string | null;
  /** The person who approved this very change (audit_logs.approved_by), and their name. */
  approvedById: string | null;
  approvedByName: string | null;
  /**
   * The agent's permission request the change ran under (agent_permission_requests.id). On a
   * person's decision about a request (entity agent_permission_request), the request decided.
   */
  agentRequestId: string | null;
  /** The standing permission the change ran under, or that a person's decision gave (agent_grants.id). */
  agentGrantId: string | null;
  /**
   * The entry in words, where its record carries words of its own: a person's approval of an
   * agent's reveal reads "Revealed full SSNs and tax IDs of "Show employee …" to agent "…", approved
   * by …." (revealSummary). Left out of every other entry.
   */
  summary?: string;
}

export interface ListAuditLogsOptions {
  entityType?: string;
  action?: string;
  /** Only the changes one agent made. */
  agentId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

const approver = alias(users, 'approver');

/** The columns both readers select (the actor and how an agent's change was allowed). */
const actorColumns = {
  actorId: auditLogs.userId,
  actorName: users.name,
  agentId: auditLogs.agentId,
  agentName: agents.name,
  approvedById: auditLogs.approvedBy,
  approverName: approver.name,
  approverEmail: approver.email,
  agentRequestId: auditLogs.agentRequestId,
  agentGrantId: auditLogs.agentGrantId,
};

type ActorRow = {
  actorId: string | null;
  actorName: string | null;
  agentId: string | null;
  agentName: string | null;
  approvedById: string | null;
  approverName: string | null;
  approverEmail: string | null;
  agentRequestId: string | null;
  agentGrantId: string | null;
};

function factsOf(r: ActorRow): ActorFacts {
  return {
    person: r.actorName,
    agentId: r.agentId,
    agentName: r.agentName,
    approvedById: r.approvedById,
    approvedByName: r.approverName || r.approverEmail || null,
    agentGrantId: r.agentGrantId,
    agentRequestId: r.agentRequestId,
  };
}

/** The actor fields of an AuditLogRow. */
function actorFields(r: ActorRow, grants: Map<string, StandingPermissionWords>, firsts: FirstApprovers = new Map()) {
  const facts = factsOf(r);
  return {
    actorId: r.actorId ?? null,
    actorName: actorLabel(facts, grants, firsts),
    agentId: r.agentId ?? null,
    agentName: r.agentId || r.agentName ? (r.agentName ?? REMOVED_AGENT) : null,
    approvedById: r.approvedById ?? null,
    approvedByName: r.approvedById ? (facts.approvedByName ?? REMOVED_PERSON) : null,
    agentRequestId: r.agentRequestId ?? null,
    agentGrantId: r.agentGrantId ?? null,
  };
}

/**
 * The access the audit records are read with: a person's (or a trusted context's) own. An agent's
 * leaves out Users & Roles and File Utilities and is never an Admin's, however it runs (its own
 * request, or through the door, whose run keeps the areas of its role). Entries of those areas
 * name who may sign in, the agents, their requests and the approvers' notes to them, backups and
 * file names: reads of those areas are class 'admin' and 'file' (plan 4.2), which a plain read of
 * the audit trail must not get round, and an agent never reads other agents' requests (the Agent
 * Activity report refuses it too). An Admin's access would see the whole log. An agent's context
 * always carries its access; one built without (a test's) gets full access less those areas,
 * masked: never wider than it was.
 */
export function auditReaderFor(ctx: Pick<ServiceContext, 'access' | 'agent'>): EffectiveAccess | undefined {
  if (!ctx.agent) return ctx.access;
  const base = ctx.access ?? maskedForAgent(fullAccess());
  return { ...withoutAreas(base, AGENT_DOOR_ONLY_AREAS), isAdmin: false };
}

/** Records of an agent's request (agentRequests.ts) and of standing permission (agentGrants.ts). */
const AGENT_REQUEST_KINDS = new Set(['agent_permission_request', 'agent_grant']);

/**
 * What those records hold about the work itself, beyond the operation and the agent: the person's
 * note (a denial's reason), the app's message (it names the records the run touched), why standing
 * permission was not given, a grant's limits (which customers or accounts, how much), and an
 * approved reveal's words (they name the record or report revealed; revealedFields, the kinds of
 * values, stays: see revealSummary).
 */
const REQUEST_DETAIL_FIELDS = ['note', 'error', 'grantNotGiven', 'constraints', 'revealed'] as const;

/**
 * An approved reveal in words (plan 5.9, D6), from its decision's record (agentRequests.ts
 * revealAudit writes `revealed`, "Revealed <which kinds of values> of "<record or report>" to agent
 * "<name>", approved by <person>.", and `revealedFields`, the kinds alone). The sentence names the
 * record, so it is shown only to a reader who may view the operation's work (requestDetails); any
 * other reader is told the kinds of values and who may see the rest. Null for any other record.
 */
function revealSummary(
  access: EffectiveAccess | null | undefined,
  values: { revealed: unknown; revealedFields: unknown; operation: unknown },
): string | null {
  if (typeof values.revealed !== 'string' || !values.revealed.trim()) return null;
  const { visible, area } = requestDetails(access ?? undefined, typeof values.operation === 'string' ? values.operation : '');
  if (visible) return values.revealed;
  const kinds = typeof values.revealedFields === 'string' && values.revealedFields.trim() ? values.revealedFields.trim() : 'protected values';
  return `Revealed ${kinds} to an agent. ${hiddenDetails(area)}`;
}

/** revealSummary of a decision's record, from its after-values (null for other records). */
function revealSummaryOf(access: EffectiveAccess | null | undefined, entityType: string, newValues: unknown): string | null {
  if (entityType !== 'agent_permission_request' || !isPlainRecord(newValues)) return null;
  return revealSummary(access, { revealed: newValues.revealed, revealedFields: newValues.revealedFields, operation: newValues.operation });
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The operation a request's or grant's record is about (both snapshots name it; '' when neither does). */
function operationIn(...values: unknown[]): string {
  for (const v of values) if (isPlainRecord(v) && typeof v.operation === 'string' && v.operation) return v.operation;
  return '';
}

function withDetailsHidden(v: unknown, words: string): unknown {
  if (!isPlainRecord(v)) return v;
  const out = { ...v };
  for (const k of REQUEST_DETAIL_FIELDS) if (out[k] !== undefined && out[k] !== null) out[k] = words;
  return out;
}

/**
 * An entry's before / after as `access` may read them: auditValuesFor (no credential material;
 * SSNs, account numbers and "Acct #" memo text masked for the reader's flags), and on the record of
 * an agent's request or standing permission, the details (REQUEST_DETAIL_FIELDS) replaced by
 * "Details hidden ..." unless the reader may view the activity of the operation it was about: the
 * Agent Activity report's rule (requestDetails). Managing agents (Users & Roles > Users) shows that
 * a request was made and decided, not a payroll request's note to someone without payroll.
 */
export function auditEntryValuesFor(
  access: EffectiveAccess | null | undefined,
  entityType: string,
  oldValues: unknown,
  newValues: unknown,
): { oldValues: unknown; newValues: unknown } {
  const [old, next] = requestDetailsFor(access, entityType, [auditValuesFor(access, oldValues), auditValuesFor(access, newValues)]);
  return { oldValues: old, newValues: next };
}

/** Snapshots already masked, with a request's or grant's details hidden from this reader when they must be. */
function requestDetailsFor(access: EffectiveAccess | null | undefined, entityType: string, snapshots: unknown[]): unknown[] {
  if (!AGENT_REQUEST_KINDS.has(entityType)) return snapshots;
  const { visible, area } = requestDetails(access ?? undefined, operationIn(...[...snapshots].reverse()));
  if (visible) return snapshots;
  const words = hiddenDetails(area);
  return snapshots.map((s) => withDetailsHidden(s, words));
}

/**
 * A transaction-log record's data ({ old, new, llmReasoning? }) as `access` may read it: the same
 * rule as an audit-trail entry (auditEntryValuesFor). For the log's own answer: pass the access of
 * auditReaderFor, so an agent's read leaves out the same entries and values as here.
 */
export function logRecordDataFor(access: EffectiveAccess | null | undefined, record: { entityType: string; data: unknown }): unknown {
  const masked = auditValuesFor(access, record.data);
  if (!isPlainRecord(masked) || !AGENT_REQUEST_KINDS.has(record.entityType)) return masked;
  const [old, next] = requestDetailsFor(access, record.entityType, [masked.old ?? null, masked.new ?? null]);
  return { ...masked, ...('old' in masked ? { old } : {}), ...('new' in masked ? { new: next } : {}) };
}

/**
 * A transaction-log record's one-line summary as `access` may read it. Most summaries are written
 * from the record's own values (transactionLog.ts describeChange: a number, a name or description,
 * an amount); a caller of logTransaction may also write its own words, memo text included ("Paid
 * the county, Acct # …"). Without "view full account numbers" an account number after its label
 * reads masked, as a memo does (maskAccountsInText). The CSV export writes this, and the log's
 * search matches this (TransactionLogFilter.shownSummary), never the stored text, so the search
 * cannot answer guesses at digits the summary hides.
 *
 * What this does not do: the app protects memos (auditValuesFor masks memo fields), not names or
 * descriptions. A number someone typed into a description reads masked in the summary but still
 * reads as typed in the record's data (data.new.description), as it does on every screen that
 * shows the description; the mask here keeps the summary in step with memos, it does not make a
 * description a protected value.
 */
export function logSummaryFor(access: EffectiveAccess | null | undefined, summary: string): string {
  if (!access || access.flags.fullAccountNumbers) return summary;
  return maskAccountsInText(summary);
}

/**
 * A transaction-log record as `access` may read it: its data through logRecordDataFor and its
 * summary through logSummaryFor. For GET /api/transaction-log, with the access of auditReaderFor.
 */
export function logRecordFor<R extends { entityType: string; summary: string; data: unknown }>(
  access: EffectiveAccess | null | undefined,
  record: R,
): R {
  return { ...record, summary: logSummaryFor(access, record.summary), data: logRecordDataFor(access, record) };
}

/** Return paginated audit log rows for the company, newest first. */
export async function listAuditLogs(
  ctx: ServiceContext,
  opts: ListAuditLogsOptions = {},
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const { entityType, action, agentId, from, to, limit = 50, offset = 0 } = opts;

  const conds = [eq(auditLogs.companyId, ctx.companyId)];
  if (entityType) conds.push(eq(auditLogs.entityType, entityType));
  if (action) conds.push(eq(auditLogs.action, action as never));
  if (agentId) conds.push(eq(auditLogs.agentId, agentId));
  if (from) conds.push(gte(auditLogs.createdAt, from));
  if (to) conds.push(lte(auditLogs.createdAt, to));
  const visible = auditVisibilitySql(auditReaderFor(ctx));
  if (visible) conds.push(visible);

  const where = and(...conds);
  // Only a decision about an agent's request carries a reveal's words (revealSummary).
  const decision = sql`${auditLogs.entityType} = 'agent_permission_request'`;
  const decisionValue = (key: string) => sql<string | null>`CASE WHEN ${decision} THEN ${auditLogs.newValues} ->> ${key} END`;

  // Count query for pagination metadata.
  const [countRow] = await ctx.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(auditLogs)
    .where(where);
  const total = Number(countRow?.count ?? 0);

  const rows = await ctx.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      ...actorColumns,
      createdAt: auditLogs.createdAt,
      revealed: decisionValue('revealed'),
      revealedFields: decisionValue('revealedFields'),
      revealOperation: decisionValue('operation'),
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(agents, and(eq(auditLogs.agentId, agents.id), eq(agents.companyId, ctx.companyId)))
    .leftJoin(approver, eq(auditLogs.approvedBy, approver.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(limit)
    .offset(offset);

  const grants = await grantsOf(ctx, rows.map(factsOf));
  const firsts = await firstApproversOf(ctx, rows.map(factsOf));
  const reader = auditReaderFor(ctx);
  return {
    rows: rows.map((r) => {
      const summary = revealSummary(reader, { revealed: r.revealed, revealedFields: r.revealedFields, operation: r.revealOperation });
      return {
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        ...actorFields(r, grants, firsts),
        createdAt: r.createdAt.toISOString(),
        // Only on the entries that have words of their own, so every other row keeps its shape.
        ...(summary ? { summary } : {}),
      };
    }),
    total,
  };
}

/** Return a single audit log entry (including oldValues / newValues). */
export async function getAuditLog(ctx: ServiceContext, id: string): Promise<AuditLogRow> {
  const [row] = await ctx.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      ...actorColumns,
      createdAt: auditLogs.createdAt,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
      llmReasoning: auditLogs.llmReasoning,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(agents, and(eq(auditLogs.agentId, agents.id), eq(agents.companyId, ctx.companyId)))
    .leftJoin(approver, eq(auditLogs.approvedBy, approver.id))
    .where(and(eq(auditLogs.id, id), eq(auditLogs.companyId, ctx.companyId)));

  if (!row) throw notFound('Audit log entry');
  // An entry about a record the caller may not view is answered like one that does not exist.
  const reader = auditReaderFor(ctx);
  if (!canSeeAuditEntry(reader, row.entityType, row.oldValues, row.newValues)) throw notFound('Audit log entry');

  const grants = await grantsOf(ctx, [factsOf(row)]);
  const firsts = await firstApproversOf(ctx, [factsOf(row)]);
  // Snapshots can hold SSNs, tax IDs and account numbers, also as memo text ("Acct # …" on a
  // check): masked per the caller's flags. Never the password hashes older builds wrote into
  // settings snapshots, whoever asks (auditValuesFor, lib/services/auditVisibility.ts). A request's
  // note and message only for someone who may view its work (auditEntryValuesFor).
  const values = auditEntryValuesFor(reader, row.entityType, row.oldValues, row.newValues);
  const summary = revealSummaryOf(reader, row.entityType, row.newValues);
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    ...actorFields(row, grants, firsts),
    createdAt: row.createdAt.toISOString(),
    oldValues: values.oldValues,
    newValues: values.newValues,
    llmReasoning: row.llmReasoning ?? null,
    ...(summary ? { summary } : {}),
  };
}

// ===========================================================================
// Agent Activity (Reports > Accountant & Taxes), plan §7.3
// ===========================================================================

/** Most requests the report lists, newest first; past it the report says so. */
export const AGENT_ACTIVITY_LIMIT = 5000;

/**
 * A request's status in plain words. 'approved' and a first-of-two approval read as the approval
 * center says them (app/agent-requests/words.ts statusLabel). 'approved' only ever means the work
 * is being carried out right now: agentRequests.ts claims the request on a person's yes, then marks
 * it done or failed. The first of two approvals (D8) leaves the request 'pending' with that person
 * in decided_by (WAITING_FOR_SECOND_PERSON).
 * 'cancelled' stays "Cancelled", not the center's "Taken back by the agent": a copy of the company
 * cancels the waiting requests too (portableFile.ts), so the agent may not be the one who did.
 */
export const REQUEST_STATUS_WORDS: Record<RequestStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved, being carried out',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
  executed: 'Done',
};

/** A waiting request the first of two people approved (D8): it waits for the second. */
export const WAITING_FOR_SECOND_PERSON = 'Waiting for a second person';

/**
 * How "Decided by" marks the person who gave the first of two approvals of a request no second
 * person approved: still waiting, expired or withdrawn.
 */
export const FIRST_OF_TWO = '(first of two)';

/**
 * The words of the status a person sees: `shown` is the approval center's own reading of the row
 * (agentRequests.ts shownStatus: a waiting request past its time is expired whether or not anything
 * has marked it yet), so the two agree on where a request stands. Their words differ on purpose
 * for some states (the center says "Waiting", "Did not go through"; a report says "Waiting for
 * approval", "Failed"). One the first of two people approved is still waiting, for a second person.
 */
export function requestStatusWords(shown: RequestStatus, decidedBy: string | null): string {
  if (shown === 'pending' && decidedBy) return WAITING_FOR_SECOND_PERSON;
  return REQUEST_STATUS_WORDS[shown] ?? shown;
}

/** The stored statuses in which a lone person in decided_by can only be the first of two (decidedByWords). */
const FIRST_OF_TWO_STATUSES: ReadonlySet<string> = new Set(['pending', 'expired', 'cancelled']);

/**
 * "Decided by": who said yes or no; once the second person said yes too, both, in order. A person
 * in decided_by with nobody after them, on a request stored as waiting, expired or withdrawn, gave
 * the first of two approvals (D8) and is marked "(first of two)". Nothing else leaves a lone name
 * in those states: one yes moves a request to 'approved' (then done or failed), a no overwrites
 * decided_by, and the sweep that marks a request expired (agentRequests.ts settleRow), the agent
 * taking it back (cancelAgentRequest) and a copy of the company (portableFile.ts) keep decided_by.
 * So the mark stays once the request is settled, not only until the next sweep. Except on a
 * request copied from an older proposal (proposal_id): it never takes two approvals, and a
 * proposal already decided under Ask AI brings its own decider along with its outcome (settleRow).
 */
function decidedByWords(r: { status: string; first: string | null; second: string | null; copied: boolean }): string {
  if (r.first && !r.second && !r.copied && FIRST_OF_TWO_STATUSES.has(r.status)) return `${r.first} ${FIRST_OF_TWO}`;
  return [r.first, r.second].filter(Boolean).join(', then ');
}

export const AGENT_ACTIVITY_FOR_PEOPLE_ONLY =
  'The Agent Activity report is for people only. An agent can see its own requests with list_my_requests.';

/**
 * May this person see what a request was about? Its summary, the person's note and the app's
 * message name the records it touches (a paycheck's employee and pay), so they need the view right
 * of the operation's own activity, as the audit trail's entries do. Admins and trusted contexts
 * (no `access`) see everything. A request whose operation is not in the registry (one copied from
 * an older proposal) or belongs to no area is shown in full to an Admin only: fail closed. The row
 * itself is always listed, so the report still counts every request.
 */
function requestDetails(access: EffectiveAccess | undefined, operationId: string): { visible: boolean; area: Area | null } {
  if (!access || access.isAdmin) return { visible: true, area: null };
  let area: Area | null = null;
  let ref: Parameters<typeof canRef>[1] | null = null;
  try {
    const op = operationById(operationId);
    area = op?.area ?? null;
    ref = op?.activity ?? op?.area ?? null;
  } catch {
    ref = null; // a registry that cannot be read shows nothing
  }
  if (!ref) return { visible: false, area: null };
  return { visible: canRef(access, ref, 'view'), area };
}

function hiddenDetails(area: Area | null): string {
  return area
    ? `Details hidden. An Admin, or someone who may view ${areaLabel(area)}, can see them.`
    : 'Details hidden. An Admin can see them.';
}

/**
 * Agent Activity: every permission request an agent made in this company, whatever its status
 * (waiting, approved, denied, expired, failed, cancelled, done), newest first: when it asked, the
 * agent, what it asked for (the summary built from the operation, never the agent's own words),
 * its risk class, its status, who decided and the person's note. The dates choose when the agent
 * asked, on the company's clock. A person's report: an agent is refused (it reads its own requests
 * through list_my_requests, and never another agent's or the approvers' notes to them).
 */
export async function agentActivityReport(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  if (ctx.agent) throw new ServiceError('FORBIDDEN', AGENT_ACTIVITY_FOR_PEOPLE_ONLY);
  // Loaded when the report runs: the approval center's module brings the agent's door and the
  // route bridge with it, which the audit trail's own screens never need.
  const { shownStatus } = await import('./agentRequests');
  const { timezone } = await getPreferences(ctx);
  const from = await companyDayBound(ctx, p.from, 'from');
  const to = await companyDayBound(ctx, p.to, 'to', true);
  const decider = alias(users, 'decider');
  const second = alias(users, 'second_approver');
  const conds = [eq(agentPermissionRequests.companyId, ctx.companyId)];
  if (from) conds.push(gte(agentPermissionRequests.createdAt, from));
  if (to) conds.push(lte(agentPermissionRequests.createdAt, to));
  const fetched = await ctx.db
    .select({
      id: agentPermissionRequests.id,
      createdAt: agentPermissionRequests.createdAt,
      agentId: agentPermissionRequests.agentId,
      agentName: agents.name,
      operation: agentPermissionRequests.operation,
      summary: agentPermissionRequests.summary,
      class: agentPermissionRequests.class,
      status: agentPermissionRequests.status,
      expiresAt: agentPermissionRequests.expiresAt,
      decidedBy: agentPermissionRequests.decidedBy,
      deciderName: decider.name,
      deciderEmail: decider.email,
      secondApprover: agentPermissionRequests.secondApprover,
      secondName: second.name,
      secondEmail: second.email,
      note: agentPermissionRequests.note,
      error: agentPermissionRequests.error,
      proposalId: agentPermissionRequests.proposalId,
    })
    .from(agentPermissionRequests)
    // Same company only: an agent id never names another company's agent here.
    .leftJoin(agents, and(eq(agentPermissionRequests.agentId, agents.id), eq(agents.companyId, ctx.companyId)))
    .leftJoin(decider, eq(agentPermissionRequests.decidedBy, decider.id))
    .leftJoin(second, eq(agentPermissionRequests.secondApprover, second.id))
    .where(and(...conds))
    .orderBy(desc(agentPermissionRequests.createdAt), asc(agentPermissionRequests.id))
    .limit(AGENT_ACTIVITY_LIMIT + 1);
  const truncated = fetched.length > AGENT_ACTIVITY_LIMIT;
  const list = truncated ? fetched.slice(0, AGENT_ACTIVITY_LIMIT) : fetched;

  // An approved reveal says what it revealed, to which agent, approved by whom: the words its
  // decision's record holds (revealSummary), in place of the bare summary.
  const revealedOf = new Map<string, { revealed: string | null; revealedFields: string | null }>();
  const done = list.filter((r) => r.status === 'executed').map((r) => r.id);
  for (let i = 0; i < done.length; i += 1000) {
    const found = await ctx.db
      .select({
        entityId: auditLogs.entityId,
        revealed: sql<string | null>`${auditLogs.newValues} ->> 'revealed'`,
        revealedFields: sql<string | null>`${auditLogs.newValues} ->> 'revealedFields'`,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'agent_permission_request'),
          inArray(auditLogs.entityId, done.slice(i, i + 1000)),
          sql`(${auditLogs.newValues} ->> 'revealed') IS NOT NULL`,
        ),
      );
    for (const f of found) revealedOf.set(f.entityId, f);
  }

  const personName = (id: string | null, name: string | null, email: string | null) =>
    id ? name || email || REMOVED_PERSON : null;
  const now = new Date();
  const rows: StdRow[] = list.map((r) => {
    const { visible, area } = requestDetails(ctx.access, r.operation);
    const decidedBy = decidedByWords({
      status: r.status,
      first: personName(r.decidedBy, r.deciderName, r.deciderEmail),
      second: personName(r.secondApprover, r.secondName, r.secondEmail),
      copied: !!r.proposalId,
    });
    const note = [r.note, r.error].filter((t): t is string => !!t && !!t.trim()).join(' · ');
    const rv = revealedOf.get(r.id);
    const revealed = rv ? revealSummary(ctx.access, { revealed: rv.revealed, revealedFields: rv.revealedFields, operation: r.operation }) : null;
    return {
      id: `aa:${r.id}`,
      depth: 0,
      kind: 'data' as const,
      cells: {
        when: localDateTime(r.createdAt, timezone),
        agent: r.agentName ?? REMOVED_AGENT,
        what: revealed ?? (visible ? r.summary : hiddenDetails(area)),
        class: isRiskClass(r.class) ? RISK_CLASS_LABELS[r.class] : r.class,
        status: requestStatusWords(shownStatus(r, now), r.decidedBy),
        decidedBy,
        note: visible ? note : '',
      },
    };
  });

  const notes = ['The dates choose when the agent asked, on the company’s clock.'];
  if (!rows.length) notes.push('No agent has asked for anything in these dates.');
  if (truncated) {
    notes.push(`This report shows the newest ${AGENT_ACTIVITY_LIMIT.toLocaleString('en-US')} requests. Narrow the dates to see the others.`);
  }
  return {
    key: 'agent-activity',
    title: 'Agent Activity',
    subtitle: p.from || p.to ? `Asked ${p.from ?? 'any time'} – ${p.to ?? 'today'}` : 'All dates',
    columns: [
      { key: 'when', header: 'Asked' },
      { key: 'agent', header: 'Agent' },
      { key: 'what', header: 'What' },
      { key: 'class', header: 'Class' },
      { key: 'status', header: 'Status' },
      { key: 'decidedBy', header: 'Decided by' },
      { key: 'note', header: 'Note' },
    ],
    rows,
    ...(truncated ? { truncated: true } : {}),
    notes,
  };
}
