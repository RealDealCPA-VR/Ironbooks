/**
 * p1 fx — foreign-currency columns of journal lines (drizzle/0043_p1_fx.sql).
 *
 * Every line on a foreign-currency bank / credit-card account carries, next to its home-currency
 * debit or credit (the ledger of record), the same amount in the ACCOUNT's currency plus the
 * rate. Registers, bank feeds and reconciliation read that column, so a EUR account is shown and
 * reconciled in EUR while the trial balance stays in home currency.
 *
 * postJournalEntry calls `foreignLineColumns` for every entry:
 *  - a line that passes `foreignAmount` keeps it exactly (documents pass the amount the user typed,
 *    so no rounding round-trip can drift a cent; 0 = a home-only revaluation line);
 *  - any other line on a foreign-currency account is converted from its home amount at the
 *    entry's own rate (`exchangeRate`, when the entry is in that currency) or else at the currency
 *    list's current rate — so no posting path can leave a foreign account line without an amount.
 *
 * This module depends only on the schema and money helpers (posting.ts imports it, so it must not
 * import any service).
 */
import { and, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { companies, currencies } from '@/lib/db/schema';
import { Money, MoneyParseError, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';

export interface ForeignLineInput {
  debit?: string | number | null;
  credit?: string | number | null;
  /** Amount in the account's currency (same side as debit/credit). */
  foreignAmount?: string | number | null;
}

export interface ForeignLineColumns {
  currency: string | null;
  foreignAmount: string | null;
  exchangeRate: string | null;
}

const NONE: ForeignLineColumns = { currency: null, foreignAmount: null, exchangeRate: null };

/** Normalise an account / document currency: null when blank or equal to the home currency. */
export function foreignCode(code: string | null | undefined, home: string | null): string | null {
  const v = (code ?? '').trim().toUpperCase();
  if (!v) return null;
  return home && v === home ? null : v;
}

export interface CurrencyListRow {
  code: string;
  rateToBase: string;
  isBase: boolean;
}

/**
 * review5 fx: THE home currency code, from the currency list and the Preferences currency: the
 * list's base, else the Preferences currency, else USD. In a list with no base row (older files,
 * migration 0056) that holds that default as a FOREIGN currency (a rate other than 1, e.g. USD at
 * 1.36 in a Canadian file), the list's rates are in units of a home currency the file never
 * recorded, so the default is not the home currency and the code is unknown: null (every code is
 * then foreign, as the list's rates say).
 */
export function homeCodeFromList(rows: ReadonlyArray<CurrencyListRow>, settingsCurrency: unknown): string | null {
  const base = rows.find((r) => r.isBase);
  if (base) return base.code.trim().toUpperCase();
  const fromSettings = typeof settingsCurrency === 'string' ? settingsCurrency.trim() : '';
  const fallback = (fromSettings || 'USD').toUpperCase();
  const listed = rows.find((r) => r.code.trim().toUpperCase() === fallback);
  return listed && !Money.of(listed.rateToBase).equals(1) ? null : fallback;
}

/**
 * The company's home currency code (homeCodeFromList) - the one every home-vs-foreign comparison
 * of a document, name or account uses (foreignCode(x, await homeCode(ctx))). review5 fx: it used
 * to read the list's base row only, so in a file without one a bank tagged with the home code was a
 * foreign account here while its documents resolved as home ones.
 */
export async function homeCode(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<string | null> {
  const [company] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const settings = (company?.settings ?? {}) as Record<string, unknown> | null;
  const rows = await ctx.db
    .select({ code: currencies.code, rateToBase: currencies.rateToBase, isBase: currencies.isBase })
    .from(currencies)
    .where(eq(currencies.companyId, ctx.companyId));
  return homeCodeFromList(rows, settings?.currency);
}

/**
 * The currency list's base row only (null while the list has none) - for "is a home currency set
 * up in the list" questions, never for deciding whether a code is foreign (use homeCode).
 */
export async function listBaseCode(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<string | null> {
  const [row] = await ctx.db
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isBase, true)));
  return row?.code ?? null;
}

export async function listRate(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  code: string,
): Promise<Decimal | null> {
  const [row] = await ctx.db
    .select({ rate: currencies.rateToBase })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, code)));
  if (!row) return null;
  const r = Money.of(row.rate);
  return r.greaterThan(0) ? r : null;
}

function lineHome(l: ForeignLineInput): Decimal {
  const d = Money.round2(l.debit);
  return d.greaterThan(0) ? d : Money.round2(l.credit);
}

/**
 * Foreign-currency columns for each line of an entry (same order as `lines`). `accountCurrency`
 * maps account id → that account's stored currency (null = home).
 */
export async function foreignLineColumns(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  input: {
    lines: ReadonlyArray<ForeignLineInput & { accountId: string }>;
    currency?: string | null;
    exchangeRate?: string | number | Decimal | null;
  },
  accountCurrency: ReadonlyMap<string, string | null>,
): Promise<ForeignLineColumns[]> {
  const anyForeignAccount = [...accountCurrency.values()].some((c) => (c ?? '').trim() !== '');
  const anyExplicit = input.lines.some((l) => l.foreignAmount != null && String(l.foreignAmount).trim() !== '');
  if (!anyForeignAccount && !anyExplicit) return input.lines.map(() => NONE);

  const home = await homeCode(ctx);
  const entryCur = foreignCode(input.currency ?? null, home);
  let entryRate: Decimal | null = null;
  if (entryCur && input.exchangeRate != null && String(input.exchangeRate).trim() !== '') {
    entryRate = Money.of(input.exchangeRate);
    if (!entryRate.isFinite() || !entryRate.greaterThan(0)) entryRate = null;
  }
  const rateCache = new Map<string, Decimal | null>();
  async function rateFor(cur: string): Promise<Decimal | null> {
    if (entryCur === cur && entryRate) return entryRate;
    if (!rateCache.has(cur)) rateCache.set(cur, await listRate(ctx, cur));
    return rateCache.get(cur) ?? null;
  }

  const out: ForeignLineColumns[] = [];
  for (const [i, l] of input.lines.entries()) {
    const acctCur = foreignCode(accountCurrency.get(l.accountId) ?? null, home);
    const hasExplicit = l.foreignAmount != null && String(l.foreignAmount).trim() !== '';
    const cur = acctCur ?? (hasExplicit ? entryCur : null);
    if (!cur) {
      out.push(NONE);
      continue;
    }
    const home2 = lineHome(l);
    if (hasExplicit) {
      let fa: Decimal;
      try {
        fa = Money.round2(l.foreignAmount);
      } catch (err) {
        if (err instanceof MoneyParseError) {
          throw new ServiceError('VALIDATION', `Line ${i + 1}: the foreign-currency amount is not a number.`);
        }
        throw err;
      }
      if (!fa.isFinite() || fa.isNegative()) {
        throw new ServiceError('VALIDATION', `Line ${i + 1}: the foreign-currency amount cannot be negative.`);
      }
      const rate = fa.isZero() ? null : (entryCur === cur && entryRate ? entryRate : home2.dividedBy(fa));
      out.push({
        currency: cur,
        foreignAmount: toAmountString(fa),
        exchangeRate: rate ? rate.toFixed(8) : null,
      });
      continue;
    }
    const rate = await rateFor(cur);
    const fa = rate ? Money.round2(home2.dividedBy(rate)) : home2;
    out.push({ currency: cur, foreignAmount: toAmountString(fa), exchangeRate: rate ? rate.toFixed(8) : null });
  }
  return out;
}
