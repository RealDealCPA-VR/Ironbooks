/**
 * Liability payment workflows — the core QuickBooks "Pay Sales Tax" and
 * "Pay Payroll Liabilities" flows.
 *
 * All GL impact is routed through postJournalEntry (the only writer of balances).
 * Balances of 2200 / 2300 are derived from posted journal entries, not cached
 * columns, so they remain accurate even after void/adjustment entries.
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines, taxAgencies } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, notFound, validation } from './_base';
import { assertNotControlAccount, postJournalEntry } from './posting';
import { type SalesTaxBasis, salesTaxLiabilityReport } from './accountant/salesTaxLedger';

// ── COA codes fixed by the project spec ─────────────────────────────────────
const CODE_SALES_TAX_PAYABLE = '2200';
const CODE_PAYROLL_LIABILITIES = '2300';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve an account ID by code for this company. Throws VALIDATION when missing. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) {
    throw validation(`Required account ${code} not found in this company's chart of accounts.`);
  }
  return row.id;
}

/**
 * Compute the current credit-normal balance of an account from the posted GL.
 * Liability accounts are credit-normal: credit balance = amount owed.
 * Returns a string (2dp) representing the natural (credit) balance.
 * A positive result means the company owes that amount.
 */
async function creditBalance(ctx: ServiceContext, accountId: string): Promise<string> {
  const [row] = await ctx.db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, accountId),
      ),
    );

  if (!row) return '0.00';
  // Credit-normal: natural balance = credit - debit
  const net = Money.sub(row.totalCredit, row.totalDebit);
  return toAmountString(net);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PaySalesTaxInput {
  /** Amount to remit to the tax agency. Must be > 0. */
  amount: number | string;
  /** Payment date. */
  date: Date;
  /** Bank / cash account used to make the payment (Cr side for asset). */
  paymentAccountId: string;
  /** Optional: tax agency id for traceability (stored in journal description). */
  agencyId?: string | null;
  /** Optional memo on the journal entry. */
  memo?: string | null;
}

/**
 * Pay sales tax:
 *   Dr <agency liability account, else 2200 Sales Tax Payable>  <amount>
 *   Cr <paymentAccountId>                                       <amount>
 *
 * Reduces the Sales Tax Payable liability and drains the bank account. When an
 * agencyId is passed and that agency has its own liabilityAccountId, the debit
 * posts against the agency's account (per-agency liability tracking); otherwise
 * it falls back to the company-wide 2200.
 */
