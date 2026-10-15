/**
 * Dimensions service — Classes and Locations (QuickBooks tracking dimensions).
 *
 * Classes and Locations tag transactions for multi-dimensional reporting without
 * affecting the GL balance. Neither table has a monetary amount so there is no
 * postJournalEntry call here — all mutations are pure master-data writes with
 * an audit trail.
 *
 * Scoping: every query is guarded by ctx.companyId. IDs coming from the client
 * are always re-verified against the company before any mutation.
 */

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { classes, locations } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertListDeleteAllowed } from './accountantCopy/guard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassRow {
  id: string;
  companyId: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
}

export interface LocationRow {
  id: string;
  companyId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** Return all active classes for the company, ordered by name. */
export async function listClasses(ctx: ServiceContext): Promise<ClassRow[]> {
  return ctx.db
    .select()
    .from(classes)
    .where(and(eq(classes.companyId, ctx.companyId), eq(classes.isActive, true)))
    .orderBy(asc(classes.name)) as Promise<ClassRow[]>;
}

/** Create a new class, optionally nested under a parent. */
export async function createClass(
  ctx: ServiceContext,
  input: { name: string; parentId?: string | null },
): Promise<ClassRow> {
  const name = input.name?.trim();
  if (!name) throw validation('Class name is required.');

  // If parentId supplied, verify it belongs to this company and is active.
  if (input.parentId) {
    const [parent] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(
        and(
          eq(classes.id, input.parentId),
          eq(classes.companyId, ctx.companyId),
          eq(classes.isActive, true),
        ),
      );
    if (!parent) throw notFound('Parent class');
  }

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(classes)
      .values({
        companyId: tx.companyId,
        name,
        parentId: input.parentId ?? null,
        isActive: true,
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'class',
      entityId: row.id,
      newValues: { name, parentId: input.parentId ?? null },
    });

    return row as ClassRow;
  });
}

/** Soft-delete a class by setting isActive = false. */
export async function deactivateClass(ctx: ServiceContext, id: string): Promise<ClassRow> {
  await assertListDeleteAllowed(ctx, 'delete', 'classes'); // Accountant's Copy (I1)
  const [existing] = await ctx.db
    .select()
    .from(classes)
    .where(and(eq(classes.id, id), eq(classes.companyId, ctx.companyId)));
  if (!existing) throw notFound('Class');

  if (!existing.isActive) {
    // Idempotent.
    return existing as ClassRow;
  }

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(classes)
      .set({ isActive: false })
      .where(eq(classes.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'delete',
      entityType: 'class',
      entityId: id,
      oldValues: { isActive: true },
      newValues: { isActive: false },
    });

    return updated as ClassRow;
  });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Return all active locations for the company, ordered by name. */
export async function listLocations(ctx: ServiceContext): Promise<LocationRow[]> {
  return ctx.db
    .select()
    .from(locations)
    .where(and(eq(locations.companyId, ctx.companyId), eq(locations.isActive, true)))
    .orderBy(asc(locations.name)) as Promise<LocationRow[]>;
}

/** Create a new location. */
export async function createLocation(
  ctx: ServiceContext,
  input: { name: string },
): Promise<LocationRow> {
  const name = input.name?.trim();
  if (!name) throw validation('Location name is required.');

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(locations)
      .values({
        companyId: tx.companyId,
        name,
        isActive: true,
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'location',
      entityId: row.id,
      newValues: { name },
    });

    return row as LocationRow;
  });
}

/** Soft-delete a location by setting isActive = false. */
export async function deactivateLocation(ctx: ServiceContext, id: string): Promise<LocationRow> {
  await assertListDeleteAllowed(ctx, 'delete', 'locations'); // Accountant's Copy (I1)
  const [existing] = await ctx.db
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.companyId, ctx.companyId)));
  if (!existing) throw notFound('Location');

  if (!existing.isActive) {
    // Idempotent.
    return existing as LocationRow;
  }

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(locations)
      .set({ isActive: false })
      .where(eq(locations.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'delete',
      entityType: 'location',
      entityId: id,
      oldValues: { isActive: true },
      newValues: { isActive: false },
    });

    return updated as LocationRow;
  });
}
