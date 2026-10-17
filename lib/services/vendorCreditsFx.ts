/**
 * p1 fx — foreign-currency vendor credits (QB Enterprise multicurrency, J10).
 *
 * A vendor credit for a foreign-currency vendor is entered in the vendor's currency. Its amounts
 * (total / unapplied / refunded, and its lines) stay in that currency; the GL gets home values:
 *   create:  Dr A/P round2(total x rate)  /  Cr line accounts (penny-allocated home shares)
 * `home_total` / `home_unapplied` track the home A/P the credit still carries, so A/P aging and the
 * A/P control account always agree.
 *
 * Applying it to a bill in the same currency relieves the bill at the BILL's booked rate and uses
 * up the credit at the CREDIT's booked rate (the exact remaining home amount when either side is
 * closed, so no cent is ever left behind). The difference is the realized exchange gain/loss:
 *   gain:  Dr A/P / Cr 6900 Exchange Gain/Loss      loss: Dr 6900 / Cr A/P
 * posted as the credit's own A/P line (sourceRef vendor_credit:<id>, controlLine), so it never
 * shows up as a General Journal item in aging. Every application is stored in
 * vendor_credit_applications (unapply = a negative row + the reversing FX entry).
 *
 * Refunding a foreign credit takes its home A/P at the credit's rate and puts the cash in the bank
 * at the refund's rate; the difference is again a realized gain/loss.
 */
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  auditLogs,
  billPaymentApplications,
  billPayments,
  bills,
  journalEntries,
  journalEntryLines,
  vendorCreditApplications,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { assertPeriodOpen } from './fiscalPeriods';
import { homeAmounts, resolveDocumentCurrency } from './currencies';
import { currencyRate, exchangeGainLossLine, foreignCode, homeCode, toHome } from './exchangeRates';
import { isDepositTargetAccount } from '@/lib/accountTypes';

type VendorCreditRow = typeof vendorCredits.$inferSelect;
type BillRow = typeof bills.$inferSelect;

export interface VendorCreditFx {
  currency: string | null;
  rate: Decimal;
  /** Home amount per line (same order as the input lines). */
  homeLines: string[];
  homeTotal: string;
}

/**
 * Currency + home amounts of a vendor credit: the vendor's currency (a home-currency vendor takes
 * home credits only), at the stated rate or the currency list's rate.
 */
export async function resolveVendorCreditFx(
  ctx: ServiceContext,
  vendorId: string,
  input: { currency?: string | null; exchangeRate?: string | number | null; lines: Array<{ amount: string | number }> },
): Promise<VendorCreditFx> {
  const [v] = await ctx.db
    .select({ currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, ctx.companyId)));
  const fx = await resolveDocumentCurrency(ctx, {
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    vendorCurrency: v?.currency ?? null,
  });
  const h = homeAmounts(
    input.lines.map((l) => Money.round2(l.amount)),
    fx.rate,
  );
  if (fx.currency) {
    h.lines.forEach((amt, i) => {
      if (!amt.greaterThan(0)) throw validation(`Line ${i + 1}: the amount is too small to convert to your home currency.`);
    });
  }
  return {
    currency: fx.currency,
    rate: fx.rate,
    homeLines: h.lines.map((x) => toAmountString(x)),
    homeTotal: toAmountString(h.total),
  };
}

/** Header columns for a (re)posted vendor credit. */
export function vendorCreditFxColumns(fx: VendorCreditFx) {
  return {
    currency: fx.currency,
    exchangeRate: fx.currency ? fx.rate.toFixed(8) : null,
    homeTotal: fx.currency ? fx.homeTotal : null,
    homeUnapplied: fx.currency ? fx.homeTotal : null,
  };
}

/** Entry-level currency fields for postJournalEntry. */
export function vendorCreditEntryFx(fx: VendorCreditFx) {
  return fx.currency ? { currency: fx.currency, exchangeRate: fx.rate.toFixed(8) } : {};
}

// ---------------------------------------------------------------------------
// Home A/P bookkeeping helpers (also used by reports and Pay Bills)
// ---------------------------------------------------------------------------

