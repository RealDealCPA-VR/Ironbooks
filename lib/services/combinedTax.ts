/**
 * Combined / multi-component sales-tax rates — QuickBooks-style combined rates.
 *
 * A single `taxRates` row can be composed of multiple `taxRateComponents` (e.g.
 * state 6% + county 1% + city 0.5% = 7.5%).  Writing components always
 * recomputes and persists the parent rate so the invoicing engine sees the
 * correct combined fraction without any extra work.
 *
 * `salesTaxByAgency` splits total collected tax across components/agencies
 * proportionally by their rate share.
 */
import { and, eq, sql } from 'drizzle-orm';
import { taxRates, taxRateComponents, taxAgencies } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation, writeAudit, inTransaction } from './_base';
import { salesTaxActivity } from './accountant/salesTaxLedger';
import { parseTaxRateFraction } from './salesTax';

// ---------------------------------------------------------------------------
// listComponents
// ---------------------------------------------------------------------------

export async function listComponents(ctx: ServiceContext, taxRateId: string) {
  // Verify the tax rate belongs to this company.
  const [rate] = await ctx.db
    .select()
    .from(taxRates)
    .where(and(eq(taxRates.id, taxRateId), eq(taxRates.companyId, ctx.companyId)));
  if (!rate) throw notFound('Tax rate');

  return ctx.db
    .select()
    .from(taxRateComponents)
    .where(
      and(
        eq(taxRateComponents.taxRateId, taxRateId),
        eq(taxRateComponents.companyId, ctx.companyId),
      ),
    );
}

// ---------------------------------------------------------------------------
// setComponents
// ---------------------------------------------------------------------------

export interface ComponentInput {
  name: string;
  agencyId?: string | null;
  rate: string | number;
}

/**
 * Replace all components for a tax rate and recompute the parent rate.
 * Returns the updated list of components.
 */
export async function setComponents(
  ctx: ServiceContext,
  taxRateId: string,
  components: ComponentInput[],
) {
  if (!Array.isArray(components)) throw validation('components must be an array.');

  // Validate and convert each component rate.
  const parsed = components.map((c, i) => {
    if (!c || typeof c !== 'object') throw validation(`Component ${i + 1}: enter a name and a rate.`);
    if (typeof c.name !== 'string' || !c.name.trim()) throw validation(`Component ${i + 1}: name is required.`);
    // NaN / Infinity / text are refused (NaN used to be stored and taxed every invoice NaN).
    const r = parseTaxRateFraction(c.rate, `Component ${i + 1}: rate`);
    return { name: c.name.trim(), agencyId: c.agencyId ?? null, rate: r };
  });
  // The combined rate is the sum of its components and must itself be a valid rate.
  const sum = parsed.reduce((s, c) => s.plus(c.rate), Money.zero());
  if (sum.greaterThan(1)) throw validation('The component rates add up to more than 100%.');

  return inTransaction(ctx, async (tx) => {
    // Verify ownership.
    const [rate] = await tx.db
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.id, taxRateId), eq(taxRates.companyId, tx.companyId)));
    if (!rate) throw notFound('Tax rate');

    // If agencyIds supplied, verify they belong to this company.
    const agencyIds = parsed
      .map((c) => c.agencyId)
      .filter((id): id is string => id !== null && id !== undefined);
    if (agencyIds.length > 0) {
      const existing = await tx.db
        .select({ id: taxAgencies.id })
        .from(taxAgencies)
        .where(
          and(
            eq(taxAgencies.companyId, tx.companyId),
            sql`${taxAgencies.id} = ANY(ARRAY[${sql.join(
              agencyIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}])`,
          ),
        );
      const foundIds = new Set(existing.map((r) => r.id));
      for (const id of agencyIds) {
        if (!foundIds.has(id)) throw notFound(`Tax agency ${id}`);
      }
    }

    // Delete existing components.
    await tx.db
      .delete(taxRateComponents)
      .where(
        and(
          eq(taxRateComponents.taxRateId, taxRateId),
          eq(taxRateComponents.companyId, tx.companyId),
        ),
      );

    // Insert new components.
    let combinedRate = Money.zero();
    let rows: (typeof taxRateComponents.$inferSelect)[] = [];

    if (parsed.length > 0) {
      rows = await tx.db
        .insert(taxRateComponents)
        .values(
          parsed.map((c) => ({
            companyId: tx.companyId,
            taxRateId,
            name: c.name,
            agencyId: c.agencyId,
            rate: c.rate.toFixed(6),
          })),
        )
        .returning();

      for (const c of parsed) combinedRate = combinedRate.plus(c.rate);
    }

    // Recompute parent taxRates.rate = sum of components.
    const newRate = combinedRate.toFixed(6);
    await tx.db
      .update(taxRates)
      .set({ rate: newRate })
      .where(eq(taxRates.id, taxRateId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'tax_rate_components',
      entityId: taxRateId,
      oldValues: { previousRate: rate.rate },
      newValues: { newRate, components: rows },
    });

    return rows;
  });
}

