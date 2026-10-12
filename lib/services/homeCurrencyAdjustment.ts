/**
 * p1 fx — Home Currency Adjustment (QB: Company > Manage Currency > Home Currency Adjustment).
 *
 * As of a date and at the exchange rates the user enters (default: the currency list), revalue
 * every foreign-currency balance to home currency and post the unrealized gain/loss to
 * 6900 Exchange Gain/Loss:
 *   - foreign-currency bank and credit-card accounts: foreign balance x new rate vs. the home
 *     balance on the books. The account line carries foreign amount 0 (home value only), so the
 *     register and reconciliation in the account's currency are untouched. Permanent.
 *   - open foreign A/R (invoices, unapplied payments) per customer and open foreign A/P (bills,
 *     vendor credits) per vendor: open foreign amount x new rate vs. the home amount carried at
 *     the booked rates. Named A/R / A/P lines, so customer / vendor balances and aging include
 *     them.
 *   - foreign-currency Loan Manager loans: loan balance x new rate vs. its home carrying value.
 * The A/R, A/P and loan part is REVERSED the next day (a second entry): open items stay at their
 * booked rates, and the realized gain/loss is recognized when they are paid — exactly once.
 *
 * Every line is posted through postJournalEntry (balanced, closing date respected, audited).
 * Voiding an adjustment voids both entries.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { accounts, currencies, homeCurrencyAdjustments, loans } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { getOrCreateExchangeGainLossAccount } from './currencies';
import { foreignCode, homeCode, parseRate } from './exchangeRates';
import { foreignAccountBalances } from './fxLedger';
import { foreignOpenPayables, foreignOpenReceivables } from './fxSubledger';
import { getLoan, voidOrphanLoanFx } from './loans';

export interface HcaLine {
  kind: 'account' | 'customer' | 'vendor' | 'loan';
  /** GL account the adjustment posts to. */
  accountId: string;
  accountName: string;
  /** Customer / vendor / loan id (null for a bank / card account). */
  entityId: string | null;
  entityName: string | null;
  currency: string;
  /** Balance in the foreign currency (natural sign: what is held / owed / receivable). */
  foreignBalance: string;
  /** Home value carried on the books now. */
  homeBalance: string;
  /** Home value at the new rate. */
  newHomeBalance: string;
  /** newHomeBalance - homeBalance (natural sign). */
  adjustment: string;
  /** Unrealized gain (+) or loss (-) in home currency. */
  gainLoss: string;
  /** True for A/R, A/P and loans (reversed the next day). */
  reversible: boolean;
}

export interface HcaPreview {
  date: string;
  homeCurrency: string | null;
  rates: Record<string, string>;
  lines: HcaLine[];
  /** Net unrealized gain (+) / loss (-). */
  total: string;
}

export interface HcaInput {
  date: Date;
  /** Currency code -> home units per 1 unit. Missing currencies use the currency list's rate. */
  rates?: Record<string, string | number>;
  memo?: string | null;
  /** Save the entered rates to the currency list (QB does). Default true. */
  updateCurrencyList?: boolean;
}

async function ratesFor(ctx: ServiceContext, input: HcaInput) {
  const home = await homeCode(ctx);
  const rows = await ctx.db
    .select({ code: currencies.code, rate: currencies.rateToBase, isBase: currencies.isBase })
    .from(currencies)
    .where(eq(currencies.companyId, ctx.companyId));
  const out: Record<string, Decimal> = {};
  for (const r of rows) {
    if (r.isBase || !foreignCode(r.code, home)) continue;
    out[r.code] = Money.of(r.rate);
  }
  for (const [code, v] of Object.entries(input.rates ?? {})) {
    const c = foreignCode(code, home);
    if (!c) continue;
    const parsed = parseRate(v, `The ${c} rate`);
    if (parsed) out[c] = parsed;
  }
  return { home, rates: out };
}

async function defaultArAp(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.subtype, ['accounts_receivable', 'accounts_payable'])))
    .orderBy(asc(accounts.code));
  const ap = rows.find((r) => r.code === '2000') ?? rows.find((r) => r.subtype === 'accounts_payable');
  const ar = rows.find((r) => r.code === '1200') ?? rows.find((r) => r.subtype === 'accounts_receivable');
  return { ar, ap };
}

