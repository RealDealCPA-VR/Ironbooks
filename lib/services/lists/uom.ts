/**
 * Unit of Measure sets (QB Enterprise "Multiple U/M per item").
 *
 * A set has a base unit (inventory is always counted in it) and related units, each with a
 * factor = base units per one of that unit (e.g. "Case" = 12 "Each"). Default purchase / sales /
 * shipping units preselect the unit on POs, sales forms and packing slips.
 *
 * Integration hook for the document teams: a line entered in unit U converts to base quantity
 * `qty × factor(U)` via `toBaseQuantity(ctx, itemId, qty, unit)` BEFORE it touches inventory
 * (quantityOnHand, FIFO layers, movements); the rate converts the other way (rate ÷ factor per
 * base unit). Items without a U/M set use factor 1. No GL impact here.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { items, uomSetUnits, uomSets } from '@/lib/db/schema';
import { uomSetSchema } from '@/lib/validation/lists';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { isReferenced } from './references';
import { assertListDeleteAllowed } from '../accountantCopy/guard';

function parseOrThrow<T>(r: { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw validation(`${first?.path?.length ? first.path.join('.') + ': ' : ''}${first?.message ?? 'Invalid input.'}`);
}

export interface UomUnit {
  name: string;
  abbrev: string;
  /** Base units per one of this unit. */
  factor: string;
}

export interface UomSetLike {
  baseUnitName: string;
  baseUnitAbbrev: string;
  units: UomUnit[];
}

/** Base units per one `unit` of the set (base unit itself → 1). Matches name or abbreviation. */
export function unitFactor(set: UomSetLike, unit: string | null | undefined): Decimal {
  const u = unit?.trim().toLowerCase();
  if (!u || u === set.baseUnitName.toLowerCase() || u === set.baseUnitAbbrev.toLowerCase()) return new Decimal(1);
  const found = set.units.find((x) => x.name.toLowerCase() === u || x.abbrev.toLowerCase() === u);
  if (!found) throw validation(`"${unit}" is not a unit of this item's unit of measure set.`);
  return new Decimal(found.factor);
}