export async function paySalesTax(ctx: ServiceContext, input: PaySalesTaxInput) {
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }

  // Agency lookup: drives both the debit account and the description. Skip for
  // non-UUID refs — comparing them against a uuid column would error (the ref
  // still lands in sourceRef below for traceability).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let agency: { name: string; liabilityAccountId: string | null } | null = null;
  if (input.agencyId && UUID_RE.test(input.agencyId)) {
    const [row] = await ctx.db
      .select({ name: taxAgencies.name, liabilityAccountId: taxAgencies.liabilityAccountId })
      .from(taxAgencies)
      .where(and(eq(taxAgencies.companyId, ctx.companyId), eq(taxAgencies.id, input.agencyId)));
    agency = row ?? null;
  }

  // QB "Pay from" lists bank / credit card accounts — never A/R or A/P (aging would not see it).
  const [payFrom] = await ctx.db
    .select({ type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
  if (payFrom) assertNotControlAccount(payFrom, 'Pay from');

  const salesTaxAccountId =
    agency?.liabilityAccountId ?? (await accountIdByCode(ctx, CODE_SALES_TAX_PAYABLE));
  const amtStr = toAmountString(amt);

  // Human-readable description: use the agency's display name, never its UUID.
  let description = input.memo?.trim() || 'Pay Sales Tax';
  if (!input.memo?.trim() && agency) {
    description = `Pay Sales Tax — ${agency.name}`;
  }

  return postJournalEntry(ctx, {
    date: input.date,
    description,
    sourceRef: input.agencyId ? `tax_agency:${input.agencyId}` : undefined,
    lines: [
      { accountId: salesTaxAccountId, debit: amtStr },
      { accountId: input.paymentAccountId, credit: amtStr },
    ],
  });
}

/** One itemized payroll-liability payment line (e.g. "Federal Income Tax" → $300). */
export interface PayrollLiabilityItemInput {
  /** Payroll item name as reported by payrollLiabilityBalances (e.g. "Federal Income Tax",
   * "401k", "Employer Social Security"). Stamped as the journal-line memo so the
   * payment reconciles against this specific item. */
  name: string;
  /** Amount to remit for this item. Must be > 0. */
  amount: number | string;
}

export interface PayPayrollLiabilitiesInput {
  /**
   * Lump-sum amount to remit (e.g. 941 tax deposit). Required when `items` is
   * omitted/empty. When `items` IS provided, this is optional — if present it must
   * equal the sum of the item amounts.
   */
  amount?: number | string;
  /** Payment date. */
  date: Date;
  /** Bank / cash account used to make the payment. */
  paymentAccountId: string;
  /** Optional memo. */
  memo?: string | null;
  /**
   * Per-item amounts (QB Pay Liabilities). Each item posts its own Dr 2300 line
   * with the item name as the memo, so payments can be reconciled per tax/deduction.
   */
  items?: PayrollLiabilityItemInput[];
}

/**
 * Pay payroll liabilities:
 *   Dr 2300 Payroll Liabilities  <amount>      (one line per item when itemized)
 *   Cr <paymentAccountId>        <total>
 *
 * Reduces the Payroll Liabilities balance and drains the bank account. Itemized
 * payments stamp each item's name as the 2300 debit-line memo — that memo is how
 * payrollLiabilityBalances attributes payments back to specific payroll items.
 */
export async function payPayrollLiabilities(
  ctx: ServiceContext,
  input: PayPayrollLiabilitiesInput,
) {
  const payrollAccountId = await accountIdByCode(ctx, CODE_PAYROLL_LIABILITIES);
  const items = input.items ?? [];

  // ── Itemized payment ──────────────────────────────────────────────────────
  if (items.length > 0) {
    let total = Money.zero();
    const debitLines: Array<{ accountId: string; debit: string; memo: string }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      const name = item.name?.trim();
      if (!name) throw validation('Each liability item needs a name.');
      if (seen.has(name)) {
        throw validation(`Duplicate liability item "${name}" — combine into one line.`);
      }
      seen.add(name);
      let amt;
      try {
        amt = Money.of(item.amount);
      } catch {
        throw validation(`Liability item "${name}": amount is not a valid number.`);
      }
      if (!amt.greaterThan(0)) {
        throw validation(`Liability item "${name}": amount must be greater than zero.`);
      }
      total = total.plus(amt);
      debitLines.push({
        accountId: payrollAccountId,
        debit: toAmountString(amt),
        memo: name,
      });
    }

    if (input.amount != null && input.amount !== '' && !Money.eq(input.amount, total)) {
      throw validation(
        `amount (${toAmountString(Money.of(input.amount))}) does not match the sum of the item amounts (${toAmountString(total)}).`,
      );
    }

    const description = input.memo?.trim()
      ? input.memo.trim()
      : `Pay Payroll Liabilities — ${items.length} item${items.length === 1 ? '' : 's'}`;

    return postJournalEntry(ctx, {
      date: input.date,
      description,
      lines: [
        ...debitLines,
        { accountId: input.paymentAccountId, credit: toAmountString(total) },
      ],
    });
  }

  // ── Legacy lump-sum payment ───────────────────────────────────────────────
  if (input.amount == null || input.amount === '') {
    throw validation('Provide amount or at least one liability item.');
  }
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }

  const amtStr = toAmountString(amt);
  const description = input.memo?.trim() ? input.memo.trim() : 'Pay Payroll Liabilities';

  return postJournalEntry(ctx, {
    date: input.date,
    description,
    lines: [
      { accountId: payrollAccountId, debit: amtStr },
      { accountId: input.paymentAccountId, credit: amtStr },
    ],
  });
}

export interface PayCreditCardInput {
  /** GL liability account for the credit card (Dr side — reduces the amount owed). */
  creditCardAccountId: string;
  /** Bank / cash GL account the payment is drawn from (Cr side). */
  paymentAccountId: string;
  /** Amount to pay. Must be > 0. */
  amount: number | string;
  /** Payment date. */
  date: Date;
  /**
   * When the payment settles a completed credit-card reconciliation, pass its id:
   * the entry is stamped sourceRef "cc-payment:<reconciliationId>" and a second
   * payment for the same reconciliation is rejected (CONFLICT).
   */
  reconciliationId?: string | null;
  /** Optional memo / description. */
  memo?: string | null;
}

/**
 * Pay a credit card (QB "Write a check for the balance" after reconciling a CC):
 *   Dr <creditCardAccountId>  <amount>   — reduces the card liability
 *   Cr <paymentAccountId>     <amount>   — drains the bank account
 */
