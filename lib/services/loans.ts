/**
 * Loan Manager (QB "Loan Manager", wave2 F1).
 *
 * A loan is tracked against a LIABILITY account (e.g. "2600 Truck Loan"). Setting up a loan does
 * not post anything — the loan proceeds are recorded the normal way (deposit / journal entry),
 * exactly like QB. The Loan Manager then:
 *   - computes the payment and the amortization schedule (principal vs interest, plus escrow),
 *   - "Set up payment" writes the NEXT payment as a check (Write Checks) or a bill (Enter Bills)
 *     whose lines split the payment:
 *         Dr  loan liability     principal
 *         Dr  interest expense   interest
 *         Dr  escrow account     escrow        (optional)
 *         Cr  bank (check)  or  A/P (bill)     total
 *     The document is created through createExpense / createBill, so it posts through
 *     postJournalEntry like any other check or bill (balanced, closing-date checked, audited).
 *
 * p1 fx — foreign-currency loans: a loan is in its lender's currency (or a stated currency). The
 * schedule and loan_payments are kept in that currency; `exchangeRate` is the rate the loan was
 * booked at (home units per 1 unit). A payment is written as a check from a bank account in the
 * loan's currency (or a bill to the lender) and converted at the payment's rate; the principal is
 * taken off the liability at the BOOKED rate, so the difference is posted as a realized exchange
 * gain/loss (sourceRef loan:<id>, stored on loan_payments.fx_entry_id). Voiding the payment
 * through voidLoanPayment voids that entry too.
 *
 * The remaining balance is derived from the payments whose check/bill is NOT void, so voiding a
 * loan payment's check automatically puts that principal back on the schedule.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { accounts, bills, expenses, journalEntries, loanPayments, loans, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createExpense, voidExpense } from './expenses';
import { createBill, voidBill } from './bills';
import { getHomeCurrencyCode, homeAmounts } from './currencies';
import { postJournalEntry, voidJournalEntry } from './posting';
import { currencyRate, exchangeGainLossLine, foreignCode, toHome } from './exchangeRates';

export const PAYMENT_FREQUENCIES: Record<number, string> = {
  1: 'Annually',
  2: 'Semi-annually',
  4: 'Quarterly',
  12: 'Monthly',
  24: 'Semi-monthly',
  26: 'Every two weeks',
  52: 'Weekly',
};

export interface LoanInput {
  name: string;
  lenderVendorId?: string | null;
  liabilityAccountId: string;
  interestAccountId: string;
  escrowAccountId?: string | null;
  paymentAccountId?: string | null;
  originalAmount: string | number;
  /** Annual interest rate in percent (6.5 = 6.5%). */
  annualRate: string | number;
  termMonths: number;
  paymentsPerYear?: number;
  originDate: Date;
  firstPaymentDate: Date;
  escrowAmount?: string | number | null;
  notes?: string | null;
  /** p1 fx: loan currency (default: the lender's currency) and the rate it was booked at. */
  currency?: string | null;
  exchangeRate?: string | number | null;
}

export interface ScheduleRow {
  number: number;
  date: Date;
  payment: string;
  principal: string;
  interest: string;
  escrow: string;
  total: string;
  balance: string;
}

// ---------------------------------------------------------------------------
// Pure amortization math
// ---------------------------------------------------------------------------

export function numberOfPayments(termMonths: number, paymentsPerYear: number): number {
  return Math.max(1, Math.round((termMonths * paymentsPerYear) / 12));
}

/** Level periodic payment (principal + interest), rounded to the cent. */
export function periodicPayment(
  principal: string | number | Decimal,
  annualRatePercent: string | number | Decimal,
  n: number,
  paymentsPerYear: number,
): Decimal {
  const p = Money.of(principal);
  const r = Money.of(annualRatePercent).dividedBy(100).dividedBy(paymentsPerYear);
  if (r.isZero()) return Money.round2(p.dividedBy(n));
  const factor = Money.of(1).minus(Money.of(1).plus(r).pow(-n));
  return Money.round2(p.times(r).dividedBy(factor));
}

