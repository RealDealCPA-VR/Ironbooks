/**
 * Products & Services (items) service.
 *
 * Items are the catalogue entries used on invoice lines, bill lines, and
 * purchase orders. They carry optional links to income, expense, and
 * inventory-asset accounts so downstream documents can auto-fill the
 * correct GL account without the user having to think about it.
 *
 * Posting note: items themselves carry NO journal impact — they are master
 * data. The GL side is posted when an invoice, bill, or inventory-adjustment
 * document is created and calls postJournalEntry. This service only manages
 * the item record and validates the linked account references.
 */
import { and, asc, eq, ilike, ne, sql } from 'drizzle-orm';
import { accounts, assemblyComponents, inventoryLayers, inventoryMovements, items } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { Money } from '@/lib/money';
import { isInventoryAssetAccount, qbAccountTypeLabel } from '@/lib/accountTypes';
import { assertItemTypeAllowed } from '@/lib/featureGate';
import { assertNotControlLineAccount } from './posting';
import { type TrackingMode, TRACKING_MODES, assertTrackingModeChangeAllowed } from './inventorySites';
import { assertUomSet, assertVendor, resolveSalesTaxCode } from './lists/fields';
import { assertAccountantListEdit, assertListDeleteAllowed } from './accountantCopy/guard';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ItemType =
  | 'service' | 'inventory' | 'non_inventory' | 'bundle'
  | 'other_charge' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

export interface CreateItemInput {
  name: string;
  sku?: string | null;
  type?: ItemType;
  description?: string | null;
  /** Selling price shown on invoice lines. Decimal string or number. */
  salesPrice?: string | number | null;
  /** Purchase cost used on bill lines / purchase orders. */
  purchaseCost?: string | number | null;
  /** Revenue account credited when this item is sold. */
  incomeAccountId?: string | null;
  /** Expense / COGS account debited when this item is purchased or expensed. */
  expenseAccountId?: string | null;
  /** Inventory asset account (required for type=inventory). */
  assetAccountId?: string | null;
  taxable?: boolean;
  /** Unit of measure shown on line grids / printed docs (e.g. "hr", "box", "ea"). */
  unitOfMeasure?: string | null;
  /** Advanced Inventory: scan code (unique per company). */
  barcode?: string | null;
  /** Advanced Inventory: serial/lot tracking (inventory items only). Defaults to 'none'. */
  trackingMode?: TrackingMode;
  /** Unit weight — used to allocate landed cost by weight. */
  weight?: string | number | null;
  /** Preferred vendor (drives "Create PO from reorder list" and Stock Status by Vendor). */
  preferredVendorId?: string | null;
  /** Sales Tax Code list entry; when set, `taxable` follows the code's taxable flag. */
  salesTaxCodeId?: string | null;
  /** Unit of measure set (quantities on lines convert to the set's base unit). */
  uomSetId?: string | null;
}

export interface UpdateItemInput {
  name?: string;
  sku?: string | null;
  type?: ItemType;
  description?: string | null;
  salesPrice?: string | number | null;
  purchaseCost?: string | number | null;
  incomeAccountId?: string | null;
  expenseAccountId?: string | null;
  assetAccountId?: string | null;
  taxable?: boolean;
  unitOfMeasure?: string | null;
  isActive?: boolean;
  barcode?: string | null;
  trackingMode?: TrackingMode;
  weight?: string | number | null;
  /** Preferred vendor (drives "Create PO from reorder list" and Stock Status by Vendor). */
  preferredVendorId?: string | null;
  /** Sales Tax Code list entry; when set, `taxable` follows the code's taxable flag. */
  salesTaxCodeId?: string | null;
  /** Unit of measure set (quantities on lines convert to the set's base unit). */
  uomSetId?: string | null;
}

/** A bundle (group item) component, joined with the component item's details. */
export interface BundleComponent {
  componentItemId: string;
  /** BOM quantity per ONE bundle. */
  quantity: string;
  name: string;
  sku: string | null;
  type: ItemType;
  description: string | null;
  salesPrice: string | null;
  taxable: boolean;
  unitOfMeasure: string | null;
  incomeAccountId: string | null;
}

