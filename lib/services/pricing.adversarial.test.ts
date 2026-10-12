/**
 * Advanced pricing — independent QA (adversarial) tests.
 *
 * Pure engine: rounding edge cases, cost-based rules on items with no known cost, tier
 * boundaries, inactive levels, sub-customer targeting, conflict-mode tie-breaks.
 * Integration (hermetic PGlite dir): cross-company id injection on every pricing write path,
 * viewer-role write rejection (and nothing persisted), malformed input, company default
 * rounding on price levels, type-list hierarchy cycles, special line types never repriced,
 * invoice totals + sales tax + GL balance with rules applied, update keeping the sales rep.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  items,
  salesReps,
  taxRates,
  invoiceLines,
  priceRules,
  priceLevels,
  customerTypes,
  accounts,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice } from './invoices';
import { createType, updateType } from './typeLists';
import {
  type AppliedPricing,
  type EngineData,
  type EngineItem,
  type EngineRule,
  DEFAULT_PRICING_SETTINGS,
  assignCustomerPricing,
  createPriceLevel,
  createPriceRule,
  deletePriceLevel,
  deletePriceRule,
  evaluateLinePrice,
  quotePrices,
  roundPrice,
  setPriceLevelItems,
  updatePriceLevel,
  updatePriceRule,
  updatePricingSettings,
} from './pricing';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

function rule(partial: Partial<EngineRule>): EngineRule {
  return {
    id: partial.id ?? 'r1',
    name: partial.name ?? 'Rule',
    priority: partial.priority ?? 100,
    isActive: partial.isActive ?? true,
    conditions: partial.conditions ?? {},
    adjustment: partial.adjustment ?? { basis: 'price', method: 'percent', direction: 'decrease', value: '10' },
    tiers: partial.tiers ?? null,
    rounding: partial.rounding ?? null,
    startDate: partial.startDate ?? null,
    endDate: partial.endDate ?? null,
    minQuantity: partial.minQuantity ?? null,
  };
}

function data(partial: Partial<EngineData>): EngineData {
  return {
    settings: partial.settings ?? { ...DEFAULT_PRICING_SETTINGS },
    rules: partial.rules ?? [],
    customer: partial.customer ?? null,
    level: partial.level ?? null,
    levelPrices: partial.levelPrices ?? new Map(),
    customerPrices: partial.customerPrices ?? new Map(),
  };
}

const line = (quantity: string | number = 1, date = '2026-03-15') => ({
  date,
  quantity,
  classId: null,
  salesRepId: null,
  jobId: null,
});

describe('Advanced pricing (QA) — pure engine edge cases', () => {
  it('rounding: step modes at exact boundaries and just past them', () => {
    expect(roundPrice('12.04', 'down_0.05').toFixed(2)).toBe('12.00');
    expect(roundPrice('12.05', 'down_0.05').toFixed(2)).toBe('12.05');
    expect(roundPrice('12.01', 'up_0.10').toFixed(2)).toBe('12.10');
    expect(roundPrice('12.10', 'up_0.10').toFixed(2)).toBe('12.10');
    expect(roundPrice('12.12', 'nearest_0.25').toFixed(2)).toBe('12.00');
    expect(roundPrice('12.13', 'nearest_0.25').toFixed(2)).toBe('12.25');
    expect(roundPrice('12.75', 'nearest_0.50').toFixed(2)).toBe('13.00');
    expect(roundPrice('12.74', 'nearest_0.50').toFixed(2)).toBe('12.50');
    expect(roundPrice('12.05', 'nearest_0.10').toFixed(2)).toBe('12.10');
    // Sub-cent input is rounded to the cent before/after steps without drifting.
    expect(roundPrice('12.0049', 'none').toFixed(2)).toBe('12.00');
    expect(roundPrice('12.005', 'none').toFixed(2)).toBe('12.01');
    // .99 modes around exact N.99 and half-way points.
    expect(roundPrice('11.99', 'down_0.99').toFixed(2)).toBe('11.99');
    expect(roundPrice('12.98', 'down_0.99').toFixed(2)).toBe('11.99');
    expect(roundPrice('12.49', 'nearest_0.99').toFixed(2)).toBe('12.99'); // tie (0.50 each way) goes up
    expect(roundPrice('12.48', 'nearest_0.99').toFixed(2)).toBe('11.99');
    // Every mode yields a non-negative 2dp price.
    for (const m of ['nearest_0.05', 'down_0.05', 'down_1.00', 'down_0.99', 'nearest_0.99'] as const) {
      const p = roundPrice('0.01', m);
      expect(p.isNegative()).toBe(false);
      expect(p.decimalPlaces()).toBeLessThanOrEqual(2);
    }
  });

  it('a cost-based rule must not price an item with NO known cost at $0 (lowest-price-wins)', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '100.00', cost: null, customFields: null };
    const d = data({
      rules: [rule({ name: 'Cost plus 20%', adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '20' } })],
    });
    const q = evaluateLinePrice(item, d, line());
    // Cost unknown -> the rule cannot be evaluated; selling at 0.00 silently gives the item away.
    expect(q.price).not.toBe('0.00');
  });

  it('a cost-based rule on an item whose cost is zero-but-known still evaluates (not skipped)', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '100.00', cost: '0', customFields: null };
    const d = data({
      rules: [rule({ adjustment: { basis: 'cost', method: 'amount', direction: 'increase', value: '5' } })],
    });
    expect(evaluateLinePrice(item, d, line()).price).toBe('5.00');
  });

  it('tier boundaries are inclusive; fractional quantities just below a tier do not reach it', () => {
    const item: EngineItem = { id: 'i1', type: 'inventory', salesPrice: '10.00', cost: '4', customFields: null };
    const d = data({
      rules: [
        rule({
          adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '0' },
          tiers: [
            { minQuantity: '100', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '7' } },
            { minQuantity: '10', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '9' } },
          ],
        }),
      ],
    });
    expect(evaluateLinePrice(item, d, line('9.9999')).price).toBe('10.00');
    expect(evaluateLinePrice(item, d, line('10')).price).toBe('9.00');
    expect(evaluateLinePrice(item, d, line('99.9999')).price).toBe('9.00');
    expect(evaluateLinePrice(item, d, line('100')).price).toBe('7.00');
    expect(evaluateLinePrice(item, d, line('100')).tierMinQuantity).toBe('100');
  });

  it('inactive rules and inactive price levels never apply', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '50.00', cost: '10', customFields: null };
    const d = data({
      rules: [rule({ isActive: false, adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '1' } })],
      customer: { id: 'c1', lineage: ['c1'], customerTypeId: null, priceLevelId: 'l1' },
      level: { id: 'l1', name: 'Dead', type: 'fixed_percent', percent: '-50', rounding: 'none', isActive: false },
    });
    const q = evaluateLinePrice(item, d, line());
    expect(q.price).toBe('50.00');
    expect(q.source).toBe('base');
  });

  it('a rule targeting a sub-customer does NOT apply to its parent', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '50.00', cost: '10', customFields: null };
    const d = (customer: EngineData['customer']) =>
      data({
        rules: [rule({ conditions: { customerIds: ['job'] }, adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '40' } })],
        customer,
      });
    expect(evaluateLinePrice(item, d({ id: 'job', lineage: ['job', 'parent'], customerTypeId: null, priceLevelId: null }), line()).price).toBe('40.00');
    expect(evaluateLinePrice(item, d({ id: 'parent', lineage: ['parent'], customerTypeId: null, priceLevelId: null }), line()).price).toBe('50.00');
    // No customer at all (cash sale) never matches a customer-conditioned rule.
    expect(evaluateLinePrice(item, d(null), line()).price).toBe('50.00');
  });

  it('priority mode: equal priorities fall back to the lower price; special item types are never repriced', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '50.00', cost: '10', customFields: null };
    const d = data({
      settings: { ...DEFAULT_PRICING_SETTINGS, conflictMode: 'priority' },
      rules: [
        rule({ id: 'a', name: 'A', priority: 5, adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '45' } }),
        rule({ id: 'b', name: 'B', priority: 5, adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '44' } }),
        rule({ id: 'c', name: 'C', priority: 6, adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '1' } }),
      ],
    });
    const q = evaluateLinePrice(item, d, line());
    expect(q.ruleId).toBe('b');
    expect(q.price).toBe('44.00');
    for (const type of ['discount', 'subtotal', 'payment', 'sales_tax']) {
      const special = evaluateLinePrice({ ...item, type }, d, line());
      expect(special.source).toBe('base');
      expect(special.candidates).toHaveLength(0);
    }
  });

  it('a rule dated by day is not affected by the time-of-day of the document date', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '50.00', cost: '10', customFields: null };
    const d = data({ rules: [rule({ startDate: '2026-03-15', endDate: '2026-03-15', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '1' } })] });
    expect(evaluateLinePrice(item, d, line(1, '2026-03-15')).price).toBe('1.00');
    expect(evaluateLinePrice(item, d, line(1, '2026-03-16')).price).toBe('50.00');
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-advanced-pricing-qa');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const ids = {
  widget: '',
  discount: '',
  bob: '',
  rep: '',
  tax: '',
  otherItem: '',
  otherCustomer: '',
  otherLevel: '',
  otherRule: '',
  otherType: '',
};

function d(day = '2026-03-15') {
  return new Date(`${day}T00:00:00.000Z`);
}

describe('Advanced pricing (QA) — integration', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'pqa@test.local', name: 'PQA', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Pricing QA', ownerId: user.id }).returning();
    const [otherCo] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    other = { db, companyId: otherCo.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4900', 'Discounts Given', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }
    const [discAcct] = await db.select().from(accounts).where(eq(accounts.code, '4900'));

    ids.widget = (await db.insert(items).values({ companyId: company.id, name: 'Widget', type: 'service', salesPrice: '33.33', purchaseCost: '20.00' }).returning())[0].id;
    ids.discount = (
      await db
        .insert(items)
        .values({ companyId: company.id, name: 'Promo Discount', type: 'discount', salesPrice: '-5.00', incomeAccountId: discAcct?.id ?? null })
        .returning()
    )[0].id;
    ids.bob = (await db.insert(customers).values({ companyId: company.id, displayName: 'Bob' }).returning())[0].id;
    ids.rep = (await db.insert(salesReps).values({ companyId: company.id, name: 'Rita' }).returning())[0].id;
    ids.tax = (await db.insert(taxRates).values({ companyId: company.id, name: 'Tax 7.375%', rate: '0.073750' }).returning())[0].id;

    // Other company's master data (ids injected into this company's calls must be rejected).
    ids.otherItem = (await db.insert(items).values({ companyId: otherCo.id, name: 'Foreign', type: 'service', salesPrice: '1.00' }).returning())[0].id;
    ids.otherCustomer = (await db.insert(customers).values({ companyId: otherCo.id, displayName: 'Foreign Cust' }).returning())[0].id;
    ids.otherLevel = (await createPriceLevel(other, { name: 'Foreign level', type: 'per_item' })).id;
    ids.otherRule = (
      await createPriceRule(other, { name: 'Foreign rule', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' } })
    ).id;
    ids.otherType = (await createType(other, 'customer', { name: 'Foreign type' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects cross-company ids on every pricing write path', async () => {
    const level = await createPriceLevel(ctx, { name: 'Mine', type: 'per_item' });
    await expect(assignCustomerPricing(ctx, ids.bob, { priceLevelId: ids.otherLevel })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(assignCustomerPricing(ctx, ids.bob, { customerTypeId: ids.otherType })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(assignCustomerPricing(ctx, ids.otherCustomer, { priceLevelId: level.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setPriceLevelItems(ctx, level.id, [{ itemId: ids.otherItem, price: '1' }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setPriceLevelItems(ctx, ids.otherLevel, [{ itemId: ids.widget, price: '1' }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      updatePriceLevel(ctx, ids.otherLevel, { name: 'hijack', type: 'fixed_percent', percent: '-99' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deletePriceLevel(ctx, ids.otherLevel)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      updatePriceRule(ctx, ids.otherRule, { name: 'hijack', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '0' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deletePriceRule(ctx, ids.otherRule)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createPriceRule(ctx, {
        name: 'x',
        conditions: { customerTypeIds: [ids.otherType] },
        adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(quotePrices(ctx, { customerId: ids.otherCustomer, date: d() }, [{ itemId: ids.widget, quantity: 1 }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.otherItem, quantity: 1 }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createInvoice(ctx, { customerId: ids.bob, date: d(), lines: [{ itemId: ids.otherItem, quantity: 1 }] })).rejects.toBeTruthy();

    // The other company's data is untouched.
    const [lvl] = await db.select().from(priceLevels).where(eq(priceLevels.id, ids.otherLevel));
    expect(lvl.name).toBe('Foreign level');
    const [r] = await db.select().from(priceRules).where(eq(priceRules.id, ids.otherRule));
    expect(r.name).toBe('Foreign rule');
    await deletePriceLevel(ctx, level.id);
  });

  it('viewer role cannot write pricing master data, and nothing is persisted', async () => {
    const viewer: ServiceContext = { ...ctx, role: 'viewer' };
    const rulesBefore = (await db.select().from(priceRules).where(eq(priceRules.companyId, ctx.companyId))).length;
    const levelsBefore = (await db.select().from(priceLevels).where(eq(priceLevels.companyId, ctx.companyId))).length;
    await expect(
      createPriceRule(viewer, { name: 'v', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createPriceLevel(viewer, { name: 'v', type: 'fixed_percent', percent: '-5' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updatePricingSettings(viewer, { conflictMode: 'priority' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createType(viewer, 'customer', { name: 'v' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assignCustomerPricing(viewer, ids.bob, { priceLevelId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await db.select().from(priceRules).where(eq(priceRules.companyId, ctx.companyId))).length).toBe(rulesBefore);
    expect((await db.select().from(priceLevels).where(eq(priceLevels.companyId, ctx.companyId))).length).toBe(levelsBefore);
    // Viewers may still READ a quote (no write).
    const [quote] = await quotePrices(viewer, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: 1 }]);
    expect(quote.price).toBe('33.33');
  });

  it('rejects malformed rules / levels / level items', async () => {
    const adj = { basis: 'price' as const, method: 'percent' as const, direction: 'decrease' as const, value: '1' };
    const bad: Array<Parameters<typeof createPriceRule>[1]> = [
      { name: '   ', adjustment: adj },
      { name: 'neg', adjustment: { ...adj, value: '-1' } },
      { name: 'neg tier', adjustment: adj, tiers: [{ minQuantity: '5', adjustment: { ...adj, value: '-3' } }] },
      { name: 'zero tier', adjustment: adj, tiers: [{ minQuantity: '0', adjustment: adj }] },
      { name: 'tier >100%', adjustment: adj, tiers: [{ minQuantity: '5', adjustment: { ...adj, value: '101' } }] },
      { name: 'type', adjustment: adj, conditions: { itemTypes: ['discount'] } },
      { name: 'rounding', adjustment: adj, rounding: 'nearest_0.07' as never },
      { name: 'prio', adjustment: adj, priority: 1.5 },
      { name: 'prio neg', adjustment: adj, priority: -1 },
      { name: 'date', adjustment: adj, startDate: '2026-13-45x' },
      { name: 'minq', adjustment: adj, minQuantity: '-2' },
      { name: 'method', adjustment: { ...adj, method: 'bogus' as never } },
    ];
    for (const input of bad) {
      await expect(createPriceRule(ctx, input), input.name).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(createPriceLevel(ctx, { name: 'all free', type: 'fixed_percent', percent: '-100' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createPriceLevel(ctx, { name: 'bad type', type: 'bogus' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
    const pct = await createPriceLevel(ctx, { name: 'pct', type: 'fixed_percent', percent: '5' });
    await expect(setPriceLevelItems(ctx, pct.id, [{ itemId: ids.widget, price: '1' }])).rejects.toMatchObject({ code: 'VALIDATION' });
    const list = await createPriceLevel(ctx, { name: 'list', type: 'per_item' });
    await expect(
      setPriceLevelItems(ctx, list.id, [
        { itemId: ids.widget, price: '1' },
        { itemId: ids.widget, price: '2' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setPriceLevelItems(ctx, list.id, [{ itemId: ids.widget, price: '-0.01' }])).rejects.toMatchObject({ code: 'VALIDATION' });
    await deletePriceLevel(ctx, pct.id);
    await deletePriceLevel(ctx, list.id);
  });

  it('company default rounding applies to a price level that has no rounding of its own', async () => {
    await updatePricingSettings(ctx, { defaultRounding: 'nearest_1.00' });
    const level = await createPriceLevel(ctx, { name: 'Minus 5', type: 'fixed_percent', percent: '-5' }); // no rounding given
    await assignCustomerPricing(ctx, ids.bob, { priceLevelId: level.id });
    try {
      const [quote] = await quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: 1 }]);
      // 33.33 * 0.95 = 31.6635 -> company default "nearest whole dollar" -> 32.00 (not 31.66)
      // (pricing.ts header: "the default rounding applied when a rule/level has none").
      expect(quote.source).toBe('price_level');
      expect(quote.price).toBe('32.00');
    } finally {
      await assignCustomerPricing(ctx, ids.bob, { priceLevelId: null });
      await deletePriceLevel(ctx, level.id);
      await updatePricingSettings(ctx, { defaultRounding: 'none' });
    }
  });

  it('customer type hierarchy rejects cycles (A under B under A)', async () => {
    const a = await createType(ctx, 'customer', { name: 'Cycle A' });
    const b = await createType(ctx, 'customer', { name: 'Cycle B', parentId: a.id });
    await expect(updateType(ctx, 'customer', a.id, { name: 'Cycle A', parentId: b.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [row] = await db.select().from(customerTypes).where(eq(customerTypes.id, a.id));
    expect(row.parentId).toBeNull();
  });

  it('vendor type hierarchy rejects deeper cycles (A under C, C under B, B under A)', async () => {
    const a = await createType(ctx, 'vendor', { name: 'VCycle A' });
    const b = await createType(ctx, 'vendor', { name: 'VCycle B', parentId: a.id });
    const c = await createType(ctx, 'vendor', { name: 'VCycle C', parentId: b.id });
    await expect(updateType(ctx, 'vendor', a.id, { name: 'VCycle A', parentId: c.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Re-parenting within a valid tree still works.
    await expect(updateType(ctx, 'vendor', c.id, { name: 'VCycle C', parentId: a.id })).resolves.toMatchObject({ parentId: a.id });
  });

  it('a fixed-price rule still applies to an item with unknown cost (only cost-based rules are skipped)', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '100.00', cost: null, customFields: null };
    const d = data({
      rules: [
        rule({ id: 'r1', name: 'Cost plus', adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '20' } }),
        rule({ id: 'r2', name: 'Fixed 80', adjustment: { basis: 'cost', method: 'fixed', direction: 'increase', value: '80' } }),
      ],
    });
    const q = evaluateLinePrice(item, d, line());
    expect(q.price).toBe('80.00');
    expect(q.candidates.map((c) => c.id)).toEqual(['r2']);
  });

  it('customer type names are unique case-insensitively; parent must be same company', async () => {
    await createType(ctx, 'customer', { name: 'Dupe' });
    await expect(createType(ctx, 'customer', { name: ' dUPE ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createType(ctx, 'customer', { name: 'Child', parentId: ids.otherType })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('invoice: rules + tier + discount item + tax compute exact totals and the GL balances', async () => {
    const r = await createPriceRule(ctx, {
      name: 'Widget volume',
      conditions: { itemIds: [ids.widget] },
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '3' },
      tiers: [{ minQuantity: '7', adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '33.3333' } }],
      rounding: 'up_0.05',
    });
    // A blanket rule matching every priceable item must never touch the discount line.
    const blanket = await createPriceRule(ctx, {
      name: 'Blanket +50%',
      priority: 1,
      adjustment: { basis: 'price', method: 'percent', direction: 'increase', value: '50' },
    });
    try {
      const inv = await createInvoice(ctx, {
        customerId: ids.bob,
        date: d('2026-04-02'),
        taxRateId: ids.tax,
        lines: [
          { itemId: ids.widget, quantity: 3 }, // 33.33 * .97 = 32.3301 -> up .05 -> 32.35 ; x3 = 97.05
          { itemId: ids.widget, quantity: '7.5' }, // cost 20 * 1.333333 = 26.66666 -> up .05 -> 26.70 ; x7.5 = 200.25
          { itemId: ids.discount, quantity: 1, rate: '-5.00' },
        ],
      });
      const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      const widgetRates = lines.filter((l) => l.itemId === ids.widget).map((l) => Number(l.rate).toFixed(2)).sort();
      expect(widgetRates).toEqual(['26.70', '32.35']);
      const disc = lines.find((l) => l.itemId === ids.discount)!;
      expect(disc.pricing).toBeNull();
      expect(Number(disc.amount)).toBe(-5);
      // subtotal = 97.05 + 200.25 - 5.00 = 292.30 ; tax 7.375% = 21.556... -> 21.56
      expect(inv.subtotal).toBe('292.30');
      expect(inv.taxAmount).toBe('21.56');
      expect(inv.total).toBe('313.86');
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    } finally {
      await deletePriceRule(ctx, r.id);
      await deletePriceRule(ctx, blanket.id);
    }
  });

  it('updating an invoice without salesRepId keeps the rep, so a rep-conditioned rule still prices it', async () => {
    const r = await createPriceRule(ctx, {
      name: 'Rita deal',
      conditions: { salesRepIds: [ids.rep], itemIds: [ids.widget] },
      adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '30' },
    });
    try {
      const inv = await createInvoice(ctx, { customerId: ids.bob, date: d(), salesRepId: ids.rep, lines: [{ itemId: ids.widget, quantity: 2 }] });
      expect(inv.total).toBe('60.00');
      const upd = await updateInvoice(ctx, inv.id, { customerId: ids.bob, date: d(), lines: [{ itemId: ids.widget, quantity: 3 }] });
      expect(upd.total).toBe('90.00');
      const [l] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      expect((l.pricing as unknown as AppliedPricing).ruleId).toBe(r.id);
      expect((await trialBalance(ctx)).balanced).toBe(true);
    } finally {
      await deletePriceRule(ctx, r.id);
    }
  });

  it('a manual override equal to the engine price (different string format) is not flagged as overridden', async () => {
    const inv = await createInvoice(ctx, { customerId: ids.bob, date: d(), lines: [{ itemId: ids.widget, quantity: 1, rate: '33.3300' }] });
    const [l] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect((l.pricing as unknown as AppliedPricing).overridden).toBe(false);
  });

  it('rejects a negative quote quantity and an empty-name rule update without changing the rule', async () => {
    await expect(quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: -1 }])).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await createPriceRule(ctx, { name: 'Keep me', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' } });
    await expect(
      updatePriceRule(ctx, r.id, { name: '', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const [row] = await db.select().from(priceRules).where(eq(priceRules.id, r.id));
    expect(row.name).toBe('Keep me');
    await deletePriceRule(ctx, r.id);
  });

  // ---- QA re-test round 1 ----
  it('re-test: a level with explicit rounding "none" is NOT rounded by the company default', async () => {
    await updatePricingSettings(ctx, { defaultRounding: 'nearest_1.00' });
    const level = await createPriceLevel(ctx, { name: 'Minus 5 exact', type: 'fixed_percent', percent: '-5', rounding: 'none' });
    await assignCustomerPricing(ctx, ids.bob, { priceLevelId: level.id });
    try {
      const [quote] = await quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: 1 }]);
      expect(quote.source).toBe('price_level');
      expect(quote.price).toBe('31.66');
    } finally {
      await assignCustomerPricing(ctx, ids.bob, { priceLevelId: null });
      await deletePriceLevel(ctx, level.id);
      await updatePricingSettings(ctx, { defaultRounding: 'none' });
    }
  });

  it('re-test: clearing a level rounding back to null reverts it to the company default', async () => {
    await updatePricingSettings(ctx, { defaultRounding: 'nearest_1.00' });
    const level = await createPriceLevel(ctx, { name: 'Minus 5 nickel', type: 'fixed_percent', percent: '-5', rounding: 'nearest_0.05' });
    await assignCustomerPricing(ctx, ids.bob, { priceLevelId: level.id });
    try {
      let [quote] = await quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: 1 }]);
      expect(quote.price).toBe('31.65'); // 31.6635 -> nearest .05
      await updatePriceLevel(ctx, level.id, { name: 'Minus 5 nickel', type: 'fixed_percent', percent: '-5', rounding: null });
      const [row] = await db.select().from(priceLevels).where(eq(priceLevels.id, level.id));
      expect(row.rounding).toBeNull();
      [quote] = await quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: ids.widget, quantity: 1 }]);
      expect(quote.price).toBe('32.00');
      // An unknown rounding string is still rejected.
      await expect(
        updatePriceLevel(ctx, level.id, { name: 'Minus 5 nickel', type: 'fixed_percent', percent: '-5', rounding: 'nearest_0.07' as never }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    } finally {
      await assignCustomerPricing(ctx, ids.bob, { priceLevelId: null });
      await deletePriceLevel(ctx, level.id);
      await updatePricingSettings(ctx, { defaultRounding: 'none' });
    }
  });

  it('re-test: invoicing a no-cost item under a matching cost-plus rule bills base price, not $0, and balances', async () => {
    const [noCost] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'NoCost service', type: 'service', salesPrice: '100.00' })
      .returning();
    const r = await createPriceRule(ctx, {
      name: 'NoCost cost-plus',
      conditions: { itemIds: [noCost.id] },
      adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '20' },
    });
    try {
      const [q] = await quotePrices(ctx, { customerId: ids.bob, date: d() }, [{ itemId: noCost.id, quantity: 2 }]);
      expect(q.price).toBe('100.00');
      expect(q.source).toBe('base');
      const inv = await createInvoice(ctx, { customerId: ids.bob, date: d(), lines: [{ itemId: noCost.id, quantity: 2 }] });
      expect(inv.total).toBe('200.00');
      const [l] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      expect(Number(l.rate).toFixed(2)).toBe('100.00');
      const applied = l.pricing as unknown as AppliedPricing | null;
      if (applied) expect(applied.overridden).toBe(false);
      // A client that types a different price is treated as an override (allowed), and flagged.
      const inv0 = await createInvoice(ctx, { customerId: ids.bob, date: d(), lines: [{ itemId: noCost.id, quantity: 1, rate: '50' }] });
      const [l0] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv0.id));
      expect((l0.pricing as unknown as AppliedPricing).overridden).toBe(true);
      expect((await trialBalance(ctx)).balanced).toBe(true);
    } finally {
      await deletePriceRule(ctx, r.id);
    }
  });

  it('re-test: type cycle check terminates on pre-existing corrupt data and still rejects self-parenting', async () => {
    const [x] = await db.insert(customerTypes).values({ companyId: ctx.companyId, name: 'Corrupt X' }).returning();
    const [y] = await db.insert(customerTypes).values({ companyId: ctx.companyId, name: 'Corrupt Y', parentId: x.id }).returning();
    await db.update(customerTypes).set({ parentId: y.id }).where(eq(customerTypes.id, x.id)); // X <-> Y already cyclic
    const z = await createType(ctx, 'customer', { name: 'Corrupt Z' });
    // Must finish (no infinite loop); Z is not in the X/Y cycle so placing it under X is allowed.
    await expect(updateType(ctx, 'customer', z.id, { name: 'Corrupt Z', parentId: x.id })).resolves.toMatchObject({ parentId: x.id });
    await expect(updateType(ctx, 'customer', z.id, { name: 'Corrupt Z', parentId: z.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A four-deep chain: root cannot go under its great-grandchild.
    const a = await createType(ctx, 'customer', { name: 'Deep A' });
    const b = await createType(ctx, 'customer', { name: 'Deep B', parentId: a.id });
    const c = await createType(ctx, 'customer', { name: 'Deep C', parentId: b.id });
    const e = await createType(ctx, 'customer', { name: 'Deep D', parentId: c.id });
    await expect(updateType(ctx, 'customer', a.id, { name: 'Deep A', parentId: e.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateType(ctx, 'customer', b.id, { name: 'Deep B', parentId: e.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Moving a leaf to the root (no parent) is fine.
    await expect(updateType(ctx, 'customer', e.id, { name: 'Deep D', parentId: null })).resolves.toMatchObject({ parentId: null });
  });
});

describe('Advanced pricing (QA) — re-test round 1, pure engine', () => {
  const noCostItem: EngineItem = { id: 'i1', type: 'service', salesPrice: '100.00', cost: null, customFields: null };

  it('priority mode: a top-priority cost rule on a no-cost item is skipped and the next rule wins', () => {
    const d0 = data({
      settings: { ...DEFAULT_PRICING_SETTINGS, conflictMode: 'priority' },
      rules: [
        rule({ id: 'top', name: 'Cost +10', priority: 1, adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '10' } }),
        rule({ id: 'next', name: 'Price -10%', priority: 5 }),
      ],
    });
    const q = evaluateLinePrice(noCostItem, d0, line());
    expect(q.ruleId).toBe('next');
    expect(q.price).toBe('90.00');
  });

  it('cost-basis AMOUNT adjustments (increase and decrease) on a no-cost item are skipped, not priced from 0', () => {
    for (const direction of ['increase', 'decrease'] as const) {
      const q = evaluateLinePrice(
        noCostItem,
        data({ rules: [rule({ adjustment: { basis: 'cost', method: 'amount', direction, value: '5' } })] }),
        line(),
      );
      expect(q.price).toBe('100.00');
      expect(q.source).toBe('base');
    }
  });

  it('a cost-based quantity tier on a no-cost item never yields a $0 price', () => {
    const r = rule({
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '5' },
      tiers: [{ minQuantity: '10', adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '25' } }],
    });
    expect(evaluateLinePrice(noCostItem, data({ rules: [r] }), line(5)).price).toBe('95.00');
    const big = evaluateLinePrice(noCostItem, data({ rules: [r] }), line(10));
    expect(Number(big.price)).toBeGreaterThan(0);
  });

  it('level rounding: null uses the company default, an explicit mode overrides it', () => {
    const item: EngineItem = { id: 'i1', type: 'service', salesPrice: '33.33', cost: null, customFields: null };
    const lvl = { id: 'L', name: 'L', type: 'fixed_percent' as const, percent: '-5', isActive: true };
    const settings = { ...DEFAULT_PRICING_SETTINGS, defaultRounding: 'nearest_1.00' as const };
    expect(evaluateLinePrice(item, data({ settings, level: { ...lvl, rounding: null } }), line()).price).toBe('32.00');
    expect(evaluateLinePrice(item, data({ settings, level: { ...lvl, rounding: 'none' } }), line()).price).toBe('31.66');
    expect(evaluateLinePrice(item, data({ settings, level: { ...lvl, rounding: 'down_0.99' } }), line()).price).toBe('30.99');
  });
});
