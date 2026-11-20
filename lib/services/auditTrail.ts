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
 */
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { agents, auditLogs, users } from '@/lib/db/schema';
import { type ServiceContext, notFound } from './_base';
import { maskForContext } from './access';
import { stripSecrets } from '@/lib/permissions/mask';
import { auditVisibilitySql, canSeeAuditEntry } from './auditVisibility';

/** How the Audit Trail names an agent (the transaction log uses the same words, _base.ts writeAudit). */
function agentActor(name: string | null | undefined): string | null {
  return name ? `${name} (agent)` : null;
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
}

export interface ListAuditLogsOptions {
  entityType?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/** Return paginated audit log rows for the company, newest first. */
export async function listAuditLogs(
  ctx: ServiceContext,
  opts: ListAuditLogsOptions = {},
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const { entityType, action, from, to, limit = 50, offset = 0 } = opts;

  const conds = [eq(auditLogs.companyId, ctx.companyId)];
  if (entityType) conds.push(eq(auditLogs.entityType, entityType));
  if (action) conds.push(eq(auditLogs.action, action as never));
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
      actorId: auditLogs.userId,
      actorName: users.name,
      agentName: agents.name,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(agents, eq(auditLogs.agentId, agents.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actorId: r.actorId ?? null,
      actorName: r.actorName ?? agentActor(r.agentName),
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
      actorId: auditLogs.userId,
      actorName: users.name,
      agentName: agents.name,
      createdAt: auditLogs.createdAt,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
      llmReasoning: auditLogs.llmReasoning,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(agents, eq(auditLogs.agentId, agents.id))
    .where(and(eq(auditLogs.id, id), eq(auditLogs.companyId, ctx.companyId)));

  if (!row) throw notFound('Audit log entry');
  // An entry about a record the caller may not view is answered like one that does not exist.
  if (!canSeeAuditEntry(ctx.access, row.entityType, row.oldValues, row.newValues)) throw notFound('Audit log entry');

  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorId: row.actorId ?? null,
    actorName: row.actorName ?? agentActor(row.agentName),
    createdAt: row.createdAt.toISOString(),
    // Snapshots can hold SSNs, tax IDs and account numbers -- mask per the caller's flags.
    // ... and never the password hashes older builds wrote into settings snapshots, whoever asks
    // (stripSecrets also for trusted contexts, which maskForContext leaves untouched).
    oldValues: maskForContext(ctx, stripSecrets(row.oldValues)),
    newValues: maskForContext(ctx, stripSecrets(row.newValues)),
    llmReasoning: row.llmReasoning ?? null,
  };
}
