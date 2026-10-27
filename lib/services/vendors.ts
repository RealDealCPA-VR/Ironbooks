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
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { accounts, vendors } from '@/lib/db/schema';
import { type ServiceContext, assertRefInCompany, inTransaction, notFound, validation, writeAudit } from './_base';
import { getPreferences } from './preferences';
import { maskForContext } from './access';
import { resolvePartyTerms } from './lists/fields';
import { type VendorPurchaseFieldsInput, resolveVendorPurchaseFields } from './vendorPurchaseFields';
import { assertAccountantListEdit, assertListDeleteAllowed } from './accountantCopy/guard';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateVendorInput extends VendorPurchaseFieldsInput {
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
  /** Terms list entry (wins over the legacy `terms` string, which is kept in sync). */
  termsId?: string | null;
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
    sql`lower(${vendors.displayName}) = lower(${displayName.trim()})`, // QB names are case-insensitive
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
  // The unique-name check runs in the same transaction as the insert (two creates at once must
  // not both add the same name).
  return inTransaction(ctx, (tx) => createVendorInTx(tx, input));
}

async function createVendorInTx(ctx: ServiceContext, input: CreateVendorInput) {
  // A masked placeholder (e.g. copied from a vendor shown to a role without the sensitive flag)
  // is not a TIN -- storing it would corrupt 1099 reporting.
  if (isMaskedValue(input.taxId)) {
    throw validation('Enter the full tax ID; a masked value cannot be saved.');
  }
  await assertUniqueDisplayName(ctx, input.displayName);
  if (input.defaultExpenseAccountId) {
    await assertRefInCompany(ctx, accounts, input.defaultExpenseAccountId, 'Default expense account');
  }
  const termsRes = await resolvePartyTerms(ctx, { termsId: input.termsId, terms: input.terms });
  const purchaseFields = await resolveVendorPurchaseFields(ctx, input);

  const [row] = await ctx.db
    .insert(vendors)
    .values({
      companyId: ctx.companyId,
      displayName: input.displayName.trim(),
      companyName: input.companyName?.trim() ?? null,
      email: input.email?.trim() ?? null,
      phone: input.phone?.trim() ?? null,
      address: input.address ?? null,
      // A Terms-list pick / typed terms win; else Preferences > Bills: default terms for new records.
      terms: termsRes ? termsRes.terms : (await getPreferences(ctx)).defaultVendorTerms,
      termsId: termsRes?.termsId ?? null,
      is1099: input.is1099 ?? false,
      taxId: input.taxId ?? null,
      defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
      notes: input.notes ?? null,
      ...purchaseFields,
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
  // The unique-name check, the update and its audit row in ONE transaction (as createVendor):
  // two vendors renamed to the same name at once both passed the check and both kept the name.
  return inTransaction(ctx, (tx) => updateVendorInTx(tx, id, patch));
}

async function updateVendorInTx(ctx: ServiceContext, id: string, patch: UpdateVendorInput) {
  const before = await loadVendor(ctx, id);
  await assertAccountantListEdit(ctx, 'vendor', before as Record<string, unknown>, patch as Record<string, unknown>); // I1

  // Re-validate displayName only if the caller is changing it.
  const newDisplayName = patch.displayName !== undefined
    ? patch.displayName
    : before.displayName;

  if (patch.displayName !== undefined) {
    await assertUniqueDisplayName(ctx, newDisplayName, id);
  }
  if (patch.defaultExpenseAccountId) {
    await assertRefInCompany(ctx, accounts, patch.defaultExpenseAccountId, 'Default expense account');
  }
  const termsRes = await resolvePartyTerms(ctx, { termsId: patch.termsId, terms: patch.terms });
  const purchaseFields = await resolveVendorPurchaseFields(ctx, patch, before);

  const [row] = await ctx.db
    .update(vendors)
    .set({
      displayName: newDisplayName.trim(),
      companyName:
        patch.companyName !== undefined ? (patch.companyName?.trim() ?? null) : before.companyName,
      email: patch.email !== undefined ? (patch.email?.trim() ?? null) : before.email,
      phone: patch.phone !== undefined ? (patch.phone?.trim() ?? null) : before.phone,
      address: patch.address !== undefined ? patch.address : before.address,
      terms: termsRes ? termsRes.terms : before.terms,
      termsId: termsRes ? termsRes.termsId : before.termsId,
      is1099: patch.is1099 !== undefined ? patch.is1099 : before.is1099,
      // A masked tax ID echoed back by a user who can't see the full one leaves it unchanged.
      taxId:
        patch.taxId !== undefined && !isMaskedValue(patch.taxId) ? patch.taxId : before.taxId,
      defaultExpenseAccountId:
        patch.defaultExpenseAccountId !== undefined
          ? patch.defaultExpenseAccountId
          : before.defaultExpenseAccountId,
      notes: patch.notes !== undefined ? patch.notes : before.notes,
      ...purchaseFields,
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
  await assertListDeleteAllowed(ctx, 'delete', 'vendors'); // Accountant's Copy (I1)
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

  // Masked like every other vendor read: DELETE /api/vendors/:id returned the raw row, so a user
  // whose role hides tax IDs / account numbers read the vendor's full SSN/EIN by making it inactive.
  return maskForContext(ctx, row);
}


/**
 * Make an inactive vendor active again (the inverse of deactivateVendor; used by Undo).
 * Audited as an update of isActive.
 */
export async function reactivateVendor(ctx: ServiceContext, id: string) {
  const before = await loadVendor(ctx, id);
  await assertAccountantListEdit(ctx, 'vendor', before as Record<string, unknown>, { isActive: true }); // I1
  const [row] = await ctx.db
    .update(vendors)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(vendors.id, id), eq(vendors.companyId, ctx.companyId)))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'vendor',
    entityId: id,
    oldValues: { isActive: before.isActive },
    newValues: { isActive: true },
  });
  return maskForContext(ctx, row);
}

/** Unmasked vendor row for internal snapshots (Undo restores it through updateVendor). */
export async function loadVendorUnmasked(ctx: ServiceContext, id: string) {
  return loadVendor(ctx, id);
}
