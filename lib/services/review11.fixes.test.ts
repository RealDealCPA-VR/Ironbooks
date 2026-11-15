/**
 * Review loop 11 fixes (pricing, inventory repair):
 *  - ".99" rounding keeps a free line free;
 *  - a %-price level on an item with no sales price is no price at all (never $0 beating the
 *    customer's own price);
 *  - Rebuild Data's item quantities leave average-cost items (no FIFO layers) alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items } from '@/lib/db/schema';
import { assignCustomerPricing, createPriceLevel, quotePrices, roundPrice } from './pricing';
import { createCustomer } from './customers';
import { previewRebuild } from './integrity';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('review11');
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('pricing', { timeout: 120_000 }, () => {
  it('".99" rounding keeps $0 at $0', () => {
    expect(roundPrice(0, 'up_0.99').toFixed(2)).toBe('0.00');
    expect(roundPrice(0, 'nearest_0.99').toFixed(2)).toBe('0.00');
    expect(roundPrice('4.20', 'up_0.99').toFixed(2)).toBe('4.99');
  });

  it('a %-level gives no price to an item with no sales price', async () => {
    const [item] = await t.db.insert(items).values({ companyId: t.ctx.companyId, name: 'R11 Consulting', type: 'service' } as never).returning();
    const level = await createPriceLevel(t.ctx, { name: 'R11 Wholesale', type: 'fixed_percent', percent: '-10' });
    const c = await createCustomer(t.ctx, { displayName: 'R11 Buyer' });
    await assignCustomerPricing(t.ctx, c.id, { priceLevelId: level.id });
    const [q] = await quotePrices(t.ctx, { customerId: c.id, date: new Date('2026-11-14T00:00:00Z') }, [{ itemId: item.id, quantity: 1 }]);
    expect(q.source).not.toBe('price_level');
  });
});

describe('Rebuild Data', { timeout: 120_000 }, () => {
  it('item quantities leave average-cost items alone', async () => {
    const [item] = await t.db
      .insert(items)
      .values({ companyId: t.ctx.companyId, name: 'R11 Avg', type: 'inventory', quantityOnHand: '50', averageCost: '2' } as never)
      .returning();
    const preview = await previewRebuild(t.ctx, 'item_quantities');
    expect(preview.fixes.some((f) => f.id === item.id)).toBe(false);
  });
});
