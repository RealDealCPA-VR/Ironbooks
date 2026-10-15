/**
 * Advanced Pricing — QuickBooks Desktop Enterprise "Price Levels" + "Advanced Pricing" parity.
 *
 * Master data (no GL impact; every mutation is audited):
 *   - Price levels ('fixed_percent' = base price +/- N%, or 'per_item' = explicit item prices),
 *     assigned to customers via customers.priceLevelId.
 *   - Price rules: CONDITIONS (items / item types / an item custom field; customers (incl. their
 *     sub-customers) / customer types / jobs; classes; sales reps; an inclusive date range; a
 *     minimum quantity) + an ADJUSTMENT (percent or amount increase/decrease from the base price
 *     or from cost, or a fixed price) + optional QUANTITY TIERS (a higher tier's adjustment
 *     replaces the base adjustment once the line quantity reaches its minimum) + ROUNDING.
 *   - Company preferences (companies.settings.advancedPricing): enabled, conflict mode
 *     ('lowest' = lowest price wins | 'priority' = highest-priority rule wins) and the default
 *     rounding applied when a rule/level has none.
 *
 * Price resolution for one line (evaluateLinePrice — pure, unit-testable):
 *   candidates = every matching active rule, the customer's price level (if it prices the item),
 *                and the customer-specific price (customer_prices, the legacy per-customer list).
 *   'lowest'   -> the lowest candidate price wins (ties: rule priority, then rule before
 *                 customer price before level).
 *   'priority' -> the highest-priority matching rule (lowest priority number) wins; with no
 *                 matching rule the customer-specific price, then the price level applies.
 *   no candidates -> the item's base sales price.
 * Special item types (discount / subtotal / payment / sales_tax) are never repriced.
 *
 * Document integration (resolveLinePricing): estimates, sales orders, invoices, sales
 * receipts and credit memos (B12) call it server-side before computing totals. The server ALWAYS recomputes the
 * expected price — the client's claim about which rule applied is never trusted:
 *   - rate omitted   -> the line is priced automatically (rule/level/base).
 *   - rate == expected -> stored provenance says which rule/level priced it.
 *   - rate != expected -> accepted as a manual override (QB lets users type over any price),
 *                         flagged `overridden: true` with the expected price kept for audit.
 * Provenance is persisted on the line's `pricing` jsonb column.
 * Known limitation: estimates, sales orders and credit memos carry no class / sales rep / job, and sales
 * receipts carry only a class, so rules conditioned on those never match there (the rule
 * editor says so).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  classes,
  companies,
  customerPrices,
  customerTypes,
  customers,
  items,
  jobs,
  priceLevelItems,
  priceLevels,
  priceRules,
  salesReps,
} from '@/lib/db/schema';
import { Money, toDecimal } from '@/lib/money';
import {
  ROUNDING_MODES,
  type AppliedPricing,
  type ConflictMode,
  type PriceAdjustment,
  type PriceCandidate,
  type PriceQuote,
  type PriceRuleConditions,
  type PriceSource,
  type PriceTier,
  type RoundingMode,
} from '@/lib/pricingShared';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { requirePermission } from './access';

// Types and constants shared with the UI live in lib/pricingShared.ts (no DB imports).
export * from '@/lib/pricingShared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PricingSettings {
  /** When false, price levels and price rules are ignored (customer-specific prices still apply). */
  enabled: boolean;
  conflictMode: ConflictMode;
  defaultRounding: RoundingMode;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  enabled: true,
  conflictMode: 'lowest',
  defaultRounding: 'none',
};

/** Item types that are priced (special QB line helpers are never repriced). */
const PRICEABLE_TYPES = new Set(['service', 'inventory', 'non_inventory', 'bundle', 'other_charge']);

// ---------------------------------------------------------------------------
// Pure helpers: rounding, adjustments
// ---------------------------------------------------------------------------

function isRoundingMode(v: unknown): v is RoundingMode {
  return typeof v === 'string' && (ROUNDING_MODES as readonly string[]).includes(v);
}