export async function payCreditCard(ctx: ServiceContext, input: PayCreditCardInput) {
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }
  if (!input.creditCardAccountId) throw validation('creditCardAccountId is required.');
  if (!input.paymentAccountId) throw validation('paymentAccountId is required.');
  if (input.creditCardAccountId === input.paymentAccountId) {
    throw validation('Payment account must be different from the credit card account.');
  }

  // Both accounts must belong to this company; the CC side must be a liability.
  const [cc] = await ctx.db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.creditCardAccountId)));
  if (!cc) throw notFound('Credit card account');
  if (cc.type !== 'liability') {
    throw validation('creditCardAccountId must be a liability (credit card) account.');
  }
  const [pay] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
  if (!pay) throw notFound('Payment account');

  // Duplicate guard: one payment per reconciliation.
  const sourceRef = input.reconciliationId ? `cc-payment:${input.reconciliationId}` : undefined;
  if (sourceRef) {
    const [existing] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, sourceRef),
          eq(journalEntries.status, 'posted'),
        ),
      );
    if (existing) {
      throw new ServiceError(
        'CONFLICT',
        'A credit card payment for this reconciliation has already been recorded.',
      );
    }
  }

  const amtStr = toAmountString(amt);
  return postJournalEntry(ctx, {
    date: input.date,
    description: input.memo?.trim() ? input.memo.trim() : 'Credit card payment',
    sourceRef,
    lines: [
      { accountId: input.creditCardAccountId, debit: amtStr },
      { accountId: input.paymentAccountId, credit: amtStr },
    ],
  });
}

/**
 * Current credit balance of account 2200 (Sales Tax Payable).
 * A positive number means the company owes that amount in sales tax.
 */
export async function salesTaxDue(ctx: ServiceContext): Promise<string> {
  const accountId = await accountIdByCode(ctx, CODE_SALES_TAX_PAYABLE);
  return creditBalance(ctx, accountId);
}

/**
 * Current credit balance of account 2300 (Payroll Liabilities).
 * A positive number means the company owes that amount in payroll taxes/withholdings.
 */
export async function payrollLiabilitiesDue(ctx: ServiceContext): Promise<string> {
  const accountId = await accountIdByCode(ctx, CODE_PAYROLL_LIABILITIES);
  return creditBalance(ctx, accountId);
}

// ── Sales tax by agency (QB Pay Sales Tax grid) ──────────────────────────────

export interface AgencyLiabilityRow {
  /** null = tax that cannot be tied to an agency (no rate/agency, or recorded outside sales tax). */
  agencyId: string | null;
  agencyName: string | null;
  /** The agency's dedicated liability account (payments post here when set; else 2200). */
  liabilityAccountId: string | null;
  /** Owed before the range (all earlier activity). '0.00' when no `from`. */
  openingBalance: string;
  /** Net tax charged in the range: invoices + sales receipts − credit memos. */
  collected: string;
  /** Sales tax adjustments in the range (signed; + increases what is owed). */
  adjusted: string;
  /** Payments remitted to this agency in the range. */
  paid: string;
  /** Owed as of the end of the range: opening + collected + adjusted − paid. */
  balance: string;
}

export interface SalesTaxLiabilityByAgencyResult {
  rows: AgencyLiabilityRow[];
  totalCollected: string;
  totalPaid: string;
  totalBalance: string;
  /** Sales-tax liability accounts' GL balance at the end of the range. */
  glBalance: string;
  /** Σ balances == GL (accrual). */
  tiesToGl: boolean;
}

/**
 * Per-agency sales-tax liability for the QB "Pay Sales Tax" screen.
 *
 * GL-driven (lib/services/accountant/salesTaxLedger.ts): every posted line on a sales-tax
 * liability account is attributed to agencies — invoice / sales receipt / credit memo tax via the
 * document's rates and combined-rate components, Pay Sales Tax payments ("tax_agency:<id>"),
 * Sales Tax Adjustments ("sales_tax_adj:<id>") and lines linked by Fix Incorrectly Recorded Sales
 * Tax. Voided documents drop out automatically, and Σ balance equals the GL balance exactly.
 * Activity that cannot be attributed shows in the null-agency row.
 */
export async function salesTaxLiabilityByAgency(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date; basis?: SalesTaxBasis },
): Promise<SalesTaxLiabilityByAgencyResult> {
  const report = await salesTaxLiabilityReport(ctx, range ?? {});
  const rows: AgencyLiabilityRow[] = report.agencies.map((a) => ({
    agencyId: a.agencyId,
    agencyName: a.agencyName,
    liabilityAccountId: a.liabilityAccountId,
    openingBalance: a.openingBalance,
    collected: toAmountString(Money.add(a.collected, a.credited, a.unattributed)),
    adjusted: a.adjustments,
    paid: a.paid,
    balance: a.balance,
  }));
  // Largest balances first; the null bucket sorts by its balance too.
  rows.sort((a, b) => Money.of(b.balance).comparedTo(Money.of(a.balance)));
  return {
    rows,
    totalCollected: toAmountString(Money.add(report.totals.collected, report.totals.credited, report.totals.unattributed)),
    totalPaid: report.totals.paid,
    totalBalance: report.totals.balance,
    glBalance: report.glBalance,
    tiesToGl: report.tiesToGl,
  };
}