/** Home A/P relieved on each bill by foreign vendor-credit applications (net of unapplies). */
export async function vendorCreditHomeByBill(
  ctx: ServiceContext,
  upTo?: Date,
): Promise<Map<string, Decimal>> {
  const conds = [eq(vendorCreditApplications.companyId, ctx.companyId)];
  if (upTo) conds.push(sql`${vendorCreditApplications.date} <= ${upTo}`);
  const rows = await ctx.db
    .select({
      billId: vendorCreditApplications.billId,
      home: sql<string>`COALESCE(SUM(${vendorCreditApplications.homeBill}), 0)`,
    })
    .from(vendorCreditApplications)
    .where(and(...conds))
    .groupBy(vendorCreditApplications.billId);
  return new Map(rows.map((r) => [r.billId, Money.of(r.home)]));
}

/** Home A/P relieved on one bill by foreign vendor-credit applications. */
export async function vendorCreditHomeOnBill(ctx: ServiceContext, billId: string): Promise<Decimal> {
  const [row] = await ctx.db
    .select({ home: sql<string>`COALESCE(SUM(${vendorCreditApplications.homeBill}), 0)` })
    .from(vendorCreditApplications)
    .where(and(eq(vendorCreditApplications.companyId, ctx.companyId), eq(vendorCreditApplications.billId, billId)));
  return Money.of(row?.home ?? 0);
}