/** Round a price per a QB rounding option. Result is always a non-negative 2dp Decimal. */
export function roundPrice(value: Decimal.Value, mode: RoundingMode | null | undefined): Decimal {
  let p = new Decimal(value);
  if (p.isNegative()) p = new Decimal(0);
  const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const m = mode ?? 'none';
  if (m === 'none') return cents(p);

  const step = (inc: string, rounding: Decimal.Rounding) =>
    cents(p.dividedBy(inc).toDecimalPlaces(0, rounding).times(inc));

  const up99 = () => {
    // Smallest N.99 >= p.
    let n = p.minus('0.99').toDecimalPlaces(0, Decimal.ROUND_CEIL);
    if (n.isNegative()) n = new Decimal(0);
    return n.plus('0.99');
  };
  const down99 = (): Decimal | null => {
    // Largest N.99 <= p (null when p < 0.99).
    const n = p.minus('0.99').toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    return n.isNegative() ? null : n.plus('0.99');
  };

  switch (m) {
    case 'nearest_0.05':
      return step('0.05', Decimal.ROUND_HALF_UP);
    case 'nearest_0.10':
      return step('0.10', Decimal.ROUND_HALF_UP);
    case 'nearest_0.25':
      return step('0.25', Decimal.ROUND_HALF_UP);
    case 'nearest_0.50':
      return step('0.50', Decimal.ROUND_HALF_UP);
    case 'nearest_1.00':
      return step('1', Decimal.ROUND_HALF_UP);
    case 'up_0.05':
      return step('0.05', Decimal.ROUND_CEIL);
    case 'up_0.10':
      return step('0.10', Decimal.ROUND_CEIL);
    case 'up_1.00':
      return step('1', Decimal.ROUND_CEIL);
    case 'down_0.05':
      return step('0.05', Decimal.ROUND_FLOOR);
    case 'down_0.10':
      return step('0.10', Decimal.ROUND_FLOOR);
    case 'down_1.00':
      return step('1', Decimal.ROUND_FLOOR);
    case 'up_0.99':
      return cents(up99());
    case 'down_0.99':
      return cents(down99() ?? p);
    case 'nearest_0.99': {
      const up = up99();
      const down = down99();
      if (!down) return cents(up);
      // Tie goes up (QB rounds half up).
      return cents(up.minus(p).lessThanOrEqualTo(p.minus(down)) ? up : down);
    }
    default:
      return cents(p);
  }
}

/** Apply one adjustment to a base price / cost. Never returns a negative price. */
export function applyAdjustment(
  basePrice: Decimal.Value,
  cost: Decimal.Value,
  adj: PriceAdjustment,
): Decimal {
  const value = new Decimal(adj.value || 0);
  if (adj.method === 'fixed') return value.isNegative() ? new Decimal(0) : value;
  const base = new Decimal(adj.basis === 'cost' ? cost : basePrice);
  const delta = adj.method === 'percent' ? base.times(value).dividedBy(100) : value;
  const out = adj.direction === 'increase' ? base.plus(delta) : base.minus(delta);
  return out.isNegative() ? new Decimal(0) : out;
}

function describeAdjustment(adj: PriceAdjustment): string {
  if (adj.method === 'fixed') return `fixed ${Money.of(adj.value).toFixed(2)}`;
  const sign = adj.direction === 'increase' ? '+' : '−';
  const amt =
    adj.method === 'percent' ? `${new Decimal(adj.value).toString()}%` : Money.of(adj.value).toFixed(2);
  return `${sign}${amt} from ${adj.basis === 'cost' ? 'cost' : 'base price'}`;
}

/** YYYY-MM-DD of a Date in UTC (document dates are stored as UTC midnight). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

export interface EngineRule {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: PriceRuleConditions;
  adjustment: PriceAdjustment;
  tiers: PriceTier[] | null;
  rounding: RoundingMode | null;
  startDate: string | null;
  endDate: string | null;
  minQuantity: string | null;
}

export interface EngineItem {
  id: string;
  type: string;
  salesPrice: string | null;
  /** purchaseCost, falling back to averageCost. */
  cost: string | null;
  customFields: Record<string, string> | null;
}

export interface EngineCustomer {
  id: string;
  /** The customer and every ancestor (parent, grandparent, ...). */
  lineage: string[];
  customerTypeId: string | null;
  priceLevelId: string | null;
}

export interface EngineLevel {
  id: string;
  name: string;
  type: 'fixed_percent' | 'per_item';
  percent: string;
  /** null = company default rounding. */
  rounding: RoundingMode | null;
  isActive: boolean;
}

export interface EngineData {
  settings: PricingSettings;
  rules: EngineRule[];
  customer: EngineCustomer | null;
  level: EngineLevel | null;
  /** itemId -> price for the customer's per-item price level. */
  levelPrices: Map<string, string>;
  /** itemId -> customer-specific price (customer_prices). */
  customerPrices: Map<string, string>;
}

export interface EngineLineContext {
  /** YYYY-MM-DD document date. */
  date: string;
  quantity: Decimal.Value;
  classId: string | null;
  salesRepId: string | null;
  jobId: string | null;
}

function listHas(list: string[] | undefined, value: string | null | undefined): boolean | null {
  if (!list || list.length === 0) return null; // no condition on this dimension
  return value != null && list.includes(value);
}

/** Does this rule's condition set match the item/customer/document context? */
export function ruleMatches(
  rule: EngineRule,
  item: EngineItem,
  customer: EngineCustomer | null,
  line: EngineLineContext,
): boolean {
  if (!rule.isActive) return false;
  if (rule.startDate && line.date < rule.startDate) return false;
  if (rule.endDate && line.date > rule.endDate) return false;
  const qty = new Decimal(line.quantity);
  if (rule.minQuantity && qty.lessThan(rule.minQuantity)) return false;

  const c = rule.conditions ?? {};
  if (listHas(c.itemIds, item.id) === false) return false;
  if (listHas(c.itemTypes, item.type) === false) return false;
  if (c.itemCustomField && c.itemCustomField.name) {
    const actual = item.customFields?.[c.itemCustomField.name];
    if (actual == null) return false;
    if (actual.trim().toLowerCase() !== (c.itemCustomField.value ?? '').trim().toLowerCase()) {
      return false;
    }
  }
  if (c.customerIds && c.customerIds.length > 0) {
    if (!customer || !customer.lineage.some((id) => c.customerIds!.includes(id))) return false;
  }
  if (listHas(c.customerTypeIds, customer?.customerTypeId ?? null) === false) return false;
  if (listHas(c.jobIds, line.jobId) === false) return false;
  if (listHas(c.classIds, line.classId) === false) return false;
  if (listHas(c.salesRepIds, line.salesRepId) === false) return false;
  return true;
}