/** Date of payment #k (1-based) given the first payment date and frequency. */
/** Add whole months, clamping to the last day of the target month (Jan 31 + 1 month = Feb 28/29). */
function addMonthsClamped(base: Date, months: number): Date {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(y, m, day, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds()),
  );
}

export function paymentDate(first: Date, k: number, paymentsPerYear: number): Date {
  if (12 % paymentsPerYear === 0) {
    return addMonthsClamped(first, (k - 1) * (12 / paymentsPerYear));
  }
  if (paymentsPerYear === 24) {
    // semi-monthly: alternate the 1st/16th-style half-month steps
    const d = addMonthsClamped(first, Math.floor((k - 1) / 2));
    if ((k - 1) % 2 === 1) d.setUTCDate(d.getUTCDate() + 15);
    return d;
  }
  const d = new Date(first);
  d.setUTCDate(d.getUTCDate() + (k - 1) * Math.round(364 / paymentsPerYear));
  return d;
}

/**
 * Amortization schedule from the CURRENT position: `balance` still owed, the next payment
 * number, the original level payment. Interest = round2(balance x periodic rate); the last
 * payment (or any payment that would overshoot) takes exactly the remaining balance, so the
 * schedule always ends at 0.00.
 */
export function amortizationSchedule(params: {
  balance: string | number | Decimal;
  annualRate: string | number | Decimal;
  paymentsPerYear: number;
  totalPayments: number;
  nextNumber: number;
  firstPaymentDate: Date;
  payment: string | number | Decimal;
  escrow?: string | number | Decimal | null;
}): ScheduleRow[] {
  const r = Money.of(params.annualRate).dividedBy(100).dividedBy(params.paymentsPerYear);
  const pay = Money.of(params.payment);
  const escrow = Money.round2(params.escrow ?? 0);
  let bal = Money.round2(params.balance);
  const rows: ScheduleRow[] = [];
  // Allow a few extra rows beyond the nominal term if payments were short (never infinite).
  const maxNumber = Math.max(params.totalPayments, params.nextNumber) + 600;
  for (let k = params.nextNumber; bal.greaterThan(0) && k <= maxNumber; k++) {
    const interest = Money.round2(bal.times(r));
    let principal = pay.minus(interest);
    const isLast = k >= params.totalPayments;
    if (isLast || principal.greaterThan(bal)) principal = bal;
    if (principal.isNegative()) principal = Money.zero();
    principal = Money.round2(principal);
    bal = Money.round2(bal.minus(principal));
    const p_i = principal.plus(interest);
    rows.push({
      number: k,
      date: paymentDate(params.firstPaymentDate, k, params.paymentsPerYear),
      payment: toAmountString(p_i),
      principal: toAmountString(principal),
      interest: toAmountString(interest),
      escrow: toAmountString(escrow),
      total: toAmountString(p_i.plus(escrow)),
      balance: toAmountString(bal),
    });
    if (principal.isZero() && !isLast) break; // payment does not even cover interest: stop
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

async function accountOf(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
  if (!row) throw notFound('Account');
  return row;
}

async function validateLoanInput(ctx: ServiceContext, input: LoanInput) {
  if (!input.name?.trim()) throw validation('Give the loan a name.');
  const amount = Money.of(input.originalAmount);
  if (!amount.greaterThan(0)) throw validation('The loan amount must be greater than zero.');
  const rate = Money.of(input.annualRate);
  if (rate.isNegative() || rate.greaterThan(100)) throw validation('The interest rate must be between 0 and 100%.');
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 600) {
    throw validation('The loan term must be between 1 and 600 months.');
  }
  const ppy = input.paymentsPerYear ?? 12;
  if (!PAYMENT_FREQUENCIES[ppy]) throw validation('Choose a payment frequency from the list.');
  const liab = await accountOf(ctx, input.liabilityAccountId);
  if (liab.type !== 'liability') throw validation('The loan account must be a liability account (e.g. Notes Payable).');
  const intr = await accountOf(ctx, input.interestAccountId);
  if (intr.type !== 'expense') throw validation('The interest account must be an expense account (e.g. Interest Expense).');
  if (input.escrowAccountId) await accountOf(ctx, input.escrowAccountId);
  if (input.paymentAccountId) {
    const pay = await accountOf(ctx, input.paymentAccountId);
    if (pay.type !== 'asset') throw validation('Loan payments must come from a bank account.');
  }
  const escrow = Money.of(input.escrowAmount ?? 0);
  if (escrow.isNegative()) throw validation('Escrow cannot be negative.');
  if (escrow.greaterThan(0) && !input.escrowAccountId) {
    throw validation('Pick an escrow account for the escrow part of each payment.');
  }
  let lenderCurrency: string | null = null;
  const home = await getHomeCurrencyCode(ctx);
  if (input.lenderVendorId) {
    const [v] = await ctx.db
      .select({ id: vendors.id, currency: vendors.currency })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, input.lenderVendorId)));
    if (!v) throw notFound('Lender');
    lenderCurrency = foreignCode(v.currency, home);
  }
  // p1 fx: the loan's currency is the lender's (QB: a vendor's transactions are in its currency).
  const stated = input.currency !== undefined && input.currency !== null && String(input.currency).trim() !== ''
    ? foreignCode(input.currency, home)
    : undefined;
  const currency = stated !== undefined ? stated : lenderCurrency;
  if (input.lenderVendorId && currency !== lenderCurrency) {
    throw validation(
      `The lender uses ${lenderCurrency ?? home ?? 'your home currency'}, so the loan must be in ${lenderCurrency ?? home ?? 'your home currency'} too.`,
    );
  }
  const fx = currency ? await currencyRate(ctx, currency, input.exchangeRate) : null;
  if (input.paymentAccountId) {
    const [pa] = await ctx.db
      .select({ currency: accounts.currency, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
    const payCur = foreignCode(pa?.currency ?? null, home);
    if (payCur !== currency) {
      throw validation(
        `This loan is in ${currency ?? home ?? 'your home currency'}, so its payments must come from a ${currency ?? 'home-currency'} bank account. "${pa?.name ?? 'That account'}" is in ${payCur ?? 'your home currency'}.`,
      );
    }
  }
  return { amount, rate, ppy, escrow, currency, fxRate: fx ? fx.rate.toFixed(8) : null };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createLoan(ctx: ServiceContext, input: LoanInput) {
  const v = await validateLoanInput(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .insert(loans)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        lenderVendorId: input.lenderVendorId ?? null,
        liabilityAccountId: input.liabilityAccountId,
        interestAccountId: input.interestAccountId,
        escrowAccountId: input.escrowAccountId ?? null,
        paymentAccountId: input.paymentAccountId ?? null,
        originalAmount: toAmountString(v.amount),
        annualRate: v.rate.toFixed(6),
        termMonths: input.termMonths,
        paymentsPerYear: v.ppy,
        originDate: input.originDate,
        firstPaymentDate: input.firstPaymentDate,
        escrowAmount: toAmountString(v.escrow),
        notes: input.notes ?? null,
        currency: v.currency,
        exchangeRate: v.fxRate,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'loan', entityId: loan.id, newValues: loan });
    return loan;
  });
}

