/**
 * Customer-specific item prices (the /customer-pricing screen; the legacy "price level" path).
 *
 * The `customerPrices` table holds per-customer prices for items. Since B12 these are NOT applied
 * by any form on its own: they are one candidate inside the advanced pricing engine
 * (lib/services/pricing.ts, source 'customer_price'), next to the customer's price level
 * (customers.priceLevelId, set on the customer form or in Advanced Pricing) and price rules.
 * Every sales form — invoice, sales receipt, estimate, sales order, credit memo — asks that one
 * engine for a quote (/api/pricing/quote) and the document services re-price server-side with
 * resolveLinePricing, so a customer price and a price level can never disagree between screens:
 * the company's conflict setting ('lowest' price wins, or rule 'priority') decides between them.
 * `getPrice` is kept for direct lookups only (no form uses it to price a line).
 *
 * No GL impact — this is master-data only. An audit log row is written on every
 * mutation so price changes are traceable.
 */
import { and, eq } from 'drizzle-orm';
import { customerPrices, customers, items } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerPrice {
  id: string;
  companyId: string;
  customerId: string;
  itemId: string;
  price: string;
}

// ---------------------------------------------------------------------------
// listCustomerPrices
// ---------------------------------------------------------------------------

/**
 * List all custom prices for a company, optionally filtered to one customer.
 */
export async function listCustomerPrices(
  ctx: ServiceContext,
  customerId?: string,
): Promise<CustomerPrice[]> {
  const conditions = [eq(customerPrices.companyId, ctx.companyId)];
  if (customerId) {
    conditions.push(eq(customerPrices.customerId, customerId));
  }

  const rows = await ctx.db
    .select()
    .from(customerPrices)
    .where(and(...conditions));

  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    customerId: r.customerId,
    itemId: r.itemId,
    price: r.price,
  }));
}

// ---------------------------------------------------------------------------
// setCustomerPrice  (upsert)
// ---------------------------------------------------------------------------

export interface SetCustomerPriceInput {
  customerId: string;
  itemId: string;
  price: string | number;
}

/**
 * Create or update the custom price for a (customer, item) pair.
 * Validates that both the customer and the item belong to this company.
 */
export async function setCustomerPrice(
  ctx: ServiceContext,
  input: SetCustomerPriceInput,
): Promise<CustomerPrice> {
  const priceDecimal = Money.of(input.price);
  if (priceDecimal.isNegative()) {
    throw validation('price cannot be negative');
  }
  const priceStr = priceDecimal.toFixed(4);

  // Verify customer belongs to this company
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

  // Verify item belongs to this company
  const [item] = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, input.itemId)));
  if (!item) throw notFound('Item');

  // Check if a row already exists for this (company, customer, item) triple
  const [existing] = await ctx.db
    .select()
    .from(customerPrices)
    .where(
      and(
        eq(customerPrices.companyId, ctx.companyId),
        eq(customerPrices.customerId, input.customerId),
        eq(customerPrices.itemId, input.itemId),
      ),
    );

  if (existing) {
    // Update
    const [updated] = await ctx.db
      .update(customerPrices)
      .set({ price: priceStr })
      .where(eq(customerPrices.id, existing.id))
      .returning();

    await writeAudit(ctx, {
      action: 'update',
      entityType: 'customer_price',
      entityId: updated.id,
      oldValues: { price: existing.price },
      newValues: { price: priceStr },
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      customerId: updated.customerId,
      itemId: updated.itemId,
      price: updated.price,
    };
  }

  // Insert
  const [created] = await ctx.db
    .insert(customerPrices)
    .values({
      companyId: ctx.companyId,
      customerId: input.customerId,
      itemId: input.itemId,
      price: priceStr,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'customer_price',
    entityId: created.id,
    newValues: { customerId: input.customerId, itemId: input.itemId, price: priceStr },
  });

  return {
    id: created.id,
    companyId: created.companyId,
    customerId: created.customerId,
    itemId: created.itemId,
    price: created.price,
  };
}

// ---------------------------------------------------------------------------
// deleteCustomerPrice
// ---------------------------------------------------------------------------

/**
 * Remove a custom price row by its ID.
 * Verifies ownership via companyId.
 */
export async function deleteCustomerPrice(ctx: ServiceContext, id: string): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(customerPrices)
    .where(and(eq(customerPrices.companyId, ctx.companyId), eq(customerPrices.id, id)));

  if (!row) throw notFound('CustomerPrice');

  await ctx.db.delete(customerPrices).where(eq(customerPrices.id, id));

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'customer_price',
    entityId: id,
    oldValues: { customerId: row.customerId, itemId: row.itemId, price: row.price },
  });
}

// ---------------------------------------------------------------------------
// getPrice
// ---------------------------------------------------------------------------

/**
 * Look up the customer-specific price for a given item.
 * Returns the price string if a custom price exists, or null if none is set
 * (caller should fall back to item.salesPrice).
 */
export async function getPrice(
  ctx: ServiceContext,
  customerId: string,
  itemId: string,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ price: customerPrices.price })
    .from(customerPrices)
    .where(
      and(
        eq(customerPrices.companyId, ctx.companyId),
        eq(customerPrices.customerId, customerId),
        eq(customerPrices.itemId, itemId),
      ),
    );

  return row?.price ?? null;
}