/**
 * Price an item under one rule (tiers + rounding). Returns the price and the tier used, or
 * null when the rule cannot be evaluated (cost-based adjustment on an item with unknown cost).
 */
export function priceUnderRule(
  rule: EngineRule,
  item: EngineItem,
  quantity: Decimal.Value,
  defaultRounding: RoundingMode,
): { price: Decimal; tierMinQuantity: string | null; adjustment: PriceAdjustment } | null {
  const qty = new Decimal(quantity);
  let adjustment = rule.adjustment;
  let tierMinQuantity: string | null = null;
  const tiers = [...(rule.tiers ?? [])].sort((a, b) =>
    new Decimal(b.minQuantity).comparedTo(new Decimal(a.minQuantity)),
  );
  for (const t of tiers) {
    if (qty.greaterThanOrEqualTo(t.minQuantity)) {
      adjustment = t.adjustment;
      tierMinQuantity = new Decimal(t.minQuantity).toString();
      break;
    }
  }
  // A cost-based adjustment on an item with no known cost cannot be evaluated: skip the rule
  // rather than price from a cost of 0 (which would give the item away).
  if (adjustment.method !== 'fixed' && adjustment.basis === 'cost' && item.cost == null) return null;
  const raw = applyAdjustment(item.salesPrice ?? 0, item.cost ?? 0, adjustment);
  return {
    price: roundPrice(raw, rule.rounding ?? defaultRounding),
    tierMinQuantity,
    adjustment,
  };
}

const SOURCE_RANK: Record<PriceCandidate['source'], number> = {
  price_rule: 0,
  customer_price: 1,
  price_level: 2,
};

/** Resolve the price of one line. Pure — all data is passed in. */
export function evaluateLinePrice(item: EngineItem, data: EngineData, line: EngineLineContext): PriceQuote {
  const basePrice = roundPrice(item.salesPrice ?? 0, 'none');
  const qtyStr = new Decimal(line.quantity).toString();
  const quote: PriceQuote = {
    itemId: item.id,
    quantity: qtyStr,
    basePrice: basePrice.toFixed(2),
    price: basePrice.toFixed(2),
    source: 'base',
    ruleId: null,
    ruleName: null,
    priceLevelId: null,
    priceLevelName: null,
    tierMinQuantity: null,
    label: 'Base price',
    candidates: [],
  };
  if (!PRICEABLE_TYPES.has(item.type)) return quote;

  const candidates: PriceCandidate[] = [];
  const ruleLabels = new Map<string, string>();

  if (data.settings.enabled) {
    for (const rule of data.rules) {
      if (!ruleMatches(rule, item, data.customer, line)) continue;
      const r = priceUnderRule(rule, item, line.quantity, data.settings.defaultRounding);
      if (!r) continue;
      candidates.push({
        source: 'price_rule',
        id: rule.id,
        name: rule.name,
        price: r.price.toFixed(2),
        priority: rule.priority,
        tierMinQuantity: r.tierMinQuantity,
      });
      ruleLabels.set(
        rule.id,
        `Rule: ${rule.name} (${describeAdjustment(r.adjustment)}${
          r.tierMinQuantity ? `, qty ${r.tierMinQuantity}+` : ''
        })`,
      );
    }

    const level = data.level;
    if (level && level.isActive) {
      let levelPrice: Decimal | null = null;
      if (level.type === 'per_item') {
        const p = data.levelPrices.get(item.id);
        if (p != null) levelPrice = roundPrice(p, 'none');
      } else {
        const pct = new Decimal(level.percent || 0);
        const raw = new Decimal(item.salesPrice ?? 0).times(new Decimal(100).plus(pct)).dividedBy(100);
        levelPrice = roundPrice(raw, level.rounding ?? data.settings.defaultRounding);
      }
      if (levelPrice) {
        candidates.push({
          source: 'price_level',
          id: level.id,
          name: level.name,
          price: levelPrice.toFixed(2),
          priority: null,
          tierMinQuantity: null,
        });
      }
    }
  }

  const custPrice = data.customerPrices.get(item.id);
  if (custPrice != null && data.customer) {
    candidates.push({
      source: 'customer_price',
      id: data.customer.id,
      name: 'Customer price',
      price: roundPrice(custPrice, 'none').toFixed(2),
      priority: null,
      tierMinQuantity: null,
    });
  }

  quote.candidates = candidates;
  if (candidates.length === 0) return quote;

  const byPriorityThenSource = (a: PriceCandidate, b: PriceCandidate) => {
    const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (rank !== 0) return rank;
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const byPrice = new Decimal(a.price).comparedTo(new Decimal(b.price));
    if (byPrice !== 0) return byPrice;
    return a.name.localeCompare(b.name);
  };

  let winner: PriceCandidate;
  if (data.settings.conflictMode === 'lowest') {
    winner = [...candidates].sort((a, b) => {
      const byPrice = new Decimal(a.price).comparedTo(new Decimal(b.price));
      return byPrice !== 0 ? byPrice : byPriorityThenSource(a, b);
    })[0];
  } else {
    winner = [...candidates].sort(byPriorityThenSource)[0];
  }

  quote.price = winner.price;
  quote.source = winner.source;
  quote.tierMinQuantity = winner.tierMinQuantity;
  if (winner.source === 'price_rule') {
    quote.ruleId = winner.id;
    quote.ruleName = winner.name;
    quote.label = ruleLabels.get(winner.id) ?? `Rule: ${winner.name}`;
  } else if (winner.source === 'price_level') {
    quote.priceLevelId = winner.id;
    quote.priceLevelName = winner.name;
    quote.label = `Price level: ${winner.name}`;
  } else {
    quote.label = 'Customer-specific price';
  }
  if (candidates.length > 1) {
    quote.label += data.settings.conflictMode === 'lowest' ? ' — lowest price wins' : ' — priority wins';
  }
  return quote;
}

