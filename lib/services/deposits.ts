/**
 * Deposits service — Undeposited Funds -> Make Deposit.
 *
 * Workflow:
 *  1. Customer payments AND sales receipts are received into Undeposited Funds
 *     (code 1050).
 *  2. The bookkeeper selects those items and "makes a deposit" into a real
 *     bank account.  `createDeposit` posts:
 *       Dr  <depositAccountId>     net      (bank account asset increases)
 *       Dr  <cashBack.accountId>   cashBack (optional — e.g. Petty Cash / Draw)
 *       Cr  1050 Undeposited Funds ufTotal  (UF asset clears)
 *       Cr  <extraLine.accountId>  amount   (optional — e.g. owner contribution)
 *     and records a `deposits` header + one `depositLines` row per item.
 *
 * "Undeposited" heuristic: a paymentsReceived/salesReceipts row is considered
 * undeposited when its `depositAccountId` equals the UF account (code 1050)
 * and it does not appear in any deposit line of a NON-VOIDED deposit.
 *
 * Schema note: depositLines.paymentId only references paymentsReceived, so
 * sales-receipt lines are recorded with paymentId = null and a structured
 * description of the form `salesReceipt:<id>` (same spirit as journal
 * sourceRef traceability). Cash-back lines use `cashback:<accountId>` with a
 * NEGATIVE amount so that sum(lines) always equals deposits.total (net).
 *
 * Invoice payment-item lines (money taken at the time of the sale and recorded on the invoice
 * itself) also land in Undeposited Funds, inside the invoice's own entry. They are deposited the
 * same way as sales receipts: one line per invoice described `invoicePayment:<invoiceId>`, for
 * the sum of the invoice's payment-item lines.
 *
 * p1 fx — a deposit is in its bank account's currency (QB Make Deposits shows only the payments
 * in that currency). Amounts on the deposit and its lines stay in that currency; the GL gets home
 * values: Undeposited Funds is relieved at the home value each payment was received at, the bank
 * (and cash back / extra lines) at the deposit's rate, and the difference is the realized exchange
 * gain or loss (6900 Exchange Gain/Loss).
 */
import { depositMismatchFixes, missingAccountFixes } from '@/lib/errorFixes';
import { defaultAccountFor } from './errorFixes';
import { and, eq, inArray, isNull, like, lte, ne, notExists, sql, type SQL } from 'drizzle-orm';
import {
  accounts,
  bouncedChecks,
  customers,
  deposits,
  depositLines,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  paymentsReceived,
  salesReceipts,
} from '@/lib/db/schema';
import Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { planPostedEdit, retitleEntry } from './postedEdit';
import { syncLineMemos } from './entryLineMemos';
import { subledgerAccountReason } from '@/lib/registerEntryPlan';
import { homeAmounts } from './currencies';
import { currencyRate, exchangeGainLossLine, foreignCode, homeCode, toHome } from './exchangeRates';

/** p1 fx: home amount each payment's posted entry put into Undeposited Funds (debits - credits). */
async function postedUndepositedHome(
  ctx: ServiceContext,
  payRows: Array<{ id: string; postedEntryId: string | null }>,
  ufId: string,
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  const byEntry = new Map(payRows.filter((p) => p.postedEntryId).map((p) => [p.postedEntryId!, p.id]));
  if (byEntry.size === 0) return out;
  const rows = await ctx.db
    .select({ entryId: journalEntryLines.journalEntryId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .where(and(inArray(journalEntryLines.journalEntryId, [...byEntry.keys()]), eq(journalEntryLines.accountId, ufId)));
  for (const r of rows) {
    const pid = byEntry.get(r.entryId)!;
    const prev = out.get(pid) ?? Money.zero();
    out.set(pid, prev.plus(Money.of(r.debit ?? 0)).minus(Money.of(r.credit ?? 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structured deposit-line description prefixes (see schema note above).
// ---------------------------------------------------------------------------

export const RECEIPT_LINE_PREFIX = 'salesReceipt:';
export const CASHBACK_LINE_PREFIX = 'cashback:';
export const INVOICE_PAYMENT_LINE_PREFIX = 'invoicePayment:';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtraDepositLineInput {
  /** GL account credited by this line (e.g. Owner Contribution equity). */
  accountId: string;
  amount: string | number;
  description?: string | null;
}

export interface CashBackInput {
  /** GL account debited with the cash kept out of the deposit (e.g. Petty Cash). */
  accountId: string;
  amount: string | number;
  memo?: string | null;
}

export interface CreateDepositInput {
  /** The bank account (asset) that will receive the funds. Must NOT be 1050. */
  depositAccountId: string;
  date: Date;
  /** IDs of paymentsReceived rows to include in this deposit. */
  paymentIds?: string[];
  /** IDs of salesReceipts rows (sitting in UF) to include in this deposit. */
  salesReceiptIds?: string[];
  /** IDs of invoices whose payment-item lines (sitting in UF) are included in this deposit. */
  invoicePaymentIds?: string[];
  /** Additional non-UF deposit lines (e.g. owner contribution: Dr bank / Cr equity). */
  extraLines?: ExtraDepositLineInput[];
  /** QB "Cash back goes to": Dr cash account, reduces the net bank deposit. */
  cashBack?: CashBackInput | null;
  memo?: string | null;
  /** p1 fx: foreign-currency bank account — home units per 1 unit (default: the list rate). */
  exchangeRate?: string | number | null;
}

/** Unified row shape for the "Payments to Deposit" picker. */
export interface UndepositedItem {
  id: string;
  kind: 'payment' | 'sales_receipt' | 'invoice_payment';
  customerId: string | null;
  customerName: string | null;
  date: Date;
  method: string;
  reference: string | null;
  amount: string;
  /** p1 fx: payment currency (null = home); `amount` is in it. */
  currency?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the Undeposited Funds account id by code 1050, scoped to company. */
async function getUFAccountId(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1050')));
  if (!row) throw new ServiceError('NOT_FOUND', 'Undeposited Funds account (1050) not found.');
  return row.id;
}

/**
 * Which of `paymentIds` a NON-VOIDED deposit already consumed. Only the asked-for ids are looked
 * up (the deposit's own payments), never the company's whole deposit history.
 */
async function usedPaymentIds(ctx: ServiceContext, paymentIds: string[], excludeDepositId?: string): Promise<string[]> {
  if (paymentIds.length === 0) return [];
  const rows = await ctx.db
    .select({ paymentId: depositLines.paymentId })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        inArray(depositLines.paymentId, paymentIds),
        ...(excludeDepositId ? [ne(deposits.id, excludeDepositId)] : []),
      ),
    );
  return [...new Set(rows.map((r) => r.paymentId).filter((id): id is string => id !== null))];
}

/** Which of `salesReceiptIds` a NON-VOIDED deposit already consumed (via description encoding). */
async function usedSalesReceiptIds(ctx: ServiceContext, salesReceiptIds: string[], excludeDepositId?: string): Promise<string[]> {
  if (salesReceiptIds.length === 0) return [];
  const rows = await ctx.db
    .select({ description: depositLines.description })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        inArray(
          depositLines.description,
          salesReceiptIds.map((id) => `${RECEIPT_LINE_PREFIX}${id}`),
        ),
        ...(excludeDepositId ? [ne(deposits.id, excludeDepositId)] : []),
      ),
    );
  return [
    ...new Set(rows.map((r) => (r.description ?? '').slice(RECEIPT_LINE_PREFIX.length)).filter((id) => id.length > 0)),
  ];
}

/**
 * SQL: a non-voided deposit (dated on or before `asOf`, when given) has a line matching `match`.
 * Used as NOT EXISTS for the "Payments to Deposit" list: naming every deposited id in a NOT IN
 * list failed outright past 65,535 deposited payments (the bind-parameter limit) on a large file.
 */
function depositedSql(ctx: ServiceContext, match: SQL, asOf?: Date) {
  return ctx.db
    .select({ one: sql`1` })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        ...(asOf ? [lte(deposits.date, asOf)] : []),
        match,
      ),
    );
}

/** Invoice IDs whose payment-item lines a NON-VOIDED deposit consumed (via description encoding). */
async function usedInvoicePaymentIds(ctx: ServiceContext, excludeDepositId?: string, asOf?: Date): Promise<string[]> {
  const rows = await ctx.db
    .select({ description: depositLines.description })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        ...(excludeDepositId ? [ne(deposits.id, excludeDepositId)] : []),
        ...(asOf ? [lte(deposits.date, asOf)] : []),
        like(depositLines.description, `${INVOICE_PAYMENT_LINE_PREFIX}%`),
      ),
    );
  return rows
    .map((r) => (r.description ?? '').slice(INVOICE_PAYMENT_LINE_PREFIX.length))
    .filter((id) => id.length > 0);
}