export interface ListItemsOpts {
  /** Include soft-deleted (inactive) items. Default: false. */
  includeInactive?: boolean;
  /** Filter by item type. */
  type?: ItemType;
  /** Case-insensitive name search substring. */
  search?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Verify that an account ID belongs to this company and (optionally) has the
 * expected account type. Throws NOT_FOUND or VALIDATION on failure.
 */
async function requireAccount(
  ctx: ServiceContext,
  accountId: string,
  label: string,
  expectedType?: string,
  opts: { inventoryAsset?: boolean } = {},
): Promise<void> {
  const [row] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)));
  if (!row) throw notFound(`${label} account ${accountId}`);
  // QB never offers A/R or A/P as an item's account (QB invariant I11).
  assertNotControlLineAccount(row, `${label} account`);
  if (expectedType && row.type !== expectedType) {
    throw validation(
      `${label} account must be a "${expectedType}" account (got "${row.type}").`,
    );
  }
  // QB lists only Other Current Asset accounts as an item's Asset Account: stock value posted to a
  // bank, Undeposited Funds or a fixed asset would land in that register / the deposit picker.
  if (opts.inventoryAsset && !isInventoryAssetAccount(row)) {
    throw validation(
      `"${row.name}" is ${qbAccountTypeLabel(row) === 'Other Current Asset' ? 'Undeposited Funds' : `a ${qbAccountTypeLabel(row)} account`}. ` +
        "An item's asset account must be an Other Current Asset account such as Inventory Asset.",
    );
  }
}

/**
 * Validate and resolve all account links in a CreateItemInput or UpdateItemInput.
 * Returns a cleaned-up object that is safe to spread into a DB insert/update.
 */
async function resolveAccountLinks(
  ctx: ServiceContext,
  input: Pick<
    CreateItemInput,
    'type' | 'incomeAccountId' | 'expenseAccountId' | 'assetAccountId'
  >,
  /**
   * Whether the asset account is being chosen (a new item, or an edit that changes it): only then
   * must it be an Other Current Asset. An item already on another asset account (older files,
   * whose Edit Item offered every asset account) saves unchanged — its forms resend the account.
   */
  opts: { assetAccountChosen?: boolean } = { assetAccountChosen: true },
): Promise<void> {
  if (input.incomeAccountId) {
    await requireAccount(ctx, input.incomeAccountId, 'Income', 'revenue');
  }
  if (input.expenseAccountId) {
    await requireAccount(ctx, input.expenseAccountId, 'Expense/COGS', 'expense');
  }
  if (input.assetAccountId) {
    await requireAccount(ctx, input.assetAccountId, 'Asset', 'asset', { inventoryAsset: opts.assetAccountChosen !== false });
  }

  // Inventory items should have an asset account so inventory tracking is
  // possible. We warn rather than hard-block so imports can proceed.
  if (input.type === 'inventory' && !input.assetAccountId) {
    // Allowed — caller may add it later via updateItem.
  }
}

/**
 * Type-specific rules for the QB-parity item types.
 *  - subtotal: pure UI helper (computed from preceding lines) — must not carry
 *    prices or account links, they would never be used and only confuse.
 *  - payment: reduces the invoice balance (Dr Undeposited Funds / Cr A/R) —
 *    income/expense/asset accounts do not apply.
 *  - discount / sales_tax / other_charge: allowed to carry a salesPrice (the
 *    default amount/rate) and an income/discount account.
 */
function validateTypeRules(
  type: ItemType,
  input: Pick<
    CreateItemInput,
    'salesPrice' | 'purchaseCost' | 'incomeAccountId' | 'expenseAccountId' | 'assetAccountId'
  >,
): void {
  if (type === 'subtotal') {
    if (input.salesPrice != null || input.purchaseCost != null) {
      throw validation('Subtotal items cannot have a sales price or purchase cost — the amount is computed from the preceding lines.');
    }
    if (input.incomeAccountId || input.expenseAccountId || input.assetAccountId) {
      throw validation('Subtotal items are non-posting and cannot link to accounts.');
    }
  }
  if (type === 'payment') {
    if (input.incomeAccountId || input.expenseAccountId || input.assetAccountId) {
      throw validation('Payment items post Dr Undeposited Funds / Cr Accounts Receivable automatically and cannot link to accounts.');
    }
  }
}