// ---------------------------------------------------------------------------
// Settings (companies.settings.advancedPricing)
// ---------------------------------------------------------------------------

export async function getPricingSettings(ctx: ServiceContext): Promise<PricingSettings> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const raw = ((row?.settings ?? {}) as Record<string, unknown>).advancedPricing as
    | Partial<PricingSettings>
    | undefined;
  return {
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_PRICING_SETTINGS.enabled,
    conflictMode: raw?.conflictMode === 'priority' ? 'priority' : 'lowest',
    defaultRounding: isRoundingMode(raw?.defaultRounding) ? raw!.defaultRounding! : 'none',
  };
}

export async function updatePricingSettings(
  ctx: ServiceContext,
  patch: Partial<PricingSettings>,
): Promise<PricingSettings> {
  if (patch.conflictMode && patch.conflictMode !== 'lowest' && patch.conflictMode !== 'priority') {
    throw validation('conflictMode must be "lowest" or "priority".');
  }
  if (patch.defaultRounding !== undefined && !isRoundingMode(patch.defaultRounding)) {
    throw validation('Unknown rounding option.');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, tx.companyId));
    if (!row) throw notFound('Company');
    const before = await getPricingSettings(tx);
    const next: PricingSettings = {
      enabled: patch.enabled ?? before.enabled,
      conflictMode: patch.conflictMode ?? before.conflictMode,
      defaultRounding: patch.defaultRounding ?? before.defaultRounding,
    };
    await tx.db
      .update(companies)
      .set({ settings: { ...(row.settings ?? {}), advancedPricing: next }, updatedAt: new Date() })
      .where(eq(companies.id, tx.companyId));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'pricing_settings',
      entityId: tx.companyId,
      oldValues: before,
      newValues: next,
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Price levels
// ---------------------------------------------------------------------------

export interface PriceLevelInput {
  name: string;
  type: 'fixed_percent' | 'per_item';
  /** Signed percent for fixed_percent levels (-10 = 10% off). */
  percent?: string | number | null;
  rounding?: RoundingMode | null;
  isActive?: boolean;
}

function normalizeLevel(input: PriceLevelInput) {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Price level name is required.');
  if (input.type !== 'fixed_percent' && input.type !== 'per_item') {
    throw validation('Price level type must be fixed_percent or per_item.');
  }
  const percent = toDecimal(input.percent ?? 0);
  if (percent.lessThanOrEqualTo(-100)) throw validation('A price level cannot reduce prices by 100% or more.');
  if (percent.greaterThan(10000)) throw validation('Price level percent is too large.');
  const rounding = input.rounding ?? null; // null = company default
  if (rounding !== null && !isRoundingMode(rounding)) throw validation('Unknown rounding option.');
  return { name, type: input.type, percent: percent.toFixed(4), rounding };
}

export async function listPriceLevels(ctx: ServiceContext) {
  const levels = await ctx.db
    .select()
    .from(priceLevels)
    .where(eq(priceLevels.companyId, ctx.companyId))
    .orderBy(asc(priceLevels.name));
  const levelItems = await ctx.db
    .select()
    .from(priceLevelItems)
    .where(eq(priceLevelItems.companyId, ctx.companyId));
  const counts = await ctx.db
    .select({ priceLevelId: customers.priceLevelId, id: customers.id })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  return levels.map((l) => ({
    ...l,
    items: levelItems.filter((i) => i.priceLevelId === l.id),
    customerCount: counts.filter((c) => c.priceLevelId === l.id).length,
  }));
}

async function loadLevel(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(priceLevels)
    .where(and(eq(priceLevels.companyId, ctx.companyId), eq(priceLevels.id, id)));
  if (!row) throw notFound('Price level');
  return row;
}

export async function createPriceLevel(ctx: ServiceContext, input: PriceLevelInput) {
  const v = normalizeLevel(input);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(priceLevels)
      .values({ companyId: tx.companyId, ...v, isActive: input.isActive ?? true })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'price_level', entityId: row.id, newValues: row });
    return row;
  });
}