/**
 * Invoices with payment-item lines: the amount those lines put in Undeposited Funds, in the
 * invoice's currency. Optionally only `ids`, or only invoices dated on or before `asOf`.
 */
async function invoicePaymentRows(ctx: ServiceContext, opts: { ids?: string[]; asOf?: Date } = {}) {
  if (opts.ids && opts.ids.length === 0) return [];
  return ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      date: invoices.date,
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      refNumber: invoices.refNumber,
      currency: invoices.currency,
      exchangeRate: invoices.exchangeRate,
      postedEntryId: invoices.postedEntryId,
      amount: sql<string>`COALESCE(SUM(CAST(${invoiceLines.amount} AS NUMERIC)), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .innerJoin(items, eq(items.id, invoiceLines.itemId))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        eq(items.type, 'payment'),
        ...(opts.ids ? [inArray(invoices.id, opts.ids)] : []),
        ...(opts.asOf ? [lte(invoices.date, opts.asOf)] : []),
      ),
    )
    .groupBy(invoices.id);
}

async function customerNameMap(
  ctx: ServiceContext,
  customerIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(customerIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)));
  return new Map(rows.map((c) => [c.id, c.displayName]));
}

// ---------------------------------------------------------------------------
// listUndepositedPayments
// ---------------------------------------------------------------------------

/**
 * Return undeposited items sitting in Undeposited Funds:
 *  - paymentsReceived rows (kind 'payment'), not voided
 *  - salesReceipts rows (kind 'sales_receipt'), not voided
 * Both must have depositAccountId = the UF (1050) account and must not be
 * referenced by any deposit line of a non-voided deposit.
 *
 * With `asOf`, the list is what was waiting in Undeposited Funds at that moment instead of today:
 * items dated on or before `asOf` that no non-voided deposit dated on or before `asOf` consumed
 * (a payment received Mar 20 and deposited Apr 2 was still waiting on Mar 31).
 */
export async function listUndepositedPayments(
  ctx: ServiceContext,
  opts: { asOf?: Date } = {},
): Promise<UndepositedItem[]> {
  const ufId = await getUFAccountId(ctx);
  const { asOf } = opts;

  // ── payments ─────────────────────────────────────────────────────────────
  const pmtConditions = [
    eq(paymentsReceived.companyId, ctx.companyId),
    eq(paymentsReceived.depositAccountId, ufId),
    isNull(paymentsReceived.voidedAt),
    ...(asOf ? [lte(paymentsReceived.date, asOf)] : []),
    notExists(depositedSql(ctx, eq(depositLines.paymentId, paymentsReceived.id), asOf)),
  ];
  const pmtRows = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(...pmtConditions))
    .orderBy(paymentsReceived.date);

  // ── sales receipts ──────────────────────────────────────────────────────
  const srConditions = [
    eq(salesReceipts.companyId, ctx.companyId),
    eq(salesReceipts.depositAccountId, ufId),
    ne(salesReceipts.status, 'void'),
    ...(asOf ? [lte(salesReceipts.date, asOf)] : []),
    notExists(
      depositedSql(ctx, sql`${depositLines.description} = ${RECEIPT_LINE_PREFIX} || ${salesReceipts.id}::text`, asOf),
    ),
  ];
  const srRows = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(...srConditions))
    .orderBy(salesReceipts.date);

  // ── invoice payment-item lines (posted invoices only; a void one took them back out) ──
  const usedInvIds = new Set(await usedInvoicePaymentIds(ctx, undefined, asOf));
  const invRows = (await invoicePaymentRows(ctx, { asOf })).filter(
    (r) =>
      r.status !== 'void' &&
      r.status !== 'draft' &&
      r.postedEntryId &&
      Money.of(r.amount).greaterThan(0) &&
      !usedInvIds.has(r.id),
  );

  // ── unify + enrich with customer names ──────────────────────────────────
  const custMap = await customerNameMap(ctx, [
    ...pmtRows.map((r) => r.customerId),
    ...srRows.map((r) => r.customerId),
    ...invRows.map((r) => r.customerId),
  ]);
  const home = await homeCode(ctx);

  const items: UndepositedItem[] = [
    ...pmtRows.map((r) => ({
      id: r.id,
      kind: 'payment' as const,
      customerId: r.customerId,
      customerName: custMap.get(r.customerId) ?? null,
      date: r.date,
      method: r.method,
      reference: r.reference,
      amount: r.amount,
      currency: foreignCode(r.currency, home),
    })),
    ...srRows.map((r) => ({
      id: r.id,
      kind: 'sales_receipt' as const,
      customerId: r.customerId,
      customerName: r.customerId ? (custMap.get(r.customerId) ?? null) : null,
      date: r.date,
      method: r.method,
      reference: r.reference ?? `Sales Receipt #${r.refNumber || r.receiptNumber}`,
      amount: r.total,
      currency: null,
    })),
    ...invRows.map((r) => ({
      id: r.id,
      kind: 'invoice_payment' as const,
      customerId: r.customerId,
      customerName: custMap.get(r.customerId) ?? null,
      date: r.date,
      method: 'payment',
      reference: `Invoice #${r.refNumber || r.invoiceNumber}`,
      amount: toAmountString(r.amount),
      currency: foreignCode(r.currency, home),
    })),
  ];

  return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ---------------------------------------------------------------------------