/** Normalise a barcode ('' → null) and enforce per-company uniqueness. */
async function resolveBarcode(
  ctx: ServiceContext,
  barcode: string | null | undefined,
  exceptItemId?: string,
): Promise<string | null> {
  const code = barcode?.trim() || null;
  if (!code) return null;
  if (code.length > 100) throw validation('Barcode cannot be longer than 100 characters.');
  const conds = [eq(items.companyId, ctx.companyId), eq(items.barcode, code)];
  if (exceptItemId) conds.push(ne(items.id, exceptItemId));
  const [dup] = await ctx.db.select({ name: items.name }).from(items).where(and(...conds));
  if (dup) throw validation(`Barcode "${code}" is already assigned to item "${dup.name}".`);
  return code;
}

function resolveTracking(type: ItemType, mode: TrackingMode | undefined): TrackingMode {
  const m = mode ?? 'none';
  if (!TRACKING_MODES.includes(m)) throw validation(`Invalid tracking mode "${m}".`);
  if (m !== 'none' && type !== 'inventory') {
    throw validation('Serial/lot tracking is only available for inventory items.');
  }
  return m;
}

function resolveWeight(weight: string | number | null | undefined): string | null {
  if (weight == null || weight === '') return null;
  const n = Number(weight);
  if (!Number.isFinite(n) || n < 0) throw validation('Weight must be a non-negative number.');
  return String(weight);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all items for the company, with optional filtering. */
export async function listItems(ctx: ServiceContext, opts: ListItemsOpts = {}) {
  const conditions = [eq(items.companyId, ctx.companyId)];

  if (!opts.includeInactive) {
    conditions.push(eq(items.isActive, true));
  }
  if (opts.type) {
    conditions.push(eq(items.type, opts.type));
  }
  if (opts.search?.trim()) {
    conditions.push(ilike(items.name, `%${opts.search.trim()}%`));
  }

  return ctx.db
    .select()
    .from(items)
    .where(and(...conditions))
    .orderBy(asc(items.name));
}

/** Fetch a single item by ID. Throws NOT_FOUND if missing or belongs to another company. */
export async function getItem(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.companyId, ctx.companyId)));
  if (!row) throw notFound('Item');
  return row;
}

/**
 * Create a new item (product or service). Validates:
 *  - name is non-empty
 *  - name is unique within the company
 *  - linked account IDs exist, belong to this company, and have the expected type
 */
export async function createItem(ctx: ServiceContext, input: CreateItemInput) {
  // The unique-name check runs in the same transaction as the insert (two creates at once must
  // not both add the same name).
  return inTransaction(ctx, (tx) => createItemInTx(tx, input));
}

async function createItemInTx(ctx: ServiceContext, input: CreateItemInput) {
  // ── Validate name ────────────────────────────────────────────────────────
  const name = input.name?.trim();
  if (!name) throw validation('Item name is required.');

  // Enforce unique name per company (case-insensitive, like QB).
  const [dup] = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), sql`lower(${items.name}) = lower(${name})`));
  if (dup) throw validation(`An item named "${name}" already exists.`);

  // ── Validate type rules + account links ──────────────────────────────────
  validateTypeRules((input.type ?? 'service') as ItemType, input);
  await assertItemTypeAllowed(ctx, input.type);
  await resolveAccountLinks(ctx, input);
  const barcode = await resolveBarcode(ctx, input.barcode);
  const trackingMode = resolveTracking((input.type ?? 'service') as ItemType, input.trackingMode);
  const weight = resolveWeight(input.weight);
  if (input.preferredVendorId) await assertVendor(ctx, input.preferredVendorId);
  if (input.uomSetId) await assertUomSet(ctx, input.uomSetId);
  const taxCode = input.salesTaxCodeId ? await resolveSalesTaxCode(ctx, input.salesTaxCodeId) : null;

  // ── Insert ───────────────────────────────────────────────────────────────
  const [row] = await ctx.db
    .insert(items)
    .values({
      companyId: ctx.companyId,
      name,
      sku: input.sku?.trim() ?? null,
      type: (input.type ?? 'service') as ItemType,
      description: input.description?.trim() ?? null,
      salesPrice: input.salesPrice != null ? String(input.salesPrice) : null,
      purchaseCost: input.purchaseCost != null ? String(input.purchaseCost) : null,
      incomeAccountId: input.incomeAccountId ?? null,
      expenseAccountId: input.expenseAccountId ?? null,
      assetAccountId: input.assetAccountId ?? null,
      taxable: taxCode ? taxCode.taxable : input.taxable ?? true,
      salesTaxCodeId: taxCode?.id ?? null,
      preferredVendorId: input.preferredVendorId ?? null,
      uomSetId: input.uomSetId ?? null,
      unitOfMeasure: input.unitOfMeasure?.trim() || null,
      barcode,
      trackingMode,
      weight,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'item',
    entityId: row.id,
    newValues: row,
  });

  return row;
}

