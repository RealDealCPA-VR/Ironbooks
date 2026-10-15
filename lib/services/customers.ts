/**
 * Customers master-data service.
 *
 * Customers are the A/R side of the business — every invoice, payment, and credit
 * memo belongs to one. This module handles CRUD for the `customers` table plus an
 * optional balance-summary that reads `invoices.balance_due` without touching the GL
 * directly (the GL is written exclusively by the invoices/payments services when they
 * call postJournalEntry).
 *
 * Conventions followed:
 *  - Every query is scoped by ctx.companyId (multi-tenant safety).
 *  - Every mutation emits an audit_logs row via writeAudit.
 *  - displayName is mandatory and non-empty; email is validated if provided.
 *  - Deactivation is soft-delete (isActive = false); hard delete is not exposed.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { customers, invoices, taxRates } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, assertRefInCompany, notFound, validation, writeAudit } from './_base';
import { unappliedPaymentsByCustomer } from './customerCredits';
import { journalBalancesByEntity } from './journal';
import { resolvePartyTerms, resolveSalesTaxCode } from './lists/fields';
import { getPreferences } from './preferences';
import { defaultShipTo, normalizeShipToAddresses, shipToAddressFields, type ShipToAddress } from '@/lib/shipTo';

/** Validate the named ship-to list; the default one also becomes `shippingAddress`. */
function resolveShipTos(list: Array<Partial<ShipToAddress>> | null | undefined): ShipToAddress[] | null {
  try {
    return normalizeShipToAddresses(list as Array<Record<string, unknown>> | null | undefined);
  } catch (err) {
    throw validation((err as Error).message);
  }
}

/** The saved ship-to list with its default entry's address replaced (or removed when blank). */
function shipToListWithDefault(
  list: Array<Record<string, unknown>> | null | undefined,
  address: object | null | undefined,
): Array<Record<string, unknown>> {
  const fields = shipToAddressFields(address);
  const blank = Object.keys(fields).length === 0;
  const rows = Array.isArray(list) ? list.filter((a) => a && typeof a === 'object') : [];
  const di = rows.findIndex((a) => a.isDefault === true);
  const idx = di >= 0 ? di : rows.length ? 0 : -1;
  if (idx < 0) return blank ? [] : [{ name: 'Ship To 1', ...fields, isDefault: true }];
  if (blank) return rows.filter((_, i) => i !== idx).map((a) => ({ ...a, isDefault: false }));
  return rows.map((a, i) =>
    i === idx ? { name: a.name, ...fields, isDefault: true } : { ...a, isDefault: false },
  );
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CustomerAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface CreateCustomerInput {
  displayName: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  billingAddress?: CustomerAddress | null;
  shippingAddress?: CustomerAddress | null;
  /** QB Enterprise: several named ship-to addresses, one marked isDefault (see lib/shipTo.ts). */
  shipToAddresses?: Array<Partial<ShipToAddress>> | null;
  terms?: string | null;
  creditLimit?: string | number | null;
  taxable?: boolean;
  taxRateId?: string | null;
  parentId?: string | null;
  notes?: string | null;
  /** Terms list entry (wins over the legacy `terms` string, which is kept in sync). */
  termsId?: string | null;
  /** Sales Tax Code list entry; when set, `taxable` follows the code's taxable flag. */
  salesTaxCodeId?: string | null;
  /** Resale certificate number (tax-exempt customers). */
  resaleNumber?: string | null;
  /** Why this customer is exempt from sales tax. */
  taxExemptionReason?: string | null;
}

export type UpdateCustomerInput = Partial<CreateCustomerInput>;

export interface CustomerBalanceSummaryRow {
  customerId: string;
  displayName: string;
  totalBalanceDue: string;
  openInvoiceCount: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertValidEmail(email: string) {
  // Simple structural check — full RFC 5322 validation belongs at the UI layer.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validation(`"${email}" is not a valid email address.`);
  }
}

function validateInput(input: CreateCustomerInput) {
  if (!input.displayName?.trim()) {
    throw validation('Customer displayName is required.');
  }
  if (input.email?.trim()) {
    assertValidEmail(input.email.trim());
  }
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

/**
 * List customers for the current company.
 * By default returns only active customers; pass `includeInactive: true` for all.
 */
export async function listCustomers(
  ctx: ServiceContext,
  opts?: { includeInactive?: boolean },
) {
  const where = opts?.includeInactive
    ? eq(customers.companyId, ctx.companyId)
    : and(eq(customers.companyId, ctx.companyId), eq(customers.isActive, true));

  return ctx.db
    .select()
    .from(customers)
    .where(where)
    .orderBy(asc(customers.displayName));
}

/**
 * Fetch a single customer by id, scoped to the current company.
 * Throws NOT_FOUND if the record doesn't exist or belongs to another company.
 */
export async function getCustomer(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.companyId, ctx.companyId)));

  if (!row) throw notFound('Customer');
  return row;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Create a new customer record (no GL impact — only master data). */