// createDeposit
// ---------------------------------------------------------------------------

/** "Deposit to <default bank account>" fix for a missing / wrong deposit account. */
async function bankAccountFix(ctx: ServiceContext) {
  const account = await defaultAccountFor(ctx, 'bank', { purpose: 'deposit' });
  return missingAccountFixes({ paths: ['depositAccountId'], account });
}

interface PreparedDeposit {
  glLines: PostingLine[];
  /** Deposit lines WITHOUT depositId. Invariant: sum(amount) === netStr. */
  lineValues: Array<Omit<typeof depositLines.$inferInsert, 'depositId'>>;
  netStr: string;
  paymentIds: string[];
  salesReceiptIds: string[];
  invoicePaymentIds: string[];
  extraLines: ExtraDepositLineInput[];
  cashBackAmt: ReturnType<typeof Money.zero>;
  /** p1 fx: deposit currency (null = home), rate, home value of the net deposit. */
  currency: string | null;
  rate: string | null;
  homeNetStr: string;
}

/**
 * Validate a deposit and build its GL + deposit lines. `excludeDepositId` lets an edit re-use the
 * payments / receipts the deposit already holds (they are not "already deposited" for itself).
 */
async function prepareDeposit(
  ctx: ServiceContext,
  input: CreateDepositInput,
  excludeDepositId?: string,
  /** Accounts the deposit being edited already uses on its extra / cash-back lines. */
  keepAccountIds: ReadonlySet<string> = new Set(),
  /** The Deposit To account the deposit being edited was saved with (kept even if now refused). */
  keepDepositAccountId: string | null = null,
): Promise<PreparedDeposit> {
  const paymentIds = input.paymentIds ?? [];
  const salesReceiptIds = input.salesReceiptIds ?? [];
  const invoicePaymentIds = input.invoicePaymentIds ?? [];
  const extraLines = input.extraLines ?? [];

  if (
    paymentIds.length === 0 &&
    salesReceiptIds.length === 0 &&
    invoicePaymentIds.length === 0 &&
    extraLines.length === 0
  ) {
    throw validation(
      'A deposit must include at least one payment, sales receipt, or additional line.',
    );
  }
  if (!input.depositAccountId) {
    throw validation('Choose the bank account to deposit to.', undefined, await bankAccountFix(ctx));
  }
  if (new Set(paymentIds).size !== paymentIds.length) {
    throw validation('Duplicate paymentId in deposit.');
  }
  if (new Set(salesReceiptIds).size !== salesReceiptIds.length) {
    throw validation('Duplicate salesReceiptId in deposit.');
  }
  if (new Set(invoicePaymentIds).size !== invoicePaymentIds.length) {
    throw validation('Duplicate invoice payment in deposit.');
  }

  const ufId = await getUFAccountId(ctx);

  // The deposit target must not be the UF account itself.
  if (input.depositAccountId === ufId) {
    throw validation('Cannot deposit into Undeposited Funds. Choose a bank account.', undefined, await bankAccountFix(ctx));
  }

  // Verify deposit account belongs to this company.
  const [depAcct] = await ctx.db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      name: accounts.name,
      code: accounts.code,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(eq(accounts.id, input.depositAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!depAcct) throw notFound('Deposit account');
  if (depAcct.type !== 'asset') {
    throw validation('Deposit account must be an asset (bank) account.');
  }
  // Inventory Asset (or a second Undeposited Funds account) as Deposit To moved a balance that the
  // inventory valuation / Make Deposits list never shows — the same rule as the deposit's other
  // lines. A deposit saved there before the rule can still be re-saved as it is.
  const depReason = depAcct.id === keepDepositAccountId ? null : subledgerAccountReason(depAcct);
  if (depReason) throw validation(`Deposit To: ${depReason}`, undefined, await bankAccountFix(ctx));
  // p1 fx: the deposit is in the bank account's currency.
  const home = await homeCode(ctx);
  const depCur = foreignCode(depAcct.currency, home);
  const depLabel = depCur ?? home ?? 'your home currency';
  /** An account used on the deposit must be in the deposit's currency or the home currency. */
  async function assertCompatibleAccount(accountId: string, role: string) {
    const [a] = await ctx.db
      .select({ name: accounts.name, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)));
    const cur = foreignCode(a?.currency ?? null, home);
    if (a && cur && cur !== depCur) {
      throw validation(`${role}: "${a.name}" is a ${cur} account. This deposit is in ${depLabel}; pick a ${depLabel} or home-currency account.`);
    }
  }
  if (input.cashBack?.accountId) await assertCompatibleAccount(input.cashBack.accountId, 'Cash back');
  for (const [i, l] of (input.extraLines ?? []).entries()) {
    if (l.accountId) await assertCompatibleAccount(l.accountId, `Extra line ${i + 1}`);
  }

  // ── payments: ownership + UF + not voided ────────────────────────────────
  const payRows =
    paymentIds.length === 0
      ? []
      : await ctx.db
          .select()
          .from(paymentsReceived)
          .where(
            and(
              eq(paymentsReceived.companyId, ctx.companyId),
              inArray(paymentsReceived.id, paymentIds),
            ),
          );

  if (payRows.length !== paymentIds.length) {
    throw notFound('One or more payments');
  }
  for (const p of payRows) {
    if (p.voidedAt) {
      throw validation(
        `Payment ${p.id} is voided and cannot be deposited.`,
        undefined,
        depositMismatchFixes({ paymentIds: [p.id], reason: 'voided' }),
      );
    }
    if (p.depositAccountId !== ufId) {
      throw validation(
        `Payment ${p.id} was not deposited to Undeposited Funds and cannot be re-deposited.`,
        undefined,
        depositMismatchFixes({ paymentIds: [p.id], reason: 'not_undeposited' }),
      );
    }
    const payCur = foreignCode(p.currency, home);
    if (payCur !== depCur) {
      throw validation(
        `A payment in this deposit is in ${payCur ?? home ?? 'your home currency'}. Deposit it into a ${payCur ?? 'home-currency'} bank account — a deposit holds payments in its account's currency only.`,
      );
    }
  }

  // ── sales receipts: ownership + UF + not voided ──────────────────────────
  const srRows =
    salesReceiptIds.length === 0
      ? []
      : await ctx.db
          .select()
          .from(salesReceipts)
          .where(
            and(
              eq(salesReceipts.companyId, ctx.companyId),
              inArray(salesReceipts.id, salesReceiptIds),
            ),
          );

  if (srRows.length !== salesReceiptIds.length) {
    throw notFound('One or more sales receipts');
  }
  for (const r of srRows) {
    if (r.status === 'void') {
      throw validation(
        `Sales receipt ${r.id} is voided and cannot be deposited.`,
        undefined,
        depositMismatchFixes({ salesReceiptIds: [r.id], reason: 'voided' }),
      );
    }
    if (r.depositAccountId !== ufId) {
      throw validation(
        `Sales receipt ${r.id} was not received into Undeposited Funds and cannot be re-deposited.`,
        undefined,
        depositMismatchFixes({ salesReceiptIds: [r.id], reason: 'not_undeposited' }),
      );
    }
    if (depCur) {
      throw validation(
        `Sales receipts are recorded in your home currency. Deposit them into a home-currency bank account, not this ${depCur} account.`,
      );
    }
  }

  // ── invoice payment-item lines: ownership + posted + currency ────────────
  const invRows = await invoicePaymentRows(ctx, { ids: invoicePaymentIds });
  if (invRows.length !== invoicePaymentIds.length) {
    throw notFound('One or more invoice payments');
  }
  for (const r of invRows) {
    const label = `Invoice #${r.refNumber || r.invoiceNumber}`;
    if (r.status === 'void') throw validation(`${label} is voided, so its payment cannot be deposited.`);
    if (r.status === 'draft' || !r.postedEntryId) {
      throw validation(`${label} is still pending, so its payment is not in Undeposited Funds yet.`);
    }
    if (!Money.of(r.amount).greaterThan(0)) throw validation(`${label} has no payment to deposit.`);
    const invCur = foreignCode(r.currency, home);
    if (invCur !== depCur) {
      throw validation(
        `The payment on ${label} is in ${invCur ?? home ?? 'your home currency'}. Deposit it into a ${invCur ?? 'home-currency'} bank account — a deposit holds payments in its account's currency only.`,
      );
    }
  }

  // ── dates: money cannot be banked before it was received ──────────────────
  // A deposit dated before a payment / receipt in it would take it out of Undeposited Funds before
  // it got there (negative Undeposited Funds, and a bank balance before the money existed).
  const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
  const depositDay = input.date && !Number.isNaN(new Date(input.date).getTime()) ? dayOf(input.date) : null;
  if (depositDay) {
    const items = [
      ...payRows.map((p) => ({ date: p.date, label: `the payment${p.reference ? ` #${p.reference}` : ''}` })),
      ...srRows.map((r) => ({ date: r.date, label: `Sales Receipt #${r.refNumber || r.receiptNumber}` })),
      ...invRows.map((r) => ({ date: r.date, label: `the payment on Invoice #${r.refNumber || r.invoiceNumber}` })),
    ];
    const late = items.filter((x) => dayOf(x.date) > depositDay).sort((a, b) => dayOf(b.date).localeCompare(dayOf(a.date)))[0];
    if (late) {
      throw validation(
        `The deposit date (${depositDay}) is before ${late.label}, received ${dayOf(late.date)}. Date the deposit on or after the day the money was received.`,
        { field: 'date', earliest: dayOf(late.date) },
      );
    }
  }

  // ── double-deposit guards (against non-voided deposits only) ─────────────
  if (paymentIds.length > 0) {
    const used = await usedPaymentIds(ctx, paymentIds, excludeDepositId);
    if (used.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        `One or more payments have already been deposited: ${used.join(', ')}`,
        { alreadyDeposited: used },
        depositMismatchFixes({ paymentIds: used, reason: 'already_deposited' }),
      );
    }
  }
  if (salesReceiptIds.length > 0) {
    const used = await usedSalesReceiptIds(ctx, salesReceiptIds, excludeDepositId);
    if (used.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        `One or more sales receipts have already been deposited: ${used.join(', ')}`,
        { alreadyDeposited: used },
        depositMismatchFixes({ salesReceiptIds: used, reason: 'already_deposited' }),
      );
    }
  }

  if (invoicePaymentIds.length > 0) {
    const used = (await usedInvoicePaymentIds(ctx, excludeDepositId)).filter((id) =>
      invoicePaymentIds.includes(id),
    );
    if (used.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        `The payment on one or more invoices has already been deposited: ${used.join(', ')}`,
        { alreadyDeposited: used },
      );
    }
  }

  // ── extra lines: account ownership + positive amounts ───────────────────
  for (const [i, line] of extraLines.entries()) {
    if (!line.accountId) {
      throw validation(`Extra line ${i + 1}: accountId is required.`);
    }
    if (Money.of(line.amount).lessThanOrEqualTo(0)) {
      throw validation(`Extra line ${i + 1}: amount must be greater than zero.`);
    }
    const desc = line.description ?? '';
    if (
      desc.startsWith(RECEIPT_LINE_PREFIX) ||
      desc.startsWith(CASHBACK_LINE_PREFIX) ||
      desc.startsWith(INVOICE_PAYMENT_LINE_PREFIX)
    ) {
      throw validation(`Extra line ${i + 1}: description uses a reserved prefix.`);
    }
    const [lineAcct] = await ctx.db
      .select({ id: accounts.id, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, ctx.companyId)));
    if (!lineAcct) throw notFound(`Extra line ${i + 1} account`);
    // An extra line from Undeposited Funds took money out of it without any payment leaving the
    // "Payments to Deposit" list (GL 1050 no longer equals the list); one from Inventory Asset
    // moved its balance without the inventory valuation. Pick those payments above instead.
    const reason = keepAccountIds.has(lineAcct.id) ? null : subledgerAccountReason(lineAcct);
    if (reason) throw validation(`Extra line ${i + 1}: ${reason}`);
  }

  // ── cash back validation ─────────────────────────────────────────────────
  const cashBackAmt = input.cashBack ? Money.round2(input.cashBack.amount) : Money.zero();
  if (input.cashBack) {
    if (!input.cashBack.accountId) {
      throw validation('cashBack.accountId is required when taking cash back.');
    }
    if (cashBackAmt.lessThanOrEqualTo(0)) {
      throw validation('cashBack.amount must be greater than zero.');
    }
    if (input.cashBack.accountId === input.depositAccountId) {
      throw validation('Cash back account must differ from the deposit account.');
    }
    const [cbAcct] = await ctx.db
      .select({ id: accounts.id, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(
        and(eq(accounts.id, input.cashBack.accountId), eq(accounts.companyId, ctx.companyId)),
      );
    if (!cbAcct) throw notFound('Cash back account');
    const reason = keepAccountIds.has(cbAcct.id) ? null : subledgerAccountReason(cbAcct);
    if (reason) throw validation(`Cash back: ${reason}`);
  }

  // ── totals ───────────────────────────────────────────────────────────────
  let ufTotal = Money.zero(); // payments + receipts sitting in UF
  for (const p of payRows) ufTotal = ufTotal.plus(Money.of(p.amount));
  for (const r of srRows) ufTotal = ufTotal.plus(Money.of(r.total));
  for (const r of invRows) ufTotal = ufTotal.plus(Money.round2(r.amount));

  let extraTotal = Money.zero();
  for (const l of extraLines) extraTotal = extraTotal.plus(Money.round2(l.amount));

  const gross = ufTotal.plus(extraTotal);
  const net = gross.minus(cashBackAmt); // what actually lands in the bank

  if (cashBackAmt.greaterThanOrEqualTo(gross)) {
    throw validation('Cash back cannot equal or exceed the deposit subtotal.', undefined, [
      { id: 'deposit-no-cashback', kind: 'patch', label: 'Remove the cash back', patch: [{ op: 'set', path: 'cashBack', value: null }] },
    ]);
  }
  if (net.lessThanOrEqualTo(0)) {
    throw validation('Total deposit amount must be greater than zero.');
  }

  const netStr = toAmountString(net);
  const ufTotalStr = toAmountString(ufTotal);

  // p1 fx: home values. Home deposits use the amounts as they are (rate 1).
  const fx = depCur ? await currencyRate(ctx, depCur, input.exchangeRate) : null;
  const rate = fx ? fx.rate : Money.of(1);
  const bankHome = fx ? toHome(net, rate) : Money.round2(net);
  const cashBackHome = fx ? toHome(cashBackAmt, rate) : cashBackAmt;
  // Undeposited Funds is relieved at the home value each payment was received at.
  // Use the home amount actually posted to UF by the payment's own entry (the stored payment
  // rate is rounded, so recomputing amount x rate can miss by a few cents).
  const postedUf = fx ? await postedUndepositedHome(ctx, payRows, ufId) : new Map<string, Decimal>();
  let ufHome = Money.zero();
  for (const p of payRows) {
    ufHome = ufHome.plus(fx ? (postedUf.get(p.id) ?? toHome(p.amount, p.exchangeRate ?? 1)) : Money.of(p.amount));
  }
  for (const r of srRows) ufHome = ufHome.plus(Money.of(r.total));
  // Invoice payment lines: the home amount the invoice's own entry put into Undeposited Funds.
  const postedInvUf = fx ? await postedUndepositedHome(ctx, invRows, ufId) : new Map<string, Decimal>();
  for (const r of invRows) {
    ufHome = ufHome.plus(
      fx ? (postedInvUf.get(r.id) ?? toHome(r.amount, r.exchangeRate ?? 1)) : Money.round2(r.amount),
    );
  }
  const extraHome = homeAmounts(
    extraLines.map((l) => Money.round2(l.amount)),
    rate,
  );
  if (fx && !bankHome.greaterThan(0)) throw validation('The deposit is too small to convert to your home currency.');
  // Realized exchange gain (+) / loss (-) on the payments between receipt and deposit.
  const fxGain = Money.round2(bankHome.plus(cashBackHome).minus(ufHome).minus(extraHome.total));
  const cashBackCur = input.cashBack ? await foreignCurrencyOfId(ctx, input.cashBack.accountId, home) : null;
  const extraCur = await Promise.all(extraLines.map((l) => foreignCurrencyOfId(ctx, l.accountId, home)));

  // GL: Dr bank (net) [+ Dr cash-back account] / Cr UF [+ Cr extra-line accounts] [+/- FX]
  const glLines: PostingLine[] = [
    {
      accountId: input.depositAccountId,
      debit: toAmountString(bankHome),
      memo: 'Deposit to bank',
      ...(depCur ? { foreignAmount: netStr } : {}),
    },
  ];
  if (input.cashBack && cashBackAmt.greaterThan(0)) {
    glLines.push({
      accountId: input.cashBack.accountId,
      debit: toAmountString(cashBackHome),
      memo: input.cashBack.memo ? `${CASH_BACK_MEMO_PREFIX}${input.cashBack.memo}` : 'Cash back',
      ...(cashBackCur ? { foreignAmount: toAmountString(cashBackAmt) } : {}),
    });
  }
  if (ufTotal.greaterThan(0)) {
    glLines.push({ accountId: ufId, credit: toAmountString(ufHome), memo: 'Undeposited Funds cleared' });
  }
  for (const [i, l] of extraLines.entries()) {
    glLines.push({
      accountId: l.accountId,
      credit: toAmountString(extraHome.lines[i]),
      memo: l.description ?? 'Additional deposit line',
      ...(extraCur[i] ? { foreignAmount: toAmountString(Money.round2(l.amount)) } : {}),
    });
  }
  if (fx) {
    const fxLine = await exchangeGainLossLine(ctx, fxGain);
    if (fxLine) glLines.push(fxLine);
  }

  // Deposit lines. Invariant: sum(lines.amount) === deposits.total.
  const lineValues: PreparedDeposit['lineValues'] = [
    ...payRows.map((p) => ({
      paymentId: p.id,
      description: null as string | null,
      amount: p.amount,
    })),
    ...srRows.map((r) => ({
      paymentId: null,
      description: `${RECEIPT_LINE_PREFIX}${r.id}`,
      amount: r.total,
    })),
    ...invRows.map((r) => ({
      paymentId: null,
      description: `${INVOICE_PAYMENT_LINE_PREFIX}${r.id}`,
      amount: toAmountString(Money.round2(r.amount)),
    })),
    ...extraLines.map((l) => ({
      paymentId: null,
      description: l.description ?? 'Additional deposit line',
      amount: toAmountString(Money.round2(l.amount)),
      // The credited account lives on the deposit's own row too (0037), so Reclassify can keep it
      // in step and the edit form re-sends the right account.
      accountId: l.accountId,
    })),
  ];
  if (input.cashBack && cashBackAmt.greaterThan(0)) {
    lineValues.push({
      paymentId: null,
      description: `${CASHBACK_LINE_PREFIX}${input.cashBack.accountId}`,
      amount: toAmountString(cashBackAmt.negated()),
    });
  }

  return {
    glLines,
    lineValues,
    netStr,
    paymentIds,
    salesReceiptIds,
    invoicePaymentIds,
    extraLines,
    cashBackAmt,
    currency: depCur,
    rate: fx ? fx.rate.toFixed(8) : null,
    homeNetStr: toAmountString(bankHome),
  };
}

const CASH_BACK_MEMO_PREFIX = 'Cash back — ';

/** The memo typed for a saved deposit's cash back (its entry line reads "Cash back — <memo>"). */
async function savedCashBackMemo(
  ctx: ServiceContext,
  entryId: string,
  oldLines: ReadonlyArray<{ description: string | null }>,
): Promise<string | null> {
  const cb = oldLines.find((l) => l.description?.startsWith(CASHBACK_LINE_PREFIX));
  if (!cb?.description) return null;
  const accountId = cb.description.slice(CASHBACK_LINE_PREFIX.length);
  const rows = await ctx.db
    .select({ memo: journalEntryLines.memo, debit: journalEntryLines.debit })
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, accountId)));
  const line = rows.find((r) => r.debit != null && r.memo?.startsWith(CASH_BACK_MEMO_PREFIX));
  return line?.memo ? line.memo.slice(CASH_BACK_MEMO_PREFIX.length) : null;
}

