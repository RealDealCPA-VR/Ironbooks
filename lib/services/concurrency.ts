/**
 * Optimistic concurrency for multi-user mode.
 *
 * Several people can have the same invoice / bill / journal entry / customer / vendor / item
 * open at once. The record's `updated_at` is its version: the UI sends the version it loaded
 * (header `x-expected-updated-at`, attached automatically by lib/client.ts) and the save is
 * refused with 409 CONFLICT if someone else saved in between:
 *
 *   "This record was changed by Dana at Jun 3, 2026, 2:14 PM. Reload to see the latest."
 *
 * Usage in a route (minimal edit — wrap the existing service call):
 *
 *   const updated = await withVersionCheck(ctx, 'invoice', id, expectedVersion(req),
 *     (c) => updateInvoice(c, id, parsed.data));
 *
 * The check, the save and the version bump run in ONE transaction (PGlite serializes
 * transactions), so two simultaneous saves can never both pass. Requests that send no version
 * (older pages, scripts) skip the check — last write wins, exactly as before.
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  auditLogs,
  bills,
  customers,
  invoices,
  items,
  journalEntries,
  users,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, ServiceError, inTransaction } from './_base';

/** Request header carrying the version (ISO updatedAt) the client last loaded. */
export const EXPECTED_VERSION_HEADER = 'x-expected-updated-at';

const TABLES = {
  invoice: invoices,
  bill: bills,
  journal_entry: journalEntries,
  customer: customers,
  vendor: vendors,
  item: items,
} as const;

export type VersionedEntity = keyof typeof TABLES;

const LABELS: Record<VersionedEntity, string> = {
  invoice: 'invoice',
  bill: 'bill',
  journal_entry: 'journal entry',
  customer: 'customer',
  vendor: 'vendor',
  item: 'item',
};

/** Parse the expected version from a request (header), or null when absent/invalid. */
export function expectedVersion(req: { headers: { get(name: string): string | null } }): Date | null {
  return parseVersion(req.headers.get(EXPECTED_VERSION_HEADER));
}

export function parseVersion(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** All six tables share id / company_id / updated_at; drizzle only needs the column objects. */
function table(entity: VersionedEntity) {
  return TABLES[entity] as unknown as typeof customers;
}

async function loadVersion(ctx: ServiceContext, entity: VersionedEntity, id: string) {
  const t = table(entity);
  const [row] = await ctx.db
    .select({ updatedAt: t.updatedAt })
    .from(t)
    .where(and(eq(t.id, id), eq(t.companyId, ctx.companyId)));
  return row ?? null;
}

/**
 * Who last changed the record: the newest audit-trail entry for it (every mutation writes one).
 * The time shown is the record's own updated_at, which the services set from the app clock.
 */
async function lastChangedBy(ctx: ServiceContext, entity: VersionedEntity, id: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ userName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(
      and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityId, id), eq(auditLogs.entityType, entity)),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row?.userName ?? null;
}

function formatWhen(d: Date): string {
  try {
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toISOString();
  }
}

/**
 * Throw CONFLICT (409) unless the record's current version equals `expected`. Versions are
 * compared at millisecond precision (what JSON round-trips). NOT_FOUND if the record is gone.
 */
export async function assertCurrentVersion(
  ctx: ServiceContext,
  entity: VersionedEntity,
  id: string,
  expected: Date | string | null | undefined,
): Promise<void> {
  const want = parseVersion(expected);
  if (!want) return;
  const row = await loadVersion(ctx, entity, id);
  if (!row) throw new ServiceError('NOT_FOUND', `${LABELS[entity][0].toUpperCase()}${LABELS[entity].slice(1)} not found`);
  if (row.updatedAt.getTime() === want.getTime()) return;

  const changedBy = await lastChangedBy(ctx, entity, id);
  const at = row.updatedAt;
  const by = changedBy ?? 'another user';
  throw new ServiceError(
    'CONFLICT',
    `This record was changed by ${by} at ${formatWhen(at)}. Reload to see the latest.`,
    {
      staleVersion: true,
      entity,
      id,
      currentUpdatedAt: row.updatedAt.toISOString(),
      changedBy,
      changedAt: at.toISOString(),
    },
  );
}

/**
 * Run `fn` (the existing service call) under an optimistic-concurrency check. Without an
 * expected version this is a plain pass-through. With one, the check + save + version bump
 * share a transaction; the bump guarantees the version moves even if the service did not
 * touch updated_at (or did within the same millisecond).
 */
export async function withVersionCheck<T>(
  ctx: ServiceContext,
  entity: VersionedEntity,
  id: string,
  expected: Date | string | null | undefined,
  fn: (ctx: ServiceContext) => Promise<T>,
): Promise<T> {
  const want = parseVersion(expected);
  if (!want) return fn(ctx);
  return inTransaction(ctx, async (tx) => {
    await assertCurrentVersion(tx, entity, id, want);
    const result = await fn(tx);
    const version = await bumpVersion(tx, entity, id, want);
    // The client caches the version in the returned record as its next expected version, so
    // it must be the bumped one — otherwise the user's next save is a false 409 naming themselves.
    return version ? withReturnedVersion(result, id, version) : result;
  });
}

/** The record's version after the save (bumped when the service didn't move it forward). */
async function bumpVersion(
  ctx: ServiceContext,
  entity: VersionedEntity,
  id: string,
  previous: Date,
): Promise<Date | null> {
  const t = table(entity);
  const row = await loadVersion(ctx, entity, id);
  if (!row) return null;
  const floor = Math.max(previous.getTime(), row.updatedAt.getTime());
  if (row.updatedAt.getTime() > previous.getTime() && row.updatedAt.getTime() <= Date.now()) return row.updatedAt;
  const next = new Date(Math.max(Date.now(), floor + 1));
  await ctx.db.update(t).set({ updatedAt: next }).where(and(eq(t.id, id), eq(t.companyId, ctx.companyId)));
  return next;
}

/**
 * Patch `updatedAt` on the record the service returned — top level ({ id, updatedAt, ... }) or
 * one level down for wrapped results ({ invoice: {...} }, { entry: {...} }). Returns a shallow
 * copy; anything without a matching record is passed through untouched.
 */
function withReturnedVersion<T>(result: T, id: string, version: Date): T {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
  const patch = (rec: Record<string, unknown>) =>
    'updatedAt' in rec && (rec.id === undefined || rec.id === id) ? { ...rec, updatedAt: version } : null;
  if (!isRecord(result)) return result;
  const top = patch(result);
  if (top) return top as T;
  const out: Record<string, unknown> = { ...result };
  let changed = false;
  for (const [k, v] of Object.entries(result)) {
    if (isRecord(v) && v.id === id) {
      const p = patch(v);
      if (p) {
        out[k] = p;
        changed = true;
      }
    }
  }
  return (changed ? out : result) as T;
}
