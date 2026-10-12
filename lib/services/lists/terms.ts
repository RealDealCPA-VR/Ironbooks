/**
 * Terms list (QB "Terms"): replaces the hard-coded 'net_30'-style strings.
 *
 * Exports the pure calculators `computeDueDate(terms, txnDate)` and
 * `computeDiscount(terms, txnDate, payDate, amount?)` (lib/services/lists/termsMath.ts) plus
 * database helpers that resolve a terms reference — an id, a legacy code ('net_30') or a name
 * ('Net 30') — to a Terms list row, and the default terms of a customer or vendor.
 *
 * Integration hooks for the document teams: sales/purchases call `dueDateFor(ctx, ref, date)` to
 * fill a document's due date and `discountFor(...)` when receiving/paying, and store the
 * resolved row's `code ?? name` in their existing `terms` varchar columns.
 */
import { and, eq, sql } from 'drizzle-orm';
import { customers, paymentTerms, vendors } from '@/lib/db/schema';
import { type ServiceContext, notFound } from '../_base';
import { ensureSeeded } from './simpleLists';
import { computeDiscount, computeDueDate, describeTerms, type DiscountResult, type TermsLike } from './termsMath';

export { computeDiscount, computeDueDate, computeDiscountDate, describeTerms } from './termsMath';
export type { TermsLike, DiscountResult } from './termsMath';

export type TermsRow = typeof paymentTerms.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a terms reference (id, legacy code like 'net_30', or name like 'Net 30') to the
 * company's Terms list row. Returns null for an empty reference; throws NOT_FOUND for an unknown one.
 */
export async function resolveTermsRef(ctx: ServiceContext, ref: string | null | undefined): Promise<TermsRow | null> {
  const value = ref?.trim();
  if (!value) return null;
  await ensureSeeded(ctx, 'terms');
  const scope = eq(paymentTerms.companyId, ctx.companyId);
  if (UUID_RE.test(value)) {
    const [byId] = await ctx.db.select().from(paymentTerms).where(and(scope, eq(paymentTerms.id, value)));
    if (byId) return byId;
  }
  const [byCode] = await ctx.db
    .select()
    .from(paymentTerms)
    .where(and(scope, sql`lower(${paymentTerms.code}) = lower(${value})`));
  if (byCode) return byCode;
  const [byName] = await ctx.db
    .select()
    .from(paymentTerms)
    .where(and(scope, sql`lower(${paymentTerms.name}) = lower(${value})`));
  if (byName) return byName;
  // Legacy strings such as 'net_45' that were never on the list: a well-formed net_N maps to "Net N".
  const m = /^net[_\s-]?(\d{1,3})$/i.exec(value);
  if (m) {
    const [byNet] = await ctx.db
      .select()
      .from(paymentTerms)
      .where(and(scope, eq(paymentTerms.kind, 'standard'), eq(paymentTerms.netDays, Number(m[1])), sql`${paymentTerms.discountPercent} IS NULL`));
    if (byNet) return byNet;
  }
  throw notFound(`Terms "${value}"`);
}

/** The legacy string stored in documents' / parties' `terms` varchar for a Terms row. */
export function termsLabel(row: Pick<TermsRow, 'code' | 'name'>): string {
  return (row.code ?? row.name).slice(0, 50);
}

/** Default terms of a customer (its termsId, else its legacy terms string), or null. */
export async function customerTerms(ctx: ServiceContext, customerId: string): Promise<TermsRow | null> {
  const [c] = await ctx.db
    .select({ termsId: customers.termsId, terms: customers.terms })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.companyId, ctx.companyId)));
  if (!c) throw notFound('Customer');
  return resolveTermsRef(ctx, c.termsId ?? c.terms).catch(() => null);
}

/** Default terms of a vendor (its termsId, else its legacy terms string), or null. */
export async function vendorTerms(ctx: ServiceContext, vendorId: string): Promise<TermsRow | null> {
  const [v] = await ctx.db
    .select({ termsId: vendors.termsId, terms: vendors.terms })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!v) throw notFound('Vendor');
  return resolveTermsRef(ctx, v.termsId ?? v.terms).catch(() => null);
}

/** Due date for a document dated `txnDate` under the referenced terms (null ref → txnDate). */
export async function dueDateFor(ctx: ServiceContext, ref: string | null | undefined, txnDate: Date): Promise<Date> {
  const row = await resolveTermsRef(ctx, ref);
  return row ? computeDueDate(row as TermsLike, txnDate) : computeDueDate({ kind: 'standard', netDays: 0 }, txnDate);
}

/** Early-payment discount under the referenced terms (no terms → never eligible). */
export async function discountFor(
  ctx: ServiceContext,
  ref: string | null | undefined,
  txnDate: Date,
  payDate: Date,
  amount?: string | number | null,
): Promise<DiscountResult> {
  const row = await resolveTermsRef(ctx, ref);
  return computeDiscount((row ?? { kind: 'standard', netDays: 0 }) as TermsLike, txnDate, payDate, amount);
}

/** Preview for the UI: due date, discount date and a plain-language description. */
export async function previewTerms(
  ctx: ServiceContext,
  ref: string,
  txnDate: Date,
  payDate?: Date | null,
  amount?: string | null,
) {
  const row = await resolveTermsRef(ctx, ref);
  if (!row) throw notFound('Terms');
  const t = row as TermsLike;
  return {
    terms: row,
    description: describeTerms(t),
    dueDate: computeDueDate(t, txnDate),
    discount: computeDiscount(t, txnDate, payDate ?? txnDate, amount ?? undefined),
  };
}
