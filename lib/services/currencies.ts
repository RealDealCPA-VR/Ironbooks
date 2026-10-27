/**
 * Multi-currency service.
 *
 * The `currencies` table (see schema.ts) tracks every currency a company uses, each with a
 * `rateToBase` (units of base currency per 1 unit of this currency). The base currency always
 * has rateToBase = 1 and isBase = true.
 *
 * Conversions:
 *   amount in foreign → amount in base : amount * fromRate
 *   amount in base    → amount in foreign: amount / toRate
 *   cross-rate (foreign A → foreign B)  : amount * fromRate / toRate
 *
 * FX gain/loss entries are posted through postJournalEntry so the GL remains the single source
 * of truth:
 *   Gain: Dr <asset/liability account>  /  Cr Exchange Gain/Loss
 *   Loss: Dr Exchange Gain/Loss         /  Cr <asset/liability account>
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { currencies, accounts, billLines, bills, journalEntryLines } from '@/lib/db/schema';
import { Money, MoneyParseError, allocate, toAmountString } from '@/lib/money';
import { postJournalEntry } from './posting';
import { type ServiceContext, ServiceError, inTransaction, validation, notFound, writeAudit } from './_base';
import {
  assertForeignCurrencyAllowed,
  assertHomeCurrencyChangeAllowed,
  assertListRatesKeepHomeCurrency,
  effectiveHomeCurrency,
} from './multiCurrency';
import { foreignCode } from './fxLines';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrencyRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  rateToBase: string;
  isBase: boolean;
  updatedAt: Date;
}

export interface UpsertCurrencyInput {
  code: string;
  name: string;
  /** Exchange rate: how many base-currency units equal 1 unit of this currency. */
  rateToBase: string | number;
}

export interface SetBaseCurrencyInput {
  code: string;
  name: string;
}

export interface RecordFxAdjustmentInput {
  /** The account being revalued (must belong to this company). */
  accountId: string;
  /** Absolute amount of the gain or loss in base currency. */
  amount: string | number;
  /** true = FX gain, false = FX loss. */
  gain: boolean;
  date: Date;
  memo?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * review5 fx: a currency code as the currency list stores it - three letters (ISO 4217), upper
 * case. Anything else (digits, symbols, a number in the JSON body) is a plain validation error,
 * never a TypeError / database error (500).
 */
function currencyCodeOf(code: unknown): string {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(c)) throw validation('Enter the currency as its 3-letter code (for example EUR, GBP or CAD).');
  return c;
}

/** review5 fx: the currency's name (required, at most the column's 100 characters). */
function currencyNameOf(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw validation('Currency name is required.');
  if (n.length > 100) throw validation('The currency name is too long (100 characters at most).');
  return n;
}

/**
 * review5 fx: an exchange rate for the currency list (home units per 1 unit): a number above zero,
 * at most 1,000,000 (the bounds every transaction's rate has, exchangeRates.parseRate) and not so
 * small that it rounds to 0 at the list's 8 decimals.
 */
