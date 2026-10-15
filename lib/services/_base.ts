/**
 * Service-layer base. Every business module (accounts, invoices, bills, payments, …) is a set of
 * pure functions that take a ServiceContext and operate through Drizzle. UI and API routes are thin
 * wrappers over these services, which keeps the accounting logic testable without a browser/Electron.
 *
 * Conventions:
 *  - Services throw `ServiceError` (with a stable `code`) on failure; API routes translate to HTTP.
 *  - Every mutation writes an `audit_logs` row via `writeAudit`.
 *  - Multi-tenant safety: every query is scoped by `ctx.companyId`. Never trust a client-supplied id
 *    without checking it belongs to the company.
 */
import { and, eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DB } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { ServiceError, type ServiceErrorFix } from './errors';
import { logTransaction } from './transactionLog';
import { auditBackstop } from './accountantCopy/guard';
import type { EffectiveAccess } from '@/lib/permissions/model';

export interface ServiceContext {
  db: DB;
  companyId: string;
  /** Acting user; nullable for system/automation actions. */
  userId: string | null;
  /**
   * RBAC (rbac-closing): the member's role in this company, loaded by `getServerContext`.
   * 'viewer' contexts are rejected by `writeAudit`/`inTransaction` (read-only app-wide).
   * Absent/undefined = trusted internal context (tests, system jobs) — no restriction.
   */
  role?: 'owner' | 'admin' | 'accountant' | 'viewer';
  /**
   * Closing-date protection (rbac-closing): true when this request supplied a valid
   * closing-date password (x-closing-password header, verified by `getServerContext`).
   * `assertPeriodOpen` blocks postings dated on/before the company closing date unless set.
   */
  closingDateOverride?: boolean;
  /**
   * Multi-user hosting: the signed-in session making this request (user_sessions.id), set by
   * `getServerContext`. Used by "Who is logged in" and the single-user-mode gate
   * (lib/services/sessions.ts). Absent for system jobs / first-run.
   */
  sessionId?: string;
  /**
   * Enterprise roles & permissions (team users): the member's effective permissions (union of
   * their roles), loaded by `getServerContext`, which also enforces the API route map
   * (lib/permissions/routes.ts). Absent = trusted internal context — no restriction.
   */
  access?: EffectiveAccess;
}

export { ServiceError, type ServiceErrorCode, type ServiceErrorFix } from './errors';

export const notFound = (what: string) => new ServiceError('NOT_FOUND', `${what} not found`);
export const validation = (msg: string, details?: unknown, fixes?: ServiceErrorFix[]) =>
  new ServiceError('VALIDATION', msg, details, fixes);

const REF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Multi-company scoping guard for foreign ids taken from a payload (customerId, employeeId, ...):
 * the referenced row must exist in ctx.companyId, otherwise VALIDATION. Without it a caller could
 * attach another company's record (and later see its name through a join). A malformed id is
 * refused the same way instead of surfacing Postgres' 22P02 as a 500.
 */
export async function assertRefInCompany(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  table: PgTable & { id: PgColumn; companyId: PgColumn },
  id: string,
  label: string,
): Promise<void> {
  const missing = () => validation(`${label} does not exist in this company.`);
  if (typeof id !== 'string' || !REF_UUID_RE.test(id)) throw missing();
  const [row] = await ctx.db
    .select({ id: table.id })
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)))
    .limit(1);
  if (!row) throw missing();
}

export type AuditAction = 'create' | 'update' | 'delete' | 'void' | 'llm_correction';

/**
 * RBAC choke-point (rbac-closing package): every mutation flows through `inTransaction` and/or
 * `writeAudit`, so rejecting 'viewer' contexts here makes viewers read-only app-wide without
 * touching each of the 70+ services. Mirrors `assertWrite` in lib/services/rbac.ts.
 */
function assertNotViewer(ctx: ServiceContext): void {
  if (ctx.role === 'viewer') {
    throw new ServiceError('FORBIDDEN', 'Your role is view-only. This action requires write access.');
  }
}

/**
 * Record a mutation in the audit trail. Call inside the same transaction as the mutation.
 * Also queues the change for the running transaction log (transactions.bktlg), which is
 * appended only after the enclosing transaction commits (see lib/services/transactionLog.ts).
 */
export async function writeAudit(
  ctx: ServiceContext,
  params: {
    action: AuditAction;
    entityType: string;
    entityId: string;
    oldValues?: unknown;
    newValues?: unknown;
    llmReasoning?: string;
  },
): Promise<void> {
  assertNotViewer(ctx); // RBAC: viewers cannot mutate (see assertNotViewer above)
  await auditBackstop(ctx, params); // Accountant's Copy: no list deletes (accountantCopy/guard.ts)
  await ctx.db.insert(auditLogs).values({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    oldValues: params.oldValues ?? null,
    newValues: params.newValues ?? null,
    llmReasoning: params.llmReasoning ?? null,
  });
  await logTransaction(ctx.db, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    data: {
      old: params.oldValues ?? null,
      new: params.newValues ?? null,
      ...(params.llmReasoning ? { llmReasoning: params.llmReasoning } : {}),
    },
  });
}

/**
 * Ledger invariants enforced by the database (drizzle/0017_team_ledger.sql) raise custom
 * SQLSTATEs. Translate them into ServiceErrors so API routes answer 400/409 with the real
 * reason instead of a generic 500. Anything else is returned unchanged.
 */
export function translateLedgerDbError(err: unknown): unknown {
  if (err instanceof ServiceError || !err || typeof err !== 'object') return err;
  const code = (err as { code?: unknown }).code;
  const message = String((err as { message?: unknown }).message ?? '');
  if (code === 'BK001') return new ServiceError('UNBALANCED', message, { sqlstate: code });
  if (code === 'BK002' || code === 'BK003') {
    return new ServiceError('CONFLICT', message, { sqlstate: code });
  }
  return err;
}

/** Run a function inside a DB transaction, returning its result. */
export async function inTransaction<T>(
  ctx: ServiceContext,
  fn: (txCtx: ServiceContext) => Promise<T>,
): Promise<T> {
  assertNotViewer(ctx); // RBAC: viewers cannot mutate (see assertNotViewer above)
  try {
    return await ctx.db.transaction(async (tx) => fn({ ...ctx, db: tx as unknown as DB }));
  } catch (err) {
    // Deferred ledger checks fire at COMMIT, i.e. here — surface them as ServiceErrors.
    throw translateLedgerDbError(err);
  }
}