export async function updateLoan(ctx: ServiceContext, id: string, input: LoanInput) {
  const [existing] = await ctx.db
    .select()
    .from(loans)
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!existing) throw notFound('Loan');
  const v = await validateLoanInput(ctx, input);
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .update(loans)
      .set({
        name: input.name.trim(),
        lenderVendorId: input.lenderVendorId ?? null,
        liabilityAccountId: input.liabilityAccountId,
        interestAccountId: input.interestAccountId,
        escrowAccountId: input.escrowAccountId ?? null,
        paymentAccountId: input.paymentAccountId ?? null,
        originalAmount: toAmountString(v.amount),
        annualRate: v.rate.toFixed(6),
        termMonths: input.termMonths,
        paymentsPerYear: v.ppy,
        originDate: input.originDate,
        firstPaymentDate: input.firstPaymentDate,
        escrowAmount: toAmountString(v.escrow),
        notes: input.notes ?? null,
        currency: v.currency,
        exchangeRate: v.fxRate,
        updatedAt: new Date(),
      })
      .where(eq(loans.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'loan', entityId: id, oldValues: existing, newValues: loan });
    return loan;
  });
}

/** Remove a loan from the Loan Manager (its checks/bills stay on the books). */
export async function deactivateLoan(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(loans)
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!existing) throw notFound('Loan');
  return inTransaction(ctx, async (tx) => {
    const [loan] = await tx.db
      .update(loans)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(loans.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'loan', entityId: id, oldValues: { isActive: true }, newValues: { isActive: false } });
    return loan;
  });
}