function listRateOf(v: unknown): Decimal {
  let r: Decimal;
  try {
    r = Money.of(v as string | number);
  } catch (err) {
    if (err instanceof MoneyParseError) throw validation('The exchange rate is not a number.');
    throw err;
  }
  if (!r.isFinite() || !r.greaterThan(0)) throw validation('The exchange rate must be greater than zero.');
  if (r.greaterThan(1_000_000)) throw validation('The exchange rate is too large.');
  const rounded = new Decimal(r.toFixed(8));
  if (!rounded.greaterThan(0)) throw validation('The exchange rate is too small (it rounds to 0 at 8 decimals).');
  return rounded;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all currencies for the company (base currency first). */
export async function listCurrencies(ctx: ServiceContext): Promise<CurrencyRow[]> {
  const rows = await ctx.db
    .select()
    .from(currencies)
    .where(eq(currencies.companyId, ctx.companyId));
  // Put base currency first for convenience
  return rows.sort((a, b) => (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0));
}

/**
 * Set (or replace) the base currency for a company.
 * - If a base already exists its isBase flag is cleared.
 * - The new base is inserted/updated with rateToBase = 1.
 * - review5 fx: the home currency is the unit of the whole ledger. Once the company has
 *   foreign-currency accounts, names or transactions it can no longer change (QB: the home currency
 *   is fixed once multicurrency is in use) - the foreign documents would silently become home ones
 *   and A/R / A/P aging would stop agreeing with the GL. Before that, a change rebases the other
 *   currencies' rates onto the new home currency (they were in units of the old one).
 * - One transaction: two concurrent saves can't leave the list with no base or two.
 */
export async function setBaseCurrency(
  ctx: ServiceContext,
  input: SetBaseCurrencyInput,
): Promise<CurrencyRow> {
  const code = currencyCodeOf(input.code);
  const name = currencyNameOf(input.name);

  return inTransaction(ctx, async (tx) => {
    const rows = await tx.db.select().from(currencies).where(eq(currencies.companyId, tx.companyId));
    const oldBase = rows.find((r) => r.isBase) ?? null;
    // review5 fx: the current home currency is the list's base, else (no base row - older files,
    // migration 0056) the Preferences currency, else USD; a change from it is refused once any
    // data carries a currency.
    const currentHome = await effectiveHomeCurrency(tx);
    const changing = await assertHomeCurrencyChangeAllowed(tx, code);

    // Rates of the other currencies are in units of the old home currency: rebase them onto the
    // new one (rate / rate of the new home currency) so the list's default rates stay right.
    const newBaseOld = rows.find((r) => !r.isBase && r.code === code);
    if (changing && !newBaseOld) {
      // review5 fx: without the new home currency's rate (in the old one) the other rates can't be
      // converted - refuse rather than leave them in the old home currency's units.
      const others = rows.filter((r) => !r.isBase && r.code !== code);
      if (others.length > 0) {
        throw validation(
          `Add ${code} to the currency list first, with its exchange rate in ${currentHome ?? 'your current home currency'}, so the rates of ${others.map((r) => r.code).join(', ')} can be converted to ${code}. Then set ${code} as the home currency.`,
        );
      }
      // Only the old home currency is listed: its rate in the new one is unknown, so it leaves the
      // list (no data uses it - checked above) instead of staying at 1. Add it back with its rate.
      if (oldBase) await tx.db.delete(currencies).where(eq(currencies.id, oldBase.id));
    }
    const pivot = changing && newBaseOld ? Money.of(newBaseOld.rateToBase) : null;
    if (pivot && pivot.greaterThan(0)) {
      for (const r of rows) {
        if (r.code === code) continue;
        const rate = (r.isBase ? Money.of(1) : Money.of(r.rateToBase)).dividedBy(pivot).toFixed(8);
        if (!Money.of(rate).greaterThan(0)) continue; // would round to 0: keep the user's rate
        await tx.db.update(currencies).set({ rateToBase: rate, updatedAt: new Date() }).where(eq(currencies.id, r.id));
      }
    }

    // Clear any existing base flag
    await tx.db
      .update(currencies)
      .set({ isBase: false, updatedAt: new Date() })
      .where(and(eq(currencies.companyId, tx.companyId), eq(currencies.isBase, true)));

    // Upsert the new base
    const existing = rows.find((r) => r.code === code);
    let row: CurrencyRow;
    if (existing) {
      const [updated] = await tx.db
        .update(currencies)
        .set({ name, rateToBase: '1', isBase: true, updatedAt: new Date() })
        .where(eq(currencies.id, existing.id))
        .returning();
      row = updated as CurrencyRow;
    } else {
      const [inserted] = await tx.db
        .insert(currencies)
        .values({
          companyId: tx.companyId,
          code,
          name,
          rateToBase: '1',
          isBase: true,
        })
        .returning();
      row = inserted as CurrencyRow;
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'currency',
      entityId: row.id,
      oldValues: oldBase ? { base: oldBase.code } : undefined,
      newValues: { code: row.code, name: row.name, isBase: true },
    });

    return row;
  });
}

/**
 * Insert or update a foreign currency and its exchange rate.
 * Cannot be used to (re-)set the base currency — use setBaseCurrency for that.
 * rateToBase must be positive (> 0).
 */