export async function updatePriceLevel(ctx: ServiceContext, id: string, input: PriceLevelInput) {
  const before = await loadLevel(ctx, id);
  const v = normalizeLevel(input);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(priceLevels)
      .set({ ...v, isActive: input.isActive ?? before.isActive, updatedAt: new Date() })
      .where(eq(priceLevels.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'price_level',
      entityId: id,
      oldValues: before,
      newValues: row,
    });
    return row;
  });
}

/** Delete a price level: unassigns it from customers and removes its item prices. */
export async function deletePriceLevel(ctx: ServiceContext, id: string) {
  const before = await loadLevel(ctx, id);
  await inTransaction(ctx, async (tx) => {
    await tx.db
      .update(customers)
      .set({ priceLevelId: null, updatedAt: new Date() })
      .where(and(eq(customers.companyId, tx.companyId), eq(customers.priceLevelId, id)));
    await tx.db.delete(priceLevelItems).where(eq(priceLevelItems.priceLevelId, id));
    await tx.db.delete(priceLevels).where(eq(priceLevels.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'price_level', entityId: id, oldValues: before });
  });
}

/**
 * Replace the explicit item prices of a per-item price level. Each price must be >= 0 and
 * every item must belong to the company. Pass an empty list to clear.
 */
export async function setPriceLevelItems(
  ctx: ServiceContext,
  levelId: string,
  entries: Array<{ itemId: string; price: string | number }>,
) {
  const level = await loadLevel(ctx, levelId);
  if (level.type !== 'per_item') {
    throw validation('Only per-item price levels have item prices.');
  }
  const seen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    if (seen.has(e.itemId)) throw validation(`Row ${i + 1}: item listed twice.`);
    seen.add(e.itemId);
    if (toDecimal(e.price).isNegative()) throw validation(`Row ${i + 1}: price cannot be negative.`);
  }
  if (seen.size > 0) {
    const found = await ctx.db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, [...seen])));
    if (found.length !== seen.size) throw notFound('Item');
  }
  return inTransaction(ctx, async (tx) => {
    const before = await tx.db.select().from(priceLevelItems).where(eq(priceLevelItems.priceLevelId, levelId));
    await tx.db.delete(priceLevelItems).where(eq(priceLevelItems.priceLevelId, levelId));
    const rows =
      entries.length > 0
        ? await tx.db
            .insert(priceLevelItems)
            .values(
              entries.map((e) => ({
                companyId: tx.companyId,
                priceLevelId: levelId,
                itemId: e.itemId,
                price: toDecimal(e.price).toFixed(4),
              })),
            )
            .returning()
        : [];
    await writeAudit(tx, {
      action: 'update',
      entityType: 'price_level',
      entityId: levelId,
      oldValues: { items: before.map((b) => ({ itemId: b.itemId, price: b.price })) },
      newValues: { items: rows.map((r) => ({ itemId: r.itemId, price: r.price })) },
    });
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Customer assignment (type + price level)
// ---------------------------------------------------------------------------

/**
 * A customer's price level belongs to Advanced Pricing (/api/pricing/levels: lists view). Every
 * path that writes customers.price_level_id (the customer routes and PATCH
 * /api/pricing/customers/:id, both in the customers area) refuses to set or clear it for users
 * without lists view. Resending the current value is harmless and passes. Trusted contexts
 * (no `access`: imports, system jobs, tests) pass.
 */
export function requirePriceLevelChangeAccess(
  ctx: ServiceContext,
  next: string | null | undefined,
  current: string | null | undefined,
): void {
  if (next === undefined) return;
  if ((next ?? null) === (current ?? null)) return;
  requirePermission(ctx, 'lists', 'view');
}

export async function assignCustomerPricing(
  ctx: ServiceContext,
  customerId: string,
  patch: { customerTypeId?: string | null; priceLevelId?: string | null },
) {
  const [before] = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!before) throw notFound('Customer');
  requirePriceLevelChangeAccess(ctx, patch.priceLevelId, before.priceLevelId);
  if (patch.priceLevelId) await loadLevel(ctx, patch.priceLevelId);
  if (patch.customerTypeId) {
    const [t] = await ctx.db
      .select({ id: customerTypes.id })
      .from(customerTypes)
      .where(and(eq(customerTypes.companyId, ctx.companyId), eq(customerTypes.id, patch.customerTypeId)));
    if (!t) throw notFound('Customer type');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(customers)
      .set({
        customerTypeId: patch.customerTypeId !== undefined ? patch.customerTypeId : before.customerTypeId,
        priceLevelId: patch.priceLevelId !== undefined ? patch.priceLevelId : before.priceLevelId,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, customerId))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'customer',
      entityId: customerId,
      oldValues: { customerTypeId: before.customerTypeId, priceLevelId: before.priceLevelId },
      newValues: { customerTypeId: row.customerTypeId, priceLevelId: row.priceLevelId },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Price rules
// ---------------------------------------------------------------------------

export interface PriceRuleInput {
  name: string;
  description?: string | null;
  isActive?: boolean;
  priority?: number;
  conditions?: PriceRuleConditions;
  adjustment: PriceAdjustment;
  tiers?: PriceTier[] | null;
  rounding?: RoundingMode | null;
  startDate?: string | null;
  endDate?: string | null;
  minQuantity?: string | number | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeAdjustment(adj: PriceAdjustment, where: string): PriceAdjustment {
  if (!adj || !['percent', 'amount', 'fixed'].includes(adj.method)) {
    throw validation(`${where}: adjustment method must be percent, amount or fixed.`);
  }
  if (adj.method !== 'fixed') {
    if (adj.basis !== 'price' && adj.basis !== 'cost') {
      throw validation(`${where}: adjustment basis must be price or cost.`);
    }
    if (adj.direction !== 'increase' && adj.direction !== 'decrease') {
      throw validation(`${where}: adjustment direction must be increase or decrease.`);
    }
  }
  const value = toDecimal(adj.value);
  if (value.isNegative()) throw validation(`${where}: adjustment value cannot be negative.`);
  if (adj.method === 'percent' && adj.direction === 'decrease' && value.greaterThan(100)) {
    throw validation(`${where}: a percent decrease cannot exceed 100%.`);
  }
  return {
    basis: adj.method === 'fixed' ? 'price' : adj.basis,
    method: adj.method,
    direction: adj.method === 'fixed' ? 'increase' : adj.direction,
    value: value.toString(),
  };
}

function cleanIds(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string' && !!x))] : [];
}

async function normalizeRule(ctx: ServiceContext, input: PriceRuleInput) {
  const name = (input.name ?? '').trim();
  if (!name) throw validation('Price rule name is required.');
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
    throw validation('Priority must be a whole number between 0 and 100000.');
  }
  const startDate = input.startDate || null;
  const endDate = input.endDate || null;
  for (const d of [startDate, endDate]) {
    if (d && !DAY_RE.test(d)) throw validation('Rule dates must be YYYY-MM-DD.');
  }
  if (startDate && endDate && startDate > endDate) {
    throw validation('Rule start date must be on or before the end date.');
  }
  const rounding = input.rounding ?? null;
  if (rounding !== null && !isRoundingMode(rounding)) throw validation('Unknown rounding option.');
  const minQuantity =
    input.minQuantity === null || input.minQuantity === undefined || input.minQuantity === ''
      ? null
      : toDecimal(input.minQuantity);
  if (minQuantity && minQuantity.lessThan(0)) throw validation('Minimum quantity cannot be negative.');

  const adjustment = normalizeAdjustment(input.adjustment, 'Rule');
  const tiers = (input.tiers ?? []).map((t, i) => {
    const mq = toDecimal(t.minQuantity);
    if (!mq.greaterThan(0)) throw validation(`Tier ${i + 1}: minimum quantity must be greater than zero.`);
    return { minQuantity: mq.toString(), adjustment: normalizeAdjustment(t.adjustment, `Tier ${i + 1}`) };
  });
  const tierQtys = new Set(tiers.map((t) => t.minQuantity));
  if (tierQtys.size !== tiers.length) throw validation('Two tiers have the same minimum quantity.');

  const c = input.conditions ?? {};
  const conditions: PriceRuleConditions = {
    itemIds: cleanIds(c.itemIds),
    itemTypes: cleanIds(c.itemTypes),
    itemCustomField:
      c.itemCustomField && c.itemCustomField.name?.trim()
        ? { name: c.itemCustomField.name.trim(), value: String(c.itemCustomField.value ?? '').trim() }
        : null,
    customerIds: cleanIds(c.customerIds),
    customerTypeIds: cleanIds(c.customerTypeIds),
    jobIds: cleanIds(c.jobIds),
    classIds: cleanIds(c.classIds),
    salesRepIds: cleanIds(c.salesRepIds),
  };
  for (const t of conditions.itemTypes ?? []) {
    if (!PRICEABLE_TYPES.has(t)) throw validation(`Item type "${t}" cannot be priced by a rule.`);
  }

  // Every referenced id must belong to this company.
  const owned = async (
    ids: string[],
    label: string,
    table: typeof items | typeof customers | typeof customerTypes | typeof jobs | typeof classes | typeof salesReps,
  ) => {
    if (ids.length === 0) return;
    const rows = await ctx.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.companyId, ctx.companyId), inArray(table.id, ids)));
    if (rows.length !== ids.length) throw notFound(label);
  };
  await owned(conditions.itemIds!, 'Item', items);
  await owned(conditions.customerIds!, 'Customer', customers);
  await owned(conditions.customerTypeIds!, 'Customer type', customerTypes);
  await owned(conditions.jobIds!, 'Job', jobs);
  await owned(conditions.classIds!, 'Class', classes);
  await owned(conditions.salesRepIds!, 'Sales rep', salesReps);

  return {
    name,
    description: input.description?.trim() || null,
    isActive: input.isActive ?? true,
    priority,
    conditions: conditions as Record<string, unknown>,
    adjustment: adjustment as unknown as Record<string, unknown>,
    tiers: tiers.length > 0 ? (tiers as unknown as Array<Record<string, unknown>>) : null,
    rounding,
    startDate,
    endDate,
    minQuantity: minQuantity ? minQuantity.toFixed(4) : null,
  };
}