/** Home A/P still carried by a foreign bill: round2(total x rate) - payments - credits. */
async function billHomeOpen(ctx: ServiceContext, bill: BillRow): Promise<Decimal> {
  const anchor = toHome(bill.total, bill.exchangeRate ?? 1);
  const [paid] = await ctx.db
    .select({
      sum: sql<string>`COALESCE(SUM(COALESCE(${billPaymentApplications.amountHome}, ${billPaymentApplications.amountApplied})), 0)`,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .where(and(eq(billPaymentApplications.billId, bill.id), isNull(billPayments.voidedAt)));
  return Money.round2(anchor.minus(Money.of(paid?.sum ?? 0)).minus(await vendorCreditHomeOnBill(ctx, bill.id)));
}

/** Home part of a foreign credit still unapplied (falls back to unapplied x rate). */
function creditHomeUnapplied(credit: VendorCreditRow): Decimal {
  if (credit.homeUnapplied != null) return Money.of(credit.homeUnapplied);
  return toHome(credit.unapplied, credit.exchangeRate ?? 1);
}

async function apAccountId(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2000')));
  if (!row) throw notFound('Accounts Payable account (2000)');
  return row.id;
}

/** Post the realized gain/loss of an application: diff = home relieved on bill - home taken from credit. */
async function postApplicationFx(
  ctx: ServiceContext,
  credit: VendorCreditRow,
  diff: Decimal,
  date: Date,
  memo: string,
): Promise<string | null> {
  if (diff.isZero()) return null;
  const ap = await apAccountId(ctx);
  const fxLine = await exchangeGainLossLine(ctx, diff, memo);
  const apLine: PostingLine = diff.greaterThan(0)
    ? { accountId: ap, debit: toAmountString(diff), memo, controlLine: true }
    : { accountId: ap, credit: toAmountString(diff.abs()), memo, controlLine: true };
  const entry = await postJournalEntry(ctx, {
    date,
    description: `Exchange gain/loss — vendor credit applied`,
    sourceRef: `vendor_credit:${credit.id}`,
    lines: [apLine, fxLine!],
  });
  return entry.id;
}

function billStatus(bill: { amountPaid: string }, balanceDue: Decimal, amountCredited: Decimal) {
  return balanceDue.isZero()
    ? 'paid'
    : Money.of(bill.amountPaid).plus(amountCredited).greaterThan(0)
      ? 'partial'
      : 'open';
}

// ---------------------------------------------------------------------------
// Apply / unapply
// ---------------------------------------------------------------------------

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The date an application (or unapply) of a vendor credit to a bill takes effect. QB does not let
 * a credit be applied before it exists: an apply is never dated before the credit or the bill, and
 * an unapply never before the credit was applied to that bill. A date that is too early is refused
 * in plain words; no date means today (or the earliest allowed day, for documents dated later).
 */
export async function vendorCreditApplicationDate(
  ctx: ServiceContext,
  credit: Pick<VendorCreditRow, 'id' | 'date'>,
  bill: Pick<BillRow, 'id' | 'date'>,
  date: Date | null | undefined,
  kind: 'apply' | 'unapply',
): Promise<Date> {
  let floor = credit.date > bill.date ? credit.date : bill.date;
  let why = credit.date > bill.date ? `the credit's date (${ymd(credit.date)})` : `the bill's date (${ymd(bill.date)})`;
  if (kind === 'unapply') {
    const [last] = await ctx.db
      .select({ date: sql<Date | string | null>`MAX(${vendorCreditApplications.date})` })
      .from(vendorCreditApplications)
      .where(
        and(
          eq(vendorCreditApplications.companyId, ctx.companyId),
          eq(vendorCreditApplications.vendorCreditId, credit.id),
          eq(vendorCreditApplications.billId, bill.id),
          sql`CAST(${vendorCreditApplications.amount} AS NUMERIC) > 0`,
        ),
      );
    const lastApplied = last?.date ? new Date(last.date) : null;
    if (lastApplied && lastApplied > floor) {
      floor = lastApplied;
      why = `the day it was applied to this bill (${ymd(lastApplied)})`;
    }
  }
  if (!date) {
    const now = new Date();
    return now > floor ? now : floor;
  }
  if (ymd(date) < ymd(floor)) {
    throw validation(
      kind === 'apply'
        ? `A credit can't be applied before it exists. Use a date on or after ${why}.`
        : `A credit can't be unapplied before it was applied. Use a date on or after ${why}.`,
    );
  }
  // Same day but an earlier time of day: take the later moment so the order is kept.
  const result = date < floor ? floor : date;
  // A dated (un)application moves the bill's and the credit's open balances on that day: one dated
  // in a closed period would change that period's A/P aging, even when no exchange entry posts.
  await assertPeriodOpen(ctx, result);
  return result;
}

/**
 * The date a vendor refund of a credit takes effect. Like an application, a refund can't be dated
 * before the credit exists (the cash would come back for a credit A/P does not carry yet). No date
 * means today, or the credit's date when the credit is dated later.
 */
export function vendorCreditRefundDate(credit: Pick<VendorCreditRow, 'date'>, date: Date | null | undefined): Date {
  const floor = new Date(credit.date);
  if (!date) {
    const now = new Date();
    return now > floor ? now : floor;
  }
  if (ymd(date) < ymd(floor)) {
    throw validation(`A credit can't be refunded before it exists. Use a date on or after the credit's date (${ymd(floor)}).`);
  }
  return date < floor ? floor : date;
}

/**
 * Vendor refunds of credits dated AFTER the cutoff, per credit id: the one dated-refund source the
 * as-of A/P aging and the foreign payables subledger (Home Currency Adjustment) share. `home` is
 * the home A/P the refund entry (sourceRef refund:<creditId>, dated) took from the credit;
 * `foreign` is the amount in the credit's currency (from the refund's audit row, postedEntryId) for
 * a foreign credit, and equals `home` for a home credit. On the cutoff date none of these refunds
 * had happened yet, so the credit still held them.
 */
export async function vendorCreditRefundsAfter(
  ctx: ServiceContext,
  cutoff: Date,
): Promise<Map<string, { foreign: Decimal; home: Decimal }>> {
  const out = new Map<string, { foreign: Decimal; home: Decimal }>();
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      sourceRef: journalEntries.sourceRef,
      apHome: sql<string>`COALESCE(SUM(CAST(${journalEntryLines.credit} AS NUMERIC)), 0) - COALESCE(SUM(CAST(${journalEntryLines.debit} AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.sourceRef} LIKE 'refund:%'`,
        eq(accounts.subtype, 'accounts_payable'),
        gt(journalEntries.date, cutoff),
      ),
    )
    .groupBy(journalEntries.id, journalEntries.sourceRef);
  if (rows.length === 0) return out;
  const credits = await ctx.db
    .select({ id: vendorCredits.id, currency: vendorCredits.currency })
    .from(vendorCredits)
    .where(eq(vendorCredits.companyId, ctx.companyId));
  const home = ((await homeCode(ctx)) ?? '').trim().toUpperCase();
  const currencyById = new Map(credits.map((c) => [c.id, (c.currency ?? '').trim().toUpperCase()] as const));
  const isForeign = (id: string) => {
    const cur = currencyById.get(id) ?? '';
    return cur !== '' && cur !== home;
  };
  const refunds = rows
    .map((r) => ({ ...r, creditId: (r.sourceRef ?? '').slice('refund:'.length) }))
    .filter((r) => currencyById.has(r.creditId));
  const foreignRefundIds = refunds.filter((r) => isForeign(r.creditId)).map((r) => r.entryId);
  const foreignByEntry = new Map<string, Decimal>();
  if (foreignRefundIds.length) {
    const audits = await ctx.db
      .select({ newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'vendor_credit'),
          sql`${auditLogs.newValues}->>'action' = 'refund'`,
          inArray(sql`${auditLogs.newValues}->>'postedEntryId'`, foreignRefundIds),
        ),
      );
    for (const a of audits) {
      const nv = (a.newValues ?? {}) as { amount?: string; postedEntryId?: string };
      if (nv.postedEntryId) foreignByEntry.set(nv.postedEntryId, Money.of(nv.amount ?? '0'));
    }
  }
  for (const r of refunds) {
    const homeAmt = Money.of(r.apHome);
    const foreignAmt = isForeign(r.creditId) ? (foreignByEntry.get(r.entryId) ?? Money.zero()) : homeAmt;
    const c = out.get(r.creditId) ?? { foreign: Money.zero(), home: Money.zero() };
    out.set(r.creditId, { foreign: c.foreign.plus(foreignAmt), home: c.home.plus(homeAmt) });
  }
  return out;
}