export async function upsertCurrency(
  ctx: ServiceContext,
  input: UpsertCurrencyInput,
): Promise<CurrencyRow> {
  const code = currencyCodeOf(input.code);
  const name = currencyNameOf(input.name);
  const rate = listRateOf(input.rateToBase);
  await assertForeignCurrencyAllowed(ctx, code); // A2: Multiple Currencies off

  // review5 fx: read and write in one transaction - two saves of a new currency at once (a double
  // click) must not both find no row and add the currency twice.
  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(currencies)
      .where(and(eq(currencies.companyId, tx.companyId), eq(currencies.code, code)));

    let row: CurrencyRow;
    if (existing?.isBase) {
      throw new ServiceError(
        'CONFLICT',
        `${code} is the base currency. Use setBaseCurrency to change the base.`,
      );
    }
    // review5 fx: with no base row the home currency is the Preferences currency, else USD. Listed
    // with a rate it would be a foreign currency: documents in it booked at that rate, and "Set as
    // home currency" later would silently turn them into home ones at the wrong amounts.
    if (code === (await effectiveHomeCurrency(tx))) {
      throw validation(
        `${code} is your home currency. Set it as the home currency instead of adding it with an exchange rate. (If your books are kept in another currency, set that one as the home currency first.)`,
      );
    }
    // review5 fx: nor may the rate itself change the home currency (with no base row, the default
    // listed at exactly 1 IS the home currency): USD listed at 1.30 and re-saved at 1 would turn its
    // documents booked at 1.30 into home ones, and "Set as home currency" would then pass as no change.
    await assertListRatesKeepHomeCurrency(tx, [{ code, rate: rate.toFixed(8) }]);
    if (existing) {
      const [updated] = await tx.db
        .update(currencies)
        .set({ name, rateToBase: rate.toFixed(8), updatedAt: new Date() })
        .where(eq(currencies.id, existing.id))
        .returning();
      row = updated as CurrencyRow;
    } else {
      const [inserted] = await tx.db
        .insert(currencies)
        .values({
          companyId: tx.companyId,
          code,
          name,
          rateToBase: rate.toFixed(8),
          isBase: false,
        })
        .returning();
      row = inserted as CurrencyRow;
    }

    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'currency',
      entityId: row.id,
      oldValues: existing ? { rateToBase: existing.rateToBase } : undefined,
      newValues: { code: row.code, name: row.name, rateToBase: row.rateToBase },
    });

    return row;
  });
}

/**
 * Convert an amount between currencies via their rateToBase values.
 *
 * @param amount    The source amount.
 * @param fromRate  rateToBase of the source currency  (1.0 if source is base).
 * @param toRate    rateToBase of the target currency  (1.0 if target is base).
 * @returns         The converted amount as a Decimal-string (toFixed(2)).
 *
 * Formula: amount * fromRate / toRate
 */
export function convert(
  amount: string | number,
  fromRate: string | number,
  toRate: string | number = '1',
): string {
  const result = Money.of(amount).times(Money.of(fromRate)).dividedBy(Money.of(toRate));
  return toAmountString(result);
}

/**
 * Return the revaluation snapshot: all non-base currencies with their current rate.
 * This is the data foundation for an FX revaluation report — callers can combine it
 * with account balances to compute unrealised gains/losses.
 */
export async function revaluation(
  ctx: ServiceContext,
): Promise<Array<{ id: string; code: string; name: string; rateToBase: string }>> {
  const rows = await ctx.db
    .select({ id: currencies.id, code: currencies.code, name: currencies.name, rateToBase: currencies.rateToBase })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), ne(currencies.isBase, true)));
  return rows;
}

/**
 * Post a balanced FX gain/loss journal entry through the posting engine.
 *
 *   Gain: Dr <accountId>          /  Cr Exchange Gain/Loss
 *   Loss: Dr Exchange Gain/Loss   /  Cr <accountId>
 *
 * Both lines are equal to `amount` so the entry is always balanced.
 */