export async function listPriceRules(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(priceRules)
    .where(eq(priceRules.companyId, ctx.companyId))
    .orderBy(asc(priceRules.priority), asc(priceRules.name));
}

async function loadRule(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(priceRules)
    .where(and(eq(priceRules.companyId, ctx.companyId), eq(priceRules.id, id)));
  if (!row) throw notFound('Price rule');
  return row;
}

export async function createPriceRule(ctx: ServiceContext, input: PriceRuleInput) {
  const v = await normalizeRule(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db.insert(priceRules).values({ companyId: tx.companyId, ...v }).returning();
    await writeAudit(tx, { action: 'create', entityType: 'price_rule', entityId: row.id, newValues: row });
    return row;
  });
}

export async function updatePriceRule(ctx: ServiceContext, id: string, input: PriceRuleInput) {
  const before = await loadRule(ctx, id);
  const v = await normalizeRule(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(priceRules)
      .set({ ...v, updatedAt: new Date() })
      .where(eq(priceRules.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'price_rule', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

export async function deletePriceRule(ctx: ServiceContext, id: string) {
  const before = await loadRule(ctx, id);
  await inTransaction(ctx, async (tx) => {
    await tx.db.delete(priceRules).where(eq(priceRules.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'price_rule', entityId: id, oldValues: before });
  });
}

// ---------------------------------------------------------------------------
// Data loading + quoting
// ---------------------------------------------------------------------------

export interface PricingHeader {
  customerId?: string | null;
  date: Date;
  classId?: string | null;
  salesRepId?: string | null;
  jobId?: string | null;
}

export interface QuoteLineInput {
  itemId: string;
  quantity: string | number;
  classId?: string | null;
  jobId?: string | null;
}

function toEngineRule(r: typeof priceRules.$inferSelect): EngineRule {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    isActive: r.isActive,
    conditions: (r.conditions ?? {}) as PriceRuleConditions,
    adjustment: r.adjustment as unknown as PriceAdjustment,
    tiers: (r.tiers as unknown as PriceTier[] | null) ?? null,
    rounding: isRoundingMode(r.rounding) ? r.rounding : null,
    startDate: r.startDate,
    endDate: r.endDate,
    minQuantity: r.minQuantity,
  };
}

/** Load everything the engine needs for one document (a handful of queries). */
export async function loadPricingData(
  ctx: ServiceContext,
  customerId: string | null | undefined,
  itemIds: string[],
): Promise<{ data: EngineData; items: Map<string, EngineItem> }> {
  const settings = await getPricingSettings(ctx);

  const itemMap = new Map<string, EngineItem>();
  if (itemIds.length > 0) {
    const rows = await ctx.db
      .select({
        id: items.id,
        type: items.type,
        salesPrice: items.salesPrice,
        purchaseCost: items.purchaseCost,
        averageCost: items.averageCost,
        customFields: items.customFields,
      })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, [...new Set(itemIds)])));
    for (const r of rows) {
      itemMap.set(r.id, {
        id: r.id,
        type: r.type,
        salesPrice: r.salesPrice,
        cost: r.purchaseCost ?? r.averageCost ?? null,
        customFields: r.customFields ?? null,
      });
    }
  }

  let customer: EngineCustomer | null = null;
  let level: EngineLevel | null = null;
  const levelPrices = new Map<string, string>();
  const custPrices = new Map<string, string>();

  if (customerId) {
    // Walk the parent chain (bounded — guards against a corrupted cycle).
    const lineage: string[] = [];
    let typeId: string | null = null;
    let levelId: string | null = null;
    let cursor: string | null = customerId;
    for (let depth = 0; cursor && depth < 20 && !lineage.includes(cursor); depth++) {
      const [c] = await ctx.db
        .select({
          id: customers.id,
          parentId: customers.parentId,
          customerTypeId: customers.customerTypeId,
          priceLevelId: customers.priceLevelId,
        })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, cursor)));
      if (!c) break;
      lineage.push(c.id);
      // Sub-customers/jobs inherit their parent's type and price level when they have none.
      typeId ??= c.customerTypeId;
      levelId ??= c.priceLevelId;
      cursor = c.parentId;
    }
    if (lineage.length > 0) {
      customer = { id: customerId, lineage, customerTypeId: typeId, priceLevelId: levelId };
    }

    if (levelId) {
      const [l] = await ctx.db
        .select()
        .from(priceLevels)
        .where(and(eq(priceLevels.companyId, ctx.companyId), eq(priceLevels.id, levelId)));
      if (l) {
        level = {
          id: l.id,
          name: l.name,
          type: l.type === 'per_item' ? 'per_item' : 'fixed_percent',
          percent: l.percent,
          rounding: isRoundingMode(l.rounding) ? l.rounding : null,
          isActive: l.isActive,
        };
        if (level.type === 'per_item' && itemIds.length > 0) {
          const rows = await ctx.db
            .select({ itemId: priceLevelItems.itemId, price: priceLevelItems.price })
            .from(priceLevelItems)
            .where(and(eq(priceLevelItems.priceLevelId, l.id), inArray(priceLevelItems.itemId, itemIds)));
          for (const r of rows) levelPrices.set(r.itemId, r.price);
        }
      }
    }

    if (itemIds.length > 0) {
      const rows = await ctx.db
        .select({ itemId: customerPrices.itemId, price: customerPrices.price })
        .from(customerPrices)
        .where(
          and(
            eq(customerPrices.companyId, ctx.companyId),
            eq(customerPrices.customerId, customerId),
            inArray(customerPrices.itemId, itemIds),
          ),
        );
      for (const r of rows) custPrices.set(r.itemId, r.price);
    }
  }

  const rules = settings.enabled
    ? (
        await ctx.db
          .select()
          .from(priceRules)
          .where(and(eq(priceRules.companyId, ctx.companyId), eq(priceRules.isActive, true)))
      ).map(toEngineRule)
    : [];

  return {
    data: { settings, rules, customer, level, levelPrices, customerPrices: custPrices },
    items: itemMap,
  };
}