/**
 * Earliest dated step recorded against a bill or a vendor credit: foreign application / unapply
 * rows, and (for a credit) its posted vendor refunds. A bill or credit can't be re-dated after one
 * of these: the step would then come before the document it belongs to, and the as-of A/P aging
 * would no longer match the ledger. Returns null when there is no such history.
 */
export async function earliestVendorCreditStep(
  ctx: ServiceContext,
  by: { billId: string } | { vendorCreditId: string },
): Promise<{ date: Date; what: string } | null> {
  const [app] = await ctx.db
    .select({ date: sql<Date | string | null>`MIN(${vendorCreditApplications.date})` })
    .from(vendorCreditApplications)
    .where(
      and(
        eq(vendorCreditApplications.companyId, ctx.companyId),
        'billId' in by ? eq(vendorCreditApplications.billId, by.billId) : eq(vendorCreditApplications.vendorCreditId, by.vendorCreditId),
      ),
    );
  let best: { date: Date; what: string } | null = app?.date ? { date: new Date(app.date), what: 'a vendor credit was applied' } : null;
  if ('vendorCreditId' in by) {
    const [refund] = await ctx.db
      .select({ date: sql<Date | string | null>`MIN(${journalEntries.date})` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `refund:${by.vendorCreditId}`),
          eq(journalEntries.status, 'posted'),
        ),
      );
    if (refund?.date) {
      const r = new Date(refund.date);
      if (!best || r < best.date) best = { date: r, what: 'a vendor refund was recorded' };
    }
  }
  return best;
}

/** Refuse moving a bill or credit to a date after its earliest dated credit step (see above). */
export async function assertRedateAfterVendorCreditSteps(
  ctx: ServiceContext,
  by: { billId: string } | { vendorCreditId: string },
  newDate: Date,
): Promise<void> {
  const step = await earliestVendorCreditStep(ctx, by);
  if (step && ymd(new Date(newDate)) > ymd(step.date)) {
    const doc = 'billId' in by ? 'bill' : 'credit';
    throw validation(
      `This ${doc} can't be dated after ${ymd(step.date)}, because ${step.what} on that date. Use a date on or before ${ymd(step.date)}.`,
    );
  }
}

/**
 * Voiding a bill or a foreign vendor credit whose applications were all unapplied again: the
 * apply / unapply pairs net to zero, but their dated rows and exchange gain/loss entries would
 * still move A/P between the apply and unapply dates for a document the ledger no longer has.
 * Void those exchange entries and drop the settled rows with the document (the audit log keeps
 * the history). A pair that is still applied is refused (the callers already require unapplying).
 */
