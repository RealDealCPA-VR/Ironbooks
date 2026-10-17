/**
 * Finance charges — QB Desktop "Assess Finance Charges" parity.
 *
 * Settings (annual interest rate %, minimum charge, grace days) live in
 * companies.settings.financeCharges (jsonb). Assessment walks every overdue
 * open invoice as of a date, computes simple interest per invoice
 * (balanceDue × annualRate/100 × daysOverdue/365), applies the minimum charge
 * per customer, and creates ONE finance-charge invoice per customer posted to
 * a "Finance Charge Income" account (code 4400, find-or-create).
 *
 * Idempotency: each finance-charge invoice carries a `[FC:YYYY-MM]` marker in
 * its memo (keyed by the asOf month). Re-running an assessment for the same
 * period skips customers that already have a non-void marker invoice. Marker
 * invoices are also EXCLUDED from the charge base, so finance charges never
 * compound on prior finance charges.
 *
 * Numbering: finance-charge invoices take the next regular invoice number through
 * allocateDocNumber (alphanumeric, honours the starting number).
 *
 * NOTE: invoices are created directly here (header + line + GL posting via
 * postJournalEntry) instead of through invoices.createInvoice, because the
 * credit-limit check there would block exactly the delinquent customers this
 * feature targets. The posting mirrors createInvoice's A/R scheme:
 *   Dr 1200 Accounts Receivable / Cr 4400 Finance Charge Income.
 */
import { and, asc, eq, gt, inArray, like, lt, ne, or, isNull, sql } from 'drizzle-orm';
import { accounts, companies, customers, invoiceLines, invoices } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry } from './posting';
import { allocateDocNumber, docRef } from './docNumbers';

const DAY_MS = 86_400_000;
const FC_INCOME_CODE = '4400';
const FC_INCOME_NAME = 'Finance Charge Income';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface FinanceChargeSettings {
  /** Annual interest rate as a percentage, e.g. '18' = 18% APR. */
  annualRate: string;
  /** Minimum charge per customer per assessment (applied when 0 < computed < min). */
  minCharge: string;
  /** Days past the due date before an invoice becomes chargeable. */
  graceDays: number;
}

export const DEFAULT_FINANCE_CHARGE_SETTINGS: FinanceChargeSettings = {
  annualRate: '18',
  minCharge: '0',
  graceDays: 0,
};

export async function getFinanceChargeSettings(
  ctx: ServiceContext,
): Promise<FinanceChargeSettings> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!row) throw notFound('Company');
  const stored = (row.settings?.financeCharges ?? {}) as Partial<FinanceChargeSettings>;
  return { ...DEFAULT_FINANCE_CHARGE_SETTINGS, ...stored };
}

function validateSettings(s: FinanceChargeSettings): void {
  const rate = Money.of(s.annualRate);
  if (rate.lessThan(0) || rate.greaterThan(100)) {
    throw validation('Annual rate must be between 0 and 100 (percent).');
  }
  if (Money.of(s.minCharge).lessThan(0)) {
    throw validation('Minimum charge cannot be negative.');
  }
  if (!Number.isInteger(s.graceDays) || s.graceDays < 0 || s.graceDays > 365) {
    throw validation('Grace days must be a whole number between 0 and 365.');
  }
}