export async function recordFxAdjustment(
  ctx: ServiceContext,
  input: RecordFxAdjustmentInput,
): Promise<{ entryId: string }> {
  const { accountId, amount, gain, date, memo } = input;

  let absAmount: Decimal;
  try {
    absAmount = Money.abs(amount);
  } catch (err) {
    if (err instanceof MoneyParseError) throw validation('The FX adjustment amount is not a number.');
    throw err;
  }
  if (!absAmount.isFinite()) throw validation('The FX adjustment amount is not a number.');
  if (absAmount.isZero()) throw validation('FX adjustment amount must be non-zero.');
  if (!(date instanceof Date) || isNaN(date.getTime())) throw validation('Enter a valid date for the FX adjustment.');

  // Verify the target account belongs to this company
  const [targetAcct] = await ctx.db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!targetAcct) throw notFound(`Account ${accountId}`);
  // review5 fx: the adjustment is a home-currency amount. On a foreign-currency bank / card account
  // it revalues the home value only (foreign amount 0, like a Home Currency Adjustment line), so
  // the account's balance in its own currency - its register and reconciliation - is untouched.
  const homeOnly = foreignCode(targetAcct.currency, await effectiveHomeCurrency(ctx)) !== null;
  const subjectFx = homeOnly ? { foreignAmount: '0' } : {};

  // review5 fx: the other side is the Exchange Gain/Loss account, where every other realized and
  // unrealized exchange difference goes (QB "Exchange Gain or Loss"). It used to be whatever
  // accounts were numbered 4900 / 6100 (Other Income / Bank & Merchant Fees): FX losses landed in
  // bank fees, and in a converted file without those numbers the adjustment could not be posted.
  const fxAccountId = await getOrCreateExchangeGainLossAccount(ctx);
  if (fxAccountId === accountId) {
    throw validation('Pick the account being revalued — the other side of an FX adjustment is already Exchange Gain/Loss.');
  }

  const amtStr = toAmountString(absAmount);
  const description = memo ?? (gain ? 'FX gain adjustment' : 'FX loss adjustment');

  let lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string; foreignAmount?: string }>;

  if (gain) {
    // Gain: Dr the subject account / Cr Exchange Gain/Loss
    lines = [
      { accountId, debit: amtStr, memo: description, ...subjectFx },
      { accountId: fxAccountId, credit: amtStr, memo: description },
    ];
  } else {
    // Loss: Dr Exchange Gain/Loss / Cr the subject account
    lines = [
      { accountId: fxAccountId, debit: amtStr, memo: description },
      { accountId, credit: amtStr, memo: description, ...subjectFx },
    ];
  }

  const entry = await postJournalEntry(ctx, {
    date,
    description,
    lines,
    sourceRef: 'fx_adjustment',
  });

  return { entryId: entry.id };
}

// ---------------------------------------------------------------------------
// wave2 purchases — multi-currency purchase documents
// ---------------------------------------------------------------------------
//
// Purchase documents (bills, checks / credit-card charges, bill payments) carry their own
// `currency` (null = home) and `exchangeRate` (home units per 1 transaction unit). The document
// stores amounts in its TRANSACTION currency; every GL line is posted in HOME currency. To keep
// the trial balance balanced to the penny, the home-currency total is computed ONCE
// (anchor = round2(total x rate)) and the lines are penny-allocated against it with `allocate`
// (largest remainder), exactly like invoices do. For rate = 1 the amounts are used as-is, so
// home-currency documents post exactly as before.

/**
 * The currency list's base (home) row's code, or null while the list has none (multi-currency
 * never set up, or an older file - migration 0056). review5 fx: only for "is the home currency set
 * up in the list"; whether a document, name or account is in a foreign currency is decided with
 * foreignCode(code, await effectiveHomeCurrency(ctx)), which also knows the home currency of a
 * list without a base row.
 */
export async function getHomeCurrencyCode(ctx: ServiceContext): Promise<string | null> {
  const [row] = await ctx.db
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isBase, true)));
  return row?.code ?? null;
}

export interface ResolvedCurrency {
  /** Transaction currency code; null = home currency. */
  currency: string | null;
  /** Home units per 1 transaction unit (exactly 1 for home documents). */
  rate: Decimal;
}

