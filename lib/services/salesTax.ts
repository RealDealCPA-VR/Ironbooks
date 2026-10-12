/**
 * Sales tax setup — agencies and rates. Invoices reference a taxRateId; the invoice service
 * computes tax and credits Sales Tax Payable. This service manages the rate/agency master data
 * and a sales-tax liability summary.
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, creditMemos, taxAgencies, taxRateComponents, taxRates, invoices } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';

export async function listTaxAgencies(ctx: ServiceContext) {
  return ctx.db.select().from(taxAgencies).where(eq(taxAgencies.companyId, ctx.companyId));
}

export async function createTaxAgency(
  ctx: ServiceContext,
  input: { name: string; liabilityAccountId?: string | null },
) {
  if (!input.name?.trim()) throw validation('Agency name is required.');
  // The liability account, when given, must belong to this company.
  if (input.liabilityAccountId) {
    const [acct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, input.liabilityAccountId), eq(accounts.companyId, ctx.companyId)));
    if (!acct) throw notFound('Liability account');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(taxAgencies)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        liabilityAccountId: input.liabilityAccountId ?? null,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'tax_agency', entityId: row.id, newValues: row });
    return row;
  });
}

export async function listTaxRates(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const where = opts?.includeInactive
    ? eq(taxRates.companyId, ctx.companyId)
    : and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.isActive, true));
  return ctx.db.select().from(taxRates).where(where);
}

export async function createTaxRate(
  ctx: ServiceContext,
  input: { name: string; rate: string | number; agencyId?: string | null },
) {
  if (!input.name?.trim()) throw validation('Rate name is required.');
  const rate = Money.of(input.rate);
  if (rate.isNegative() || rate.greaterThan(1)) {
    throw validation('Rate must be a decimal fraction between 0 and 1 (e.g. 0.0825 for 8.25%).');
  }
  const [row] = await ctx.db
    .insert(taxRates)
    .values({
      companyId: ctx.companyId,
      name: input.name.trim(),
      rate: rate.toFixed(6),
      agencyId: input.agencyId ?? null,
    })
    .returning();
  await writeAudit(ctx, { action: 'create', entityType: 'tax_rate', entityId: row.id, newValues: row });
  return row;
}

/**
 * Edit a sales tax rate item (QB: edit the Sales Tax Item). A new rate applies to transactions
 * entered from now on — posted invoices keep the tax they were charged (their taxAmount and
 * journal entries are not touched). Deactivating hides the rate from new transactions.
 */
export async function updateTaxRate(
  ctx: ServiceContext,
  id: string,
  patch: { name?: string; rate?: string | number; agencyId?: string | null; isActive?: boolean },
) {
  const before = await getTaxRate(ctx, id);
  const name = patch.name !== undefined ? patch.name.trim() : before.name;
  if (!name) throw validation('Rate name is required.');
  let rate = before.rate;
  if (patch.rate !== undefined) {
    // A combined rate is the sum of its components — edit the components instead.
    const [component] = await ctx.db
      .select({ id: taxRateComponents.id })
      .from(taxRateComponents)
      .where(eq(taxRateComponents.taxRateId, id))
      .limit(1);
    if (component && !Money.eq(patch.rate, before.rate)) {
      throw validation('This rate is made of component rates. Change the components and the total updates itself.');
    }
    const r = Money.of(patch.rate);
    if (r.isNegative() || r.greaterThan(1)) {
      throw validation('Rate must be a decimal fraction between 0 and 1 (e.g. 0.0825 for 8.25%).');
    }
    rate = r.toFixed(6);
  }
  if (patch.agencyId) {
    const [agency] = await ctx.db
      .select({ id: taxAgencies.id })
      .from(taxAgencies)
      .where(and(eq(taxAgencies.id, patch.agencyId), eq(taxAgencies.companyId, ctx.companyId)));
    if (!agency) throw notFound('Tax agency');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(taxRates)
      .set({
        name,
        rate,
        agencyId: patch.agencyId !== undefined ? patch.agencyId : before.agencyId,
        isActive: patch.isActive !== undefined ? patch.isActive : before.isActive,
      })
      .where(and(eq(taxRates.id, id), eq(taxRates.companyId, tx.companyId)))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'tax_rate', entityId: id, oldValues: before, newValues: row });
    return row;
  });
}

export async function getTaxRate(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.id, id), eq(taxRates.companyId, ctx.companyId)));
  if (!row) throw notFound('Tax rate');
  return row;
}

/**
 * Total sales tax charged on invoices in a date range.
 * @deprecated Invoice headers only (misses sales receipts, credit memos, edits). Use
 * salesTaxLiabilityReport / salesTaxRevenueSummary in lib/services/accountant/salesTaxLedger.ts,
 * which read the Sales Tax Payable ledger and tie to it exactly.
 */
export async function salesTaxLiability(ctx: ServiceContext, range?: { from?: Date; to?: Date }) {
  const conds = [eq(invoices.companyId, ctx.companyId)];
  if (range?.from) conds.push(sql`${invoices.date} >= ${range.from}`);
  if (range?.to) conds.push(sql`${invoices.date} <= ${range.to}`);
  // Only live, issued invoices owe tax to agencies. Void invoices have had their
  // tax reversed in the GL; drafts have never been issued.
  conds.push(sql`${invoices.status} NOT IN ('void', 'draft')`);
  const [row] = await ctx.db
    .select({ total: sql<string>`COALESCE(SUM(${invoices.taxAmount}), 0)` })
    .from(invoices)
    .where(and(...conds));
  return { taxCollected: toAmountString(row?.total ?? 0) };
}

/**
 * Net sales-tax liability for a date range: tax charged on live invoices MINUS
 * tax credited back on live credit memos (credit memos post Dr Sales Tax
 * Payable, reversing the invoice's tax direction). This is the figure that
 * matches the 2200 GL movement once credit memos carry tax.
 *
 * @deprecated Not used by the app (wave2 accountant reconciled it): it ignores sales receipts,
 * per-line rates and agency attribution. The GL-driven engine
 * (lib/services/accountant/salesTaxLedger.ts → salesTaxLiabilityReport) supersedes it; kept only
 * for backwards compatibility of existing callers/tests.
 */
export async function salesTaxLiabilityNet(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
) {
  const { taxCollected } = await salesTaxLiability(ctx, range);

  const conds = [eq(creditMemos.companyId, ctx.companyId)];
  if (range?.from) conds.push(sql`${creditMemos.date} >= ${range.from}`);
  if (range?.to) conds.push(sql`${creditMemos.date} <= ${range.to}`);
  // Void memos have had their tax reversal reversed in the GL.
  conds.push(sql`${creditMemos.status} <> 'void'`);
  const [row] = await ctx.db
    .select({ total: sql<string>`COALESCE(SUM(${creditMemos.taxAmount}), 0)` })
    .from(creditMemos)
    .where(and(...conds));
  const taxCredited = toAmountString(row?.total ?? 0);

  return {
    taxCollected,
    taxCredited,
    netLiability: toAmountString(Money.of(taxCollected).minus(Money.of(taxCredited))),
  };
}
