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
 * until <time>". The ids behind those words come with each row too.
 *
 * agentActivityReport: the "Agent Activity" standard report (Reports > Accountant & Taxes): every
 * permission request an agent made, whatever became of it.
 */
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { agentPermissionRequests, agents, auditLogs, users } from '@/lib/db/schema';
import { areaLabel, canRef, type Area, type EffectiveAccess } from '@/lib/permissions/model';
import { RISK_CLASS_LABELS, isRiskClass, type RequestStatus } from '@/lib/agent/operations/types';
import { operationById } from '@/lib/agent/operations/registry';
import { localDateTime } from '@/lib/reports/dates';
import type { StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import { ServiceError, type ServiceContext, notFound } from './_base';
import { maskForContext } from './access';
import { stripSecrets } from '@/lib/permissions/mask';
import { auditVisibilitySql, canSeeAuditEntry } from './auditVisibility';
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
}

/** How the Audit Trail names who made a change (the transaction log uses the same words). */
function actorLabel(r: ActorFacts, grants: Map<string, StandingPermissionWords>): string | null {
  if (!r.agentId && !r.agentName) return r.person ?? null;
  const actor = agentLabel(r.agentName ?? REMOVED_AGENT);
  if (r.approvedById) return agentActorName(actor, { approvedBy: r.approvedByName || REMOVED_PERSON });
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
  };
}

/** The actor fields of an AuditLogRow. */
function actorFields(r: ActorRow, grants: Map<string, StandingPermissionWords>) {
  const facts = factsOf(r);
  return {
    actorId: r.actorId ?? null,
    actorName: actorLabel(facts, grants),
    agentId: r.agentId ?? null,
    agentName: r.agentId || r.agentName ? (r.agentName ?? REMOVED_AGENT) : null,
    approvedById: r.approvedById ?? null,
    approvedByName: r.approvedById ? (facts.approvedByName ?? REMOVED_PERSON) : null,
    agentRequestId: r.agentRequestId ?? null,
    agentGrantId: r.agentGrantId ?? null,
  };
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
  const visible = auditVisibilitySql(ctx.access);
  if (visible) conds.push(visible);

  const where = and(...conds);

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
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(agents, eq(auditLogs.agentId, agents.id))
    .leftJoin(approver, eq(auditLogs.approvedBy, approver.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(limit)
    .offset(offset);

  const grants = await grantsOf(ctx, rows.map(factsOf));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ...actorFields(r, grants),
      createdAt: r.createdAt.toISOString(),
    })),
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
    .leftJoin(agents, eq(auditLogs.agentId, agents.id))
    .leftJoin(approver, eq(auditLogs.approvedBy, approver.id))
    .where(and(eq(auditLogs.id, id), eq(auditLogs.companyId, ctx.companyId)));

  if (!row) throw notFound('Audit log entry');
  // An entry about a record the caller may not view is answered like one that does not exist.
  if (!canSeeAuditEntry(ctx.access, row.entityType, row.oldValues, row.newValues)) throw notFound('Audit log entry');

  const grants = await grantsOf(ctx, [factsOf(row)]);
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    ...actorFields(row, grants),
    createdAt: row.createdAt.toISOString(),
    // Snapshots can hold SSNs, tax IDs and account numbers -- mask per the caller's flags.
    // ... and never the password hashes older builds wrote into settings snapshots, whoever asks
    // (stripSecrets also for trusted contexts, which maskForContext leaves untouched).
    oldValues: maskForContext(ctx, stripSecrets(row.oldValues)),
    newValues: maskForContext(ctx, stripSecrets(row.newValues)),
    llmReasoning: row.llmReasoning ?? null,
  };
}

// ===========================================================================
// Agent Activity (Reports > Accountant & Taxes), plan §7.3
// ===========================================================================

/** Most requests the report lists, newest first; past it the report says so. */
export const AGENT_ACTIVITY_LIMIT = 5000;

/**
 * A request's status in plain words. 'approved' is the moment between a person's yes and the work
 * being done (agentRequests.ts claims the request, then marks it done or failed): a request left
 * there was approved but has not been carried out.
 */
export const REQUEST_STATUS_WORDS: Record<RequestStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved, not yet done',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
  executed: 'Done',
};

/** A waiting request the first of two people approved (D8): it waits for the second. */
export const WAITING_FOR_SECOND_PERSON = 'Waiting for a second person';

/**
 * The status the report shows, by the approval center's rule (agentRequests.ts shownStatus): a
 * waiting request past its time is expired whether or not anything has marked it yet. One the
 * first of two people approved is still 'pending', with that person in decided_by.
 */
export function requestStatusWords(r: { status: string; expiresAt: Date; decidedBy: string | null }, now: Date): string {
  if (r.status === 'pending') {
    if (r.expiresAt.getTime() <= now.getTime()) return REQUEST_STATUS_WORDS.expired;
    if (r.decidedBy) return WAITING_FOR_SECOND_PERSON;
  }
  return REQUEST_STATUS_WORDS[r.status as RequestStatus] ?? r.status;
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

  const personName = (id: string | null, name: string | null, email: string | null) =>
    id ? name || email || REMOVED_PERSON : null;
  const now = new Date();
  const rows: StdRow[] = list.map((r) => {
    const { visible, area } = requestDetails(ctx.access, r.operation);
    const deciders = [personName(r.decidedBy, r.deciderName, r.deciderEmail), personName(r.secondApprover, r.secondName, r.secondEmail)].filter(Boolean);
    const note = [r.note, r.error].filter((t): t is string => !!t && !!t.trim()).join(' · ');
    return {
      id: `aa:${r.id}`,
      depth: 0,
      kind: 'data' as const,
      cells: {
        when: localDateTime(r.createdAt, timezone),
        agent: r.agentName ?? REMOVED_AGENT,
        what: visible ? r.summary : hiddenDetails(area),
        class: isRiskClass(r.class) ? RISK_CLASS_LABELS[r.class] : r.class,
        status: requestStatusWords(r, now),
        decidedBy: deciders.join(', then '),
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