export async function createCustomer(ctx: ServiceContext, input: CreateCustomerInput) {
  validateInput(input);

  // Enforce unique displayName per company so the pick-list stays unambiguous.
  const [conflict] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.companyId, ctx.companyId),
        sql`lower(${customers.displayName}) = lower(${input.displayName.trim()})`, // QB names are case-insensitive
      ),
    );
  if (conflict) {
    throw validation(`A customer named "${input.displayName.trim()}" already exists.`);
  }

  // If parentId supplied, verify parent belongs to same company.
  if (input.parentId) {
    const [parent] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.id, input.parentId),
          eq(customers.companyId, ctx.companyId),
        ),
      );
    if (!parent) throw notFound('Parent customer');
  }

  if (input.taxRateId) await assertRefInCompany(ctx, taxRates, input.taxRateId, 'Sales tax rate');

  const termsRes = await resolvePartyTerms(ctx, { termsId: input.termsId, terms: input.terms });
  const taxCode = input.salesTaxCodeId ? await resolveSalesTaxCode(ctx, input.salesTaxCodeId) : null;
  // Named ship-to addresses; a lone shipping address becomes "Ship To 1".
  const shipTos =
    input.shipToAddresses !== undefined
      ? resolveShipTos(input.shipToAddresses)
      : input.shippingAddress && Object.values(input.shippingAddress).some((v) => String(v ?? '').trim())
        ? resolveShipTos([{ name: 'Ship To 1', ...input.shippingAddress, isDefault: true }])
        : null;

  const [row] = await ctx.db
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      displayName: input.displayName.trim(),
      companyName: input.companyName?.trim() ?? null,
      email: input.email?.trim() ?? null,
      phone: input.phone?.trim() ?? null,
      billingAddress: (input.billingAddress as Record<string, string>) ?? null,
      shippingAddress:
        (shipTos ? defaultShipTo(shipTos as never) : null) ??
        (input.shippingAddress as Record<string, string>) ??
        null,
      shipToAddresses: (shipTos as Array<Record<string, string | boolean>> | null) ?? null,
      // A Terms-list pick / typed terms win; else Preferences > Sales & Customers: default terms for new records.
      terms: termsRes ? termsRes.terms : (await getPreferences(ctx)).defaultCustomerTerms,
      termsId: termsRes?.termsId ?? null,
      creditLimit: input.creditLimit != null ? toAmountString(input.creditLimit) : null,
      taxable: taxCode ? taxCode.taxable : input.taxable ?? true,
      salesTaxCodeId: taxCode?.id ?? null,
      resaleNumber: input.resaleNumber?.trim() || null,
      taxExemptionReason: input.taxExemptionReason?.trim() || null,
      taxRateId: input.taxRateId ?? null,
      parentId: input.parentId ?? null,
      notes: input.notes ?? null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'customer',
    entityId: row.id,
    newValues: row,
  });

  return row;
}

