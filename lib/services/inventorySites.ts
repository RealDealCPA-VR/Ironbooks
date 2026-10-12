/**
 * Advanced Inventory core — inventory sites, bins, and the site-tagged movement ledger
 * (QuickBooks Desktop Enterprise "Advanced Inventory" parity).
 *
 * ── Quantity model ─────────────────────────────────────────────────────────────────────
 * `items.quantityOnHand` remains the company-wide on-hand total, maintained exactly as before
 * by every costing path (average cost in inventory.ts, FIFO layers in fifo.ts, bills, item
 * receipts, invoices, sales receipts, credit memos, assemblies, physical counts …). Costing is
 * item-level (QB Enterprise also costs per item, not per site), so FIFO/average behaviour and
 * the GL are untouched by sites.
 *
 * Where the stock physically sits is recorded in `inventory_movements`, an append-only ledger
 * of signed quantities tagged with site / bin / serial / lot and the source document. Every
 * site-aware document writes movements in the SAME transaction as its quantity change:
 *
 *   - a NON-default site's quantity  = Σ its movements
 *   - the DEFAULT site's quantity    = quantityOnHand − Σ (all non-default sites)
 *
 * so the sum of site quantities equals quantityOnHand by construction — a sites report can never
 * disagree with the item total, and any legacy/un-sited path (imports, physical counts, assembly
 * builds without a site) naturally lands on the default site. Movements on the default site are
 * still written (they carry its bin / serial / lot detail and the transaction history) but do
 * not participate in its quantity. Changing the default site materialises the old default's
 * remainder as a `site_rebalance` movement so no quantity ever jumps between sites.
 *
 * Bins, serial numbers and lots are always derived from movements:
 *   - bin quantity            = Σ movements with that bin; "unbinned" = site quantity − Σ bins
 *   - a serial is in stock at  the (site, bin) whose movement sum is 1
 *   - a lot's quantity         = Σ movements for (item, site, lot)
 *
 * ── Guards (post-state validation) ────────────────────────────────────────────────────
 * After every batch of movements the affected (item, site) keys are re-derived and must be
 * non-negative (sites, bins, lots); a serial's company-wide sum must stay 0 or 1 (no duplicate
 * serial receipts) and can never go negative at a site/bin (you cannot sell or transfer a serial
 * that is not on hand there). The same validation covers forward postings AND reversals
 * (void/edit), so e.g. voiding a receipt whose serial was already sold is refused.
 *
 * For companies that never use a second site, the default-site check is skipped while no other
 * site holds stock — behaviour is then byte-for-byte the legacy single-location behaviour.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  inventoryBins,
  inventoryLineDetails,
  inventoryLots,
  inventoryMovements,
  inventorySites,
  items,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrackingMode = 'none' | 'serial' | 'lot';
export const TRACKING_MODES: TrackingMode[] = ['none', 'serial', 'lot'];

export const DEFAULT_SITE_NAME = 'Main Warehouse';

/**
 * Optional Advanced Inventory detail carried by any inventory-affecting document line.
 * Every field is optional: an un-sited line lands on the company's default site.
 */
export interface InventoryLineDetail {
  /** Inventory site; defaults to the company's default site. */
  siteId?: string | null;
  /** Bin within the site (optional). */
  binId?: string | null;
  /** Serial numbers — required (one per unit) for serial-tracked items. */
  serialNumbers?: string[] | null;
  /** Lot number — required for lot-tracked items. */
  lotNumber?: string | null;
  /** Lot expiration date (receipts only; recorded on the lot master). */
  lotExpiration?: Date | null;
}

export interface SiteInput {
  name: string;
  code?: string | null;
  address?: Record<string, string> | null;
  notes?: string | null;
  isDefault?: boolean;
}

export interface SitePatch {
  name?: string;
  code?: string | null;
  address?: Record<string, string> | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface MovementRequest {
  itemId: string;
  siteId?: string | null;
  binId?: string | null;
  /** Signed quantity (+ in, − out). Must be non-zero. */
  quantity: Decimal | string | number;
  serialNumbers?: string[] | null;
  lotNumber?: string | null;
  lotExpiration?: Date | null;
  date: Date;
  sourceType: string;
  sourceId?: string | null;
  sourceLine?: number | null;
  memo?: string | null;
}

type Dec = ReturnType<typeof Money.zero>;
type SiteRow = typeof inventorySites.$inferSelect;
type MovementRow = typeof inventoryMovements.$inferSelect;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Pick the Advanced Inventory detail off a document line; undefined when the line carries none of the keys. */
export function pickLineDetail(line: InventoryLineDetail | null | undefined): InventoryLineDetail | undefined {
  if (!line) return undefined;
  const keys: Array<keyof InventoryLineDetail> = ['siteId', 'binId', 'serialNumbers', 'lotNumber', 'lotExpiration'];
  if (keys.every((k) => line[k] === undefined)) return undefined;
  return {
    siteId: line.siteId ?? null,
    binId: line.binId ?? null,
    serialNumbers: line.serialNumbers ?? null,
    lotNumber: line.lotNumber ?? null,
    lotExpiration: line.lotExpiration ?? null,
  };
}

/** True when a detail actually specifies something worth storing. */
export function hasLineDetail(d: InventoryLineDetail | null | undefined): boolean {
  if (!d) return false;
  return Boolean(
    d.siteId || d.binId || (d.serialNumbers && d.serialNumbers.length > 0) || d.lotNumber || d.lotExpiration,
  );
}

/** Trim + validate a serial list (no blanks, no duplicates, max 100 chars each). */
export function normalizeSerials(serials: string[] | null | undefined): string[] {
  if (!serials) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of serials) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s.length > 100) throw validation(`Serial number "${s.slice(0, 20)}…" is longer than 100 characters.`);
    if (seen.has(s)) throw validation(`Serial number "${s}" is entered more than once.`);
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeLot(lot: string | null | undefined): string | null {
  const s = (lot ?? '').trim();
  if (!s) return null;
  if (s.length > 100) throw validation('Lot number is longer than 100 characters.');
  return s;
}