/** Quote prices for a set of lines (the server-side pricing function the UI calls). */
export async function quotePrices(
  ctx: ServiceContext,
  header: PricingHeader,
  lines: QuoteLineInput[],
): Promise<PriceQuote[]> {
  if (header.customerId) {
    const [c] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, header.customerId)));
    if (!c) throw notFound('Customer');
  }
  const { data, items: itemMap } = await loadPricingData(
    ctx,
    header.customerId,
    lines.map((l) => l.itemId),
  );
  const date = isoDay(header.date);
  return lines.map((l, i) => {
    const item = itemMap.get(l.itemId);
    if (!item) throw notFound(`Item on line ${i + 1}`);
    const qty = toDecimal(l.quantity);
    if (qty.isNegative()) throw validation(`Line ${i + 1}: quantity cannot be negative.`);
    return evaluateLinePrice(item, data, {
      date,
      quantity: qty,
      classId: l.classId ?? header.classId ?? null,
      salesRepId: header.salesRepId ?? null,
      jobId: l.jobId ?? header.jobId ?? null,
    });
  });
}

// ---------------------------------------------------------------------------
// Document integration
// ---------------------------------------------------------------------------

/** The subset of a document line the pricing step reads. */
export interface PricedLineInput {
  itemId?: string | null;
  quantity: string | number;
  rate?: string | number | null;
  classId?: string | null;
  jobId?: string | null;
  /** Internal callers (conversions) may tag where a carried-over price came from. */
  pricing?: { origin?: string | null } | null;
}