/** Merge-update the finance-charge settings stored on companies.settings. */
export async function updateFinanceChargeSettings(
  ctx: ServiceContext,
  input: Partial<FinanceChargeSettings>,
): Promise<FinanceChargeSettings> {
  const current = await getFinanceChargeSettings(ctx);
  const next: FinanceChargeSettings = {
    annualRate:
      input.annualRate !== undefined ? toAmountString(input.annualRate) : current.annualRate,
    minCharge:
      input.minCharge !== undefined ? toAmountString(input.minCharge) : current.minCharge,
    graceDays: input.graceDays !== undefined ? Number(input.graceDays) : current.graceDays,
  };
  validateSettings(next);

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, tx.companyId));
    if (!row) throw notFound('Company');

    await tx.db
      .update(companies)
      .set({
        settings: { ...(row.settings ?? {}), financeCharges: next },
        updatedAt: new Date(),
      })
      .where(eq(companies.id, tx.companyId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'company_settings',
      entityId: tx.companyId,
      oldValues: { financeCharges: current },
      newValues: { financeCharges: next },
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface FinanceChargeInvoiceDetail {
  invoiceId: string;
  invoiceNumber: number;
  /** The invoice number the user sees (typed ref number, else the legacy integer). */
  refNumber: string;
  dueDate: string;
  balanceDue: string;
  daysOverdue: number;
  charge: string;
}

export interface FinanceChargeCustomerPreview {
  customerId: string;
  displayName: string;
  overdueInvoices: FinanceChargeInvoiceDetail[];
  /** Sum of per-invoice interest before applying the minimum charge. */
  baseCharge: string;
  /** Charge to assess (baseCharge or minCharge, whichever applies). */
  charge: string;
  minimumApplied: boolean;
  /** A non-void finance-charge invoice already exists for this period. */
  alreadyAssessed: boolean;
}

export interface FinanceChargePreview {
  asOf: string;
  /** Idempotency key — the asOf month, e.g. '2026-06'. */
  periodKey: string;
  settings: FinanceChargeSettings;
  customers: FinanceChargeCustomerPreview[];
}

function periodKeyFor(asOf: Date): string {
  return asOf.toISOString().slice(0, 7);
}

export function fcMarker(periodKey: string): string {
  return `[FC:${periodKey}]`;
}

/**
 * Compute (without posting) the finance charges that WOULD be assessed as of
 * `asOf`. Pass `settings` to override stored settings for this run.
 */
export async function previewFinanceCharges(
  ctx: ServiceContext,
  opts: { asOf: Date; settings?: Partial<FinanceChargeSettings> },
): Promise<FinanceChargePreview> {
  const stored = await getFinanceChargeSettings(ctx);
  const settings: FinanceChargeSettings = {
    annualRate:
      opts.settings?.annualRate !== undefined
        ? String(opts.settings.annualRate)
        : stored.annualRate,
    minCharge:
      opts.settings?.minCharge !== undefined ? String(opts.settings.minCharge) : stored.minCharge,
    graceDays: opts.settings?.graceDays !== undefined ? Number(opts.settings.graceDays) : stored.graceDays,
  };
  validateSettings(settings);

  const asOf = opts.asOf;
  if (isNaN(asOf.getTime())) throw validation('Invalid assessment date.');
  const periodKey = periodKeyFor(asOf);

  // All open invoices with a balance, dated on/before asOf, excluding prior
  // finance-charge invoices (memo marker) so charges never compound.
  const rows = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      date: invoices.date,
      dueDate: invoices.dueDate,
      balanceDue: invoices.balanceDue,
      exchangeRate: invoices.exchangeRate,
      displayName: customers.displayName,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoices.status, ['open', 'partial', 'overdue']),
        gt(sql`CAST(${invoices.balanceDue} AS NUMERIC)`, 0),
        lt(invoices.date, new Date(asOf.getTime() + DAY_MS)),
        or(isNull(invoices.memo), sql`${invoices.memo} NOT LIKE '%[FC:%'`),
      ),
    )
    .orderBy(asc(customers.displayName), asc(invoices.dueDate));

  // Customers already assessed for this period (non-void marker invoice).
  const assessedRows = await ctx.db
    .select({ customerId: invoices.customerId })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        ne(invoices.status, 'void'),
        like(invoices.memo, `%${fcMarker(periodKey)}%`),
      ),
    );
  const assessedSet = new Set(assessedRows.map((r) => r.customerId));

  const dailyRate = Money.div(Money.div(settings.annualRate, 100), 365);
  const minCharge = Money.of(settings.minCharge);

  const byCustomer = new Map<string, FinanceChargeCustomerPreview>();
  for (const r of rows) {
    const effDue = r.dueDate ?? r.date;
    const daysOverdue = Math.floor((asOf.getTime() - effDue.getTime()) / DAY_MS);
    // Chargeable only once past the grace period; interest accrues from the due date.
    if (daysOverdue <= settings.graceDays) continue;

    // balanceDue is in the invoice's own currency; the finance-charge invoice is in home
    // currency, so the interest is charged on the balance's home value (balance x booked rate).
    const homeBalance = Money.round2(Money.mul(Money.of(r.balanceDue), Money.of(r.exchangeRate ?? 1)));
    const charge = Money.round2(Money.mul(Money.mul(homeBalance, dailyRate), daysOverdue));
    if (charge.lessThanOrEqualTo(0)) continue;

    let entry = byCustomer.get(r.customerId);
    if (!entry) {
      entry = {
        customerId: r.customerId,
        displayName: r.displayName,
        overdueInvoices: [],
        baseCharge: '0.00',
        charge: '0.00',
        minimumApplied: false,
        alreadyAssessed: assessedSet.has(r.customerId),
      };
      byCustomer.set(r.customerId, entry);
    }
    entry.overdueInvoices.push({
      invoiceId: r.id,
      invoiceNumber: r.invoiceNumber,
      refNumber: docRef(r.refNumber, r.invoiceNumber),
      dueDate: effDue.toISOString().slice(0, 10),
      balanceDue: toAmountString(homeBalance), // home currency, the base the charge is on
      daysOverdue,
      charge: toAmountString(charge),
    });
  }

  for (const entry of byCustomer.values()) {
    const base = entry.overdueInvoices.reduce(
      (sum, inv) => sum.plus(Money.of(inv.charge)),
      Money.zero(),
    );
    entry.baseCharge = toAmountString(base);
    if (base.greaterThan(0) && base.lessThan(minCharge)) {
      entry.charge = toAmountString(minCharge);
      entry.minimumApplied = true;
    } else {
      entry.charge = toAmountString(base);
    }
  }

  return {
    asOf: asOf.toISOString().slice(0, 10),
    periodKey,
    settings,
    customers: [...byCustomer.values()],
  };
}

