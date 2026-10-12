/**
 * Customer-driven defaults for sales forms (QuickBooks Desktop behaviour):
 *
 *  - Sales tax: a customer's "Tax item" (customers.taxRateId) fills the form's tax rate when
 *    the caller did not choose one, and a customer whose tax code is non-taxable ("Non",
 *    customers.taxable = false) makes every line non-taxable — QB only taxes a taxable item
 *    for a taxable customer.
 *
 * Kept free of other service imports so invoices / estimates / sales receipts / credit memos /
 * sales orders can all use it without import cycles.
 */
import { and, eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import type { ServiceContext } from './_base';

export interface CustomerTaxDefaults {
  /** The customer's default tax item (taxRates row), or null. */
  taxRateId: string | null;
  /** false = the customer's tax code is non-taxable (lines are never taxed). */
  taxable: boolean;
}

export async function customerTaxDefaults(
  ctx: ServiceContext,
  customerId: string | null | undefined,
): Promise<CustomerTaxDefaults | null> {
  if (!customerId) return null;
  const [row] = await ctx.db
    .select({ taxRateId: customers.taxRateId, taxable: customers.taxable })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!row) return null;
  return { taxRateId: row.taxRateId ?? null, taxable: row.taxable !== false };
}

type TaxableDoc = {
  customerId?: string | null;
  taxRateId?: string | null;
  lines: Array<{ taxable?: boolean | null }>;
};

/**
 * Apply the customer's sales-tax defaults to a sales document input:
 *  - `taxRateId` left out (undefined) → the customer's tax item (only when `defaultRate`,
 *    i.e. on create; an explicit null means "no tax" and is kept);
 *  - non-taxable customer → every line `taxable: false`.
 * Returns a shallow copy; the input is not mutated.
 */
export async function applyCustomerTaxDefaults<T extends TaxableDoc>(
  ctx: ServiceContext,
  input: T,
  opts: { defaultRate?: boolean } = {},
): Promise<T> {
  const d = await customerTaxDefaults(ctx, input.customerId);
  if (!d) return input;
  let out: T = input;
  if (opts.defaultRate && input.taxRateId === undefined && d.taxRateId) {
    out = { ...out, taxRateId: d.taxRateId };
  }
  if (!d.taxable && input.lines.some((l) => l.taxable !== false)) {
    out = { ...out, lines: input.lines.map((l) => ({ ...l, taxable: false })) };
  }
  return out;
}