function hasText(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Decide a purchase document's currency + exchange rate.
 *  - `currency` defaults to the payment account's currency, then the vendor's currency.
 *  - A vendor or bank/credit-card account with a foreign currency only takes documents in that
 *    currency (QuickBooks rule: a vendor's transactions are in the vendor's currency).
 *  - A currency equal to the home currency is normalised to null (rate 1).
 *  - Foreign documents use `exchangeRate` when given, else the currency list's current rate.
 */
export async function resolveDocumentCurrency(
  ctx: ServiceContext,
  input: {
    currency?: string | null;
    exchangeRate?: string | number | null;
    /** The vendor's currency; null = a home-currency vendor; undefined = no vendor (free-text payee). */
    vendorCurrency?: string | null;
    accountCurrency?: string | null;
  },
): Promise<ResolvedCurrency> {
  const homeVendor = input.vendorCurrency === null;
  const anyForeign = hasText(input.currency) || hasText(input.vendorCurrency) || hasText(input.accountCurrency);
  if (!anyForeign) return { currency: null, rate: Money.of(1) };

  // review5 fx: the home code even without a base row (the Preferences currency, else USD), as
  // invoices resolve it - a bill or check typed "USD" in such a file is a home document.
  const home = await effectiveHomeCurrency(ctx);
  const norm = (c: string | null | undefined): string | null => {
    const v = (c ?? '').trim().toUpperCase();
    return v === '' || (home != null && v === home) ? null : v;
  };
  const vendorCur = norm(input.vendorCurrency);
  const accountCur = norm(input.accountCurrency);
  const currency = hasText(input.currency) ? norm(input.currency) : (accountCur ?? vendorCur ?? null);

  if (homeVendor && !vendorCur && currency) {
    throw validation(
      `This vendor uses your home currency, so it can't be paid from a ${currency} account. Pick a home-currency account (or set up the vendor in ${currency}).`,
    );
  }
  if (vendorCur && currency !== vendorCur) {
    throw validation(
      `This vendor uses ${vendorCur}. Enter the transaction in ${vendorCur} (or change the vendor's currency).`,
    );
  }
  if (accountCur && currency !== accountCur) {
    throw validation(
      `The selected account is a ${accountCur} account. Transactions in it must be in ${accountCur}.`,
    );
  }
  if (!currency) return { currency: null, rate: Money.of(1) };
  await assertForeignCurrencyAllowed(ctx, currency); // A2: Multiple Currencies off

  let rate: Decimal;
  if (hasText(input.exchangeRate)) {
    // review5 fx: a typed rate that is not a number, too large or rounds to 0 is a plain 400.
    rate = listRateOf(input.exchangeRate);
  } else {
    const [row] = await ctx.db
      .select({ rateToBase: currencies.rateToBase })
      .from(currencies)
      .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, currency)));
    if (!row) {
      throw validation(
        `${currency} is not in your currency list. Add it under Currencies (with an exchange rate) first.`,
      );
    }
    rate = Money.of(row.rateToBase);
  }
  if (!rate.isFinite() || !rate.greaterThan(0)) throw validation('Exchange rate must be greater than zero.');
  return { currency, rate: new Decimal(rate.toFixed(8)) };
}

/**
 * Home-currency amounts for a document: anchor = round2(total x rate); each line gets its
 * penny-allocated share so the lines sum to the anchor exactly. Line amounts are positive
 * 2dp values in the transaction currency.
 */
export function homeAmounts(
  lineAmounts: Array<string | number | Decimal>,
  rate: string | number | Decimal,
): { total: Decimal; lines: Decimal[] } {
  const r = Money.of(rate);
  const totalTxn = lineAmounts.reduce<Decimal>((a, v) => a.plus(Money.of(v)), Money.zero());
  if (r.equals(1)) {
    return { total: Money.round2(totalTxn), lines: lineAmounts.map((v) => Money.round2(v)) };
  }
  const anchor = Money.round2(totalTxn.times(r));
  return { total: anchor, lines: allocate(anchor, lineAmounts.map((v) => Money.of(v))) };
}

/**
 * review5 fx: the HOME amount each line of these bills was posted at — the bill's home total
 * penny-allocated over its lines in line order (homeAmounts, exactly as bills.ts posts it). Keyed
 * by bill line id; only FOREIGN-currency bills' lines are in the map (a home-currency bill's line
 * posted its own amount). Bills and their lines are read 2,000 ids at a time (a large file's IN
 * lists stay under Postgres' 65,535 bind parameters), and only the foreign bills' lines are read.
 */