// ---------------------------------------------------------------------------
// salesTaxByAgency
// ---------------------------------------------------------------------------

export interface AgencyTaxRow {
  agencyId: string | null;
  agencyName: string | null;
  componentName: string;
  componentRate: string;
  rateShare: string; // fraction of parent rate
  taxCollected: string; // dollar amount for the period (net of credit memos)
}

export interface SalesTaxByAgencyResult {
  rows: AgencyTaxRow[];
  total: string;
}

/**
 * Net sales tax collected in the date range, per agency component.
 *
 * Delegates to the GL-driven sales-tax engine (lib/services/accountant/salesTaxLedger.ts), so it
 * covers invoices, sales receipts, credit memos (negative), per-line rates and combined-rate
 * components, and excludes voided documents — and it agrees to the penny with the Sales Tax
 * Payable ledger. Rates without components report under the rate's own agency; tax with no
 * resolvable rate lands in an "Unassigned tax" row.
 */
export async function salesTaxByAgency(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<SalesTaxByAgencyResult> {
  const activity = await salesTaxActivity(ctx, { to: range?.to });

  const rateRows = await ctx.db.select().from(taxRates).where(eq(taxRates.companyId, ctx.companyId));
  const compRows = await ctx.db
    .select()
    .from(taxRateComponents)
    .where(eq(taxRateComponents.companyId, ctx.companyId));
  const agencyRows = await ctx.db
    .select({ id: taxAgencies.id, name: taxAgencies.name })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));
  const agencyName = new Map(agencyRows.map((a) => [a.id, a.name]));

  const acc = new Map<string, { row: Omit<AgencyTaxRow, 'taxCollected'>; v: ReturnType<typeof Money.zero> }>();
  let total = Money.zero();
  for (const r of activity) {
    if (r.kind !== 'collected' && r.kind !== 'credited') continue;
    if (range?.from && r.date < range.from) continue;
    const amt = Money.of(r.amount);
    total = total.plus(amt);
    const rate = r.taxRateId ? rateRows.find((x) => x.id === r.taxRateId) : undefined;
    const comps = r.taxRateId ? compRows.filter((c) => c.taxRateId === r.taxRateId) : [];
    const comp = comps.find((c) => c.name === r.componentName && c.agencyId === r.agencyId);
    const totalRate = comps.reduce((s, c) => s.plus(Money.of(c.rate)), Money.zero());
    const componentRate = comp?.rate ?? rate?.rate ?? '0.000000';
    const rateShare = comp && !totalRate.isZero() ? Money.of(comp.rate).dividedBy(totalRate).toFixed(6) : '1.000000';
    const key = `${r.agencyId ?? '__none__'}|${r.componentName}|${componentRate}`;
    const e = acc.get(key) ?? {
      row: {
        agencyId: r.agencyId,
        agencyName: r.agencyId ? (agencyName.get(r.agencyId) ?? null) : null,
        componentName: r.componentName,
        componentRate,
        rateShare,
      },
      v: Money.zero(),
    };
    e.v = e.v.plus(amt);
    acc.set(key, e);
  }

  const rows: AgencyTaxRow[] = [...acc.values()]
    .filter((e) => !e.v.isZero())
    .map((e) => ({ ...e.row, taxCollected: toAmountString(e.v) }));
  return { rows, total: toAmountString(total) };
}
