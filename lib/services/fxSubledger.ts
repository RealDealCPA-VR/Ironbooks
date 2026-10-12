/**
 * p1 fx — open foreign-currency A/R and A/P items with BOTH their foreign open amount and the home
 * amount the A/R / A/P control account still carries for them.
 *
 * QuickBooks keeps each foreign invoice / bill at the rate it was booked at until it is paid (the
 * payment posts the realized gain/loss) or a Home Currency Adjustment revalues it. These helpers
 * reconstruct, as of a date:
 *   invoice  foreign open = total - retainage - payments/discounts applied (payments dated <= asOf)
 *            home open    = the invoice's own A/R line - round2(each application x invoice rate)
 *   payment  (unapplied, foreign)  home = round2(unapplied x payment rate)
 *   bill     foreign open = total - bill-payment applications - foreign vendor-credit applications
 *            home open    = round2(total x bill rate) - home A/P each of them relieved
 *   vendor credit (foreign) foreign open = unapplied as of the date, home = the home part left
 * A/R aging, A/P aging, customer / vendor balance detail and Home Currency Adjustment use them, so
 * every report ties to the control accounts in home currency.
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  billPaymentApplications,
  billPayments,
  bills,
  customers,
  invoices,
  journalEntryLines,
  paymentApplications,
  paymentsReceived,
  vendorCreditApplications,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { foreignCode, homeCode } from './fxLines';

export interface ForeignOpenItem {
  kind: 'invoice' | 'payment' | 'bill' | 'vendor_credit';
  id: string;
  entityId: string;
  entityName: string;
  date: Date;
  currency: string;
  /** Rate the item was booked at (home units per 1 unit). */
  rate: Decimal;
  /** Open amount in the item's currency (negative for credits: payments / vendor credits). */
  foreignOpen: Decimal;
  /** Home amount the control account carries for it (same sign convention). */
  homeOpen: Decimal;
}

const r2 = (v: Decimal | string | number) => Money.round2(v);