/**
 * An inventory item can only change to another type while it carries no stock history: once it
 * has quantity on hand, FIFO cost layers or site movements, its value sits in the inventory asset
 * account, and every inventory report / COGS path only looks at type 'inventory' items — the
 * change would strand that value in the GL (QB likewise refuses to convert an Inventory Part).
 */
async function assertInventoryTypeChangeAllowed(
  ctx: ServiceContext,
  item: { id: string; name: string; quantityOnHand: string | null },
): Promise<void> {
  const hasStock = !Money.of(item.quantityOnHand ?? '0').isZero();
  const [layer] = hasStock
    ? [undefined]
    : await ctx.db
        .select({ id: inventoryLayers.id })
        .from(inventoryLayers)
        .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, item.id)))
        .limit(1);
  const [movement] = hasStock || layer
    ? [undefined]
    : await ctx.db
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.companyId, ctx.companyId), eq(inventoryMovements.itemId, item.id)))
        .limit(1);
  if (hasStock || layer || movement) {
    throw validation(
      `"${item.name}" is an inventory item with ${hasStock ? 'quantity on hand' : 'inventory history'}, so its type cannot change. ` +
        'Create a new item of the type you need and make this one inactive instead.',
    );
  }
}

/**
 * An inventory item's asset account can only change while it holds no stock value: the value of
 * its stock was debited to the current account, and every later COGS / adjustment credits the
 * new one — the old account would keep value the item no longer carries and the new one would
 * go negative. (Stock = quantity on hand or FIFO layers with quantity remaining.)
 */
async function assertAssetAccountChangeAllowed(
  ctx: ServiceContext,
  item: { id: string; name: string; type: string; quantityOnHand: string | null; assetAccountId: string | null },
  newAssetAccountId: string | null,
): Promise<void> {
  if (item.type !== 'inventory') return;
  // A null asset account means the 1300 fallback used by every posting path.
  const effective = async (accountId: string | null) => {
    if (accountId) return accountId;
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1300')));
    return row?.id ?? null;
  };
  if ((await effective(item.assetAccountId)) === (await effective(newAssetAccountId))) return;
  const hasStock = !Money.of(item.quantityOnHand ?? '0').isZero();
  const [layer] = hasStock
    ? [undefined]
    : await ctx.db
        .select({ id: inventoryLayers.id })
        .from(inventoryLayers)
        .where(
          and(
            eq(inventoryLayers.companyId, ctx.companyId),
            eq(inventoryLayers.itemId, item.id),
            sql`${inventoryLayers.quantityRemaining} <> 0`,
          ),
        )
        .limit(1);
  if (hasStock || layer) {
    throw validation(
      `"${item.name}" has stock on hand, so its inventory asset account cannot change. ` +
        'Adjust its quantity to zero first, or create a new item that uses the other account.',
    );
  }
}

/**
 * Patch an existing item. Only supplied fields are changed. Validates name
 * uniqueness (if being changed) and account-link types.
 */
export async function updateItem(ctx: ServiceContext, id: string, patch: UpdateItemInput) {
  // Read, check and write in ONE transaction (as createItem does): two saves at once must not
  // both pass the unique-name / barcode checks (two items named alike, or the barcode index's raw
  // error), and the change and its audit row are written together.
  return inTransaction(ctx, (tx) => updateItemInTx(tx, id, patch));
}

