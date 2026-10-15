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
 * p1 fx — a deposit is in its bank account's currency (QB Make Deposits shows only the payments
 * in that currency). Amounts on the deposit and its lines stay in that currency; the GL gets home
 * values: Undeposited Funds is relieved at the home value each payment was received at, the bank
 * (and cash back / extra lines) at the deposit's rate, and the difference is the realized exchange
 * gain or loss (6900 Exchange Gain/Loss).
 */
import { and, eq, inArray, isNull, like, lte, ne, notInArray } from 'drizzle-orm';
import {
  accounts,
  bouncedChecks,
  customers,
  deposits,
  depositLines,
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
  kind: 'payment' | 'sales_receipt';
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

/** Payment IDs already consumed by a NON-VOIDED deposit. */
async function usedPaymentIds(ctx: ServiceContext, excludeDepositId?: string, asOf?: Date): Promise<string[]> {
  const rows = await ctx.db
    .select({ paymentId: depositLines.paymentId })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        ...(excludeDepositId ? [ne(deposits.id, excludeDepositId)] : []),
        ...(asOf ? [lte(deposits.date, asOf)] : []),
      ),
    );
  return rows.map((r) => r.paymentId).filter((id): id is string => id !== null);
}

/** Sales-receipt IDs already consumed by a NON-VOIDED deposit (via description encoding). */
async function usedSalesReceiptIds(ctx: ServiceContext, excludeDepositId?: string, asOf?: Date): Promise<string[]> {
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
        like(depositLines.description, `${RECEIPT_LINE_PREFIX}%`),
      ),
    );
  return rows
    .map((r) => (r.description ?? '').slice(RECEIPT_LINE_PREFIX.length))
    .filter((id) => id.length > 0);
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
  const usedPmtIds = await usedPaymentIds(ctx, undefined, asOf);
  const pmtConditions = [
    eq(paymentsReceived.companyId, ctx.companyId),
    eq(paymentsReceived.depositAccountId, ufId),
    isNull(paymentsReceived.voidedAt),
    ...(asOf ? [lte(paymentsReceived.date, asOf)] : []),
  ];
  if (usedPmtIds.length > 0) {
    pmtConditions.push(notInArray(paymentsReceived.id, usedPmtIds));
  }
  const pmtRows = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(...pmtConditions))
    .orderBy(paymentsReceived.date);

  // ── sales receipts ──────────────────────────────────────────────────────
  const usedSrIds = await usedSalesReceiptIds(ctx, undefined, asOf);
  const srConditions = [
    eq(salesReceipts.companyId, ctx.companyId),
    eq(salesReceipts.depositAccountId, ufId),
    ne(salesReceipts.status, 'void'),
    ...(asOf ? [lte(salesReceipts.date, asOf)] : []),
  ];
  if (usedSrIds.length > 0) {
    srConditions.push(notInArray(salesReceipts.id, usedSrIds));
  }
  const srRows = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(...srConditions))
    .orderBy(salesReceipts.date);

  // ── unify + enrich with customer names ──────────────────────────────────
  const custMap = await customerNameMap(ctx, [
    ...pmtRows.map((r) => r.customerId),
    ...srRows.map((r) => r.customerId),
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
  ];

  return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ---------------------------------------------------------------------------
// createDeposit
// ---------------------------------------------------------------------------

interface PreparedDeposit {
  glLines: PostingLine[];
  /** Deposit lines WITHOUT depositId. Invariant: sum(amount) === netStr. */
  lineValues: Array<Omit<typeof depositLines.$inferInsert, 'depositId'>>;
  netStr: string;
  paymentIds: string[];
  salesReceiptIds: string[];
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
): Promise<PreparedDeposit> {
  const paymentIds = input.paymentIds ?? [];
  const salesReceiptIds = input.salesReceiptIds ?? [];
  const extraLines = input.extraLines ?? [];

  if (paymentIds.length === 0 && salesReceiptIds.length === 0 && extraLines.length === 0) {
    throw validation(
      'A deposit must include at least one payment, sales receipt, or additional line.',
    );
  }
  if (!input.depositAccountId) {
    throw validation('depositAccountId is required.');
  }
  if (new Set(paymentIds).size !== paymentIds.length) {
    throw validation('Duplicate paymentId in deposit.');
  }
  if (new Set(salesReceiptIds).size !== salesReceiptIds.length) {
    throw validation('Duplicate salesReceiptId in deposit.');
  }

  const ufId = await getUFAccountId(ctx);

  // The deposit target must not be the UF account itself.
  if (input.depositAccountId === ufId) {
    throw validation('Cannot deposit into Undeposited Funds. Choose a bank account.');
  }

  // Verify deposit account belongs to this company.
  const [depAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, code: accounts.code, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.depositAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!depAcct) throw notFound('Deposit account');
  if (depAcct.type !== 'asset') {
    throw validation('Deposit account must be an asset (bank) account.');
  }
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
      throw validation(`Payment ${p.id} is voided and cannot be deposited.`);
    }
    if (p.depositAccountId !== ufId) {
      throw validation(
        `Payment ${p.id} was not deposited to Undeposited Funds and cannot be re-deposited.`,
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
      throw validation(`Sales receipt ${r.id} is voided and cannot be deposited.`);
    }
    if (r.depositAccountId !== ufId) {
      throw validation(
        `Sales receipt ${r.id} was not received into Undeposited Funds and cannot be re-deposited.`,
      );
    }
    if (depCur) {
      throw validation(
        `Sales receipts are recorded in your home currency. Deposit them into a home-currency bank account, not this ${depCur} account.`,
      );
    }
  }

  // ── double-deposit guards (against non-voided deposits only) ─────────────
  if (paymentIds.length > 0) {
    const used = (await usedPaymentIds(ctx, excludeDepositId)).filter((id) => paymentIds.includes(id));
    if (used.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        `One or more payments have already been deposited: ${used.join(', ')}`,
      );
    }
  }
  if (salesReceiptIds.length > 0) {
    const used = (await usedSalesReceiptIds(ctx, excludeDepositId)).filter((id) =>
      salesReceiptIds.includes(id),
    );
    if (used.length > 0) {
      throw new ServiceError(
        'CONFLICT',
        `One or more sales receipts have already been deposited: ${used.join(', ')}`,
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
    if (desc.startsWith(RECEIPT_LINE_PREFIX) || desc.startsWith(CASHBACK_LINE_PREFIX)) {
      throw validation(`Extra line ${i + 1}: description uses a reserved prefix.`);
    }
    const [lineAcct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, ctx.companyId)));
    if (!lineAcct) throw notFound(`Extra line ${i + 1} account`);
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
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.id, input.cashBack.accountId), eq(accounts.companyId, ctx.companyId)),
      );
    if (!cbAcct) throw notFound('Cash back account');
  }

  // ── totals ───────────────────────────────────────────────────────────────
  let ufTotal = Money.zero(); // payments + receipts sitting in UF
  for (const p of payRows) ufTotal = ufTotal.plus(Money.of(p.amount));
  for (const r of srRows) ufTotal = ufTotal.plus(Money.of(r.total));

  let extraTotal = Money.zero();
  for (const l of extraLines) extraTotal = extraTotal.plus(Money.round2(l.amount));

  const gross = ufTotal.plus(extraTotal);
  const net = gross.minus(cashBackAmt); // what actually lands in the bank

  if (cashBackAmt.greaterThanOrEqualTo(gross)) {
    throw validation('Cash back cannot equal or exceed the deposit subtotal.');
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
      memo: input.cashBack.memo ? `Cash back — ${input.cashBack.memo}` : 'Cash back',
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
    extraLines,
    cashBackAmt,
    currency: depCur,
    rate: fx ? fx.rate.toFixed(8) : null,
    homeNetStr: toAmountString(bankHome),
  };
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
  const prep = await prepareDeposit(ctx, input);
  const { netStr, paymentIds, salesReceiptIds, extraLines, cashBackAmt } = prep;

  return inTransaction(ctx, async (tx) => {
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

    return { ...deposit, lines: [...paymentIds, ...salesReceiptIds] };
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

  return inTransaction(ctx, async (tx) => {
    const prep = await prepareDeposit(tx, input, id);
    const oldLines = await tx.db.select().from(depositLines).where(eq(depositLines.depositId, id));
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

  // Attach lines (payment ids) to each deposit.
  const depositIds = rows.map((r) => r.id);
  const lineRows = await ctx.db
    .select()
    .from(depositLines)
    .where(inArray(depositLines.depositId, depositIds));

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
  const extraLines: ExtraDepositLineInput[] = [];
  let cashBack: CashBackInput | null = null;
  for (const l of deposit.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) {
      if (l.paymentId !== paymentId) paymentIds.push(l.paymentId);
    } else if (desc.startsWith(RECEIPT_LINE_PREFIX)) {
      salesReceiptIds.push(desc.slice(RECEIPT_LINE_PREFIX.length));
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
  if (paymentIds.length === 0 && salesReceiptIds.length === 0 && extraLines.length === 0) {
    await voidDeposit(ctx, depositId);
    return { voided: true };
  }
  await updateDeposit(ctx, depositId, {
    depositAccountId: deposit.depositAccountId,
    date: deposit.date,
    paymentIds,
    salesReceiptIds,
    extraLines,
    cashBack,
    memo: deposit.memo,
    exchangeRate: deposit.currency ? deposit.exchangeRate : null,
  });
  return { voided: false };
}
