/**
 * Advanced pricing tests.
 *
 * Pure engine: rounding options, adjustments.
 * Integration (hermetic PGlite dir): rule precedence (priority vs lowest-price-wins), price
 * levels (fixed % and per-item), customer-specific prices, quantity tiers, date ranges,
 * condition dimensions (customer type, sub-customer inheritance, class, sales rep, item type,
 * item custom field, minimum quantity), and document integration — invoices priced server-side
 * with sales tax, overrides flagged, estimates / sales orders / sales receipts, SO conversion
 * provenance — with the trial balance balanced throughout.
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
  classes,
  salesReps,
  taxRates,
  invoiceLines,
  salesOrderLines,
  estimateLines,
  salesReceiptLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { setCustomerPrice } from './customerPricing';
import { createInvoice, getInvoice } from './invoices';
import { createEstimate } from './estimates';
import { createSalesOrder, convertToInvoice as convertSoToInvoice } from './salesOrders';
import { createSalesReceipt } from './salesReceipts';
import { createType } from './typeLists';
import {
  type AppliedPricing,
  applyAdjustment,
  assignCustomerPricing,
  createPriceLevel,
  createPriceRule,
  deletePriceRule,
  quotePrices,
  roundPrice,
  setPriceLevelItems,
  updatePriceRule,
  updatePricingSettings,
} from './pricing';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-advanced-pricing');
let db: DB;
let ctx: ServiceContext;

const ids = {
  widget: '', // service item, base 100.00, cost 60.00
  gadget: '', // non-inventory item, base 20.00
  stocked: '', // inventory item, base 50.00
  acme: '', // customer (type Wholesale)
  acmeJob: '', // sub-customer of acme
  bob: '', // retail customer
  wholesale: '',
  retail: '',
  classEast: '',
  rep: '',
  tax: '',
};

function q(date = '2026-03-15') {
  return new Date(`${date}T00:00:00.000Z`);
}

async function price(itemId: string, customerId: string | null, quantity: string | number = 1, extra: Partial<{ date: string; classId: string; salesRepId: string }> = {}) {
  const [quote] = await quotePrices(
    ctx,
    { customerId, date: q(extra.date), classId: extra.classId ?? null, salesRepId: extra.salesRepId ?? null },
    [{ itemId, quantity }],
  );
  return quote;
}

describe('Advanced pricing — pure helpers', () => {
  it('rounds per QB rounding options', () => {
    expect(roundPrice('12.345', 'none').toFixed(2)).toBe('12.35');
    expect(roundPrice('12.32', 'nearest_0.05').toFixed(2)).toBe('12.30');
    expect(roundPrice('12.33', 'nearest_0.05').toFixed(2)).toBe('12.35');
    expect(roundPrice('12.01', 'up_0.05').toFixed(2)).toBe('12.05');
    expect(roundPrice('12.49', 'nearest_1.00').toFixed(2)).toBe('12.00');
    expect(roundPrice('12.50', 'nearest_1.00').toFixed(2)).toBe('13.00');
    expect(roundPrice('12.01', 'up_1.00').toFixed(2)).toBe('13.00');
    expect(roundPrice('12.99', 'down_1.00').toFixed(2)).toBe('12.00');
    expect(roundPrice('12.10', 'up_0.99').toFixed(2)).toBe('12.99');
    expect(roundPrice('12.99', 'up_0.99').toFixed(2)).toBe('12.99');
    expect(roundPrice('13.00', 'up_0.99').toFixed(2)).toBe('13.99');
    expect(roundPrice('12.50', 'down_0.99').toFixed(2)).toBe('11.99');
    expect(roundPrice('0.50', 'down_0.99').toFixed(2)).toBe('0.50'); // no N.99 below
    expect(roundPrice('12.40', 'nearest_0.99').toFixed(2)).toBe('11.99');
    expect(roundPrice('12.60', 'nearest_0.99').toFixed(2)).toBe('12.99');
    expect(roundPrice('-3', 'none').toFixed(2)).toBe('0.00');
  });

  it('applies percent / amount / fixed adjustments from price or cost', () => {
    const pct = { basis: 'price' as const, method: 'percent' as const, direction: 'decrease' as const, value: '15' };
    expect(applyAdjustment('100', '60', pct).toFixed(2)).toBe('85.00');
    const markup = { basis: 'cost' as const, method: 'percent' as const, direction: 'increase' as const, value: '25' };
    expect(applyAdjustment('100', '60', markup).toFixed(2)).toBe('75.00');
    const amt = { basis: 'price' as const, method: 'amount' as const, direction: 'decrease' as const, value: '150' };
    expect(applyAdjustment('100', '60', amt).toFixed(2)).toBe('0.00'); // never negative
    const fixed = { basis: 'price' as const, method: 'fixed' as const, direction: 'increase' as const, value: '42.5' };
    expect(applyAdjustment('100', '60', fixed).toFixed(2)).toBe('42.50');
  });
});

describe('Advanced pricing — engine + documents', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'pricing@test.local', name: 'Pricing', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'Pricing Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }

    const [w] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Widget', type: 'service', salesPrice: '100.00', purchaseCost: '60.00', customFields: { Brand: 'Acme' } })
      .returning();
    const [g] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Gadget', type: 'non_inventory', salesPrice: '20.00' })
      .returning();
    const [s] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Stocked', type: 'inventory', salesPrice: '50.00', quantityOnHand: '100', averageCost: '30.0000' })
      .returning();
    ids.widget = w.id;
    ids.gadget = g.id;
    ids.stocked = s.id;

    ids.wholesale = (await createType(ctx, 'customer', { name: 'Wholesale' })).id;
    ids.retail = (await createType(ctx, 'customer', { name: 'Retail' })).id;

    const [acme] = await db.insert(customers).values({ companyId: company.id, displayName: 'Acme Corp' }).returning();
    const [job] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Acme Corp:Warehouse', parentId: acme.id })
      .returning();
    const [bob] = await db.insert(customers).values({ companyId: company.id, displayName: 'Bob Retail' }).returning();
    ids.acme = acme.id;
    ids.acmeJob = job.id;
    ids.bob = bob.id;
    await assignCustomerPricing(ctx, acme.id, { customerTypeId: ids.wholesale });
    await assignCustomerPricing(ctx, bob.id, { customerTypeId: ids.retail });

    const [cls] = await db.insert(classes).values({ companyId: company.id, name: 'East' }).returning();
    ids.classEast = cls.id;
    const [rep] = await db.insert(salesReps).values({ companyId: company.id, name: 'Rita' }).returning();
    ids.rep = rep.id;
    const [tax] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'State 8.25%', rate: '0.082500' })
      .returning();
    ids.tax = tax.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('uses the base price when nothing applies', async () => {
    const quote = await price(ids.widget, ids.bob);
    expect(quote.price).toBe('100.00');
    expect(quote.source).toBe('base');
  });

  it('applies a fixed-percent price level with rounding, inherited by sub-customers', async () => {
    const level = await createPriceLevel(ctx, { name: 'Wholesale -12.5%', type: 'fixed_percent', percent: '-12.5', rounding: 'up_0.99' });
    await assignCustomerPricing(ctx, ids.acme, { priceLevelId: level.id });
    const quote = await price(ids.gadget, ids.acme); // 20 * 0.875 = 17.50 -> up to 17.99
    expect(quote.price).toBe('17.99');
    expect(quote.source).toBe('price_level');
    expect(quote.priceLevelName).toBe('Wholesale -12.5%');
    // The job (sub-customer) has no level of its own -> inherits the parent's.
    expect((await price(ids.gadget, ids.acmeJob)).price).toBe('17.99');
    expect((await price(ids.gadget, ids.bob)).price).toBe('20.00');
  });

  it('per-item price levels only price the listed items', async () => {
    const level = await createPriceLevel(ctx, { name: 'VIP list', type: 'per_item' });
    await setPriceLevelItems(ctx, level.id, [{ itemId: ids.widget, price: '77.70' }]);
    await assignCustomerPricing(ctx, ids.bob, { priceLevelId: level.id });
    expect((await price(ids.widget, ids.bob)).price).toBe('77.70');
    expect((await price(ids.gadget, ids.bob)).source).toBe('base');
    await assignCustomerPricing(ctx, ids.bob, { priceLevelId: null });
  });

  it('rule precedence: lowest price wins vs priority wins', async () => {
    const big = await createPriceRule(ctx, {
      name: 'Wholesale 20% off',
      priority: 50,
      conditions: { customerTypeIds: [ids.wholesale], itemIds: [ids.widget] },
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '20' },
    });
    const small = await createPriceRule(ctx, {
      name: 'Acme contract 5% off',
      priority: 10,
      conditions: { customerIds: [ids.acme] },
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '5' },
    });

    await updatePricingSettings(ctx, { conflictMode: 'lowest' });
    let quote = await price(ids.widget, ids.acme);
    expect(quote.price).toBe('80.00');
    expect(quote.ruleName).toBe('Wholesale 20% off');
    expect(quote.candidates.length).toBeGreaterThanOrEqual(2);

    await updatePricingSettings(ctx, { conflictMode: 'priority' });
    quote = await price(ids.widget, ids.acme);
    expect(quote.price).toBe('95.00'); // priority 10 beats priority 50 even though dearer
    expect(quote.ruleId).toBe(small.id);
    // Customer conditions match sub-customers (jobs) of the listed customer.
    expect((await price(ids.widget, ids.acmeJob)).ruleId).toBe(small.id);

    // In priority mode a matching rule also beats the customer's price level.
    quote = await price(ids.gadget, ids.acme);
    expect(quote.source).toBe('price_rule');
    expect(quote.price).toBe('19.00');

    await deletePriceRule(ctx, small.id);
    await deletePriceRule(ctx, big.id);
    await updatePricingSettings(ctx, { conflictMode: 'lowest' });
  });

  it('lowest-price-wins also weighs customer-specific prices and levels', async () => {
    await setCustomerPrice(ctx, { customerId: ids.acme, itemId: ids.gadget, price: '16.00' });
    const rule = await createPriceRule(ctx, {
      name: 'Gadget promo',
      conditions: { itemIds: [ids.gadget] },
      adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '18.50' },
    });
    let quote = await price(ids.gadget, ids.acme); // level 17.99, rule 18.50, customer 16.00
    expect(quote.price).toBe('16.00');
    expect(quote.source).toBe('customer_price');
    await updatePricingSettings(ctx, { conflictMode: 'priority' });
    quote = await price(ids.gadget, ids.acme);
    expect(quote.price).toBe('18.50'); // rule first in priority mode
    await updatePricingSettings(ctx, { conflictMode: 'lowest' });
    await deletePriceRule(ctx, rule.id);
  });

  it('quantity tiers pick the highest tier reached; min quantity gates the rule', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'Volume',
      conditions: { itemIds: [ids.widget] },
      minQuantity: '5',
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '2' },
      tiers: [
        { minQuantity: '10', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '10' } },
        { minQuantity: '50', adjustment: { basis: 'cost', method: 'percent', direction: 'increase', value: '30' } },
      ],
    });
    expect((await price(ids.widget, ids.bob, 4)).source).toBe('base');
    expect((await price(ids.widget, ids.bob, 5)).price).toBe('98.00');
    const t10 = await price(ids.widget, ids.bob, 10);
    expect(t10.price).toBe('90.00');
    expect(t10.tierMinQuantity).toBe('10');
    expect((await price(ids.widget, ids.bob, 49.5)).price).toBe('90.00');
    const t50 = await price(ids.widget, ids.bob, 50);
    expect(t50.price).toBe('78.00'); // cost 60 + 30%
    expect(t50.tierMinQuantity).toBe('50');
    await deletePriceRule(ctx, rule.id);
  });

  it('date ranges are inclusive and compared to the document date', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'January sale',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      adjustment: { basis: 'price', method: 'amount', direction: 'decrease', value: '7.25' },
    });
    expect((await price(ids.widget, ids.bob, 1, { date: '2025-12-31' })).source).toBe('base');
    expect((await price(ids.widget, ids.bob, 1, { date: '2026-01-01' })).price).toBe('92.75');
    expect((await price(ids.widget, ids.bob, 1, { date: '2026-01-31' })).price).toBe('92.75');
    expect((await price(ids.widget, ids.bob, 1, { date: '2026-02-01' })).source).toBe('base');
    await expect(
      updatePriceRule(ctx, rule.id, {
        name: 'bad',
        startDate: '2026-02-01',
        endDate: '2026-01-01',
        adjustment: { basis: 'price', method: 'amount', direction: 'decrease', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await deletePriceRule(ctx, rule.id);
  });

  it('matches class, sales rep, item type and item custom field conditions', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'East + Rita + Acme brand services',
      conditions: {
        classIds: [ids.classEast],
        salesRepIds: [ids.rep],
        itemTypes: ['service'],
        itemCustomField: { name: 'Brand', value: ' acme ' },
      },
      adjustment: { basis: 'price', method: 'percent', direction: 'increase', value: '10' },
      rounding: 'nearest_1.00',
    });
    expect((await price(ids.widget, ids.bob, 1, { classId: ids.classEast, salesRepId: ids.rep })).price).toBe('110.00');
    expect((await price(ids.widget, ids.bob, 1, { classId: ids.classEast })).source).toBe('base');
    expect((await price(ids.widget, ids.bob, 1, { salesRepId: ids.rep })).source).toBe('base');
    // Gadget is non_inventory and has no Brand field.
    expect((await price(ids.gadget, ids.bob, 1, { classId: ids.classEast, salesRepId: ids.rep })).source).toBe('base');
    await deletePriceRule(ctx, rule.id);
  });

  it('disabling advanced pricing ignores rules and levels but keeps customer prices', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'Everything 50% off',
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '50' },
    });
    await updatePricingSettings(ctx, { enabled: false });
    expect((await price(ids.widget, ids.bob)).price).toBe('100.00');
    expect((await price(ids.gadget, ids.acme)).price).toBe('16.00'); // customer price still applies
    await updatePricingSettings(ctx, { enabled: true });
    expect((await price(ids.widget, ids.bob)).price).toBe('50.00');
    await deletePriceRule(ctx, rule.id);
  });

  it('rejects invalid rules and cross-company references', async () => {
    await expect(
      createPriceRule(ctx, {
        name: 'x',
        adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '120' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createPriceRule(ctx, {
        name: 'x',
        conditions: { itemIds: ['00000000-0000-0000-0000-000000000000'] },
        adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      createPriceRule(ctx, {
        name: 'x',
        tiers: [
          { minQuantity: '5', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '1' } },
          { minQuantity: '5', adjustment: { basis: 'price', method: 'fixed', direction: 'increase', value: '2' } },
        ],
        adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('invoices: server-side pricing, provenance, overrides, and sales tax on the priced amounts', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'Retail 15% off widgets',
      conditions: { customerTypeIds: [ids.retail], itemIds: [ids.widget] },
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '15' },
      tiers: [{ minQuantity: '3', adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '20' } }],
    });

    const invoice = await createInvoice(ctx, {
      customerId: ids.bob,
      date: q('2026-04-01'),
      taxRateId: ids.tax,
      lines: [
        { itemId: ids.widget, quantity: 3 }, // tier: 80.00 x 3 = 240.00
        { itemId: ids.gadget, quantity: 2, rate: '19.99' }, // override (expected 20.00)
        { itemId: ids.stocked, quantity: 1 }, // base 50.00 (inventory -> COGS)
        { description: 'Delivery', quantity: 1, rate: '10.00', taxable: false },
      ],
    });
    // subtotal 240 + 39.98 + 50 + 10 = 339.98; taxable 329.98 * 8.25% = 27.22
    expect(invoice.subtotal).toBe('339.98');
    expect(invoice.taxAmount).toBe('27.22');
    expect(invoice.total).toBe('367.20');

    const stored = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
    const byItem = (id: string | null) => stored.find((l) => l.itemId === id)!;
    const widgetLine = byItem(ids.widget);
    expect(widgetLine.rate).toBe('80.0000');
    expect(widgetLine.amount).toBe('240.00');
    const wp = widgetLine.pricing as unknown as AppliedPricing;
    expect(wp.source).toBe('price_rule');
    expect(wp.ruleId).toBe(rule.id);
    expect(wp.tierMinQuantity).toBe('3');
    expect(wp.overridden).toBe(false);
    const gp = byItem(ids.gadget).pricing as unknown as AppliedPricing;
    expect(gp.overridden).toBe(true);
    expect(gp.expectedPrice).toBe('20.00');
    expect(byItem(ids.stocked).pricing).toMatchObject({ source: 'base', overridden: false });
    expect(byItem(null).pricing).toBeNull();

    // A line without an item is never priced: an omitted rate stays 0 (comment lines).
    const comment = await createInvoice(ctx, {
      customerId: ids.bob,
      date: q(),
      lines: [{ itemId: ids.gadget, quantity: 1 }, { description: 'Thank you!', quantity: 1 }],
    });
    expect(comment.total).toBe('20.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    const full = await getInvoice(ctx, invoice.id);
    expect(full.total).toBe('367.20');
    await deletePriceRule(ctx, rule.id);
  });

  it('estimates, sales orders and sales receipts are priced the same way; SO conversion keeps the order price', async () => {
    const rule = await createPriceRule(ctx, {
      name: 'Gadget 10% for retail',
      conditions: { customerTypeIds: [ids.retail], itemIds: [ids.gadget] },
      adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '10' },
    });

    const est = await createEstimate(ctx, { customerId: ids.bob, date: q(), taxRateId: ids.tax, lines: [{ itemId: ids.gadget, quantity: 5 }] });
    expect(est.subtotal).toBe('90.00');
    expect(est.taxAmount).toBe('7.43');
    const [el] = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, est.id));
    expect((el.pricing as unknown as AppliedPricing).ruleName).toBe('Gadget 10% for retail');

    const so = await createSalesOrder(ctx, { customerId: ids.bob, date: q(), lines: [{ itemId: ids.gadget, quantity: 4 }] });
    expect(so.total).toBe('72.00');
    const [sol] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    expect((sol.pricing as unknown as AppliedPricing).source).toBe('price_rule');

    const sr = await createSalesReceipt(ctx, { customerId: ids.bob, date: q(), lines: [{ itemId: ids.gadget, quantity: 1 }] });
    expect(sr.total).toBe('18.00');
    const [srl] = await db.select().from(salesReceiptLines).where(eq(salesReceiptLines.salesReceiptId, sr.id));
    expect((srl.pricing as unknown as AppliedPricing).expectedPrice).toBe('18.00');

    // Rule removed after the order was taken: the invoice keeps the ORDER's price and says why.
    await deletePriceRule(ctx, rule.id);
    const inv = await convertSoToInvoice(ctx, so.id);
    expect(inv.total).toBe('72.00');
    const [il] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const ip = il.pricing as unknown as AppliedPricing;
    expect(ip.overridden).toBe(true);
    expect(ip.origin).toBe('sales_order');
    expect(ip.expectedPrice).toBe('20.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
