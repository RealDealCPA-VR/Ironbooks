/**
 * Customer-driven defaults for sales forms (QuickBooks Desktop behaviour):
 *
 *  - Sales tax: a customer's "Tax item" (customers.taxRateId) fills the form's tax rate when
 *    the caller did not choose one, and a customer whose tax code is non-taxable ("Non",
 *    customers.taxable = false) makes every line non-taxable — QB only taxes a taxable item
 *    for a taxable customer. Each line's Sales Tax Code (salesar B9) is resolved on the server
 *    from the code it states, else the item's code (salesFormLists.applyLineTaxCodes): an item
 *    whose code is non-taxable is never taxed, whatever the caller sends.
 *  - Ship to: a new invoice / sales order / sales receipt / estimate whose ship-to was left out
 *    gets the customer's default ship-to address.
 *
 * Kept free of other service imports so invoices / estimates / sales receipts / credit memos /
 * sales orders can all use it without import cycles.
 */
import { and, eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import { defaultShipTo } from '@/lib/shipTo';
import { salesTaxOn } from '@/lib/featureGate';
import type { ServiceContext } from './_base';
import { applyLineTaxCodes, type TaxCodedLine } from './salesFormLists';

export interface CustomerTaxDefaults {
  /** The customer's default tax item (taxRates row), or null. */
  taxRateId: string | null;
  /** false = the customer's tax code is non-taxable (lines are never taxed). */
  taxable: boolean;
  /** The customer's Sales Tax Code (Sales Tax Code list), when set. */
  salesTaxCodeId: string | null;
}

export async function customerTaxDefaults(
  ctx: ServiceContext,
  customerId: string | null | undefined,
): Promise<CustomerTaxDefaults | null> {
  if (!customerId) return null;
  const [row] = await ctx.db
    .select({ taxRateId: customers.taxRateId, taxable: customers.taxable, salesTaxCodeId: customers.salesTaxCodeId })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!row) return null;
  return { taxRateId: row.taxRateId ?? null, taxable: row.taxable !== false, salesTaxCodeId: row.salesTaxCodeId ?? null };
}

type TaxableDoc = {
  customerId?: string | null;
  taxRateId?: string | null;
  lines: TaxCodedLine[];
};

/**
 * Apply the customer's sales-tax defaults to a sales document input:
 *  - `taxRateId` left out (undefined) → the customer's tax item (only when `defaultRate`,
 *    i.e. on create; an explicit null means "no tax" and is kept);
 *  - non-taxable customer → every line `taxable: false`;
 *  - every line gets its Sales Tax Code and the taxability the code gives (applyLineTaxCodes).
 * Returns a shallow copy; the input is not mutated.
 */
export async function applyCustomerTaxDefaults<T extends TaxableDoc>(
  ctx: ServiceContext,
  input: T,
  opts: { defaultRate?: boolean } = {},
): Promise<T> {
  const d = await customerTaxDefaults(ctx, input.customerId);
  if (!d) {
    // No customer (a walk-in sales receipt): the lines still get the item's code and a stated
    // code must be this company's (B9 is enforced on every sales document, not only named ones).
    return Array.isArray(input.lines) ? { ...input, lines: await applyLineTaxCodes(ctx, input.lines, null) } : input;
  }
  let out: T = input;
  if (opts.defaultRate && input.taxRateId === undefined && d.taxRateId && (await salesTaxOn(ctx))) {
    out = { ...out, taxRateId: d.taxRateId };
  }
  if (Array.isArray(input.lines)) {
    out = { ...out, lines: await applyLineTaxCodes(ctx, input.lines, { taxable: d.taxable, salesTaxCodeId: d.salesTaxCodeId }) };
  }
  return out;
}

/**
 * New document with no ship-to given (undefined) → the customer's default ship-to address
 * (customers.ship_to_addresses, else the plain shipping address). An explicit null is kept.
 */
export async function applyCustomerShipToDefault<T extends { customerId?: string | null; shipTo?: Record<string, string> | null }>(
  ctx: ServiceContext,
  input: T,
): Promise<T> {
  if (input.shipTo !== undefined || !input.customerId) return input;
  const [row] = await ctx.db
    .select({ list: customers.shipToAddresses, shipping: customers.shippingAddress })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!row) return input;
  const addr = defaultShipTo(row.list) ?? defaultShipTo(row.shipping ? [row.shipping] : null);
  return addr ? { ...input, shipTo: addr } : input;
}