export async function clearSettledForeignApplications(
  tx: ServiceContext,
  by: { billId: string } | { vendorCreditId: string },
): Promise<void> {
  const rows = await tx.db
    .select()
    .from(vendorCreditApplications)
    .where(
      and(
        eq(vendorCreditApplications.companyId, tx.companyId),
        'billId' in by ? eq(vendorCreditApplications.billId, by.billId) : eq(vendorCreditApplications.vendorCreditId, by.vendorCreditId),
      ),
    );
  if (rows.length === 0) return;
  const pairs = new Map<string, { amount: Decimal; homeBill: Decimal; homeCredit: Decimal }>();
  for (const r of rows) {
    const k = `${r.vendorCreditId}|${r.billId}`;
    const p = pairs.get(k) ?? { amount: Money.zero(), homeBill: Money.zero(), homeCredit: Money.zero() };
    p.amount = p.amount.plus(Money.of(r.amount));
    p.homeBill = p.homeBill.plus(Money.of(r.homeBill));
    p.homeCredit = p.homeCredit.plus(Money.of(r.homeCredit));
    pairs.set(k, p);
  }
  for (const p of pairs.values()) {
    if (!p.amount.isZero() || !p.homeBill.isZero() || !p.homeCredit.isZero()) {
      throw new ServiceError('CONFLICT', 'This vendor credit is still applied to a bill. Unapply it first.');
    }
  }
  const entryIds = [...new Set(rows.map((r) => r.fxEntryId).filter((x): x is string => !!x))];
  for (const entryId of entryIds) await voidJournalEntry(tx, entryId);
  await tx.db.delete(vendorCreditApplications).where(inArray(vendorCreditApplications.id, rows.map((r) => r.id)));
  await writeAudit(tx, {
    action: 'delete',
    entityType: 'vendor_credit_application',
    entityId: rows[0].id,
    oldValues: { rows: rows.map((r) => ({ id: r.id, vendorCreditId: r.vendorCreditId, billId: r.billId, date: r.date, amount: r.amount, fxEntryId: r.fxEntryId })) },
    newValues: { reason: 'billId' in by ? 'bill voided' : 'vendor credit voided', voidedFxEntries: entryIds },
  });
}

export function isForeignApplication(credit: VendorCreditRow, bill: BillRow): boolean {
  return !!credit.currency || !!bill.currency;
}

/**
 * Apply a vendor credit to a bill when either is in a foreign currency. Both must be in the same
 * currency (QB: a vendor's transactions are all in the vendor's currency).
 */
export async function applyForeignVendorCredit(
  ctx: ServiceContext,
  credit: VendorCreditRow,
  bill: BillRow,
  amount: Decimal,
  date?: Date | null,
) {
  if ((credit.currency ?? null) !== (bill.currency ?? null)) {
    const home = await homeCode(ctx);
    throw validation(
      `This credit is in ${credit.currency ?? home ?? 'home currency'} and the bill is in ${bill.currency ?? home ?? 'home currency'}. A credit can only be applied to a bill in the same currency.`,
    );
  }
  const unapplied = Money.of(credit.unapplied);
  const balanceDue = Money.of(bill.balanceDue);
  const homeCredit = amount.equals(unapplied) ? creditHomeUnapplied(credit) : toHome(amount, credit.exchangeRate ?? 1);
  const homeBill = amount.equals(balanceDue) ? await billHomeOpen(ctx, bill) : toHome(amount, bill.exchangeRate ?? 1);
  const diff = Money.round2(homeBill.minus(homeCredit));
  const when = date ?? new Date();

  return inTransaction(ctx, async (tx) => {
    const fxEntryId = await postApplicationFx(tx, credit, diff, when, diff.greaterThan(0) ? 'Realized exchange gain' : 'Realized exchange loss');
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newHomeUnapplied = Money.round2(creditHomeUnapplied(credit).minus(homeCredit));
    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        homeUnapplied: toAmountString(newHomeUnapplied),
        status: (newUnapplied.isZero() ? 'closed' : 'partial') as never,
      })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    const newCredited = Money.round2(Money.of(bill.amountCredited).plus(amount));
    const newBalance = Money.round2(balanceDue.minus(amount));
    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newCredited),
        balanceDue: toAmountString(newBalance),
        status: billStatus(bill, newBalance, newCredited) as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, bill.id))
      .returning();
    const [app] = await tx.db
      .insert(vendorCreditApplications)
      .values({
        companyId: tx.companyId,
        vendorCreditId: credit.id,
        billId: bill.id,
        date: when,
        amount: toAmountString(amount),
        homeBill: toAmountString(homeBill),
        homeCredit: toAmountString(homeCredit),
        fxEntryId,
      })
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: credit.id,
      newValues: {
        action: 'applied_to_bill',
        billId: bill.id,
        amount: toAmountString(amount),
        currency: credit.currency,
        homeBill: toAmountString(homeBill),
        homeCredit: toAmountString(homeCredit),
        exchangeGainLoss: toAmountString(diff),
        fxEntryId,
        applicationId: app.id,
        newUnapplied: toAmountString(newUnapplied),
      },
    });
    return { credit: updatedCredit, bill: updatedBill };
  });
}