// ---------------------------------------------------------------------------
// Reads: payments, summary, schedule
// ---------------------------------------------------------------------------

/** Loan payments with their check/bill status; `active` = document not void. */
async function paymentsFor(ctx: ServiceContext, loanId: string) {
  const rows = await ctx.db
    .select({
      payment: loanPayments,
      expenseVoidedAt: expenses.voidedAt,
      expenseRef: expenses.reference,
      billStatus: bills.status,
      billNumber: bills.billNumber,
    })
    .from(loanPayments)
    .leftJoin(expenses, eq(loanPayments.expenseId, expenses.id))
    .leftJoin(bills, eq(loanPayments.billId, bills.id))
    .where(and(eq(loanPayments.companyId, ctx.companyId), eq(loanPayments.loanId, loanId)))
    .orderBy(asc(loanPayments.paymentNumber), asc(loanPayments.createdAt));
  return rows.map((r) => ({
    ...r.payment,
    reference: r.payment.kind === 'check' ? (r.expenseRef ?? null) : (r.billNumber ?? null),
    active: r.payment.kind === 'check' ? !r.expenseVoidedAt : r.billStatus !== 'void',
  }));
}

export async function loanSummary(ctx: ServiceContext, loan: typeof loans.$inferSelect) {
  const payments = await paymentsFor(ctx, loan.id);
  const active = payments.filter((p) => p.active);
  const principalPaid = active.reduce((s, p) => s.plus(Money.of(p.principal)), Money.zero());
  const interestPaid = active.reduce((s, p) => s.plus(Money.of(p.interest)), Money.zero());
  const balance = Money.round2(Money.of(loan.originalAmount).minus(principalPaid));
  const n = numberOfPayments(loan.termMonths, loan.paymentsPerYear);
  const payment = periodicPayment(loan.originalAmount, loan.annualRate, n, loan.paymentsPerYear);
  const nextNumber = active.length === 0 ? 1 : Math.max(...active.map((p) => p.paymentNumber)) + 1;
  const schedule = amortizationSchedule({
    balance,
    annualRate: loan.annualRate,
    paymentsPerYear: loan.paymentsPerYear,
    totalPayments: n,
    nextNumber,
    firstPaymentDate: loan.firstPaymentDate,
    payment,
    escrow: loan.escrowAmount,
  });
  return {
    payments,
    numberOfPayments: n,
    payment: toAmountString(payment),
    balance: toAmountString(balance),
    principalPaid: toAmountString(principalPaid),
    interestPaid: toAmountString(interestPaid),
    paymentsMade: active.length,
    next: schedule[0] ?? null,
    schedule,
  };
}

export async function listLoans(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const rows = await ctx.db
    .select({ loan: loans, lenderName: vendors.displayName, accountName: accounts.name, accountBalance: accounts.balance })
    .from(loans)
    .leftJoin(vendors, eq(loans.lenderVendorId, vendors.id))
    .leftJoin(accounts, eq(loans.liabilityAccountId, accounts.id))
    .where(
      and(eq(loans.companyId, ctx.companyId), ...(opts?.includeInactive ? [] : [eq(loans.isActive, true)])),
    )
    .orderBy(desc(loans.createdAt));
  const out = [];
  for (const r of rows) {
    const s = await loanSummary(ctx, r.loan);
    out.push({
      ...r.loan,
      lenderName: r.lenderName ?? null,
      liabilityAccountName: r.accountName ?? null,
      liabilityAccountBalance: r.accountBalance ?? null,
      payment: s.payment,
      balance: s.balance,
      paymentsMade: s.paymentsMade,
      numberOfPayments: s.numberOfPayments,
      next: s.next,
    });
  }
  return out;
}

