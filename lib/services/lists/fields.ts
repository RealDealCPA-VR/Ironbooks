/**
 * Shared resolution of list-backed fields on customers, vendors and items (Terms, Sales Tax Code,
 * preferred vendor, U/M set). Keeps the legacy columns in sync so older code keeps working:
 *  - `terms` varchar mirrors the Terms row (code ?? name) whenever `termsId` is set;
 *  - `taxable` mirrors the Sales Tax Code's taxable flag whenever `salesTaxCodeId` is set.
 */
import { and, eq } from 'drizzle-orm';
import { salesTaxCodes, uomSets, vendors } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation } from '../_base';
import { resolveTermsRef, termsLabel } from './terms';
import { ensureSeeded } from './simpleLists';

/**
 * Resolve terms input. `termsId` wins (must exist); otherwise a `terms` string is matched against
 * the Terms list (id / code / name) and, when it is not on the list, kept as a legacy string.
 * Returns undefined when neither key was supplied (leave the record's terms unchanged).
 */
export async function resolvePartyTerms(
  ctx: ServiceContext,
  input: { termsId?: string | null; terms?: string | null },
): Promise<{ termsId: string | null; terms: string | null } | undefined> {
  if (input.termsId !== undefined) {
    if (input.termsId === null) {
      return { termsId: null, terms: input.terms !== undefined ? input.terms ?? null : null };
    }
    const row = await resolveTermsRef(ctx, input.termsId);
    if (!row || row.id !== input.termsId) throw notFound('Terms');
    if (!row.isActive) throw validation(`The terms "${row.name}" are inactive.`);
    return { termsId: row.id, terms: termsLabel(row) };
  }
  if (input.terms !== undefined) {
    if (!input.terms) return { termsId: null, terms: null };
    const row = await resolveTermsRef(ctx, input.terms).catch(() => null);
    // Keep the caller's own wording in the legacy column; link the list entry when it matches.
    if (row) return { termsId: row.id, terms: input.terms.slice(0, 50) };
    return { termsId: null, terms: input.terms.slice(0, 50) };
  }
  return undefined;
}

/** Validate a sales tax code id; returns its taxable flag. */
export async function resolveSalesTaxCode(ctx: ServiceContext, id: string): Promise<{ id: string; taxable: boolean; code: string }> {
  await ensureSeeded(ctx, 'sales-tax-codes');
  const [row] = await ctx.db
    .select()
    .from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.id, id), eq(salesTaxCodes.companyId, ctx.companyId)));
  if (!row) throw notFound('Sales tax code');
  return { id: row.id, taxable: row.taxable, code: row.code };
}

/** The company's default taxable / non-taxable code ('Tax' / 'Non' unless renamed). */
export async function defaultSalesTaxCode(ctx: ServiceContext, taxable: boolean): Promise<string | null> {
  await ensureSeeded(ctx, 'sales-tax-codes');
  const rows = await ctx.db
    .select()
    .from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.companyId, ctx.companyId), eq(salesTaxCodes.taxable, taxable), eq(salesTaxCodes.isActive, true)));
  const preferred = rows.find((r) => r.code.toLowerCase() === (taxable ? 'tax' : 'non'));
  return (preferred ?? rows[0])?.id ?? null;
}

export async function assertVendor(ctx: ServiceContext, vendorId: string): Promise<void> {
  const [v] = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!v) throw notFound('Preferred vendor');
}

export async function assertUomSet(ctx: ServiceContext, setId: string): Promise<void> {
  const [s] = await ctx.db
    .select({ id: uomSets.id })
    .from(uomSets)
    .where(and(eq(uomSets.id, setId), eq(uomSets.companyId, ctx.companyId)));
  if (!s) throw notFound('Unit of measure set');
}