/** Reverse (part of) a foreign application: a negative application row + the reversing FX entry. */
export async function unapplyForeignVendorCredit(
  ctx: ServiceContext,
  credit: VendorCreditRow,
  bill: BillRow,
  amount: Decimal,
  date?: Date | null,
) {
  const [pair] = await ctx.db
    .select({
      amount: sql<string>`COALESCE(SUM(${vendorCreditApplications.amount}), 0)`,
      homeBill: sql<string>`COALESCE(SUM(${vendorCreditApplications.homeBill}), 0)`,
      homeCredit: sql<string>`COALESCE(SUM(${vendorCreditApplications.homeCredit}), 0)`,
    })
    .from(vendorCreditApplications)
    .where(
      and(
        eq(vendorCreditApplications.companyId, ctx.companyId),
        eq(vendorCreditApplications.vendorCreditId, credit.id),
        eq(vendorCreditApplications.billId, bill.id),
      ),
    );
  const applied = Money.of(pair?.amount ?? 0);
  if (amount.greaterThan(applied)) {
    throw validation(
      `Only ${toAmountString(applied)} of this credit is applied to that bill, so ${toAmountString(amount)} can't be unapplied.`,
    );
  }
  const full = amount.equals(applied);
  const homeBill = full ? Money.of(pair!.homeBill) : toHome(amount, bill.exchangeRate ?? 1);
  const homeCredit = full ? Money.of(pair!.homeCredit) : toHome(amount, credit.exchangeRate ?? 1);
  const diff = Money.round2(homeCredit.minus(homeBill)); // reverses the application's diff
  const when = date ?? new Date();

  return inTransaction(ctx, async (tx) => {
    const fxEntryId = await postApplicationFx(tx, credit, diff, when, 'Exchange gain/loss reversed — credit unapplied');
    const newUnapplied = Money.round2(Money.of(credit.unapplied).plus(amount));
    const newHomeUnapplied = Money.round2(creditHomeUnapplied(credit).plus(homeCredit));
    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        homeUnapplied: toAmountString(newHomeUnapplied),
        status: (newUnapplied.greaterThanOrEqualTo(Money.of(credit.total)) ? 'open' : 'partial') as never,
      })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    const newCredited = Money.round2(Money.of(bill.amountCredited).minus(amount));
    const newBalance = Money.round2(Money.of(bill.balanceDue).plus(amount));
    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newCredited),
        balanceDue: toAmountString(newBalance),
        status: billStatus(bill, newBalance, newCredited) as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, bill.id))
      .returning();
    await tx.db.insert(vendorCreditApplications).values({
      companyId: tx.companyId,
      vendorCreditId: credit.id,
      billId: bill.id,
      date: when,
      amount: toAmountString(amount.negated()),
      homeBill: toAmountString(homeBill.negated()),
      homeCredit: toAmountString(homeCredit.negated()),
      fxEntryId,
    });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: credit.id,
      newValues: {
        action: 'unapplied_from_bill',
        billId: bill.id,
        amount: toAmountString(amount),
        currency: credit.currency,
        exchangeGainLoss: toAmountString(diff),
        fxEntryId,
        newUnapplied: toAmountString(newUnapplied),
      },
    });
    return { credit: updatedCredit, bill: updatedBill };
  });
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