/** Compute (without posting) what a Home Currency Adjustment as of `date` would post. */
export async function previewHomeCurrencyAdjustment(ctx: ServiceContext, input: HcaInput): Promise<HcaPreview> {
  if (!input.date || isNaN(new Date(input.date).getTime())) throw validation('Pick the date of the adjustment.');
  const date = new Date(input.date);
  const { home, rates } = await ratesFor(ctx, input);
  const lines: HcaLine[] = [];
  const need = (cur: string) => {
    const r = rates[cur];
    if (!r) throw validation(`Enter an exchange rate for ${cur}.`);
    return r;
  };
  const push = (l: Omit<HcaLine, 'adjustment' | 'gainLoss' | 'newHomeBalance'>, newHome: Decimal, assetLike: boolean) => {
    const adj = Money.round2(newHome.minus(Money.of(l.homeBalance)));
    if (adj.isZero()) return;
    lines.push({
      ...l,
      newHomeBalance: toAmountString(newHome),
      adjustment: toAmountString(adj),
      // An asset worth more home currency is a gain; a liability costing more is a loss.
      gainLoss: toAmountString(assetLike ? adj : adj.negated()),
    });
  };

  // 1. Foreign-currency bank / credit-card accounts.
  for (const a of await foreignAccountBalances(ctx, date)) {
    const rate = need(a.currency);
    const newHome = Money.round2(a.foreign.times(rate));
    push(
      {
        kind: 'account',
        accountId: a.accountId,
        accountName: `${a.code} ${a.name}`,
        entityId: null,
        entityName: null,
        currency: a.currency,
        foreignBalance: toAmountString(a.foreign),
        homeBalance: toAmountString(a.home),
        reversible: false,
      },
      newHome,
      a.type === 'asset',
    );
  }

  const { ar, ap } = await defaultArAp(ctx);

  // 2. Foreign A/R per customer + currency.
  const recv = await foreignOpenReceivables(ctx, date);
  const byCustomer = new Map<string, { name: string; currency: string; foreign: Decimal; home: Decimal; newHome: Decimal }>();
  for (const it of recv) {
    const k = `${it.entityId}|${it.currency}`;
    const rate = need(it.currency);
    const cur = byCustomer.get(k) ?? { name: it.entityName, currency: it.currency, foreign: Money.zero(), home: Money.zero(), newHome: Money.zero() };
    cur.foreign = cur.foreign.plus(it.foreignOpen);
    cur.home = cur.home.plus(it.homeOpen);
    cur.newHome = cur.newHome.plus(Money.round2(it.foreignOpen.times(rate)));
    byCustomer.set(k, cur);
  }
  if (byCustomer.size > 0 && !ar) throw validation('There is no Accounts Receivable account to adjust.');
  for (const [k, v] of byCustomer) {
    push(
      {
        kind: 'customer',
        accountId: ar!.id,
        accountName: `${ar!.code} ${ar!.name}`,
        entityId: k.split('|')[0],
        entityName: v.name,
        currency: v.currency,
        foreignBalance: toAmountString(v.foreign),
        homeBalance: toAmountString(v.home),
        reversible: true,
      },
      v.newHome,
      true,
    );
  }

  // 3. Foreign A/P per vendor + currency (bills positive = owed).
  const pay = await foreignOpenPayables(ctx, date);
  const byVendor = new Map<string, { name: string; currency: string; foreign: Decimal; home: Decimal; newHome: Decimal }>();
  for (const it of pay) {
    const k = `${it.entityId}|${it.currency}`;
    const rate = need(it.currency);
    const cur = byVendor.get(k) ?? { name: it.entityName, currency: it.currency, foreign: Money.zero(), home: Money.zero(), newHome: Money.zero() };
    cur.foreign = cur.foreign.plus(it.foreignOpen);
    cur.home = cur.home.plus(it.homeOpen);
    cur.newHome = cur.newHome.plus(Money.round2(it.foreignOpen.times(rate)));
    byVendor.set(k, cur);
  }
  if (byVendor.size > 0 && !ap) throw validation('There is no Accounts Payable account to adjust.');
  for (const [k, v] of byVendor) {
    push(
      {
        kind: 'vendor',
        accountId: ap!.id,
        accountName: `${ap!.code} ${ap!.name}`,
        entityId: k.split('|')[0],
        entityName: v.name,
        currency: v.currency,
        foreignBalance: toAmountString(v.foreign),
        homeBalance: toAmountString(v.home),
        reversible: true,
      },
      v.newHome,
      false,
    );
  }

  // 4. Foreign-currency Loan Manager loans (balance as of the date, carried at the booked rate).
  const loanRows = await ctx.db
    .select({ loan: loans, accountName: accounts.name, accountCode: accounts.code })
    .from(loans)
    .innerJoin(accounts, eq(loans.liabilityAccountId, accounts.id))
    .where(and(eq(loans.companyId, ctx.companyId), eq(loans.isActive, true)));
  for (const { loan, accountName, accountCode } of loanRows) {
    const cur = foreignCode(loan.currency, home);
    if (!cur) continue;
    const rate = need(cur);
    const { activePrincipal } = await loanPrincipalPaid(ctx, loan.id, date);
    const balance = Money.round2(Money.of(loan.originalAmount).minus(activePrincipal));
    if (balance.isZero()) continue;
    const carried = Money.round2(balance.times(Money.of(loan.exchangeRate ?? rate)));
    push(
      {
        kind: 'loan',
        accountId: loan.liabilityAccountId,
        accountName: `${accountCode} ${accountName}`,
        entityId: loan.id,
        entityName: loan.name,
        currency: cur,
        foreignBalance: toAmountString(balance),
        homeBalance: toAmountString(carried),
        reversible: true,
      },
      Money.round2(balance.times(rate)),
      false,
    );
  }

  const total = lines.reduce((s, l) => s.plus(Money.of(l.gainLoss)), Money.zero());
  return {
    date: date.toISOString(),
    homeCurrency: home,
    rates: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v.toFixed(8)])),
    lines,
    total: toAmountString(total),
  };
}