/** Pure conversion: quantity in `unit` → quantity in the base unit (4dp string). */
export function convertToBase(set: UomSetLike | null, qty: Decimal.Value, unit: string | null | undefined): string {
  const q = new Decimal(qty);
  if (!set) return q.toFixed(4);
  return q.times(unitFactor(set, unit)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export async function listUomSets(ctx: ServiceContext, opts: { includeInactive?: boolean } = {}) {
  const conds = [eq(uomSets.companyId, ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(uomSets.isActive, true));
  const sets = await ctx.db.select().from(uomSets).where(and(...conds)).orderBy(asc(uomSets.name));
  if (sets.length === 0) return [];
  const units = await ctx.db
    .select()
    .from(uomSetUnits)
    .where(inArray(uomSetUnits.setId, sets.map((s) => s.id)))
    .orderBy(asc(uomSetUnits.lineOrder));
  return sets.map((s) => ({ ...s, units: units.filter((u) => u.setId === s.id) }));
}

export async function getUomSet(ctx: ServiceContext, id: string) {
  const [set] = await ctx.db.select().from(uomSets).where(and(eq(uomSets.id, id), eq(uomSets.companyId, ctx.companyId)));
  if (!set) throw notFound('Unit of measure set');
  const units = await ctx.db.select().from(uomSetUnits).where(eq(uomSetUnits.setId, id)).orderBy(asc(uomSetUnits.lineOrder));
  return { ...set, units };
}

async function validateSet(ctx: ServiceContext, body: unknown, selfId?: string) {
  const input = parseOrThrow(uomSetSchema.safeParse(body ?? {}));
  const all = await ctx.db.select({ id: uomSets.id, name: uomSets.name }).from(uomSets).where(eq(uomSets.companyId, ctx.companyId));
  if (all.some((s) => s.id !== selfId && s.name.toLowerCase() === input.name.toLowerCase())) {
    throw validation(`A unit of measure set named "${input.name}" already exists.`);
  }
  const names = new Set([input.baseUnitName.toLowerCase(), input.baseUnitAbbrev.toLowerCase()]);
  const units = input.units.map((u, i) => {
    const f = new Decimal(u.factor);
    if (!f.isFinite() || f.lte(0)) throw validation(`Unit ${i + 1} ("${u.name}"): the conversion must be greater than zero.`);
    if (f.decimalPlaces() > 6) {
      // Stored as numeric(…,6): refuse rather than silently round (0.0000001 would become 0).
      throw validation(`Unit ${i + 1} ("${u.name}"): the conversion can have at most 6 decimal places.`);
    }
    for (const n of [u.name.toLowerCase(), u.abbrev.toLowerCase()]) {
      if (names.has(n)) throw validation(`The unit name or abbreviation "${n}" is used twice in this set.`);
      names.add(n);
    }
    return { name: u.name, abbrev: u.abbrev, factor: f.toFixed(6), lineOrder: i };
  });
  const known = (v: string | null | undefined) => {
    if (!v) return null;
    if (!names.has(v.toLowerCase())) throw validation(`Default unit "${v}" is not one of this set's units.`);
    return v;
  };
  return {
    header: {
      name: input.name,
      kind: input.kind,
      baseUnitName: input.baseUnitName,
      baseUnitAbbrev: input.baseUnitAbbrev,
      defaultPurchaseUnit: known(input.defaultPurchaseUnit),
      defaultSalesUnit: known(input.defaultSalesUnit),
      defaultShippingUnit: known(input.defaultShippingUnit),
      isActive: input.isActive ?? true,
    },
    units,
  };
}

export async function createUomSet(ctx: ServiceContext, body: unknown) {
  // Validated in the insert's transaction: a double-submitted "New" gets the plain duplicate-name
  // message instead of the unique index's raw error.
  return inTransaction(ctx, async (tx) => {
    const { header, units } = await validateSet(tx, body);
    const [row] = await tx.db.insert(uomSets).values({ companyId: tx.companyId, ...header }).returning();
    if (units.length) await tx.db.insert(uomSetUnits).values(units.map((u) => ({ ...u, companyId: tx.companyId, setId: row.id })));
    const created = await getUomSet(tx, row.id);
    await writeAudit(tx, { action: 'create', entityType: 'uom_set', entityId: row.id, newValues: created });
    return created;
  });
}

/**
 * Update a set. The base unit is what inventory is counted in, so it cannot change while items
 * use the set (that would silently rescale every quantity on hand).
 */
export async function updateUomSet(ctx: ServiceContext, id: string, body: unknown) {
  return inTransaction(ctx, (tx) => updateUomSetInTx(tx, id, body));
}

async function updateUomSetInTx(ctx: ServiceContext, id: string, body: unknown) {
  const before = await getUomSet(ctx, id);
  const { header, units } = await validateSet(ctx, body, id);
  const [used] = await ctx.db.select({ id: items.id }).from(items).where(eq(items.uomSetId, id)).limit(1);
  if (used && header.baseUnitName.toLowerCase() !== before.baseUnitName.toLowerCase()) {
    throw validation('Items already use this set, so its base unit cannot change. Create a new set instead.');
  }
  if (used) {
    for (const old of before.units) {
      const now = units.find((u) => u.name.toLowerCase() === old.name.toLowerCase());
      if (now && !new Decimal(now.factor).eq(old.factor)) {
        throw validation(`Items already use this set, so the conversion for "${old.name}" cannot change.`);
      }
    }
  }
  return inTransaction(ctx, async (tx) => {
    await tx.db.update(uomSets).set({ ...header, updatedAt: new Date() }).where(eq(uomSets.id, id));
    await tx.db.delete(uomSetUnits).where(eq(uomSetUnits.setId, id));
    if (units.length) await tx.db.insert(uomSetUnits).values(units.map((u) => ({ ...u, companyId: tx.companyId, setId: id })));
    const after = await getUomSet(tx, id);
    await writeAudit(tx, { action: 'update', entityType: 'uom_set', entityId: id, oldValues: before, newValues: after });
    return after;
  });
}

export async function deleteUomSet(ctx: ServiceContext, id: string) {
  await assertListDeleteAllowed(ctx, 'delete', 'unit of measure sets'); // Accountant's Copy (I1)
  const before = await getUomSet(ctx, id);
  const [used] = await ctx.db.select({ id: items.id }).from(items).where(eq(items.uomSetId, id)).limit(1);
  return inTransaction(ctx, async (tx) => {
    if (used) {
      await tx.db.update(uomSets).set({ isActive: false, updatedAt: new Date() }).where(eq(uomSets.id, id));
      await writeAudit(tx, { action: 'update', entityType: 'uom_set', entityId: id, oldValues: { isActive: before.isActive }, newValues: { isActive: false, reason: 'in use — made inactive instead of deleted' } });
      return { deleted: false, deactivated: true };
    }
    await tx.db.delete(uomSetUnits).where(eq(uomSetUnits.setId, id));
    await tx.db.delete(uomSets).where(eq(uomSets.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'uom_set', entityId: id, oldValues: before });
    return { deleted: true, deactivated: false };
  });
}

/** Load an item's U/M set (null when it has none). */
export async function itemUomSet(ctx: ServiceContext, itemId: string): Promise<UomSetLike | null> {
  const [item] = await ctx.db.select({ setId: items.uomSetId }).from(items).where(and(eq(items.id, itemId), eq(items.companyId, ctx.companyId)));
  if (!item) throw notFound('Item');
  if (!item.setId) return null;
  return getUomSet(ctx, item.setId);
}

/** Quantity in the item's base unit for a line entered in `unit` (4dp string). */
export async function toBaseQuantity(ctx: ServiceContext, itemId: string, qty: Decimal.Value, unit: string | null | undefined): Promise<string> {
  return convertToBase(await itemUomSet(ctx, itemId), qty, unit);
}

/** Is the set used by anything (for Clean Up)? */
export async function uomSetInUse(ctx: ServiceContext, id: string): Promise<boolean> {
  return isReferenced(ctx, 'uom_sets', id);
}