function trackingOf(item: { trackingMode: string | null }): TrackingMode {
  return (item.trackingMode as TrackingMode) || 'none';
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** The company's default site, creating "Main Warehouse" on first use. */
export async function ensureDefaultSite(ctx: ServiceContext): Promise<SiteRow> {
  const [existing] = await ctx.db
    .select()
    .from(inventorySites)
    .where(and(eq(inventorySites.companyId, ctx.companyId), eq(inventorySites.isDefault, true)));
  if (existing) return existing;

  // A partial unique index allows only one default per company; if a concurrent request won the
  // race the insert is skipped (ON CONFLICT DO NOTHING keeps any open transaction usable) and
  // we read the winner.
  const [created] = await ctx.db
    .insert(inventorySites)
    .values({ companyId: ctx.companyId, name: DEFAULT_SITE_NAME, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [winner] = await ctx.db
    .select()
    .from(inventorySites)
    .where(and(eq(inventorySites.companyId, ctx.companyId), eq(inventorySites.isDefault, true)));
  if (!winner) throw new ServiceError('INTERNAL', 'Could not create the default inventory site.');
  return winner;
}

export async function listSites(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  await ensureDefaultSite(ctx);
  const conds = [eq(inventorySites.companyId, ctx.companyId)];
  if (!opts?.includeInactive) conds.push(eq(inventorySites.isActive, true));
  const rows = await ctx.db.select().from(inventorySites).where(and(...conds));
  // Default first, then alphabetical.
  return rows.sort((a, b) =>
    a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1,
  );
}

export async function getSite(ctx: ServiceContext, id: string): Promise<SiteRow> {
  const [row] = await ctx.db
    .select()
    .from(inventorySites)
    .where(and(eq(inventorySites.companyId, ctx.companyId), eq(inventorySites.id, id)));
  if (!row) throw notFound('Inventory site');
  return row;
}

async function assertUniqueSiteName(ctx: ServiceContext, name: string, exceptId?: string) {
  const conds = [
    eq(inventorySites.companyId, ctx.companyId),
    sql`lower(${inventorySites.name}) = lower(${name})`,
  ];
  if (exceptId) conds.push(ne(inventorySites.id, exceptId));
  const [dup] = await ctx.db.select({ id: inventorySites.id }).from(inventorySites).where(and(...conds));
  if (dup) throw validation(`An inventory site named "${name}" already exists.`);
}

export async function createSite(ctx: ServiceContext, input: SiteInput): Promise<SiteRow> {
  const name = input.name?.trim();
  if (!name) throw validation('Site name is required.');

  return inTransaction(ctx, async (tx) => {
    await assertUniqueSiteName(tx, name);
    const [hasDefault] = await tx.db
      .select({ id: inventorySites.id })
      .from(inventorySites)
      .where(and(eq(inventorySites.companyId, tx.companyId), eq(inventorySites.isDefault, true)));

    const [row] = await tx.db
      .insert(inventorySites)
      .values({
        companyId: tx.companyId,
        name,
        code: input.code?.trim() || null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        // The first site of a company becomes its default automatically.
        isDefault: !hasDefault,
      })
      .returning();

    await writeAudit(tx, { action: 'create', entityType: 'inventory_site', entityId: row.id, newValues: row });

    if (input.isDefault && hasDefault) {
      return setDefaultSite(tx, row.id);
    }
    return row;
  });
}

export async function updateSite(ctx: ServiceContext, id: string, patch: SitePatch): Promise<SiteRow> {
  return inTransaction(ctx, async (tx) => {
    const before = await getSite(tx, id);
    let name = before.name;
    if (patch.name !== undefined) {
      name = patch.name.trim();
      if (!name) throw validation('Site name cannot be empty.');
      if (name.toLowerCase() !== before.name.toLowerCase()) await assertUniqueSiteName(tx, name, id);
    }
    if (patch.isActive === false && before.isActive) {
      if (before.isDefault) {
        throw validation('The default site cannot be made inactive. Choose another default site first.');
      }
      const qty = await siteQuantityTotals(tx, id);
      if (qty.some((r) => !r.quantity.isZero())) {
        throw new ServiceError(
          'CONFLICT',
          `Site "${before.name}" still holds stock. Transfer it to another site before making the site inactive.`,
        );
      }
    }

    const [row] = await tx.db
      .update(inventorySites)
      .set({
        name,
        code: patch.code !== undefined ? patch.code?.trim() || null : before.code,
        address: patch.address !== undefined ? patch.address : before.address,
        notes: patch.notes !== undefined ? patch.notes : before.notes,
        isActive: patch.isActive !== undefined ? patch.isActive : before.isActive,
      })
      .where(eq(inventorySites.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'inventory_site',
      entityId: id,
      oldValues: before,
      newValues: row,
    });
    return row;
  });
}

/**
 * Make a site the company default. The old default's derived remainder is materialised as a
 * `site_rebalance` movement first, so every site keeps exactly the quantity it had: the old
 * default becomes movement-tracked, and the new default's derived remainder equals its previous
 * movement total. Quantity-neutral; no GL impact.
 */
export async function setDefaultSite(ctx: ServiceContext, id: string): Promise<SiteRow> {
  return inTransaction(ctx, async (tx) => {
    const target = await getSite(tx, id);
    if (!target.isActive) throw validation('An inactive site cannot be the default site.');
    const oldDefault = await ensureDefaultSite(tx);
    if (oldDefault.id === target.id) return target;

    // Derived quantity of every item at the old default vs its own movement total.
    const derived = await siteQuantitiesForSite(tx, oldDefault.id);
    const ownSums = await tx.db
      .select({
        itemId: inventoryMovements.itemId,
        qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
      })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.companyId, tx.companyId), eq(inventoryMovements.siteId, oldDefault.id)))
      .groupBy(inventoryMovements.itemId);
    const ownByItem = new Map(ownSums.map((r) => [r.itemId, Money.of(r.qty)]));
    const now = new Date();
    for (const [itemId, qty] of derived) {
      const diff = qty.minus(ownByItem.get(itemId) ?? Money.zero());
      if (diff.isZero()) continue;
      await tx.db.insert(inventoryMovements).values({
        companyId: tx.companyId,
        itemId,
        siteId: oldDefault.id,
        quantity: diff.toFixed(4),
        date: now,
        sourceType: 'site_rebalance',
        memo: `Default site changed from "${oldDefault.name}" to "${target.name}"`,
      });
    }

    await tx.db.update(inventorySites).set({ isDefault: false }).where(eq(inventorySites.id, oldDefault.id));
    const [row] = await tx.db
      .update(inventorySites)
      .set({ isDefault: true })
      .where(eq(inventorySites.id, target.id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'inventory_site',
      entityId: target.id,
      oldValues: { isDefault: false, previousDefaultSiteId: oldDefault.id },
      newValues: { isDefault: true },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

export async function listBins(ctx: ServiceContext, opts?: { siteId?: string | null; includeInactive?: boolean }) {
  const conds = [eq(inventoryBins.companyId, ctx.companyId)];
  if (opts?.siteId) conds.push(eq(inventoryBins.siteId, opts.siteId));
  if (!opts?.includeInactive) conds.push(eq(inventoryBins.isActive, true));
  return ctx.db.select().from(inventoryBins).where(and(...conds)).orderBy(asc(inventoryBins.name));
}

export async function createBin(ctx: ServiceContext, input: { siteId: string; name: string }) {
  const name = input.name?.trim();
  if (!name) throw validation('Bin name is required.');
  return inTransaction(ctx, async (tx) => {
    const site = await getSite(tx, input.siteId);
    const [dup] = await tx.db
      .select({ id: inventoryBins.id })
      .from(inventoryBins)
      .where(
        and(
          eq(inventoryBins.companyId, tx.companyId),
          eq(inventoryBins.siteId, site.id),
          sql`lower(${inventoryBins.name}) = lower(${name})`,
        ),
      );
    if (dup) throw validation(`Site "${site.name}" already has a bin named "${name}".`);
    const [row] = await tx.db
      .insert(inventoryBins)
      .values({ companyId: tx.companyId, siteId: site.id, name })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'inventory_bin', entityId: row.id, newValues: row });
    return row;
  });
}

export async function updateBin(ctx: ServiceContext, id: string, patch: { name?: string; isActive?: boolean }) {
  return inTransaction(ctx, async (tx) => {
    const [before] = await tx.db
      .select()
      .from(inventoryBins)
      .where(and(eq(inventoryBins.companyId, tx.companyId), eq(inventoryBins.id, id)));
    if (!before) throw notFound('Bin');
    let name = before.name;
    if (patch.name !== undefined) {
      name = patch.name.trim();
      if (!name) throw validation('Bin name cannot be empty.');
    }
    if (patch.isActive === false && before.isActive) {
      const [row] = await tx.db
        .select({ qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)` })
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.companyId, tx.companyId), eq(inventoryMovements.binId, id)));
      if (!Money.of(row?.qty ?? '0').isZero()) {
        throw new ServiceError('CONFLICT', `Bin "${before.name}" still holds stock. Move it before making the bin inactive.`);
      }
    }
    const [row] = await tx.db
      .update(inventoryBins)
      .set({ name, isActive: patch.isActive ?? before.isActive })
      .where(eq(inventoryBins.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'inventory_bin', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Quantity derivation
// ---------------------------------------------------------------------------

/**
 * Per-item, per-site quantities for the company (optionally limited to some items).
 * Includes the derived default-site remainder; sites with a zero quantity are omitted.
 */
export async function siteQuantities(
  ctx: ServiceContext,
  itemIds?: string[],
): Promise<Map<string, Map<string, Dec>>> {
  const defaultSite = await ensureDefaultSite(ctx);
  if (itemIds && itemIds.length === 0) return new Map();

  const itemConds = [eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')];
  if (itemIds) itemConds.push(inArray(items.id, itemIds));
  const itemRows = await ctx.db
    .select({ id: items.id, quantityOnHand: items.quantityOnHand })
    .from(items)
    .where(and(...itemConds));

  const mvConds = [eq(inventoryMovements.companyId, ctx.companyId), ne(inventoryMovements.siteId, defaultSite.id)];
  if (itemIds) mvConds.push(inArray(inventoryMovements.itemId, itemIds));
  const sums = await ctx.db
    .select({
      itemId: inventoryMovements.itemId,
      siteId: inventoryMovements.siteId,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(...mvConds))
    .groupBy(inventoryMovements.itemId, inventoryMovements.siteId);

  const result = new Map<string, Map<string, Dec>>();
  for (const it of itemRows) result.set(it.id, new Map());
  for (const s of sums) {
    const m = result.get(s.itemId);
    if (!m) continue;
    const q = Money.of(s.qty);
    if (!q.isZero()) m.set(s.siteId, q);
  }
  for (const it of itemRows) {
    const m = result.get(it.id)!;
    let other = Money.zero();
    for (const q of m.values()) other = other.plus(q);
    const remainder = Money.of(it.quantityOnHand ?? '0').minus(other);
    if (!remainder.isZero()) m.set(defaultSite.id, remainder);
  }
  return result;
}

/** itemId → quantity at one site (derived remainder for the default site). */
async function siteQuantitiesForSite(ctx: ServiceContext, siteId: string): Promise<Map<string, Dec>> {
  const all = await siteQuantities(ctx);
  const out = new Map<string, Dec>();
  for (const [itemId, bySite] of all) {
    const q = bySite.get(siteId);
    if (q && !q.isZero()) out.set(itemId, q);
  }
  return out;
}

/** Rows of { itemId, quantity } held at a site. */
export async function siteQuantityTotals(ctx: ServiceContext, siteId: string) {
  const m = await siteQuantitiesForSite(ctx, siteId);
  return [...m.entries()].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/** Quantity of one item at one site. */
export async function quantityAtSite(ctx: ServiceContext, itemId: string, siteId: string): Promise<Dec> {
  const all = await siteQuantities(ctx, [itemId]);
  return all.get(itemId)?.get(siteId) ?? Money.zero();
}

export interface BinQuantityRow {
  itemId: string;
  siteId: string;
  binId: string;
  quantity: string;
}

/** Bin-level quantities (movement sums), non-zero only. */
export async function binQuantities(
  ctx: ServiceContext,
  opts?: { itemIds?: string[]; siteId?: string | null },
): Promise<BinQuantityRow[]> {
  const conds = [eq(inventoryMovements.companyId, ctx.companyId), sql`${inventoryMovements.binId} IS NOT NULL`];
  if (opts?.itemIds) {
    if (opts.itemIds.length === 0) return [];
    conds.push(inArray(inventoryMovements.itemId, opts.itemIds));
  }
  if (opts?.siteId) conds.push(eq(inventoryMovements.siteId, opts.siteId));
  const rows = await ctx.db
    .select({
      itemId: inventoryMovements.itemId,
      siteId: inventoryMovements.siteId,
      binId: inventoryMovements.binId,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(...conds))
    .groupBy(inventoryMovements.itemId, inventoryMovements.siteId, inventoryMovements.binId);
  return rows
    .filter((r) => r.binId && !Money.of(r.qty).isZero())
    .map((r) => ({ itemId: r.itemId, siteId: r.siteId, binId: r.binId!, quantity: Money.of(r.qty).toFixed(4) }));
}

export interface SerialLocation {
  itemId: string;
  serialNumber: string;
  siteId: string;
  binId: string | null;
}

/** Serial numbers currently in stock (movement sum = 1 at a site/bin). */
export async function serialsInStock(
  ctx: ServiceContext,
  opts?: { itemIds?: string[]; siteId?: string | null; serialNumbers?: string[] },
): Promise<SerialLocation[]> {
  const conds = [eq(inventoryMovements.companyId, ctx.companyId), sql`${inventoryMovements.serialNumber} IS NOT NULL`];
  if (opts?.itemIds) {
    if (opts.itemIds.length === 0) return [];
    conds.push(inArray(inventoryMovements.itemId, opts.itemIds));
  }
  if (opts?.siteId) conds.push(eq(inventoryMovements.siteId, opts.siteId));
  if (opts?.serialNumbers) {
    if (opts.serialNumbers.length === 0) return [];
    conds.push(inArray(inventoryMovements.serialNumber, opts.serialNumbers));
  }
  const rows = await ctx.db
    .select({
      itemId: inventoryMovements.itemId,
      serialNumber: inventoryMovements.serialNumber,
      siteId: inventoryMovements.siteId,
      binId: inventoryMovements.binId,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(...conds))
    .groupBy(
      inventoryMovements.itemId,
      inventoryMovements.serialNumber,
      inventoryMovements.siteId,
      inventoryMovements.binId,
    );
  return rows
    .filter((r) => Money.of(r.qty).greaterThan(0))
    .map((r) => ({ itemId: r.itemId, serialNumber: r.serialNumber!, siteId: r.siteId, binId: r.binId ?? null }));
}

// ---------------------------------------------------------------------------
// Movement posting
// ---------------------------------------------------------------------------

interface ItemMeta {
  id: string;
  name: string;
  type: string;
  trackingMode: string;
}

async function loadItemMeta(ctx: ServiceContext, itemIds: string[]): Promise<Map<string, ItemMeta>> {
  if (itemIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: items.id, name: items.name, type: items.type, trackingMode: items.trackingMode })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Plan where an outbound quantity without an explicit bin is taken from: unbinned stock
 * first, then bins in name order. Returns the draws (binId null = unbinned); any shortfall
 * is left unbinned so post-validation reports it with a clear message.
 *
 *  - Lots are fully movement-tracked, so the plan uses the lot's current buckets.
 *  - Otherwise the unbinned bucket is site quantity − Σ bins. Callers record movements
 *    AFTER the document's other effects (on-hand total updated; a transfer's inbound rows
 *    written first), so the default site's derived quantity is already the post-move value,
 *    while a non-default site's movement sum is still the pre-move value.
 */
async function planOutboundDraws(
  ctx: ServiceContext,
  params: { itemId: string; siteId: string; isDefaultSite: boolean; lotNumber: string | null; quantity: Dec },
): Promise<Array<{ binId: string | null; quantity: Dec }>> {
  const { itemId, siteId, lotNumber, quantity } = params;
  const conds = [
    eq(inventoryMovements.companyId, ctx.companyId),
    eq(inventoryMovements.itemId, itemId),
    eq(inventoryMovements.siteId, siteId),
  ];
  if (lotNumber) conds.push(eq(inventoryMovements.lotNumber, lotNumber));
  const rows = await ctx.db
    .select({
      binId: inventoryMovements.binId,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(...conds))
    .groupBy(inventoryMovements.binId);
  const binIds = rows.map((r) => r.binId).filter(Boolean) as string[];
  if (binIds.length === 0) return [{ binId: null, quantity }];
  const names = new Map(
    (
      await ctx.db
        .select({ id: inventoryBins.id, name: inventoryBins.name })
        .from(inventoryBins)
        .where(inArray(inventoryBins.id, binIds))
    ).map((b) => [b.id, b.name]),
  );
  const binned = rows
    .filter((r) => r.binId)
    .map((r) => ({ binId: r.binId as string, quantity: Money.of(r.qty), name: names.get(r.binId!) ?? '' }))
    .filter((r) => r.quantity.greaterThan(0))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (binned.length === 0) return [{ binId: null, quantity }];
  const binTotal = binned.reduce((s, b) => s.plus(b.quantity), Money.zero());

  // How much must come out of bins (the rest comes from unbinned stock).
  let fromBins: Dec;
  if (lotNumber) {
    const unbinned = Money.of(rows.find((r) => !r.binId)?.qty ?? '0');
    const fromUnbinned = unbinned.greaterThan(0) ? (unbinned.lessThan(quantity) ? unbinned : quantity) : Money.zero();
    fromBins = quantity.minus(fromUnbinned);
  } else {
    const siteNow = await quantityAtSite(ctx, itemId, siteId);
    const siteAfter = params.isDefaultSite ? siteNow : siteNow.minus(quantity);
    const unbinnedAfter = siteAfter.minus(binTotal);
    fromBins = unbinnedAfter.isNegative() ? unbinnedAfter.abs() : Money.zero();
    if (fromBins.greaterThan(quantity)) fromBins = quantity;
  }

  const draws: Array<{ binId: string | null; quantity: Dec }> = [];
  let remaining = fromBins;
  for (const b of binned) {
    if (!remaining.greaterThan(0)) break;
    const take = remaining.lessThan(b.quantity) ? remaining : b.quantity;
    draws.push({ binId: b.binId, quantity: take });
    remaining = remaining.minus(take);
  }
  const drawnFromBins = fromBins.minus(remaining);
  const unbinnedPart = quantity.minus(drawnFromBins);
  if (unbinnedPart.greaterThan(0)) draws.unshift({ binId: null, quantity: unbinnedPart });
  return draws;
}

/** Find-or-update the lot master row (expiration date: latest non-null value wins). */
async function upsertLot(
  ctx: ServiceContext,
  itemId: string,
  lotNumber: string,
  expiration: Date | null | undefined,
): Promise<void> {
  const [existing] = await ctx.db
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.companyId, ctx.companyId),
        eq(inventoryLots.itemId, itemId),
        eq(inventoryLots.lotNumber, lotNumber),
      ),
    );
  if (!existing) {
    await ctx.db.insert(inventoryLots).values({
      companyId: ctx.companyId,
      itemId,
      lotNumber,
      expirationDate: expiration ?? null,
    });
  } else if (expiration && existing.expirationDate?.getTime() !== expiration.getTime()) {
    await ctx.db.update(inventoryLots).set({ expirationDate: expiration }).where(eq(inventoryLots.id, existing.id));
  }
}

interface AffectedKeys {
  sites: Map<string, Set<string>>; // itemId -> siteIds
  serials: Map<string, Set<string>>; // itemId -> serials
  lots: Map<string, Set<string>>; // itemId -> lots
}

function newAffected(): AffectedKeys {
  return { sites: new Map(), serials: new Map(), lots: new Map() };
}

function addKey(m: Map<string, Set<string>>, k: string, v: string) {
  const s = m.get(k) ?? new Set<string>();
  s.add(v);
  m.set(k, s);
}

/**
 * Write movements for a batch of requests (one source document), validating site/bin
 * ownership and the item's serial/lot tracking rules, then re-derive and validate the
 * affected keys. Must run inside the caller's transaction AFTER the item's on-hand total has
 * been updated (the default-site check reads quantityOnHand).
 */
export async function recordMovements(
  tx: ServiceContext,
  requests: MovementRequest[],
  opts?: { enforceTracking?: boolean },
): Promise<MovementRow[]> {
  const enforce = opts?.enforceTracking !== false;
  const meta = await loadItemMeta(tx, [...new Set(requests.map((r) => r.itemId))]);
  const relevant = requests.filter((r) => meta.get(r.itemId)?.type === 'inventory');
  if (relevant.length === 0) return [];

  const defaultSite = await ensureDefaultSite(tx);
  const siteIds = [...new Set(relevant.map((r) => r.siteId).filter(Boolean) as string[])];
  const siteRows = siteIds.length
    ? await tx.db
        .select()
        .from(inventorySites)
        .where(and(eq(inventorySites.companyId, tx.companyId), inArray(inventorySites.id, siteIds)))
    : [];
  const siteById = new Map<string, SiteRow>([[defaultSite.id, defaultSite], ...siteRows.map((s) => [s.id, s] as const)]);
  const binIds = [...new Set(relevant.map((r) => r.binId).filter(Boolean) as string[])];
  const binRows = binIds.length
    ? await tx.db
        .select()
        .from(inventoryBins)
        .where(and(eq(inventoryBins.companyId, tx.companyId), inArray(inventoryBins.id, binIds)))
    : [];
  const binById = new Map(binRows.map((b) => [b.id, b]));

  const affected = newAffected();
  const inserted: MovementRow[] = [];

  // Default-site outbound rows go last: the default site's quantity is derived from the other
  // sites, so its bin planning must see every other row of this batch first.
  const isDefaultOut = (r: MovementRequest) =>
    (r.siteId || defaultSite.id) === defaultSite.id && Money.of(r.quantity).isNegative();
  const ordered = [...relevant.filter((r) => !isDefaultOut(r)), ...relevant.filter(isDefaultOut)];

  for (const req of ordered) {
    const item = meta.get(req.itemId)!;
    const qty = Money.of(req.quantity);
    if (qty.isZero()) continue;

    const siteId = req.siteId || defaultSite.id;
    const site = siteById.get(siteId);
    if (!site) throw notFound(`Inventory site ${siteId}`);
    if (!site.isActive) throw validation(`Inventory site "${site.name}" is inactive.`);

    let binId: string | null = req.binId || null;
    if (binId) {
      const bin = binById.get(binId);
      if (!bin) throw notFound(`Bin ${binId}`);
      if (bin.siteId !== siteId) throw validation(`Bin "${bin.name}" does not belong to site "${site.name}".`);
      if (!bin.isActive) throw validation(`Bin "${bin.name}" is inactive.`);
    }

    const mode = trackingOf(item);
    const serials = normalizeSerials(req.serialNumbers);
    const lot = normalizeLot(req.lotNumber);
    if (mode !== 'serial' && serials.length > 0) {
      throw validation(`Item "${item.name}" does not track serial numbers.`);
    }
    if (mode !== 'lot' && lot) {
      throw validation(`Item "${item.name}" does not track lot numbers.`);
    }

    const base = {
      companyId: tx.companyId,
      itemId: req.itemId,
      siteId,
      date: req.date,
      sourceType: req.sourceType,
      sourceId: req.sourceId ?? null,
      sourceLine: req.sourceLine ?? null,
      memo: req.memo ?? null,
    };
    addKey(affected.sites, req.itemId, siteId);

    if (mode === 'serial') {
      const units = qty.abs();
      if (enforce) {
        if (!units.isInteger()) {
          throw validation(`Item "${item.name}" is serial-tracked: quantities must be whole units.`);
        }
        if (serials.length !== units.toNumber()) {
          throw validation(
            `Item "${item.name}" is serial-tracked: enter exactly ${units.toFixed(0)} serial number(s) (got ${serials.length}).`,
          );
        }
      }
      const sign = qty.isNegative() ? '-1.0000' : '1.0000';
      // Outbound without a bin: take each serial out of the bin it currently sits in.
      let currentBin = new Map<string, string | null>();
      if (qty.isNegative() && !binId && serials.length > 0) {
        const locs = await serialsInStock(tx, { itemIds: [req.itemId], siteId, serialNumbers: serials });
        currentBin = new Map(locs.map((l) => [l.serialNumber, l.binId]));
      }
      for (const serial of serials) {
        const [row] = await tx.db
          .insert(inventoryMovements)
          .values({ ...base, binId: binId ?? currentBin.get(serial) ?? null, quantity: sign, serialNumber: serial })
          .returning();
        inserted.push(row);
        addKey(affected.serials, req.itemId, serial);
      }
      // Lenient mode (reversal copies / legacy): any units without a serial still move.
      const leftover = units.minus(serials.length);
      if (!enforce && leftover.greaterThan(0)) {
        const [row] = await tx.db
          .insert(inventoryMovements)
          .values({ ...base, binId, quantity: (qty.isNegative() ? leftover.negated() : leftover).toFixed(4) })
          .returning();
        inserted.push(row);
      }
      continue;
    }

    if (mode === 'lot') {
      if (!lot && enforce) throw validation(`Item "${item.name}" is lot-tracked: enter a lot number.`);
      if (lot) {
        addKey(affected.lots, req.itemId, lot);
        if (qty.greaterThan(0)) await upsertLot(tx, req.itemId, lot, req.lotExpiration ?? null);
      }
    }

    // Outbound without an explicit bin: unbinned stock first, then bins by name.
    if (qty.isNegative() && !binId) {
      const draws = await planOutboundDraws(tx, {
        itemId: req.itemId,
        siteId,
        isDefaultSite: siteId === defaultSite.id,
        lotNumber: lot,
        quantity: qty.abs(),
      });
      for (const d of draws) {
        const [row] = await tx.db
          .insert(inventoryMovements)
          .values({ ...base, binId: d.binId, quantity: d.quantity.negated().toFixed(4), lotNumber: lot })
          .returning();
        inserted.push(row);
      }
      continue;
    }

    const [row] = await tx.db
      .insert(inventoryMovements)
      .values({ ...base, binId, quantity: qty.toFixed(4), lotNumber: lot })
      .returning();
    inserted.push(row);
  }

  await assertMovementState(tx, affected);
  return inserted;
}

/**
 * Reverse every still-active movement of a source document (void / edit). Reversal rows copy
 * the originals negated (same site, bin, serial, lot, date) and are validated like any other
 * movement — e.g. un-receiving a serial that has since been sold is refused.
 */
export async function reverseSourceMovements(
  tx: ServiceContext,
  sourceType: string,
  sourceId: string,
  opts?: { lineOrders?: number[] },
): Promise<number> {
  const conds = [
    eq(inventoryMovements.companyId, tx.companyId),
    eq(inventoryMovements.sourceType, sourceType),
    eq(inventoryMovements.sourceId, sourceId),
    isNull(inventoryMovements.reversalOfId),
    isNull(inventoryMovements.reversedAt),
  ];
  if (opts?.lineOrders) {
    if (opts.lineOrders.length === 0) return 0;
    conds.push(inArray(inventoryMovements.sourceLine, opts.lineOrders));
  }
  const originals = await tx.db.select().from(inventoryMovements).where(and(...conds));
  if (originals.length === 0) return 0;

  const affected = newAffected();
  const now = new Date();
  for (const m of originals) {
    await tx.db.insert(inventoryMovements).values({
      companyId: tx.companyId,
      itemId: m.itemId,
      siteId: m.siteId,
      binId: m.binId,
      quantity: Money.of(m.quantity).negated().toFixed(4),
      serialNumber: m.serialNumber,
      lotNumber: m.lotNumber,
      date: m.date,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      sourceLine: m.sourceLine,
      reversalOfId: m.id,
      memo: m.memo,
    });
    addKey(affected.sites, m.itemId, m.siteId);
    if (m.serialNumber) addKey(affected.serials, m.itemId, m.serialNumber);
    if (m.lotNumber) addKey(affected.lots, m.itemId, m.lotNumber);
  }
  await tx.db
    .update(inventoryMovements)
    .set({ reversedAt: now })
    .where(inArray(inventoryMovements.id, originals.map((m) => m.id)));

  await assertMovementState(tx, affected);
  return originals.length;
}

/**
 * Re-derive and validate the affected keys (see module header). Throws CONFLICT with a
 * user-readable message naming the item and site.
 */
async function assertMovementState(tx: ServiceContext, affected: AffectedKeys): Promise<void> {
  const itemIds = [...new Set([...affected.sites.keys(), ...affected.serials.keys(), ...affected.lots.keys()])];
  if (itemIds.length === 0) return;
  const defaultSite = await ensureDefaultSite(tx);
  const itemRows = await tx.db
    .select({ id: items.id, name: items.name, quantityOnHand: items.quantityOnHand })
    .from(items)
    .where(and(eq(items.companyId, tx.companyId), inArray(items.id, itemIds)));
  const itemById = new Map(itemRows.map((r) => [r.id, r]));
  const siteRows = await tx.db
    .select({ id: inventorySites.id, name: inventorySites.name })
    .from(inventorySites)
    .where(eq(inventorySites.companyId, tx.companyId));
  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
  const binName = async (binId: string) => {
    const [b] = await tx.db.select({ name: inventoryBins.name }).from(inventoryBins).where(eq(inventoryBins.id, binId));
    return b?.name ?? binId;
  };

  // --- Site and bin quantities -------------------------------------------------------
  for (const [itemId, sites] of affected.sites) {
    const item = itemById.get(itemId);
    if (!item) continue;
    const rows = await tx.db
      .select({
        siteId: inventoryMovements.siteId,
        binId: inventoryMovements.binId,
        qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
      })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.companyId, tx.companyId), eq(inventoryMovements.itemId, itemId)))
      .groupBy(inventoryMovements.siteId, inventoryMovements.binId);

    const siteSum = new Map<string, Dec>();
    for (const r of rows) siteSum.set(r.siteId, (siteSum.get(r.siteId) ?? Money.zero()).plus(Money.of(r.qty)));
    let nonDefault = Money.zero();
    for (const [sid, q] of siteSum) if (sid !== defaultSite.id) nonDefault = nonDefault.plus(q);

    for (const siteId of sites) {
      let qty: Dec;
      if (siteId === defaultSite.id) {
        qty = Money.of(item.quantityOnHand ?? '0').minus(nonDefault);
        // Legacy single-site behaviour: nothing to police while no other site holds stock.
        if (qty.isNegative() && nonDefault.greaterThan(0)) {
          throw new ServiceError(
            'CONFLICT',
            `Not enough "${item.name}" at site "${siteName.get(siteId)}" (short by ${qty.abs().toFixed(4)}). ` +
              'Choose the site that holds the stock, or transfer it first.',
          );
        }
      } else {
        qty = siteSum.get(siteId) ?? Money.zero();
        if (qty.isNegative()) {
          throw new ServiceError(
            'CONFLICT',
            `Not enough "${item.name}" at site "${siteName.get(siteId)}" (short by ${qty.abs().toFixed(4)}).`,
          );
        }
      }
      const binRows = rows.filter((r) => r.siteId === siteId && r.binId);
      if (binRows.length === 0) continue;
      let binTotal = Money.zero();
      for (const b of binRows) {
        const bq = Money.of(b.qty);
        if (bq.isNegative()) {
          throw new ServiceError(
            'CONFLICT',
            `Not enough "${item.name}" in bin "${await binName(b.binId!)}" at site "${siteName.get(siteId)}" (short by ${bq.abs().toFixed(4)}).`,
          );
        }
        binTotal = binTotal.plus(bq);
      }
      if (binTotal.greaterThan(qty) && qty.greaterThanOrEqualTo(0)) {
        throw new ServiceError(
          'CONFLICT',
          `Bin quantities of "${item.name}" at site "${siteName.get(siteId)}" (${binTotal.toFixed(4)}) exceed the site quantity (${qty.toFixed(4)}). Specify the bin the stock is taken from.`,
        );
      }
    }
  }

  // --- Serial numbers ------------------------------------------------------------------
  for (const [itemId, serials] of affected.serials) {
    const item = itemById.get(itemId);
    const list = [...serials];
    const rows = await tx.db
      .select({
        serialNumber: inventoryMovements.serialNumber,
        siteId: inventoryMovements.siteId,
        binId: inventoryMovements.binId,
        qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.companyId, tx.companyId),
          eq(inventoryMovements.itemId, itemId),
          inArray(inventoryMovements.serialNumber, list),
        ),
      )
      .groupBy(inventoryMovements.serialNumber, inventoryMovements.siteId, inventoryMovements.binId);
    const total = new Map<string, Dec>();
    for (const r of rows) {
      const q = Money.of(r.qty);
      total.set(r.serialNumber!, (total.get(r.serialNumber!) ?? Money.zero()).plus(q));
      if (q.isNegative()) {
        throw new ServiceError(
          'CONFLICT',
          `Serial number "${r.serialNumber}" of "${item?.name}" is not in stock at site "${siteName.get(r.siteId)}"` +
            (r.binId ? ` (bin "${await binName(r.binId)}")` : '') +
            '.',
        );
      }
      if (q.greaterThan(1)) {
        throw new ServiceError('CONFLICT', `Serial number "${r.serialNumber}" of "${item?.name}" is already in stock.`);
      }
    }
    for (const [serial, q] of total) {
      if (q.greaterThan(1)) {
        throw new ServiceError('CONFLICT', `Serial number "${serial}" of "${item?.name}" is already in stock.`);
      }
      if (q.isNegative()) {
        throw new ServiceError('CONFLICT', `Serial number "${serial}" of "${item?.name}" is not in stock.`);
      }
    }
  }

  // --- Lots --------------------------------------------------------------------------
  for (const [itemId, lots] of affected.lots) {
    const item = itemById.get(itemId);
    const rows = await tx.db
      .select({
        lotNumber: inventoryMovements.lotNumber,
        siteId: inventoryMovements.siteId,
        binId: inventoryMovements.binId,
        qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.companyId, tx.companyId),
          eq(inventoryMovements.itemId, itemId),
          inArray(inventoryMovements.lotNumber, [...lots]),
        ),
      )
      .groupBy(inventoryMovements.lotNumber, inventoryMovements.siteId, inventoryMovements.binId);
    const bySite = new Map<string, Dec>();
    for (const r of rows) {
      const k = `${r.lotNumber}|${r.siteId}`;
      bySite.set(k, (bySite.get(k) ?? Money.zero()).plus(Money.of(r.qty)));
      if (r.binId && Money.of(r.qty).isNegative()) {
        throw new ServiceError(
          'CONFLICT',
          `Not enough of lot "${r.lotNumber}" of "${item?.name}" in bin "${await binName(r.binId)}" at site "${siteName.get(r.siteId)}".`,
        );
      }
    }
    for (const [k, q] of bySite) {
      if (q.isNegative()) {
        const [lot, siteId] = k.split('|');
        throw new ServiceError(
          'CONFLICT',
          `Not enough of lot "${lot}" of "${item?.name}" at site "${siteName.get(siteId)}" (short by ${q.abs().toFixed(4)}).`,
        );
      }
    }
  }
}

/**
 * For quantity changes that carry no site (e.g. a whole-company physical count): make sure the
 * default site — which absorbs them — does not go negative while other sites hold stock.
 */
export async function assertDefaultSiteQuantities(tx: ServiceContext, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const defaultSite = await ensureDefaultSite(tx);
  const affected = newAffected();
  for (const id of itemIds) addKey(affected.sites, id, defaultSite.id);
  await assertMovementState(tx, affected);
}

// ---------------------------------------------------------------------------
// Document hooks — used by invoices, sales receipts, credit memos, bills, item receipts …
// ---------------------------------------------------------------------------

export interface DocumentInventoryLine extends InventoryLineDetail {
  lineOrder: number;
  itemId: string | null | undefined;
  quantity: string | number | Decimal;
}

/** Stored per-line detail for a source document, keyed by lineOrder. */
export async function loadDocumentInventoryDetails(
  ctx: ServiceContext,
  sourceType: string,
  sourceId: string,
): Promise<Map<number, InventoryLineDetail & { itemId: string }>> {
  const rows = await ctx.db
    .select()
    .from(inventoryLineDetails)
    .where(
      and(
        eq(inventoryLineDetails.companyId, ctx.companyId),
        eq(inventoryLineDetails.sourceType, sourceType),
        eq(inventoryLineDetails.sourceId, sourceId),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.lineOrder,
      {
        itemId: r.itemId,
        siteId: r.siteId,
        binId: r.binId,
        serialNumbers: r.serialNumbers ?? null,
        lotNumber: r.lotNumber,
        lotExpiration: r.lotExpiration,
      },
    ]),
  );
}

/**
 * Resolve each line's effective detail: explicit fields on the line win; with `carryForward`
 * a line that carries NO detail keys at all keeps the detail previously stored for the same
 * lineOrder + item (so editing a document in a form that does not show sites never silently
 * moves stock back to the default site).
 */
async function resolveLineDetails(
  tx: ServiceContext,
  sourceType: string,
  sourceId: string,
  lines: DocumentInventoryLine[],
  carryForward: boolean,
): Promise<Array<{ line: DocumentInventoryLine; detail: InventoryLineDetail | null }>> {
  const previous = carryForward ? await loadDocumentInventoryDetails(tx, sourceType, sourceId) : new Map();
  return lines.map((line) => {
    const explicit = pickLineDetail(line);
    if (explicit !== undefined) return { line, detail: explicit };
    const prev = previous.get(line.lineOrder);
    if (prev && prev.itemId === line.itemId) return { line, detail: prev };
    return { line, detail: null };
  });
}

/** Replace the stored per-line details of a source document. */
async function storeDetails(
  tx: ServiceContext,
  sourceType: string,
  sourceId: string,
  resolved: Array<{ line: DocumentInventoryLine; detail: InventoryLineDetail | null }>,
  inventoryItemIds: Set<string>,
) {
  await tx.db
    .delete(inventoryLineDetails)
    .where(
      and(
        eq(inventoryLineDetails.companyId, tx.companyId),
        eq(inventoryLineDetails.sourceType, sourceType),
        eq(inventoryLineDetails.sourceId, sourceId),
      ),
    );
  const rows = resolved
    .filter((r) => r.line.itemId && inventoryItemIds.has(r.line.itemId) && hasLineDetail(r.detail))
    .map((r) => ({
      companyId: tx.companyId,
      sourceType,
      sourceId,
      lineOrder: r.line.lineOrder,
      itemId: r.line.itemId!,
      siteId: r.detail!.siteId || null,
      binId: r.detail!.binId || null,
      serialNumbers: r.detail!.serialNumbers?.length ? normalizeSerials(r.detail!.serialNumbers) : null,
      lotNumber: normalizeLot(r.detail!.lotNumber),
      lotExpiration: r.detail!.lotExpiration ?? null,
    }));
  if (rows.length > 0) await tx.db.insert(inventoryLineDetails).values(rows);
}

async function inventoryItemSet(tx: ServiceContext, lines: DocumentInventoryLine[]): Promise<Set<string>> {
  const ids = [...new Set(lines.map((l) => l.itemId).filter(Boolean) as string[])];
  const meta = await loadItemMeta(tx, ids);
  return new Set([...meta.values()].filter((m) => m.type === 'inventory').map((m) => m.id));
}

/**
 * Save a document's per-line site/bin/serial/lot WITHOUT moving stock (pending/draft
 * documents). Lines for non-inventory items are ignored.
 */
export async function saveDocumentInventoryDetails(
  tx: ServiceContext,
  params: { sourceType: string; sourceId: string; lines: DocumentInventoryLine[]; carryForward?: boolean },
): Promise<void> {
  const invItems = await inventoryItemSet(tx, params.lines);
  const resolved = await resolveLineDetails(tx, params.sourceType, params.sourceId, params.lines, Boolean(params.carryForward));
  await storeDetails(tx, params.sourceType, params.sourceId, resolved, invItems);
}

/**
 * Post a document's site-tagged movements (and store its per-line details). `direction`
 * 'out' relieves stock (sales), 'in' adds it (receipts, returns). Call AFTER the document's
 * on-hand quantities have been updated, in the same transaction.
 */
export async function postDocumentInventory(
  tx: ServiceContext,
  params: {
    sourceType: string;
    sourceId: string;
    date: Date;
    direction: 'in' | 'out';
    lines: DocumentInventoryLine[];
    memo?: string | null;
    /** Keep previously stored detail for lines that carry none (document edits). */
    carryForward?: boolean;
    /** Only these lineOrders move stock (e.g. credit-memo lines marked restock). Details are stored for all. */
    movingLineOrders?: number[];
  },
): Promise<MovementRow[]> {
  const invItems = await inventoryItemSet(tx, params.lines);
  const resolved = await resolveLineDetails(tx, params.sourceType, params.sourceId, params.lines, Boolean(params.carryForward));
  await storeDetails(tx, params.sourceType, params.sourceId, resolved, invItems);

  const moving = params.movingLineOrders ? new Set(params.movingLineOrders) : null;
  const requests: MovementRequest[] = [];
  for (const { line, detail } of resolved) {
    if (!line.itemId || !invItems.has(line.itemId)) continue;
    if (moving && !moving.has(line.lineOrder)) continue;
    const qty = Money.of(line.quantity).abs();
    if (qty.isZero()) continue;
    requests.push({
      itemId: line.itemId,
      siteId: detail?.siteId ?? null,
      binId: detail?.binId ?? null,
      quantity: params.direction === 'in' ? qty : qty.negated(),
      serialNumbers: detail?.serialNumbers ?? null,
      lotNumber: detail?.lotNumber ?? null,
      lotExpiration: detail?.lotExpiration ?? null,
      date: params.date,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceLine: line.lineOrder,
      memo: params.memo ?? null,
    });
  }
  return recordMovements(tx, requests);
}

/** Reverse a document's movements (void / before re-posting an edit). */
export async function reverseDocumentInventory(
  tx: ServiceContext,
  sourceType: string,
  sourceId: string,
  opts?: { lineOrders?: number[] },
): Promise<number> {
  return reverseSourceMovements(tx, sourceType, sourceId, opts);
}

/** Delete stored details of a document (e.g. a deleted draft). */
export async function deleteDocumentInventoryDetails(tx: ServiceContext, sourceType: string, sourceId: string) {
  await tx.db
    .delete(inventoryLineDetails)
    .where(
      and(
        eq(inventoryLineDetails.companyId, tx.companyId),
        eq(inventoryLineDetails.sourceType, sourceType),
        eq(inventoryLineDetails.sourceId, sourceId),
      ),
    );
}

/**
 * Attach stored site/bin/serial/lot detail to a document's lines for display/editing.
 * Lines without stored detail are returned unchanged (keeps legacy response shapes intact).
 */
export async function attachInventoryDetails<T extends { lineOrder: number }>(
  ctx: ServiceContext,
  sourceType: string,
  sourceId: string,
  lines: T[],
): Promise<Array<T & Partial<InventoryLineDetail>>> {
  const details = await loadDocumentInventoryDetails(ctx, sourceType, sourceId);
  if (details.size === 0) return lines;
  return lines.map((l) => {
    const d = details.get(l.lineOrder);
    if (!d) return l;
    return {
      ...l,
      siteId: d.siteId ?? null,
      binId: d.binId ?? null,
      serialNumbers: d.serialNumbers ?? null,
      lotNumber: d.lotNumber ?? null,
      lotExpiration: d.lotExpiration ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Item tracking-mode changes
// ---------------------------------------------------------------------------

/**
 * Guard for switching an item's serial/lot tracking mode: QB only allows it while nothing is
 * on hand (otherwise existing units would have no serial/lot identity).
 */
export async function assertTrackingModeChangeAllowed(
  ctx: ServiceContext,
  item: { id: string; name: string; trackingMode: string | null; quantityOnHand: string | null },
  next: TrackingMode,
): Promise<void> {
  if (!TRACKING_MODES.includes(next)) throw validation(`Invalid tracking mode "${next}".`);
  if (trackingOf(item) === next) return;
  if (!Money.of(item.quantityOnHand ?? '0').isZero()) {
    throw validation(
      `Serial/lot tracking for "${item.name}" can only be changed while it has no quantity on hand.`,
    );
  }
}