/** Principal of a loan's active (not voided) payments dated on/before `asOf`. */
async function loanPrincipalPaid(ctx: ServiceContext, loanId: string, asOf: Date) {
  const loan = await getLoan(ctx, loanId);
  const active = loan.payments.filter((p) => p.active && new Date(p.date).getTime() <= asOf.getTime());
  return { activePrincipal: active.reduce((s, p) => s.plus(Money.of(p.principal)), Money.zero()) };
}

/** Posting lines for a set of HCA lines (+ the Exchange Gain/Loss offset). */
async function linesFor(ctx: ServiceContext, hca: HcaLine[], reverse: boolean): Promise<PostingLine[]> {
  const out: PostingLine[] = [];
  const types = new Map<string, string>();
  const ids = [...new Set(hca.map((l) => l.accountId))];
  if (ids.length) {
    const rows = await ctx.db
      .select({ id: accounts.id, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, ids)));
    for (const r of rows) types.set(r.id, r.type);
  }
  let net = Money.zero(); // debit - credit of the adjusted lines
  for (const l of hca) {
    let adj = Money.of(l.adjustment);
    if (reverse) adj = adj.negated();
    const debitNormal = types.get(l.accountId) === 'asset' || types.get(l.accountId) === 'expense';
    const signed = debitNormal ? adj : adj.negated(); // debit (+) / credit (-)
    if (signed.isZero()) continue;
    net = net.plus(signed);
    const memo = `${reverse ? 'Reverse home currency adjustment' : 'Home currency adjustment'} — ${l.entityName ?? l.accountName} (${l.currency})`;
    const name =
      l.kind === 'customer'
        ? { entityType: 'customer' as const, entityId: l.entityId! }
        : l.kind === 'vendor'
          ? { entityType: 'vendor' as const, entityId: l.entityId! }
          : {};
    out.push({
      accountId: l.accountId,
      ...(signed.greaterThan(0) ? { debit: toAmountString(signed) } : { credit: toAmountString(signed.abs()) }),
      memo,
      ...name,
      ...(l.kind === 'account' ? { foreignAmount: '0' } : {}),
    });
  }
  if (out.length === 0) return out;
  const fxAccountId = await getOrCreateExchangeGainLossAccount(ctx);
  out.push(
    net.greaterThan(0)
      ? { accountId: fxAccountId, credit: toAmountString(net), memo: reverse ? 'Reverse unrealized exchange gain/loss' : 'Unrealized exchange gain' }
      : { accountId: fxAccountId, debit: toAmountString(net.abs()), memo: reverse ? 'Reverse unrealized exchange gain/loss' : 'Unrealized exchange loss' },
  );
  if (net.isZero()) out.pop();
  return out;
}