export async function getLoan(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select({ loan: loans, lenderName: vendors.displayName })
    .from(loans)
    .leftJoin(vendors, eq(loans.lenderVendorId, vendors.id))
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.id, id)));
  if (!row) throw notFound('Loan');
  const s = await loanSummary(ctx, row.loan);
  return { ...row.loan, lenderName: row.lenderName ?? null, ...s };
}

// ---------------------------------------------------------------------------
// Set up payment
// ---------------------------------------------------------------------------

export interface SetUpPaymentInput {
  /** 'check' writes a check now; 'bill' enters a bill to pay later. */
  kind: 'check' | 'bill';
  /** Defaults to the scheduled date of the next payment. */
  date?: Date | null;
  /** Bank account for a check (defaults to the loan's payment account). */
  paymentAccountId?: string | null;
  /** Override the scheduled split (e.g. extra principal). */
  principal?: string | number | null;
  interest?: string | number | null;
  escrow?: string | number | null;
  /** Check number / bill number. */
  reference?: string | null;
  toPrint?: boolean;
  memo?: string | null;
  dueDate?: Date | null;
  /** p1 fx: foreign loan — home units per 1 unit on the payment date (default: the list rate). */
  exchangeRate?: string | number | null;
}

/**
 * Create the next loan payment as a check or a bill, split between principal (loan liability),
 * interest (expense) and escrow, and record it on the loan — all in one transaction.
 */
/**
 * Loan payments are kept in home currency (the schedule, loan_payments and the liability all
 * agree). Refuse a foreign-currency lender or payment account rather than post converted amounts.
 */
async function assertLoanPaymentCurrency(
  ctx: ServiceContext,
  loanCurrency: string | null,
  refs: { lenderVendorId: string | null; paymentAccountId: string | null },
) {
  const home = await getHomeCurrencyCode(ctx);
  const loanLabel = loanCurrency ?? home ?? 'your home currency';
  if (refs.lenderVendorId) {
    const [v] = await ctx.db
      .select({ currency: vendors.currency })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, refs.lenderVendorId)));
    const cur = foreignCode(v?.currency ?? null, home);
    if (cur !== loanCurrency) {
      throw validation(
        `This loan is in ${loanLabel} but its lender uses ${cur ?? 'your home currency'}. Edit the loan so both use the same currency.`,
      );
    }
  }
  if (refs.paymentAccountId) {
    const [a] = await ctx.db
      .select({ currency: accounts.currency, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, refs.paymentAccountId)));
    const cur = foreignCode(a?.currency ?? null, home);
    if (cur !== loanCurrency) {
      throw validation(
        `This loan is in ${loanLabel}, so its payments must come from a ${loanCurrency ?? 'home-currency'} bank account. "${a?.name ?? 'That account'}" uses ${cur ?? 'your home currency'}.`,
      );
    }
  }
}

/**
 * p1 fx: a loan payment whose check / bill was voided outside the Loan Manager leaves its realized
 * exchange gain/loss entry behind — void those (called before every new payment and by HCA).
 */
export async function voidOrphanLoanFx(ctx: ServiceContext, loanId?: string): Promise<number> {
  const rows = await ctx.db
    .select({
      id: loanPayments.id,
      fxEntryId: loanPayments.fxEntryId,
      kind: loanPayments.kind,
      expenseVoidedAt: expenses.voidedAt,
      billStatus: bills.status,
      entryStatus: journalEntries.status,
    })
    .from(loanPayments)
    .leftJoin(expenses, eq(loanPayments.expenseId, expenses.id))
    .leftJoin(bills, eq(loanPayments.billId, bills.id))
    .innerJoin(journalEntries, eq(loanPayments.fxEntryId, journalEntries.id))
    .where(and(eq(loanPayments.companyId, ctx.companyId), ...(loanId ? [eq(loanPayments.loanId, loanId)] : [])));
  let n = 0;
  for (const r of rows) {
    const docVoid = r.kind === 'check' ? !!r.expenseVoidedAt : r.billStatus === 'void';
    if (docVoid && r.entryStatus === 'posted' && r.fxEntryId) {
      await voidJournalEntry(ctx, r.fxEntryId);
      n += 1;
    }
  }
  return n;
}