/**
 * Update mutable fields on an existing customer.
 * Only supplied (non-undefined) fields are changed; others keep their current values.
 */
export async function updateCustomer(
  ctx: ServiceContext,
  id: string,
  patch: UpdateCustomerInput,
) {
  const before = await getCustomer(ctx, id); // also verifies company ownership

  // Validate incoming values only when present in patch.
  if (patch.displayName !== undefined) {
    if (!patch.displayName?.trim()) throw validation('Customer displayName is required.');

    // Uniqueness check — skip if displayName is unchanged.
    if (patch.displayName.trim() !== before.displayName) {
      const [conflict] = await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, ctx.companyId),
            sql`lower(${customers.displayName}) = lower(${patch.displayName.trim()})`,
            sql`${customers.id} <> ${id}`,
          ),
        );
      if (conflict) {
        throw validation(`A customer named "${patch.displayName.trim()}" already exists.`);
      }
    }
  }

  if (patch.email !== undefined && patch.email?.trim()) {
    assertValidEmail(patch.email.trim());
  }

  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (patch.parentId === id) throw validation('A customer cannot be its own parent.');
    const [parent] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.id, patch.parentId),
          eq(customers.companyId, ctx.companyId),
        ),
      );
    if (!parent) throw notFound('Parent customer');
  }

  if (patch.taxRateId) await assertRefInCompany(ctx, taxRates, patch.taxRateId, 'Sales tax rate');

  const termsRes = await resolvePartyTerms(ctx, { termsId: patch.termsId, terms: patch.terms });
  let shipTos = patch.shipToAddresses !== undefined ? resolveShipTos(patch.shipToAddresses) : undefined;
  if (shipTos === undefined && patch.shippingAddress !== undefined) {
    // Editing only the shipping address edits the default ship-to (as in QuickBooks), so new
    // sales forms default to the new address. Clearing it drops the default entry.
    shipTos = resolveShipTos(
      shipToListWithDefault(before.shipToAddresses as Array<Record<string, unknown>> | null, patch.shippingAddress),
    );
  }
  const taxCode =
    patch.salesTaxCodeId !== undefined && patch.salesTaxCodeId !== null
      ? await resolveSalesTaxCode(ctx, patch.salesTaxCodeId)
      : null;

  const [row] = await ctx.db
    .update(customers)
    .set({
      displayName:
        patch.displayName !== undefined ? patch.displayName.trim() : before.displayName,
      companyName:
        patch.companyName !== undefined ? patch.companyName?.trim() ?? null : before.companyName,
      email:
        patch.email !== undefined ? patch.email?.trim() ?? null : before.email,
      phone:
        patch.phone !== undefined ? patch.phone?.trim() ?? null : before.phone,
      billingAddress:
        patch.billingAddress !== undefined
          ? (patch.billingAddress as Record<string, string>) ?? null
          : before.billingAddress,
      shippingAddress:
        shipTos !== undefined
          ? defaultShipTo(shipTos as never)
          : before.shippingAddress,
      shipToAddresses:
        shipTos !== undefined
          ? ((shipTos as Array<Record<string, string | boolean>> | null) ?? null)
          : before.shipToAddresses,
      terms: termsRes ? termsRes.terms ?? before.terms : before.terms,
      termsId: termsRes ? termsRes.termsId : before.termsId,
      creditLimit:
        patch.creditLimit !== undefined
          ? patch.creditLimit != null
            ? toAmountString(patch.creditLimit)
            : null
          : before.creditLimit,
      taxable: taxCode
        ? taxCode.taxable
        : patch.taxable !== undefined
          ? patch.taxable
          : before.taxable,
      salesTaxCodeId:
        patch.salesTaxCodeId !== undefined ? taxCode?.id ?? null : before.salesTaxCodeId,
      resaleNumber:
        patch.resaleNumber !== undefined ? patch.resaleNumber?.trim() || null : before.resaleNumber,
      taxExemptionReason:
        patch.taxExemptionReason !== undefined
          ? patch.taxExemptionReason?.trim() || null
          : before.taxExemptionReason,
      taxRateId:
        patch.taxRateId !== undefined ? patch.taxRateId ?? null : before.taxRateId,
      parentId:
        patch.parentId !== undefined ? patch.parentId ?? null : before.parentId,
      notes:
        patch.notes !== undefined ? patch.notes ?? null : before.notes,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'customer',
    entityId: id,
    oldValues: before,
    newValues: row,
  });

  return row;
}