export type PricedLine<T extends PricedLineInput> = Omit<T, 'rate' | 'pricing'> & {
  rate: string | number;
  pricing: AppliedPricing | null;
};

/**
 * Server-side pricing for a document's lines: fills omitted rates from the pricing engine and
 * records provenance (or a manual override) for every item line. Never changes a rate the
 * caller supplied. Lines without an item are not priced (an omitted rate stays 0, as before —
 * e.g. comment lines).
 */
export async function resolveLinePricing<T extends PricedLineInput>(
  ctx: ServiceContext,
  header: PricingHeader,
  lines: T[],
): Promise<Array<PricedLine<T>>> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
  const needsEngine = itemIds.length > 0;
  const { data, items: itemMap } = needsEngine
    ? await loadPricingData(ctx, header.customerId, itemIds)
    : { data: null, items: new Map<string, EngineItem>() };
  const date = isoDay(header.date);

  return lines.map((l, i) => {
    const { pricing: incoming, rate: rawRate, ...rest } = l;
    const hasRate = rawRate !== null && rawRate !== undefined && rawRate !== '';
    if (!l.itemId) {
      return { ...rest, rate: hasRate ? (rawRate as string | number) : '0', pricing: null };
    }
    const item = itemMap.get(l.itemId);
    if (!item) throw notFound(`Item ${l.itemId}`);
    const qty = toDecimal(l.quantity);
    if (!PRICEABLE_TYPES.has(item.type) || !qty.greaterThan(0) || !data) {
      // Special line types (discount/subtotal/payment/sales_tax) keep their entered amount;
      // invalid quantities are rejected by the document service's own validation.
      return {
        ...rest,
        rate: hasRate ? (rawRate as string | number) : (item.salesPrice ?? '0'),
        pricing: null,
      };
    }
    const quote = evaluateLinePrice(item, data, {
      date,
      quantity: qty,
      classId: l.classId ?? header.classId ?? null,
      salesRepId: header.salesRepId ?? null,
      jobId: l.jobId ?? header.jobId ?? null,
    });
    const overridden = hasRate && !toDecimal(rawRate).equals(toDecimal(quote.price));
    const pricing: AppliedPricing = {
      source: overridden ? 'manual' : quote.source,
      ruleId: quote.ruleId,
      ruleName: quote.ruleName,
      priceLevelId: quote.priceLevelId,
      priceLevelName: quote.priceLevelName,
      tierMinQuantity: quote.tierMinQuantity,
      basePrice: quote.basePrice,
      expectedPrice: quote.price,
      overridden,
      label: overridden ? `Price overridden (expected ${quote.price}: ${quote.label})` : quote.label,
      origin: incoming?.origin ?? null,
    };
    return { ...rest, rate: hasRate ? (rawRate as string | number) : quote.price, pricing };
  });
}