async function updateItemInTx(ctx: ServiceContext, id: string, patch: UpdateItemInput) {
  const before = await getItem(ctx, id);
  await assertAccountantListEdit(ctx, 'item', before as Record<string, unknown>, patch as Record<string, unknown>); // I1
  // Making an item inactive (PATCH isActive: false) is deleting it: refused like deactivateItem
  // while an Accountant's Copy is out (I1).
  if (patch.isActive === false && before.isActive) await assertListDeleteAllowed(ctx, 'delete', 'items');
  if (patch.type !== undefined && patch.type !== before.type) await assertItemTypeAllowed(ctx, patch.type);
  if (patch.type !== undefined && patch.type !== before.type && before.type === 'inventory') {
    await assertInventoryTypeChangeAllowed(ctx, before);
  }
  if (patch.assetAccountId !== undefined && patch.assetAccountId !== before.assetAccountId) {
    await assertAssetAccountChangeAllowed(ctx, before, patch.assetAccountId);
  }

  // ── Name validation ──────────────────────────────────────────────────────
  let newName = before.name;
  if (patch.name !== undefined) {
    newName = patch.name.trim();
    if (!newName) throw validation('Item name cannot be empty.');
    if (newName !== before.name) {
      const [dup] = await ctx.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.companyId, ctx.companyId),
            sql`lower(${items.name}) = lower(${newName})`,
            ne(items.id, id),
          ),
        );
      if (dup) throw validation(`An item named "${newName}" already exists.`);
    }
  }

  // ── Type rules (validated against the EFFECTIVE post-patch values) ──────
  const effectiveType = (patch.type ?? before.type) as ItemType;
  validateTypeRules(effectiveType, {
    salesPrice: patch.salesPrice !== undefined ? patch.salesPrice : before.salesPrice,
    purchaseCost: patch.purchaseCost !== undefined ? patch.purchaseCost : before.purchaseCost,
    incomeAccountId:
      patch.incomeAccountId !== undefined ? patch.incomeAccountId : before.incomeAccountId,
    expenseAccountId:
      patch.expenseAccountId !== undefined ? patch.expenseAccountId : before.expenseAccountId,
    assetAccountId:
      patch.assetAccountId !== undefined ? patch.assetAccountId : before.assetAccountId,
  });

  // ── Account link validation (only for fields being patched) ─────────────
  await resolveAccountLinks(ctx, {
    type: patch.type ?? before.type,
    incomeAccountId:
      patch.incomeAccountId !== undefined ? patch.incomeAccountId : undefined,
    expenseAccountId:
      patch.expenseAccountId !== undefined ? patch.expenseAccountId : undefined,
    assetAccountId:
      patch.assetAccountId !== undefined ? patch.assetAccountId : undefined,
  }, { assetAccountChosen: patch.assetAccountId !== before.assetAccountId });

  // ── Advanced Inventory fields ───────────────────────────────────────────
  const barcode =
    patch.barcode !== undefined ? await resolveBarcode(ctx, patch.barcode, id) : before.barcode;
  let trackingMode = before.trackingMode as TrackingMode;
  if (patch.trackingMode !== undefined || patch.type !== undefined) {
    trackingMode = resolveTracking(effectiveType, patch.trackingMode ?? trackingMode);
    await assertTrackingModeChangeAllowed(ctx, before, trackingMode);
  }
  const weight = patch.weight !== undefined ? resolveWeight(patch.weight) : before.weight;
  if (patch.preferredVendorId) await assertVendor(ctx, patch.preferredVendorId);
  if (patch.uomSetId && patch.uomSetId !== before.uomSetId) {
    await assertUomSet(ctx, patch.uomSetId);
    // Inventory is counted in the set's base unit: switching sets on stocked items would
    // silently reinterpret the quantity on hand.
    if (before.type === 'inventory' && before.uomSetId && Number(before.quantityOnHand ?? 0) !== 0) {
      throw validation('This item has stock on hand, so its unit of measure set cannot change.');
    }
  }
  const taxCode =
    patch.salesTaxCodeId !== undefined && patch.salesTaxCodeId !== null
      ? await resolveSalesTaxCode(ctx, patch.salesTaxCodeId)
      : null;

  // ── Update ───────────────────────────────────────────────────────────────
  const [row] = await ctx.db
    .update(items)
    .set({
      name: newName,
      sku: patch.sku !== undefined ? (patch.sku?.trim() ?? null) : before.sku,
      type: (patch.type ?? before.type) as ItemType,
      description:
        patch.description !== undefined
          ? (patch.description?.trim() ?? null)
          : before.description,
      salesPrice:
        patch.salesPrice !== undefined
          ? patch.salesPrice != null
            ? String(patch.salesPrice)
            : null
          : before.salesPrice,
      purchaseCost:
        patch.purchaseCost !== undefined
          ? patch.purchaseCost != null
            ? String(patch.purchaseCost)
            : null
          : before.purchaseCost,
      incomeAccountId:
        patch.incomeAccountId !== undefined
          ? patch.incomeAccountId
          : before.incomeAccountId,
      expenseAccountId:
        patch.expenseAccountId !== undefined
          ? patch.expenseAccountId
          : before.expenseAccountId,
      assetAccountId:
        patch.assetAccountId !== undefined ? patch.assetAccountId : before.assetAccountId,
      taxable: taxCode ? taxCode.taxable : patch.taxable !== undefined ? patch.taxable : before.taxable,
      salesTaxCodeId: patch.salesTaxCodeId !== undefined ? taxCode?.id ?? null : before.salesTaxCodeId,
      preferredVendorId:
        patch.preferredVendorId !== undefined ? patch.preferredVendorId : before.preferredVendorId,
      uomSetId: patch.uomSetId !== undefined ? patch.uomSetId : before.uomSetId,
      unitOfMeasure:
        patch.unitOfMeasure !== undefined
          ? (patch.unitOfMeasure?.trim() || null)
          : before.unitOfMeasure,
      isActive: patch.isActive !== undefined ? patch.isActive : before.isActive,
      barcode,
      trackingMode,
      weight,
      updatedAt: new Date(),
    })
    .where(eq(items.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'item',
    entityId: id,
    oldValues: before,
    newValues: row,
  });

  return row;
}