// ---------------------------------------------------------------------------
// Assess
// ---------------------------------------------------------------------------

export interface AssessedFinanceCharge {
  customerId: string;
  displayName: string;
  invoiceId: string;
  invoiceNumber: number;
  /** The invoice number the user sees (alphanumeric, e.g. "INV-1003"). */
  refNumber: string;
  charge: string;
}

export interface AssessFinanceChargesResult {
  asOf: string;
  periodKey: string;
  assessed: AssessedFinanceCharge[];
  skipped: Array<{ customerId: string; displayName: string; reason: string }>;
}

/** Find-or-create an account by code (local helper — mirrors invoices.ts). */
async function getOrCreateAccountByCode(
  ctx: ServiceContext,
  code: string,
  def: { name: string; type: string; subtype: string },
): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (row) return row.id;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code,
      name: def.name,
      type: def.type as never,
      subtype: def.subtype as never,
    })
    .returning();
  return created.id;
}

/**
 * Assess finance charges as of a date: creates one finance-charge invoice per
 * customer with a chargeable overdue balance (Dr A/R, Cr Finance Charge
 * Income), skipping customers already assessed for the period. Pass
 * `customerIds` to assess a subset of the preview.
 */
export async function assessFinanceCharges(
  ctx: ServiceContext,
  opts: {
    asOf: Date;
    customerIds?: string[];
    settings?: Partial<FinanceChargeSettings>;
  },
): Promise<AssessFinanceChargesResult> {
  const preview = await previewFinanceCharges(ctx, { asOf: opts.asOf, settings: opts.settings });
  const onlySet = opts.customerIds ? new Set(opts.customerIds) : null;

  // Find-or-create in one transaction, so two runs at once cannot both create the account.
  const { arAccountId, fcIncomeId } = await inTransaction(ctx, async (tx) => ({
    arAccountId: await getOrCreateAccountByCode(tx, '1200', {
      name: 'Accounts Receivable',
      type: 'asset',
      subtype: 'accounts_receivable',
    }),
    fcIncomeId: await getOrCreateAccountByCode(tx, FC_INCOME_CODE, {
      name: FC_INCOME_NAME,
      type: 'revenue',
      subtype: 'other_income',
    }),
  }));

  const assessed: AssessedFinanceCharge[] = [];
  const skipped: AssessFinanceChargesResult['skipped'] = [];

  for (const row of preview.customers) {
    if (onlySet && !onlySet.has(row.customerId)) continue;
    if (row.alreadyAssessed) {
      skipped.push({
        customerId: row.customerId,
        displayName: row.displayName,
        reason: `Already assessed for ${preview.periodKey}.`,
      });
      continue;
    }
    const charge = Money.of(row.charge);
    if (charge.lessThanOrEqualTo(0)) continue;

    try {
      const result = await inTransaction(ctx, async (tx) => {
        // The preview was read outside this transaction: re-check inside it, so two runs at once
        // (a double-click on Assess) cannot both charge this customer for the period.
        const [already] = await tx.db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.companyId, tx.companyId),
              eq(invoices.customerId, row.customerId),
              ne(invoices.status, 'void'),
              like(invoices.memo, `%${fcMarker(preview.periodKey)}%`),
            ),
          )
          .limit(1);
        if (already) throw new ServiceError('CONFLICT', `Already assessed for ${preview.periodKey}.`);
        // Same numbering as every other invoice (QB: finance-charge invoices take the next
        // invoice number): the last number used with its trailing digits + 1, prefix kept
        // ("INV-1002" -> "INV-1003"), under the per-company allocation lock.
        const { refNumber, number: invoiceNumber } = await allocateDocNumber(tx, 'invoice', null);
        const shownNumber = docRef(refNumber, invoiceNumber);
        const asOfIso = preview.asOf;
        const description = `Finance charge on overdue balance (assessed ${asOfIso})`;

        const [invoice] = await tx.db
          .insert(invoices)
          .values({
            companyId: tx.companyId,
            customerId: row.customerId,
            invoiceNumber,
            refNumber,
            date: opts.asOf,
            dueDate: opts.asOf,
            status: 'open',
            subtotal: toAmountString(charge),
            discount: '0.00',
            taxAmount: '0.00',
            total: toAmountString(charge),
            amountPaid: '0.00',
            balanceDue: toAmountString(charge),
            memo: `Finance charge assessed ${asOfIso} ${fcMarker(preview.periodKey)}`,
          })
          .returning();

        await tx.db.insert(invoiceLines).values({
          invoiceId: invoice.id,
          accountId: fcIncomeId,
          description,
          quantity: '1.00',
          rate: toAmountString(charge),
          amount: toAmountString(charge),
          taxable: false,
          lineOrder: 0,
        });

        const entry = await postJournalEntry(tx, {
          date: opts.asOf,
          description: `Invoice #${shownNumber} — finance charge`,
          reference: shownNumber,
          sourceRef: `invoice:${invoice.id}`,
          lines: [
            {
              accountId: arAccountId,
              debit: toAmountString(charge),
              memo: `Invoice #${shownNumber} — finance charge`,
              controlLine: true,
            },
            {
              accountId: fcIncomeId,
              credit: toAmountString(charge),
              memo: `Invoice #${shownNumber} — finance charge income`,
            },
          ],
        });

        const [updated] = await tx.db
          .update(invoices)
          .set({ postedEntryId: entry.id, updatedAt: new Date() })
          .where(eq(invoices.id, invoice.id))
          .returning();

        await writeAudit(tx, {
          action: 'create',
          entityType: 'invoice',
          entityId: invoice.id,
          newValues: {
            invoiceNumber,
            refNumber,
            customerId: row.customerId,
            total: toAmountString(charge),
            financeCharge: true,
            periodKey: preview.periodKey,
            postedEntryId: entry.id,
          },
        });

        return updated;
      });

      assessed.push({
        customerId: row.customerId,
        displayName: row.displayName,
        invoiceId: result.id,
        invoiceNumber: result.invoiceNumber,
        refNumber: docRef(result.refNumber, result.invoiceNumber),
        charge: toAmountString(charge),
      });
    } catch (err) {
      // Permission problems abort the whole run; per-customer posting issues
      // (e.g. closed period without override) are reported and skipped.
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
      skipped.push({
        customerId: row.customerId,
        displayName: row.displayName,
        reason: err instanceof Error ? err.message : 'Unknown error.',
      });
    }
  }

  return { asOf: preview.asOf, periodKey: preview.periodKey, assessed, skipped };
}