/**
 * Vendor refund of a foreign credit: Dr bank (refund amount at the refund's rate) / Cr A/P (the
 * credit's home value at its booked rate) / exchange gain or loss for the difference. The bank
 * must be in the credit's currency or the home currency.
 */
export async function refundForeignVendorCredit(
  ctx: ServiceContext,
  credit: VendorCreditRow,
  input: { bankAccountId: string; amount: Decimal; date?: Date | null; memo?: string | null; exchangeRate?: string | number | null },
) {
  const [bank] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, currency: accounts.currency, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bank) throw notFound('Bank account');
  if (!isDepositTargetAccount(bank)) throw validation('Vendor refunds must be deposited into a bank/cash account.');
  const home = await homeCode(ctx);
  const bankCur = foreignCode(bank.currency, home);
  if (bankCur && bankCur !== credit.currency) {
    throw validation(
      `"${bank.name}" is a ${bankCur} account. Deposit this ${credit.currency} refund into a ${credit.currency} account or a home-currency account.`,
    );
  }
  const fx = await currencyRate(ctx, credit.currency, input.exchangeRate);
  const amount = input.amount;
  const unapplied = Money.of(credit.unapplied);
  const homeCredit = amount.equals(unapplied) ? creditHomeUnapplied(credit) : toHome(amount, credit.exchangeRate ?? 1);
  const bankHome = toHome(amount, fx.rate);
  if (!bankHome.greaterThan(0)) throw validation('This refund is too small to convert to your home currency.');
  const ap = await apAccountId(ctx);
  const when = vendorCreditRefundDate(credit, input.date);

  return inTransaction(ctx, async (tx) => {
    const lines: PostingLine[] = [
      {
        accountId: input.bankAccountId,
        debit: toAmountString(bankHome),
        memo: 'Vendor refund deposited',
        ...(bankCur ? { foreignAmount: toAmountString(amount) } : {}),
      },
      { accountId: ap, credit: toAmountString(homeCredit), memo: 'Vendor credit settled in cash', controlLine: true },
    ];
    const fxLine = await exchangeGainLossLine(tx, bankHome.minus(homeCredit));
    if (fxLine) lines.push(fxLine);
    const entry = await postJournalEntry(tx, {
      date: when,
      description: input.memo ?? 'Vendor refund received',
      sourceRef: `refund:${credit.id}`,
      currency: fx.currency,
      exchangeRate: fx.rate.toFixed(8),
      lines,
    });
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newRefunded = Money.round2(Money.of(credit.refundedAmount).plus(amount));
    const newHomeUnapplied = Money.round2(creditHomeUnapplied(credit).minus(homeCredit));
    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        homeUnapplied: toAmountString(newHomeUnapplied),
        status: (newUnapplied.isZero() ? 'closed' : 'partial') as never,
      })
      .where(eq(vendorCredits.id, credit.id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: credit.id,
      oldValues: { unapplied: credit.unapplied, refundedAmount: credit.refundedAmount, status: credit.status },
      newValues: {
        action: 'refund',
        amount: toAmountString(amount),
        currency: credit.currency,
        exchangeRate: fx.rate.toFixed(8),
        bankAccountId: input.bankAccountId,
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        postedEntryId: entry.id,
      },
    });
    return { credit: updatedCredit, entry };
  });
}

/** Refuse to refund a HOME credit into a foreign-currency account (amounts would mix currencies). */
export async function assertHomeRefundAccount(ctx: ServiceContext, bankAccountId: string): Promise<void> {
  const [bank] = await ctx.db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, bankAccountId), eq(accounts.companyId, ctx.companyId)));
  const cur = foreignCode(bank?.currency ?? null, await homeCode(ctx));
  if (cur) {
    throw new ServiceError(
      'VALIDATION',
      `This is a ${cur} account. A home-currency vendor's refund can only go into a home-currency bank account.`,
    );
  }
}