async function foreignCurrencyOfId(ctx: ServiceContext, accountId: string, home: string | null): Promise<string | null> {
  const [a] = await ctx.db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)));
  return foreignCode(a?.currency ?? null, home);
}

function fxHeader(prep: PreparedDeposit) {
  return {
    currency: prep.currency,
    exchangeRate: prep.rate,
    homeTotal: prep.currency ? prep.homeNetStr : null,
  };
}

export async function createDeposit(ctx: ServiceContext, input: CreateDepositInput) {
  return inTransaction(ctx, async (tx) => {
    // Validate inside the transaction ("already deposited" etc.), so two concurrent deposits of
    // the same payment cannot both pass (updateDeposit does the same).
    const prep = await prepareDeposit(tx, input);
    const { netStr, paymentIds, salesReceiptIds, invoicePaymentIds, extraLines, cashBackAmt } = prep;

    // 1. Post GL.
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo ? `Deposit: ${input.memo}` : 'Bank Deposit',
      sourceRef: `deposit:pending`,
      lines: prep.glLines,
      ...(prep.currency ? { currency: prep.currency, exchangeRate: prep.rate } : {}),
    });

    // 2. Insert the deposit header (total = NET amount that hit the bank).
    const [deposit] = await tx.db
      .insert(deposits)
      .values({
        companyId: tx.companyId,
        depositAccountId: input.depositAccountId,
        date: input.date,
        total: netStr,
        memo: input.memo ?? null,
        postedEntryId: entry.id,
        ...fxHeader(prep),
      })
      .returning();

    // 2b. Backfill the entry's sourceRef with the real deposit id. This runs in the
    // same transaction, so the 'deposit:pending' placeholder is never visible outside it.
    await tx.db
      .update(journalEntries)
      .set({ sourceRef: `deposit:${deposit.id}` })
      .where(and(eq(journalEntries.id, entry.id), eq(journalEntries.companyId, tx.companyId)));

    // 3. Insert deposit lines.
    await tx.db.insert(depositLines).values(prep.lineValues.map((l) => ({ ...l, depositId: deposit.id })));

    // 4. Audit log.
    await writeAudit(tx, {
      action: 'create',
      entityType: 'deposit',
      entityId: deposit.id,
      newValues: {
        depositAccountId: input.depositAccountId,
        date: input.date,
        total: netStr,
        paymentIds,
        salesReceiptIds,
        invoicePaymentIds,
        extraLines: extraLines.map((l) => ({
          accountId: l.accountId,
          amount: toAmountString(Money.round2(l.amount)),
        })),
        cashBack: input.cashBack
          ? { accountId: input.cashBack.accountId, amount: toAmountString(cashBackAmt) }
          : null,
        postedEntryId: entry.id,
        ...fxHeader(prep),
      },
    });

    return { ...deposit, lines: [...paymentIds, ...salesReceiptIds, ...invoicePaymentIds] };
  });
}