/** Open foreign-currency A/R items (invoices and unapplied payments) as of a date. */
export async function foreignOpenReceivables(ctx: ServiceContext, asOf: Date): Promise<ForeignOpenItem[]> {
  const home = await homeCode(ctx);
  const inv = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      date: invoices.date,
      currency: invoices.currency,
      rate: invoices.exchangeRate,
      total: invoices.total,
      retainage: invoices.retainageAmount,
      postedEntryId: invoices.postedEntryId,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        isNotNull(invoices.currency),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
        lte(invoices.date, asOf),
      ),
    );
  const foreignInv = inv.filter((i) => foreignCode(i.currency, home));
  const out: ForeignOpenItem[] = [];
  if (foreignInv.length > 0) {
    const ids = foreignInv.map((i) => i.id);
    const entryIds = foreignInv.map((i) => i.postedEntryId).filter((x): x is string => !!x);
    // The invoice's own A/R line (home), exactly as posted.
    const arRows = entryIds.length
      ? await ctx.db
          .select({
            entryId: journalEntryLines.journalEntryId,
            net: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0) - COALESCE(${journalEntryLines.credit}, 0)), 0)`,
          })
          .from(journalEntryLines)
          .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
          .where(and(inArray(journalEntryLines.journalEntryId, entryIds), eq(accounts.subtype, 'accounts_receivable')))
          .groupBy(journalEntryLines.journalEntryId)
      : [];
    const arByEntry = new Map(arRows.map((r) => [r.entryId, Money.of(r.net)]));
    const apps = await ctx.db
      .select({
        invoiceId: paymentApplications.invoiceId,
        applied: paymentApplications.amountApplied,
        discount: paymentApplications.discountAmount,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(
        and(
          inArray(paymentApplications.invoiceId, ids),
          isNull(paymentsReceived.voidedAt),
          lte(paymentsReceived.date, asOf),
        ),
      );
    const appsBy = new Map<string, typeof apps>();
    for (const a of apps) appsBy.set(a.invoiceId, [...(appsBy.get(a.invoiceId) ?? []), a]);
    for (const i of foreignInv) {
      const rate = Money.of(i.rate ?? 1);
      let foreign = Money.of(i.total).minus(Money.of(i.retainage ?? 0));
      let homeOpen = i.postedEntryId && arByEntry.has(i.postedEntryId) ? arByEntry.get(i.postedEntryId)! : r2(foreign.times(rate));
      for (const a of appsBy.get(i.id) ?? []) {
        foreign = foreign.minus(Money.of(a.applied)).minus(Money.of(a.discount ?? 0));
        homeOpen = homeOpen.minus(r2(r2(a.applied).times(rate))).minus(r2(r2(a.discount ?? 0).times(rate)));
      }
      if (foreign.isZero() && homeOpen.isZero()) continue;
      out.push({
        kind: 'invoice',
        id: i.id,
        entityId: i.customerId,
        entityName: i.customerName,
        date: i.date,
        currency: foreignCode(i.currency, home)!,
        rate,
        foreignOpen: r2(foreign),
        homeOpen: r2(homeOpen),
      });
    }
  }

  const pays = await ctx.db
    .select({
      id: paymentsReceived.id,
      customerId: paymentsReceived.customerId,
      customerName: customers.displayName,
      date: paymentsReceived.date,
      currency: paymentsReceived.currency,
      rate: paymentsReceived.exchangeRate,
      unapplied: paymentsReceived.unapplied,
    })
    .from(paymentsReceived)
    .innerJoin(customers, eq(paymentsReceived.customerId, customers.id))
    .where(
      and(
        eq(paymentsReceived.companyId, ctx.companyId),
        isNotNull(paymentsReceived.currency),
        isNull(paymentsReceived.voidedAt),
        lte(paymentsReceived.date, asOf),
        sql`CAST(${paymentsReceived.unapplied} AS NUMERIC) > 0`,
      ),
    );
  for (const p of pays) {
    const cur = foreignCode(p.currency, home);
    if (!cur) continue;
    const rate = Money.of(p.rate ?? 1);
    out.push({
      kind: 'payment',
      id: p.id,
      entityId: p.customerId,
      entityName: p.customerName,
      date: p.date,
      currency: cur,
      rate,
      foreignOpen: Money.of(p.unapplied).negated(),
      homeOpen: r2(Money.of(p.unapplied).times(rate)).negated(),
    });
  }
  return out;
}

/** Open foreign-currency A/P items (bills and vendor credits) as of a date. Bills are positive. */
export async function foreignOpenPayables(ctx: ServiceContext, asOf: Date): Promise<ForeignOpenItem[]> {
  const home = await homeCode(ctx);
  const out: ForeignOpenItem[] = [];
  const billRows = await ctx.db
    .select({
      id: bills.id,
      vendorId: bills.vendorId,
      vendorName: vendors.displayName,
      date: bills.date,
      currency: bills.currency,
      rate: bills.exchangeRate,
      total: bills.total,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        isNotNull(bills.currency),
        ne(bills.status, 'void'),
        ne(bills.status, 'draft'),
        lte(bills.date, asOf),
      ),
    );
  const fb = billRows.filter((b) => foreignCode(b.currency, home));
  if (fb.length > 0) {
    const ids = fb.map((b) => b.id);
    const payApps = await ctx.db
      .select({
        billId: billPaymentApplications.billId,
        applied: billPaymentApplications.amountApplied,
        home: billPaymentApplications.amountHome,
      })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(
        and(inArray(billPaymentApplications.billId, ids), isNull(billPayments.voidedAt), lte(billPayments.date, asOf)),
      );
    const vcApps = await ctx.db
      .select({
        billId: vendorCreditApplications.billId,
        amount: vendorCreditApplications.amount,
        home: vendorCreditApplications.homeBill,
      })
      .from(vendorCreditApplications)
      .where(and(inArray(vendorCreditApplications.billId, ids), lte(vendorCreditApplications.date, asOf)));
    for (const b of fb) {
      const rate = Money.of(b.rate ?? 1);
      let foreign = Money.of(b.total);
      let homeOpen = r2(foreign.times(rate));
      for (const a of payApps.filter((x) => x.billId === b.id)) {
        foreign = foreign.minus(Money.of(a.applied));
        homeOpen = homeOpen.minus(Money.of(a.home ?? a.applied));
      }
      for (const a of vcApps.filter((x) => x.billId === b.id)) {
        foreign = foreign.minus(Money.of(a.amount));
        homeOpen = homeOpen.minus(Money.of(a.home));
      }
      if (foreign.isZero() && homeOpen.isZero()) continue;
      out.push({
        kind: 'bill',
        id: b.id,
        entityId: b.vendorId,
        entityName: b.vendorName,
        date: b.date,
        currency: foreignCode(b.currency, home)!,
        rate,
        foreignOpen: r2(foreign),
        homeOpen: r2(homeOpen),
      });
    }
  }

  const credits = await ctx.db
    .select({
      id: vendorCredits.id,
      vendorId: vendorCredits.vendorId,
      vendorName: vendors.displayName,
      date: vendorCredits.date,
      currency: vendorCredits.currency,
      rate: vendorCredits.exchangeRate,
      total: vendorCredits.total,
      unapplied: vendorCredits.unapplied,
      refunded: vendorCredits.refundedAmount,
      homeTotal: vendorCredits.homeTotal,
      homeUnapplied: vendorCredits.homeUnapplied,
    })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
    .where(
      and(
        eq(vendorCredits.companyId, ctx.companyId),
        isNotNull(vendorCredits.currency),
        ne(vendorCredits.status, 'void'),
        lte(vendorCredits.date, asOf),
      ),
    );
  if (credits.length > 0) {
    const apps = await ctx.db
      .select({
        creditId: vendorCreditApplications.vendorCreditId,
        amount: vendorCreditApplications.amount,
        home: vendorCreditApplications.homeCredit,
        date: vendorCreditApplications.date,
      })
      .from(vendorCreditApplications)
      .where(inArray(vendorCreditApplications.vendorCreditId, credits.map((c) => c.id)));
    for (const c of credits) {
      const cur = foreignCode(c.currency, home);
      if (!cur) continue;
      const mine = apps.filter((a) => a.creditId === c.id);
      const allHome = mine.reduce((s, a) => s.plus(Money.of(a.home)), Money.zero());
      const homeTotal = Money.of(c.homeTotal ?? r2(Money.of(c.total).times(Money.of(c.rate ?? 1))));
      // Refunds are not dated per row: treat them as before the date (like A/P aging does).
      const homeRefunded = homeTotal.minus(Money.of(c.homeUnapplied ?? 0)).minus(allHome);
      let foreign = Money.of(c.total).minus(Money.of(c.refunded ?? 0));
      let homeOpen = homeTotal.minus(homeRefunded);
      for (const a of mine) {
        if (a.date.getTime() > asOf.getTime()) continue;
        foreign = foreign.minus(Money.of(a.amount));
        homeOpen = homeOpen.minus(Money.of(a.home));
      }
      if (foreign.isZero() && homeOpen.isZero()) continue;
      out.push({
        kind: 'vendor_credit',
        id: c.id,
        entityId: c.vendorId,
        entityName: c.vendorName,
        date: c.date,
        currency: cur,
        rate: Money.of(c.rate ?? 1),
        foreignOpen: r2(foreign).negated(),
        homeOpen: r2(homeOpen).negated(),
      });
    }
  }
  return out;
}

/** invoiceId → home open amount (A/R aging of foreign invoices ties to the A/R account). */
export async function foreignInvoiceHomeOpen(
  ctx: ServiceContext,
  asOf: Date,
): Promise<Map<string, { foreignOpen: Decimal; homeOpen: Decimal; currency: string }>> {
  const items = await foreignOpenReceivables(ctx, asOf);
  return new Map(
    items
      .filter((i) => i.kind === 'invoice')
      .map((i) => [i.id, { foreignOpen: i.foreignOpen, homeOpen: i.homeOpen, currency: i.currency }]),
  );
}

/**
 * Foreign amount of each foreign-currency A/R / A/P document posting, by journal entry id: the
 * document's currency and its amount in that currency (invoices, payments, bills, bill payments,
 * vendor credits). Exchange gain/loss and Home Currency Adjustment entries carry amount 0 (they
 * change the home value only). Used for the foreign columns of Customer / Vendor Balance Detail.
 */
export async function foreignAmountsByEntry(
  ctx: ServiceContext,
  entryIds: string[],
): Promise<Map<string, { currency: string; amount: Decimal }>> {
  const out = new Map<string, { currency: string; amount: Decimal }>();
  const ids = [...new Set(entryIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const home = await homeCode(ctx);
  const put = (entryId: string | null, cur: string | null, amount: Decimal | string | number) => {
    const c = foreignCode(cur, home);
    if (entryId && c) out.set(entryId, { currency: c, amount: Money.of(amount) });
  };
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    for (const r of await ctx.db
      .select({ e: invoices.postedEntryId, c: invoices.currency, t: invoices.total, ret: invoices.retainageAmount })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.postedEntryId, chunk)))) {
      put(r.e, r.c, Money.of(r.t).minus(Money.of(r.ret ?? 0)));
    }
    const pays = await ctx.db
      .select({ id: paymentsReceived.id, e: paymentsReceived.postedEntryId, c: paymentsReceived.currency, a: paymentsReceived.amount })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.postedEntryId, chunk)));
    if (pays.length) {
      const disc = await ctx.db
        .select({ p: paymentApplications.paymentId, d: sql<string>`COALESCE(SUM(${paymentApplications.discountAmount}), 0)` })
        .from(paymentApplications)
        .where(inArray(paymentApplications.paymentId, pays.map((p) => p.id)))
        .groupBy(paymentApplications.paymentId);
      const dBy = new Map(disc.map((d) => [d.p, Money.of(d.d)]));
      for (const p of pays) put(p.e, p.c, Money.of(p.a).plus(dBy.get(p.id) ?? Money.zero()));
    }
    for (const r of await ctx.db
      .select({ e: bills.postedEntryId, c: bills.currency, t: bills.total })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.postedEntryId, chunk)))) {
      put(r.e, r.c, r.t);
    }
    const bps = await ctx.db
      .select({ id: billPayments.id, e: billPayments.postedEntryId, c: billPayments.currency })
      .from(billPayments)
      .where(and(eq(billPayments.companyId, ctx.companyId), inArray(billPayments.postedEntryId, chunk)));
    if (bps.length) {
      const settled = await ctx.db
        .select({ p: billPaymentApplications.billPaymentId, s: sql<string>`COALESCE(SUM(${billPaymentApplications.amountApplied}), 0)` })
        .from(billPaymentApplications)
        .where(inArray(billPaymentApplications.billPaymentId, bps.map((b) => b.id)))
        .groupBy(billPaymentApplications.billPaymentId);
      const sBy = new Map(settled.map((s) => [s.p, Money.of(s.s)]));
      for (const b of bps) put(b.e, b.c, sBy.get(b.id) ?? Money.zero());
    }
    for (const r of await ctx.db
      .select({ e: vendorCredits.postedEntryId, c: vendorCredits.currency, t: vendorCredits.total })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.companyId, ctx.companyId), inArray(vendorCredits.postedEntryId, chunk)))) {
      put(r.e, r.c, r.t);
    }
    for (const r of await ctx.db
      .select({ e: vendorCreditApplications.fxEntryId, c: vendorCredits.currency })
      .from(vendorCreditApplications)
      .innerJoin(vendorCredits, eq(vendorCreditApplications.vendorCreditId, vendorCredits.id))
      .where(and(eq(vendorCreditApplications.companyId, ctx.companyId), inArray(vendorCreditApplications.fxEntryId, chunk)))) {
      put(r.e, r.c, 0);
    }
  }
  return out;
}