/** Void a Loan Manager payment: its check or bill and its exchange gain/loss entry together. */
export async function voidLoanPayment(ctx: ServiceContext, loanId: string, paymentId: string) {
  const [lp] = await ctx.db
    .select()
    .from(loanPayments)
    .where(and(eq(loanPayments.companyId, ctx.companyId), eq(loanPayments.loanId, loanId), eq(loanPayments.id, paymentId)));
  if (!lp) throw notFound('Loan payment');
  return inTransaction(ctx, async (tx) => {
    if (lp.kind === 'check' && lp.expenseId) await voidExpense(tx, lp.expenseId);
    if (lp.kind === 'bill' && lp.billId) await voidBill(tx, lp.billId);
    if (lp.fxEntryId) {
      const [e] = await tx.db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, lp.fxEntryId));
      if (e?.status === 'posted') await voidJournalEntry(tx, lp.fxEntryId);
    }
    await writeAudit(tx, {
      action: 'void',
      entityType: 'loan_payment',
      entityId: lp.id,
      oldValues: { loanId, paymentNumber: lp.paymentNumber, total: lp.total },
      newValues: { voided: true },
    });
    return lp;
  });
}

export async function setUpLoanPayment(ctx: ServiceContext, loanId: string, input: SetUpPaymentInput) {
  const loan = await getLoan(ctx, loanId);
  if (!loan.isActive) throw new ServiceError('CONFLICT', 'This loan is no longer in the Loan Manager.');
  const next = loan.next;
  if (!next && input.principal == null) {
    throw new ServiceError('CONFLICT', 'This loan is paid off — there is no next payment.');
  }
  const principal = Money.round2(input.principal ?? next?.principal ?? 0);
  const interest = Money.round2(input.interest ?? next?.interest ?? 0);
  const escrow = Money.round2(input.escrow ?? next?.escrow ?? loan.escrowAmount ?? 0);
  if (principal.isNegative() || interest.isNegative() || escrow.isNegative()) {
    throw validation('Principal, interest and escrow cannot be negative.');
  }
  if (principal.greaterThan(Money.of(loan.balance))) {
    throw validation(`Principal ${toAmountString(principal)} is more than the ${loan.balance} still owed on this loan.`);
  }
  const total = principal.plus(interest).plus(escrow);
  if (!total.greaterThan(0)) throw validation('The payment total must be greater than zero.');
  if (escrow.greaterThan(0) && !loan.escrowAccountId) {
    throw validation('This loan has no escrow account. Edit the loan and pick one first.');
  }
  const date = input.date ?? next?.date ?? new Date();
  const number = next?.number ?? loan.paymentsMade + 1;
  const memo = input.memo ?? `${loan.name} — payment ${number}`;

  const accountLines: Array<{ accountId: string; amount: string; description: string }> = [];
  if (principal.greaterThan(0)) {
    accountLines.push({ accountId: loan.liabilityAccountId, amount: toAmountString(principal), description: `Principal — ${loan.name}` });
  }
  if (interest.greaterThan(0)) {
    accountLines.push({ accountId: loan.interestAccountId, amount: toAmountString(interest), description: `Interest — ${loan.name}` });
  }
  if (escrow.greaterThan(0) && loan.escrowAccountId) {
    accountLines.push({ accountId: loan.escrowAccountId, amount: toAmountString(escrow), description: `Escrow — ${loan.name}` });
  }

  const loanCurrency = loan.currency ?? null;
  await assertLoanPaymentCurrency(ctx, loanCurrency, {
    lenderVendorId: loan.lenderVendorId ?? null,
    paymentAccountId: input.kind === 'check' ? (input.paymentAccountId ?? loan.paymentAccountId ?? null) : null,
  });
  // p1 fx: the payment's rate; the principal comes off the liability at the loan's booked rate.
  const payFx = loanCurrency ? await currencyRate(ctx, loanCurrency, input.exchangeRate) : null;
  const fxDocFields = payFx ? { currency: payFx.currency, exchangeRate: payFx.rate.toFixed(8) } : {};

  return inTransaction(ctx, async (tx) => {
    await voidOrphanLoanFx(tx, loanId);
    let expenseId: string | null = null;
    let billId: string | null = null;
    if (input.kind === 'check') {
      const paymentAccountId = input.paymentAccountId ?? loan.paymentAccountId;
      if (!paymentAccountId) throw validation('Pick the bank account the loan payment comes from.');
      const exp = await createExpense(tx, {
        vendorId: loan.lenderVendorId ?? null,
        payeeName: loan.lenderVendorId ? null : loan.name,
        date,
        method: 'check',
        reference: input.reference ?? null,
        paymentAccountId,
        memo,
        toPrint: input.toPrint,
        lines: accountLines,
        checkDuplicateNumber: Boolean(input.reference),
        ...fxDocFields,
      });
      expenseId = exp.id;
    } else {
      if (!loan.lenderVendorId) {
        throw validation('To enter the payment as a bill, set the lender (a vendor) on the loan first.');
      }
      const bill = await createBill(tx, {
        vendorId: loan.lenderVendorId,
        billNumber: input.reference ?? null,
        date,
        dueDate: input.dueDate ?? date,
        memo,
        lines: accountLines,
        ...fxDocFields,
      });
      billId = bill.id;
    }
    // p1 fx: realized exchange gain/loss on the principal (paid at the payment's rate, booked at
    // the loan's rate). The check / bill credited the liability with its own home share of the
    // principal line; the difference goes to Exchange Gain/Loss.
    let fxEntryId: string | null = null;
    if (payFx && principal.greaterThan(0)) {
      const paidHome = homeAmounts(
        accountLines.map((l) => l.amount),
        payFx.rate,
      ).lines[0];
      const bookedHome = toHome(principal, loan.exchangeRate ?? payFx.rate);
      const gain = Money.round2(bookedHome.minus(paidHome)); // > 0: cost less than booked
      if (!gain.isZero()) {
        const fxLine = await exchangeGainLossLine(tx, gain, gain.greaterThan(0) ? 'Realized exchange gain — loan principal' : 'Realized exchange loss — loan principal');
        const entry = await postJournalEntry(tx, {
          date,
          description: `Exchange gain/loss — ${loan.name} payment ${number}`,
          sourceRef: `loan:${loanId}`,
          lines: [
            gain.greaterThan(0)
              ? { accountId: loan.liabilityAccountId, debit: toAmountString(gain), memo: `Principal at booked rate — ${loan.name}` }
              : { accountId: loan.liabilityAccountId, credit: toAmountString(gain.abs()), memo: `Principal at booked rate — ${loan.name}` },
            fxLine!,
          ],
        });
        fxEntryId = entry.id;
      }
    }
    const [lp] = await tx.db
      .insert(loanPayments)
      .values({
        companyId: tx.companyId,
        loanId,
        paymentNumber: number,
        date,
        principal: toAmountString(principal),
        interest: toAmountString(interest),
        escrow: toAmountString(escrow),
        total: toAmountString(total),
        kind: input.kind,
        expenseId,
        billId,
        exchangeRate: payFx ? payFx.rate.toFixed(8) : null,
        fxEntryId,
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'loan_payment',
      entityId: lp.id,
      newValues: { loanId, paymentNumber: number, principal: lp.principal, interest: lp.interest, escrow: lp.escrow, total: lp.total, kind: input.kind, expenseId, billId, currency: loanCurrency, exchangeRate: lp.exchangeRate, fxEntryId },
    });
    return lp;
  });
}
