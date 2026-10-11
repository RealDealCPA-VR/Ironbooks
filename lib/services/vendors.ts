/**
 * Vendors service — master data for bill payees (QuickBooks "Vendor" entity).
 *
 * Vendors are pure master data: they carry no GL impact themselves. GL entries
 * are written by the bills, bill-payments, and expenses services when they post
 * through postJournalEntry. This module only manages the vendor directory.
 *
 * Conventions (identical to accounts.ts / customers.ts):
 *  - Every query is scoped by ctx.companyId.
 *  - Mutations write an audit_logs row via writeAudit.
 *  - Soft-delete only: deactivateVendor sets isActive = false.
 *  - ServiceError codes: NOT_FOUND, VALIDATION, CONFLICT.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { vendors } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { maskForContext } from './access';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateVendorInput {
  /** The name shown in all lists and documents — required and must be unique per company. */
  displayName: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Free-form address map, e.g. { street, city, state, zip, country }. */
  address?: Record<string, string> | null;
  /** Net-30, net-60, etc. Stored as a short string; defaults to 'net_30'. */
  terms?: string | null;
  /** Mark as a 1099-MISC contractor — used in year-end 1099 reports. */
  is1099?: boolean;
  /** Federal EIN or SSN — stored encrypted at rest by the DB layer. */
  taxId?: string | null;
  /** Preferred expense account pre-filled on new bills / expenses for this vendor. */
  defaultExpenseAccountId?: string | null;
  notes?: string | null;
}

export type UpdateVendorInput = Partial<CreateVendorInput>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that displayName is non-empty and unique within the company. */
async function assertUniqueDisplayName(
  ctx: ServiceContext,
  displayName: string,
  excludeId?: string,
): Promise<void> {
  if (!displayName?.trim()) {
    throw validation('displayName is required.');
  }
  const conds = [
    eq(vendors.companyId, ctx.companyId),
    eq(vendors.displayName, displayName.trim()),
  ];
  if (excludeId) {
    conds.push(ne(vendors.id, excludeId));
  }
  const existing = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(...conds));
  if (existing.length > 0) {
    throw validation(`A vendor with displayName "${displayName}" already exists.`);
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Return all vendors for the company ordered by displayName.
 * By default only active vendors are returned; pass includeInactive to see all.
 */
export async function listVendors(
  ctx: ServiceContext,
  opts?: { includeInactive?: boolean },
) {
  const where = opts?.includeInactive
    ? eq(vendors.companyId, ctx.companyId)
    : and(eq(vendors.companyId, ctx.companyId), eq(vendors.isActive, true));
  // Tax IDs (a sole proprietor's TIN is their SSN) leave this service masked unless the
  // caller may view sensitive data (Users & Roles flag).
  return maskForContext(
    ctx,
    await ctx.db.select().from(vendors).where(where).orderBy(asc(vendors.displayName)),
  );
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

/** Unmasked row (internal: updates must never write a masked tax ID back). */
async function loadVendor(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, id), eq(vendors.companyId, ctx.companyId)));
  if (!row) throw notFound('Vendor');
  return row;
}

/** Fetch a single vendor by id, scoped to the company. Throws NOT_FOUND if missing. */
export async function getVendor(ctx: ServiceContext, id: string) {
  return maskForContext(ctx, await loadVendor(ctx, id));
}

/** True for a value produced by masking ("***-**-6789") -- never store it as a tax ID. */
const isMaskedValue = (v: string | null | undefined) =>
  typeof v === 'string' && /[*\u2022]/.test(v);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Create a new vendor record for the company. */
export async function createVendor(ctx: ServiceContext, input: CreateVendorInput) {
  await assertUniqueDisplayName(ctx, input.displayName);

  const [row] = await ctx.db
    .insert(vendors)
    .values({
      companyId: ctx.companyId,
      displayName: input.displayName.trim(),
      companyName: input.companyName?.trim() ?? null,
      email: input.email?.trim() ?? null,
      phone: input.phone?.trim() ?? null,
      address: input.address ?? null,
      terms: input.terms ?? 'net_30',
      is1099: input.is1099 ?? false,
      taxId: input.taxId ?? null,
      defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
      notes: input.notes ?? null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'vendor',
    entityId: row.id,
    newValues: row,
  });

  return maskForContext(ctx, row);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Patch an existing vendor. Only supplied fields are changed; omitted fields
 * keep their current values. displayName uniqueness is re-validated if changed.
 */
export async function updateVendor(
  ctx: ServiceContext,
  id: string,
  patch: UpdateVendorInput,
) {
  const before = await loadVendor(ctx, id);

  // Re-validate displayName only if the caller is changing it.
  const newDisplayName = patch.displayName !== undefined
    ? patch.displayName
    : before.displayName;

  if (patch.displayName !== undefined) {
    await assertUniqueDisplayName(ctx, newDisplayName, id);
  }

  const [row] = await ctx.db
    .update(vendors)
    .set({
      displayName: newDisplayName.trim(),
      companyName:
        patch.companyName !== undefined ? (patch.companyName?.trim() ?? null) : before.companyName,
      email: patch.email !== undefined ? (patch.email?.trim() ?? null) : before.email,
      phone: patch.phone !== undefined ? (patch.phone?.trim() ?? null) : before.phone,
      address: patch.address !== undefined ? patch.address : before.address,
      terms: patch.terms !== undefined ? patch.terms : before.terms,
      is1099: patch.is1099 !== undefined ? patch.is1099 : before.is1099,
      // A masked tax ID echoed back by a user who can't see the full one leaves it unchanged.
      taxId:
        patch.taxId !== undefined && !isMaskedValue(patch.taxId) ? patch.taxId : before.taxId,
      defaultExpenseAccountId:
        patch.defaultExpenseAccountId !== undefined
          ? patch.defaultExpenseAccountId
          : before.defaultExpenseAccountId,
      notes: patch.notes !== undefined ? patch.notes : before.notes,
      updatedAt: new Date(),
    })
    .where(eq(vendors.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'vendor',
    entityId: id,
    oldValues: before,
    newValues: row,
  });

  return maskForContext(ctx, row);
}

// ---------------------------------------------------------------------------
// Deactivate (soft-delete)
// ---------------------------------------------------------------------------

/**
 * Soft-delete a vendor by marking it inactive. Existing bills and expenses that
 * reference this vendor are preserved; the vendor simply stops appearing in active
 * lists and cannot be selected for new documents.
 */
export async function deactivateVendor(ctx: ServiceContext, id: string) {
  const before = await loadVendor(ctx, id);

  const [row] = await ctx.db
    .update(vendors)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(vendors.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'vendor',
    entityId: id,
    oldValues: { isActive: before.isActive },
    newValues: { isActive: false },
  });

  return row;
}