/**
 * Soft-delete an item. Deactivated items are hidden from normal lists but
 * remain on historical documents. Hard delete is intentionally not exposed.
 */
export async function deactivateItem(ctx: ServiceContext, id: string) {
  await assertListDeleteAllowed(ctx, 'delete', 'items'); // Accountant's Copy (I1)
  return updateItem(ctx, id, { isActive: false });
}

/**
 * Return the components of a bundle (group) item, joined with each component
 * item's sales details so callers (the invoice form) can expand the bundle
 * into individual lines. Reuses the assemblyComponents BOM rows — the
 * assemblies service manages those rows; bundles simply read them.
 *
 * Returns [] when the bundle has no BOM yet (the caller keeps a plain line).
 */
export async function getBundleComponents(
  ctx: ServiceContext,
  bundleItemId: string,
): Promise<BundleComponent[]> {
  // Validate the bundle item belongs to this company (any type is tolerated so
  // assemblies can reuse this too, but the primary caller passes type=bundle).
  await getItem(ctx, bundleItemId);

  const rows = await ctx.db
    .select({
      componentItemId: assemblyComponents.componentItemId,
      quantity: assemblyComponents.quantity,
      name: items.name,
      sku: items.sku,
      type: items.type,
      description: items.description,
      salesPrice: items.salesPrice,
      taxable: items.taxable,
      unitOfMeasure: items.unitOfMeasure,
      incomeAccountId: items.incomeAccountId,
    })
    .from(assemblyComponents)
    .innerJoin(items, eq(items.id, assemblyComponents.componentItemId))
    .where(
      and(
        eq(assemblyComponents.companyId, ctx.companyId),
        eq(assemblyComponents.assemblyItemId, bundleItemId),
      ),
    )
    .orderBy(asc(items.name));

  return rows as BundleComponent[];
}

/**
 * Look up an active item by scanned code (keyboard-wedge barcode scanners type the code and
 * press Enter). Matches the barcode exactly first, then falls back to an exact,
 * case-insensitive SKU match when exactly one item has that SKU. Returns null when nothing
 * matches.
 */
export async function findItemByBarcode(ctx: ServiceContext, code: string) {
  const value = code?.trim();
  if (!value) return null;
  const [byBarcode] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.barcode, value), eq(items.isActive, true)));
  if (byBarcode) return byBarcode;
  const bySku = await ctx.db
    .select()
    .from(items)
    .where(
      and(
        eq(items.companyId, ctx.companyId),
        eq(items.isActive, true),
        sql`lower(${items.sku}) = lower(${value})`,
      ),
    )
    .limit(2);
  return bySku.length === 1 ? bySku[0] : null;
}