export async function billLineHomeShares(ctx: ServiceContext, billIds: ReadonlyArray<string>): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  const ids = [...new Set(billIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const home = await effectiveHomeCurrency(ctx);
  for (let i = 0; i < ids.length; i += 2000) {
    const part = ids.slice(i, i + 2000);
    const docs = (
      await ctx.db
        .select({ id: bills.id, currency: bills.currency, rate: bills.exchangeRate })
        .from(bills)
        .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.id, part)))
    ).filter((b) => foreignCode(b.currency, home) !== null);
    if (docs.length === 0) continue;
    const byBill = new Map<string, Array<{ id: string; amount: string; lineOrder: number }>>();
    for (const l of await ctx.db
      .select({ id: billLines.id, billId: billLines.billId, amount: billLines.amount, lineOrder: billLines.lineOrder })
      .from(billLines)
      .where(inArray(billLines.billId, docs.map((b) => b.id)))) {
      const list = byBill.get(l.billId) ?? [];
      list.push(l);
      byBill.set(l.billId, list);
    }
    for (const b of docs) {
      const mine = (byBill.get(b.id) ?? []).sort((x, y) => x.lineOrder - y.lineOrder);
      const h = homeAmounts(mine.map((l) => Money.of(l.amount)), b.rate ?? 1);
      mine.forEach((l, j) => out.set(l.id, h.lines[j]));
    }
  }
  return out;
}