/** Post a Home Currency Adjustment (and its next-day reversal for A/R, A/P and loans). */
export async function createHomeCurrencyAdjustment(ctx: ServiceContext, input: HcaInput) {
  await voidOrphanLoanFx(ctx);
  const preview = await previewHomeCurrencyAdjustment(ctx, input);
  if (preview.lines.length === 0) {
    throw validation('Nothing to adjust: every foreign-currency balance is already at these rates.');
  }
  const date = new Date(input.date);
  const reversalDate = new Date(date.getTime() + 86_400_000);

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(homeCurrencyAdjustments)
      .values({
        companyId: tx.companyId,
        date,
        memo: input.memo ?? null,
        rates: preview.rates,
        detail: preview.lines,
        total: preview.total,
      })
      .returning();
    const description = input.memo?.trim() || `Home currency adjustment ${date.toISOString().slice(0, 10)}`;
    const lines = await linesFor(tx, preview.lines, false);
    const entry = lines.length >= 2
      ? await postJournalEntry(tx, { date, description, sourceRef: `hca:${row.id}`, isAdjusting: true, lines })
      : null;
    const reversible = preview.lines.filter((l) => l.reversible);
    const revLines = await linesFor(tx, reversible, true);
    const reversal = revLines.length >= 2
      ? await postJournalEntry(tx, {
          date: reversalDate,
          description: `Reversal of ${description}`,
          sourceRef: `hca-reversal:${row.id}`,
          isAdjusting: true,
          lines: revLines,
        })
      : null;
    const [saved] = await tx.db
      .update(homeCurrencyAdjustments)
      .set({ entryId: entry?.id ?? null, reversalEntryId: reversal?.id ?? null })
      .where(eq(homeCurrencyAdjustments.id, row.id))
      .returning();
    if (input.updateCurrencyList !== false) {
      for (const [code, rate] of Object.entries(preview.rates)) {
        await tx.db
          .update(currencies)
          .set({ rateToBase: rate, updatedAt: new Date() })
          .where(and(eq(currencies.companyId, tx.companyId), eq(currencies.code, code), eq(currencies.isBase, false)));
      }
    }
    await writeAudit(tx, {
      action: 'create',
      entityType: 'home_currency_adjustment',
      entityId: row.id,
      newValues: {
        date,
        rates: preview.rates,
        total: preview.total,
        lines: preview.lines.length,
        entryId: entry?.id ?? null,
        reversalEntryId: reversal?.id ?? null,
      },
    });
    return { ...saved, preview };
  });
}

export async function listHomeCurrencyAdjustments(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(homeCurrencyAdjustments)
    .where(eq(homeCurrencyAdjustments.companyId, ctx.companyId))
    .orderBy(desc(homeCurrencyAdjustments.date), desc(homeCurrencyAdjustments.createdAt));
}

export async function getHomeCurrencyAdjustment(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(homeCurrencyAdjustments)
    .where(and(eq(homeCurrencyAdjustments.companyId, ctx.companyId), eq(homeCurrencyAdjustments.id, id)));
  if (!row) throw notFound('Home currency adjustment');
  return row;
}

/** Void an adjustment: both its entry and its reversal (closing date respected). */
export async function voidHomeCurrencyAdjustment(ctx: ServiceContext, id: string) {
  const row = await getHomeCurrencyAdjustment(ctx, id);
  if (row.voidedAt) return row;
  return inTransaction(ctx, async (tx) => {
    for (const entryId of [row.reversalEntryId, row.entryId]) {
      if (entryId) await voidJournalEntry(tx, entryId);
    }
    const [updated] = await tx.db
      .update(homeCurrencyAdjustments)
      .set({ voidedAt: new Date() })
      .where(eq(homeCurrencyAdjustments.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'void',
      entityType: 'home_currency_adjustment',
      entityId: id,
      oldValues: { total: row.total, entryId: row.entryId, reversalEntryId: row.reversalEntryId },
      newValues: { voided: true },
    });
    return updated;
  });
}