/**
 * Soft-deactivate a customer (isActive = false).
 * The customer's historical invoices/payments are preserved; they just won't appear
 * in active customer pick-lists.
 */
export async function deactivateCustomer(ctx: ServiceContext, id: string) {
  const before = await getCustomer(ctx, id);

  const [row] = await ctx.db
    .update(customers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(customers.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'customer',
    entityId: id,
    oldValues: { isActive: before.isActive },
    newValues: { isActive: false },
  });

  return row;
}

/**
 * Make an inactive customer active again (the inverse of deactivateCustomer; used by Undo).
 * Audited as an update of isActive.
 */
export async function reactivateCustomer(ctx: ServiceContext, id: string) {
  const before = await getCustomer(ctx, id);
  const [row] = await ctx.db
    .update(customers)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(customers.id, id), eq(customers.companyId, ctx.companyId)))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'customer',
    entityId: id,
    oldValues: { isActive: before.isActive },
    newValues: { isActive: true },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Balance summary (optional — reads invoices.balance_due, not the raw GL)
// ---------------------------------------------------------------------------

/**
 * Aggregate outstanding invoice balances per customer for the current company.
 * Only includes invoices that are not 'void' or 'closed'/'paid' (i.e., still open/partial/overdue).
 * This is a convenience read — it does not touch the GL directly.
 */
export async function customerBalanceSummary(
  ctx: ServiceContext,
): Promise<CustomerBalanceSummaryRow[]> {
  const rows = await ctx.db
    .select({
      customerId: invoices.customerId,
      displayName: customers.displayName,
      totalBalanceDue: sql<string>`COALESCE(SUM(${invoices.balanceDue}), 0)`,
      openInvoiceCount: sql<number>`COUNT(${invoices.id})`,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        // Only open/partial/overdue invoices count toward the balance.
        sql`${invoices.status} NOT IN ('void', 'paid', 'closed', 'draft')`,
      ),
    )
    .groupBy(invoices.customerId, customers.displayName)
    .orderBy(asc(customers.displayName));

  const result = rows.map((r) => ({
    customerId: r.customerId,
    displayName: r.displayName,
    totalBalanceDue: toAmountString(r.totalBalanceDue),
    openInvoiceCount: Number(r.openInvoiceCount),
  }));

  // Named General Journal lines on A/R are part of the customer's balance (QB parity), and
  // unapplied payments are credits against it (the whole payment was credited to A/R).
  const journal = await journalBalancesByEntity(ctx, 'ar');
  for (const [id, credit] of await unappliedPaymentsByCustomer(ctx)) {
    journal.set(id, toAmountString(Money.of(journal.get(id) ?? '0').minus(Money.of(credit))));
  }
  if (journal.size > 0) {
    const byId = new Map(result.map((r) => [r.customerId, r]));
    const missing = [...journal.keys()].filter((id) => !byId.has(id));
    const names = missing.length
      ? await ctx.db
          .select({ id: customers.id, displayName: customers.displayName })
          .from(customers)
          .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, missing)))
      : [];
    for (const n of names) {
      const row = { customerId: n.id, displayName: n.displayName, totalBalanceDue: '0.00', openInvoiceCount: 0 };
      result.push(row);
      byId.set(n.id, row);
    }
    for (const [id, amt] of journal) {
      const row = byId.get(id);
      if (row) row.totalBalanceDue = toAmountString(Money.of(row.totalBalanceDue).plus(Money.of(amt)));
    }
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return result;
}