/** Find-or-create the Exchange Gain/Loss account (code 6900) used for realized FX. */
export async function getOrCreateExchangeGainLossAccount(ctx: ServiceContext): Promise<string> {
  // review5 fx: the account is found by what it IS, not only by number. A converted QuickBooks
  // file has QB's own "Exchange Gain or Loss" account (any number), and its 6900 can be anything
  // (a bank, Telephone, ...) — realized gains / losses were posted to that account.
  const candidates = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        sql`(${accounts.code} = '6900' OR lower(${accounts.name}) LIKE '%exchange gain%' OR lower(${accounts.name}) LIKE '%exchange loss%')`,
      ),
    );
  const pl = (a: { type: string; subtype: string }) =>
    (a.type === 'expense' || a.type === 'revenue') && a.subtype !== 'non_posting';
  const named = (a: { name: string }) => /exchange\s+(gain|loss)/i.test(a.name);
  const pick =
    candidates.find((a) => pl(a) && named(a) && a.code === '6900') ??
    candidates.find((a) => pl(a) && named(a) && a.isActive) ??
    candidates.find((a) => pl(a) && named(a));
  if (pick) return pick.id;
  // Create it: 6900 when that number is free, else the first free 69xx number.
  const used = new Set(
    (
      await ctx.db
        .select({ code: accounts.code })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.code} LIKE '69%'`))
    ).map((r) => r.code),
  );
  let code = 'FX-GAIN-LOSS';
  for (let n = 6900; n <= 6999; n += 1) {
    if (!used.has(String(n))) {
      code = String(n);
      break;
    }
  }
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code,
      name: 'Exchange Gain/Loss',
      type: 'expense' as never,
      subtype: 'operating_expenses' as never,
    })
    .returning();
  return created.id;
}

/**
 * Set the currency of a bank / credit-card account (QB: a foreign-currency bank account).
 * Allowed only while the account has no transactions - changing it later would re-denominate
 * history.
 */
export async function setAccountCurrency(
  ctx: ServiceContext,
  accountId: string,
  code: string | null,
): Promise<{ id: string; currency: string | null }> {
  const [acct] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!acct) throw notFound('Account');
  const isBankish = acct.type === 'asset' && ['checking', 'savings'].includes(acct.subtype);
  const isCard = acct.type === 'liability' && acct.subtype === 'credit_card';
  if (!isBankish && !isCard) {
    throw validation('Only bank and credit card accounts can have their own currency.');
  }
  const home = await effectiveHomeCurrency(ctx); // review5 fx: also without a base row
  const next = foreignCode(code, home);
  if (next) {
    await assertForeignCurrencyAllowed(ctx, next); // A2: Multiple Currencies off
    const [cur] = await ctx.db
      .select({ id: currencies.id })
      .from(currencies)
      .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, next)));
    if (!cur) throw validation(`${next} is not in your currency list. Add it under Currencies first.`);
  }
  // review5 fx: nothing to do only when the column already holds exactly `next`. An account tagged
  // with the home code (saved before the file had a home currency) or in another spelling (' eur')
  // is the same currency in effect, but its column is still rewritten while the account is unused,
  // so the answer never claims a value the column does not hold.
  if ((acct.currency ?? null) === next) return { id: acct.id, currency: next };
  const [used] = await ctx.db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.accountId, accountId))
    .limit(1);
  if (used && foreignCode(acct.currency, home) === next) {
    // Already that currency in effect (a used bank tagged with the home code is a home account):
    // no change - its stored tag stays with its history, and the answer says what it holds.
    return { id: acct.id, currency: acct.currency ?? null };
  }
  if (used) {
    throw new ServiceError(
      'CONFLICT',
      'This account already has transactions, so its currency can no longer be changed. Create a new account in the other currency instead.',
    );
  }
  const [updated] = await ctx.db
    .update(accounts)
    .set({ currency: next, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'account',
    entityId: accountId,
    oldValues: { currency: acct.currency ?? null },
    newValues: { currency: next },
  });
  return { id: updated.id, currency: updated.currency ?? null };
}

/**
 * review5 fx: the lines of a purchase document (check, card charge, bill, vendor credit) may use a
 * bank / credit-card account in the document's own currency or in home currency only. On an
 * account in a third currency (a USD check "paying the Euro card") the amount that account moved
 * by in its own currency is unknown, and the ledger would invent it at the list rate. QB asks for
 * Transfer Funds / Pay credit card (with the exchange rate) for that.
 */
export async function assertLineAccountsInDocumentCurrency(
  ctx: ServiceContext,
  accountIds: ReadonlyArray<string | null | undefined>,
  documentCurrency: string | null,
): Promise<void> {
  const ids = [...new Set(accountIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const rows = await ctx.db
    .select({ name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, ids), sql`${accounts.currency} IS NOT NULL`));
  if (rows.length === 0) return;
  // review5 fx: the home code also without a base row (a bank tagged with it is a home account).
  const home = await effectiveHomeCurrency(ctx);
  const doc = foreignCode(documentCurrency, home);
  for (const a of rows) {
    const cur = foreignCode(a.currency, home);
    if (!cur || cur === doc) continue;
    throw validation(
      `"${a.name}" is a ${cur} account, but this transaction is in ${doc ?? (home || 'your home currency')}. Use Transfer Funds or Pay credit card (where you enter the exchange rate), or enter it in ${cur}.`,
    );
  }
}

/**
 * review5 fx: the line accounts (bank / credit card) whose currency is the document's own foreign
 * currency. Their posting lines carry the typed line amount as the account's amount
 * (`foreignAmount`) - converting the line's home share back at the rate can be a cent off
 * (CAD 100.02 at 0.73 = USD 73.01 = CAD 100.01), and without an entry rate it was converted at
 * the list rate. Empty for a home-currency document.
 */
export async function sameCurrencyAccountIds(
  ctx: ServiceContext,
  accountIds: ReadonlyArray<string | null | undefined>,
  documentCurrency: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  const doc = (documentCurrency ?? '').trim().toUpperCase();
  const ids = [...new Set(accountIds.filter((x): x is string => !!x))];
  if (!doc || ids.length === 0) return out;
  const rows = await ctx.db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, ids)));
  for (const a of rows) if ((a.currency ?? '').trim().toUpperCase() === doc) out.add(a.id);
  return out;
}

/**
 * J10: documents that are recorded in home currency only (deposits, transfers, vendor credits,
 * Loan Manager payments) refuse a foreign-currency bank / credit-card account with a plain
 * message, so the ledger never takes a transaction-currency amount as if it were home currency.
 */
export async function assertHomeCurrencyAccounts(
  ctx: ServiceContext,
  accountIds: ReadonlyArray<string | null | undefined>,
  what: string,
): Promise<void> {
  const ids = [...new Set(accountIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  let home: string | null | undefined;
  for (const id of ids) {
    const [a] = await ctx.db
      .select({ name: accounts.name, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
    if (!(a?.currency ?? '').trim()) continue;
    // review5 fx: the home code also without a base row (a bank tagged with it is a home account).
    if (home === undefined) home = await effectiveHomeCurrency(ctx);
    const cur = foreignCode(a!.currency, home);
    if (!cur) continue;
    throw validation(
      `"${a!.name}" is a ${cur} account. ${what} can only use home-currency accounts for now.`,
    );
  }
}
