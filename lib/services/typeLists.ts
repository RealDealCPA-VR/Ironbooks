/**
 * Customer Type and Vendor Type lists (QB Desktop "Customer & Vendor Profile Lists").
 *
 * Simple, optionally hierarchical name lists. Customer types are a price-rule condition
 * (lib/services/pricing.ts) and a reporting dimension; vendor types are a reporting dimension.
 * Master data only — no GL impact. Deleting a type that is in use deactivates it instead so
 * historical assignments keep resolving.
 */
import { and, asc, eq } from 'drizzle-orm';
import { customerTypes, customers, vendorTypes, vendors } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';

export type TypeListKind = 'customer' | 'vendor';

export interface TypeListInput {
  name: string;
  parentId?: string | null;
  isActive?: boolean;
}

function tableFor(kind: TypeListKind) {
  return kind === 'customer' ? customerTypes : vendorTypes;
}

const ENTITY: Record<TypeListKind, string> = { customer: 'customer_type', vendor: 'vendor_type' };

export async function listTypes(ctx: ServiceContext, kind: TypeListKind) {
  const t = tableFor(kind);
  return ctx.db.select().from(t).where(eq(t.companyId, ctx.companyId)).orderBy(asc(t.name));
}

async function loadType(ctx: ServiceContext, kind: TypeListKind, id: string) {
  const t = tableFor(kind);
  const [row] = await ctx.db.select().from(t).where(and(eq(t.companyId, ctx.companyId), eq(t.id, id)));
  if (!row) throw notFound(kind === 'customer' ? 'Customer type' : 'Vendor type');
  return row;
}

async function validateInput(ctx: ServiceContext, kind: TypeListKind, input: TypeListInput, selfId?: string) {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Name is required.');
  if (name.length > 255) throw validation('Name is too long.');
  const t = tableFor(kind);
  const existing = await ctx.db
    .select({ id: t.id, name: t.name, parentId: t.parentId })
    .from(t)
    .where(eq(t.companyId, ctx.companyId));
  if (existing.some((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())) {
    throw validation(`A ${kind} type named "${name}" already exists.`);
  }
  if (input.parentId) {
    if (input.parentId === selfId) throw validation('A type cannot be its own parent.');
    await loadType(ctx, kind, input.parentId);
    if (selfId) {
      // Walk the proposed parent's ancestor chain: reaching this type would create a cycle.
      const parentOf = new Map(existing.map((r) => [r.id, r.parentId]));
      const seen = new Set<string>();
      let cur: string | null | undefined = input.parentId;
      while (cur && !seen.has(cur)) {
        if (cur === selfId) throw validation('A type cannot be placed under one of its own subtypes.');
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    }
  }
  return { name, parentId: input.parentId ?? null };
}

export async function createType(ctx: ServiceContext, kind: TypeListKind, input: TypeListInput) {
  const v = await validateInput(ctx, kind, input);
  const t = tableFor(kind);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(t)
      .values({ companyId: tx.companyId, ...v, isActive: input.isActive ?? true })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: ENTITY[kind], entityId: row.id, newValues: row });
    return row;
  });
}

export async function updateType(ctx: ServiceContext, kind: TypeListKind, id: string, input: TypeListInput) {
  const before = await loadType(ctx, kind, id);
  const v = await validateInput(ctx, kind, input, id);
  const t = tableFor(kind);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(t)
      .set({ ...v, isActive: input.isActive ?? before.isActive })
      .where(eq(t.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: ENTITY[kind],
      entityId: id,
      oldValues: before,
      newValues: row,
    });
    return row;
  });
}

/** Delete an unused type; a type still assigned to customers/vendors is deactivated instead. */
export async function deleteType(
  ctx: ServiceContext,
  kind: TypeListKind,
  id: string,
): Promise<{ deleted: boolean; deactivated: boolean }> {
  const before = await loadType(ctx, kind, id);
  const inUse =
    kind === 'customer'
      ? await ctx.db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.companyId, ctx.companyId), eq(customers.customerTypeId, id)))
          .limit(1)
      : await ctx.db
          .select({ id: vendors.id })
          .from(vendors)
          .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.vendorTypeId, id)))
          .limit(1);
  const t = tableFor(kind);
  return inTransaction(ctx, async (tx) => {
    if (inUse.length > 0) {
      await tx.db.update(t).set({ isActive: false }).where(eq(t.id, id));
      await writeAudit(tx, {
        action: 'update',
        entityType: ENTITY[kind],
        entityId: id,
        oldValues: { isActive: before.isActive },
        newValues: { isActive: false, reason: 'in use — deactivated instead of deleted' },
      });
      return { deleted: false, deactivated: true };
    }
    // Children of the deleted type move up to its parent.
    await tx.db.update(t).set({ parentId: before.parentId }).where(and(eq(t.companyId, tx.companyId), eq(t.parentId, id)));
    await tx.db.delete(t).where(eq(t.id, id));
    await writeAudit(tx, { action: 'delete', entityType: ENTITY[kind], entityId: id, oldValues: before });
    return { deleted: true, deactivated: false };
  });
}

/** Assign (or clear, with null) a vendor's type. */
export async function assignVendorType(ctx: ServiceContext, vendorId: string, vendorTypeId: string | null) {
  const [before] = await ctx.db
    .select()
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
  if (!before) throw notFound('Vendor');
  if (vendorTypeId) await loadType(ctx, 'vendor', vendorTypeId);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(vendors)
      .set({ vendorTypeId, updatedAt: new Date() })
      .where(eq(vendors.id, vendorId))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor',
      entityId: vendorId,
      oldValues: { vendorTypeId: before.vendorTypeId },
      newValues: { vendorTypeId },
    });
    return row;
  });
}