// ---------------------------------------------------------------------------
// updateDeposit — edit a saved deposit (D1)
// ---------------------------------------------------------------------------

/**
 * Edit a saved deposit in ONE transaction: payments / receipts can be added or removed (removed
 * ones go back to Undeposited Funds), extra lines and cash back changed. A ledger-neutral edit
 * (memo / descriptions only) keeps the entry, so it works on a reconciled deposit; otherwise the
 * entry is voided and re-posted (refused when it was cleared in a completed reconciliation).
 */
export async function updateDeposit(ctx: ServiceContext, id: string, input: CreateDepositInput) {
  const [existing] = await ctx.db
    .select()
    .from(deposits)
    .where(and(eq(deposits.id, id), eq(deposits.companyId, ctx.companyId)));
  if (!existing) throw notFound('Deposit');
  if (existing.voidedAt) throw new ServiceError('CONFLICT', 'This deposit is void and cannot be edited.');
  // p1 fx / review5 fx: an edit that states no rate keeps the deposit's OWN rate while the deposit stays in the
  // same currency (QB keeps a transaction's exchange rate when it is edited). The Make Deposits
  // form opens with the rate box blank, so a memo-only edit used to re-price a foreign deposit at
  // today's list rate (new home value and exchange gain/loss, a re-post, and a refusal on a
  // reconciled deposit although nothing was changed).
  if ((input.exchangeRate == null || String(input.exchangeRate).trim() === '') && existing.currency && existing.exchangeRate) {
    const [acct] = await ctx.db
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.id, input.depositAccountId), eq(accounts.companyId, ctx.companyId)));
    if (acct && foreignCode(acct.currency, await homeCode(ctx)) === existing.currency) {
      input = { ...input, exchangeRate: existing.exchangeRate };
    }
  }

  return inTransaction(ctx, async (tx) => {
    const oldLines = await tx.db.select().from(depositLines).where(eq(depositLines.depositId, id));
    // A deposit saved before the Undeposited Funds / Inventory Asset rule keeps its own lines.
    const keep = new Set<string>();
    for (const l of oldLines) {
      if (l.accountId) keep.add(l.accountId);
      if (l.description?.startsWith(CASHBACK_LINE_PREFIX)) keep.add(l.description.slice(CASHBACK_LINE_PREFIX.length));
    }
    // The Make Deposits form never sends the cash-back memo (it has no field for it), so an edit
    // from it rewrote "Cash back — petty cash box" (from the API or an Accountant's Copy) to
    // "Cash back". Not sending a memo keeps the saved one; sending one (even empty) replaces it.
    if (input.cashBack && input.cashBack.memo === undefined && existing.postedEntryId) {
      const savedMemo = await savedCashBackMemo(tx, existing.postedEntryId, oldLines);
      if (savedMemo) input = { ...input, cashBack: { ...input.cashBack, memo: savedMemo } };
    }
    const prep = await prepareDeposit(tx, input, id, keep, existing.depositAccountId);
    let plan = await planPostedEdit(tx, {
      entryId: existing.postedEntryId,
      date: input.date,
      lines: prep.glLines,
      what: 'deposit',
    });
    // p1 fx: a foreign deposit whose amount changed re-posts even if its home value did not.
    if (plan === 'unchanged' && prep.currency && !Money.eq(prep.netStr, existing.total)) plan = 'repost';

    let entryId = existing.postedEntryId;
    if (plan === 'repost') {
      if (existing.postedEntryId) await voidJournalEntry(tx, existing.postedEntryId);
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: input.memo ? `Deposit: ${input.memo}` : 'Bank Deposit',
        sourceRef: `deposit:${id}`,
        lines: prep.glLines,
        ...(prep.currency ? { currency: prep.currency, exchangeRate: prep.rate } : {}),
      });
      entryId = entry.id;
    } else {
      await retitleEntry(tx, entryId, { description: input.memo ? `Deposit: ${input.memo}` : 'Bank Deposit' });
      // Line descriptions / cash-back memo are the entry lines' memos (register Memo column).
      await syncLineMemos(tx, entryId, prep.glLines);
    }

    // Deposit lines are a subledger of the entry — safe to rewrite (same totals either way).
    await tx.db.delete(depositLines).where(eq(depositLines.depositId, id));
    await tx.db.insert(depositLines).values(prep.lineValues.map((l) => ({ ...l, depositId: id })));
    const [updated] = await tx.db
      .update(deposits)
      .set({
        depositAccountId: input.depositAccountId,
        date: input.date,
        total: prep.netStr,
        memo: input.memo ?? null,
        postedEntryId: entryId,
        ...fxHeader(prep),
      })
      .where(eq(deposits.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'deposit',
      entityId: id,
      oldValues: {
        depositAccountId: existing.depositAccountId,
        date: existing.date,
        total: existing.total,
        memo: existing.memo,
        postedEntryId: existing.postedEntryId,
        lines: oldLines.map((l) => ({ paymentId: l.paymentId, description: l.description, amount: l.amount })),
      },
      newValues: {
        depositAccountId: input.depositAccountId,
        date: input.date,
        total: prep.netStr,
        memo: input.memo ?? null,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
        lines: prep.lineValues,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// voidDeposit
// ---------------------------------------------------------------------------

/**
 * Void a deposit:
 *  1. Reverse the GL entry via voidJournalEntry (guards closed periods and
 *     reconciled lines).
 *  2. Stamp deposits.voidedAt. Deposit lines are KEPT for history; the
 *     undeposited heuristics ignore lines whose deposit is voided, so the
 *     underlying payments / sales receipts automatically return to the
 *     "Payments to Deposit" list.
 */
export async function voidDeposit(ctx: ServiceContext, id: string) {
  const [deposit] = await ctx.db
    .select()
    .from(deposits)
    .where(and(eq(deposits.id, id), eq(deposits.companyId, ctx.companyId)));
  if (!deposit) throw notFound('Deposit');
  if (deposit.voidedAt) return deposit; // idempotent

  // wave2 sales (F2): a bounced check already took its money back out of this bank account.
  // Voiding the deposit would take it out a second time.
  const [bounced] = await ctx.db
    .select({ id: bouncedChecks.id })
    .from(bouncedChecks)
    .innerJoin(depositLines, eq(depositLines.paymentId, bouncedChecks.paymentId))
    .where(and(eq(bouncedChecks.companyId, ctx.companyId), eq(depositLines.depositId, id)))
    .limit(1);
  if (bounced) {
    throw new ServiceError(
      'CONFLICT',
      'A check in this deposit was recorded as bounced, and the bank already took that money back. This deposit can no longer be voided.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    if (deposit.postedEntryId) {
      await voidJournalEntry(tx, deposit.postedEntryId);
    }

    const [updated] = await tx.db
      .update(deposits)
      .set({ voidedAt: new Date() })
      .where(eq(deposits.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'deposit',
      entityId: id,
      oldValues: { total: deposit.total, postedEntryId: deposit.postedEntryId },
      newValues: { voided: true },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// listDeposits
// ---------------------------------------------------------------------------

export async function listDeposits(ctx: ServiceContext) {
  const rows = await ctx.db
    .select()
    .from(deposits)
    .where(eq(deposits.companyId, ctx.companyId))
    .orderBy(deposits.date);

  if (rows.length === 0) return [];

  // Enrich with deposit account name.
  const acctIds = [...new Set(rows.map((r) => r.depositAccountId))];
  const acctRows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, acctIds)));
  const acctMap = new Map(acctRows.map((a) => [a.id, { name: a.name, code: a.code }]));

  // Attach lines (payment ids) to each deposit. Joined on the company rather than naming every
  // deposit id (an IN list past 65,535 deposits fails on the bind-parameter limit).
  const lineRows = (
    await ctx.db
      .select({ line: depositLines })
      .from(depositLines)
      .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
      .where(eq(deposits.companyId, ctx.companyId))
  ).map((r) => r.line);

  const linesByDeposit = new Map<string, typeof lineRows>();
  for (const l of lineRows) {
    const arr = linesByDeposit.get(l.depositId) ?? [];
    arr.push(l);
    linesByDeposit.set(l.depositId, arr);
  }

  return rows.map((d) => ({
    ...d,
    accountName: acctMap.get(d.depositAccountId)?.name ?? null,
    accountCode: acctMap.get(d.depositAccountId)?.code ?? null,
    lines: linesByDeposit.get(d.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// getDeposit
// ---------------------------------------------------------------------------

export async function getDeposit(ctx: ServiceContext, id: string) {
  const [deposit] = await ctx.db
    .select()
    .from(deposits)
    .where(and(eq(deposits.id, id), eq(deposits.companyId, ctx.companyId)));
  if (!deposit) throw notFound('Deposit');

  const lines = await ctx.db
    .select()
    .from(depositLines)
    .where(eq(depositLines.depositId, id));

  return { ...deposit, lines };
}

// ---------------------------------------------------------------------------
// removePaymentFromDeposit — C1: take one received payment back out of its deposit
// ---------------------------------------------------------------------------

/**
 * Take a received payment out of a saved deposit (QB: open the deposit and delete the line), so
 * the payment goes back to Undeposited Funds and can be edited freely. The rest of the deposit
 * is kept: payments, sales receipts, extra lines and cash back are re-sent through updateDeposit
 * (same validation, re-post and audit as an edit on the deposit window). A deposit that held only
 * this payment is voided instead (a deposit needs at least one line).
 */
export async function removePaymentFromDeposit(
  ctx: ServiceContext,
  depositId: string,
  paymentId: string,
): Promise<{ voided: boolean }> {
  const deposit = await getDeposit(ctx, depositId);
  if (deposit.voidedAt) return { voided: true };
  if (!deposit.lines.some((l) => l.paymentId === paymentId)) {
    throw validation('That payment is not part of this deposit.');
  }
  const paymentIds: string[] = [];
  const salesReceiptIds: string[] = [];
  const invoicePaymentIds: string[] = [];
  const extraLines: ExtraDepositLineInput[] = [];
  let cashBack: CashBackInput | null = null;
  for (const l of deposit.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) {
      if (l.paymentId !== paymentId) paymentIds.push(l.paymentId);
    } else if (desc.startsWith(RECEIPT_LINE_PREFIX)) {
      salesReceiptIds.push(desc.slice(RECEIPT_LINE_PREFIX.length));
    } else if (desc.startsWith(INVOICE_PAYMENT_LINE_PREFIX)) {
      invoicePaymentIds.push(desc.slice(INVOICE_PAYMENT_LINE_PREFIX.length));
    } else if (desc.startsWith(CASHBACK_LINE_PREFIX)) {
      cashBack = {
        accountId: desc.slice(CASHBACK_LINE_PREFIX.length),
        amount: toAmountString(Money.of(l.amount).abs()),
      };
    } else if (l.accountId) {
      extraLines.push({ accountId: l.accountId, amount: l.amount, description: l.description });
    } else {
      throw new ServiceError(
        'CONFLICT',
        'This deposit has a line from an older version that cannot be re-saved automatically. Open the deposit and remove the payment there.',
      );
    }
  }
  if (
    paymentIds.length === 0 &&
    salesReceiptIds.length === 0 &&
    invoicePaymentIds.length === 0 &&
    extraLines.length === 0
  ) {
    await voidDeposit(ctx, depositId);
    return { voided: true };
  }
  await updateDeposit(ctx, depositId, {
    depositAccountId: deposit.depositAccountId,
    date: deposit.date,
    paymentIds,
    salesReceiptIds,
    invoicePaymentIds,
    extraLines,
    cashBack,
    memo: deposit.memo,
    exchangeRate: deposit.currency ? deposit.exchangeRate : null,
  });
  return { voided: false };
}
