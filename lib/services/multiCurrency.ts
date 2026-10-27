/**
 * Multiple Currencies preference (QB Edit > Preferences > Multiple Currencies) — A2.
 *
 *  - `multiCurrencyEnabled` lives in companies.settings like every company preference. New
 *    company files store an explicit `false` (off by default); migration 0056 stored `true` for
 *    every existing company that already had foreign-currency data (or foreign currencies in its
 *    list) and `false` for the others.
 *  - A company whose settings have no value at all (a file created by an older build and not yet
 *    migrated, or a test fixture) is treated as "on" exactly when it already has foreign-currency
 *    data or currencies — the same rule the migration applies — and is never refused.
 *  - While it is OFF (explicit false): currency fields and the Currencies screen are hidden, and
 *    every save that would use a foreign currency is refused with a plain message
 *    (assertForeignCurrencyAllowed, called from the currency choke points: the currency list,
 *    account / vendor currency, Receive Payments, purchase documents, invoices, and every
 *    `currencyRate` lookup).
 *  - The QB lock: once it is on and foreign-currency data exists, it can't be turned off
 *    (assertMultiCurrencyChangeAllowed, called by updateCompany).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { companies, currencies } from '@/lib/db/schema';
import type { DB } from '@/lib/db';
import { Money } from '@/lib/money';
import { ServiceError, validation, type ServiceContext } from './_base';
import { homeCode, homeCodeFromList, type CurrencyListRow } from './fxLines';

type Settings = Record<string, unknown> | null | undefined;

/** Plain message for a foreign-currency save while Multiple Currencies is off. */
export function multiCurrencyOffMessage(code: string): string {
  return `Multiple currencies is turned off for this company, so ${code} can't be used. An administrator can turn it on in Settings > Preferences > Multiple Currencies ("I use more than one currency").`;
}

export const MULTI_CURRENCY_LOCKED_MESSAGE =
  'Multiple currencies can no longer be turned off: this company already has foreign-currency accounts, names or transactions (QuickBooks works the same way).';

async function settingsOf(db: DB, companyId: string): Promise<Settings> {
  const [row] = await db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  return (row?.settings ?? {}) as Settings;
}

function listRowsOf(db: DB, companyId: string): Promise<CurrencyListRow[]> {
  return db
    .select({ code: currencies.code, rateToBase: currencies.rateToBase, isBase: currencies.isBase })
    .from(currencies)
    .where(eq(currencies.companyId, companyId));
}

/** The company's home currency code with these settings (fxLines.homeCodeFromList). */
async function homeCodeOf(db: DB, companyId: string, settings: Settings): Promise<string | null> {
  return homeCodeFromList(await listRowsOf(db, companyId), settings?.currency);
}

/**
 * review5 fx: the company's home currency code even before a currency list exists (the currency
 * list's base, else the Preferences currency, else USD) — so the home code typed on a document
 * (any case) is never taken for a foreign currency in a company that never set up currencies.
 * Null when a list without a base row holds that default as a foreign currency (homeCodeFromList):
 * every code is then foreign, as the list's rates say. The same code as fxLines.homeCode, which
 * the ledger (posting, registers, revaluation) uses, so documents and accounts always agree.
 */
export async function effectiveHomeCurrency(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<string | null> {
  return homeCode(ctx);
}

/**
 * True when the company has foreign-currency DATA: a bank / credit-card account or vendor in a
 * foreign currency, or any transaction (invoice, payment, bill, bill payment, check, transfer,
 * vendor credit, deposit, loan, journal line) recorded in one.
 */
export async function hasForeignCurrencyData(db: DB, companyId: string, settings?: Settings): Promise<boolean> {
  const home = await homeCodeOf(db, companyId, settings ?? (await settingsOf(db, companyId)));
  return hasCurrencyDataOtherThan(db, companyId, home);
}

/**
 * True when an account, vendor or transaction is recorded in a currency other than `home` (any
 * currency at all when `home` is null).
 */
function hasCurrencyDataOtherThan(db: DB, companyId: string, home: string | null): Promise<boolean> {
  return currencyDataExists(db, companyId, (col) => sql`upper(btrim(${sql.raw(col)})) <> ${home ?? ''}`);
}

/** True when an account, vendor or transaction is recorded in exactly the currency `code`. */
function hasCurrencyDataIn(db: DB, companyId: string, code: string): Promise<boolean> {
  return currencyDataExists(db, companyId, (col) => sql`upper(btrim(${sql.raw(col)})) = ${code}`);
}

async function currencyDataExists(db: DB, companyId: string, test: (col: string) => SQL): Promise<boolean> {
  const foreign = (table: string) =>
    sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} t WHERE t.company_id = ${companyId} AND t.currency IS NOT NULL AND btrim(t.currency) <> '' AND ${test('t.currency')})`;
  const tables = [
    'accounts',
    'vendors',
    'invoices',
    'payments_received',
    'bills',
    'bill_payments',
    'expenses',
    'transfers',
    'vendor_credits',
    'deposits',
    'loans',
  ];
  const checks = [
    ...tables.map(foreign),
    sql`EXISTS (SELECT 1 FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = ${companyId} AND l.currency IS NOT NULL AND btrim(l.currency) <> '' AND ${test('l.currency')})`,
  ];
  const res = await db.execute(sql`SELECT (${sql.join(checks, sql` OR `)}) AS found`);
  const row = (res.rows as Array<{ found: boolean }>)[0];
  return Boolean(row?.found);
}

export const HOME_CURRENCY_LOCKED_MESSAGE = (home: string) =>
  `Your home currency is ${home}. This company already has foreign-currency accounts, names or transactions, so the home currency can no longer be changed (QuickBooks works the same way).`;

/** No base row: one of the currency list's foreign currencies can't become the home currency. */
export const LISTED_FOREIGN_HOME_LOCKED_MESSAGE = (code: string, rate: string | number) =>
  `${code} is a foreign currency in your currency list (exchange rate ${Money.of(rate).toString()}), and this company already has foreign-currency accounts, names or transactions, so ${code} can no longer become the home currency (QuickBooks works the same way). Set the currency your books are kept in as the home currency instead.`;

/**
 * review5 fx: with no base row the home currency also depends on the list's RATES - the Preferences
 * / USD default is the home currency unless the list holds it at a rate other than 1
 * (homeCodeFromList). So writing a rate could change the home currency without "Set as home
 * currency": USD listed at 1.30 and re-saved at 1 became the home currency (its documents, booked
 * at 1.30, silently home ones - and "Set as home currency" then passed as "no change"); USD listed
 * at 1 and saved at 1.30 stops being it. Every write of list rates (the Currencies page, a Home
 * Currency Adjustment that updates the list) calls this first, in its transaction: a write that
 * would change the home currency is refused like any other home-currency change once data carries
 * a currency. `changes` are the rates about to be written for non-base codes.
 */
export async function assertListRatesKeepHomeCurrency(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  changes: ReadonlyArray<{ code: string; rate: string | number | { toString(): string } }>,
): Promise<void> {
  if (changes.length === 0) return;
  const rows = await listRowsOf(ctx.db, ctx.companyId);
  if (rows.some((r) => r.isBase)) return; // the base row is the home currency whatever the rates
  const settings = await settingsOf(ctx.db, ctx.companyId);
  const before = homeCodeFromList(rows, settings?.currency);
  const next = rows.map((r) => ({ ...r }));
  for (const c of changes) {
    const code = c.code.trim().toUpperCase();
    const row = next.find((r) => r.code.trim().toUpperCase() === code);
    if (row) row.rateToBase = String(c.rate);
    else next.push({ code, rateToBase: String(c.rate), isBase: false });
  }
  const after = homeCodeFromList(next, settings?.currency);
  if (before === after) return;
  // Nothing recorded in any currency yet: nothing would be re-denominated.
  if (
    !(await hasCurrencyDataOtherThan(ctx.db, ctx.companyId, before)) &&
    !(await hasCurrencyDataOtherThan(ctx.db, ctx.companyId, after))
  ) {
    return;
  }
  const locked = (message: string) => new ServiceError('CONFLICT', message, { homeCurrencyLocked: true });
  if (before !== null) throw locked(HOME_CURRENCY_LOCKED_MESSAGE(before));
  const listed = rows.find((r) => r.code.trim().toUpperCase() === after)!;
  throw locked(LISTED_FOREIGN_HOME_LOCKED_MESSAGE(after!, listed.rateToBase));
}

/**
 * review5 fx: the home currency is the unit of the whole ledger. Changing it from the current one
 * (the currency list's base, else the Preferences currency, else USD — so a list with no base row,
 * as migration 0056 left older files, is no way around it) is refused once any account, name or
 * transaction carries a currency: a document in the new currency would silently become a home one,
 * and one tagged with the old home code a foreign one, so aging would stop agreeing with the GL.
 * Returns true when `next` is a change (the caller then rebases the currency list).
 */
export async function assertHomeCurrencyChangeAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  next: string,
): Promise<boolean> {
  const current = await effectiveHomeCurrency(ctx);
  const code = next.trim().toUpperCase();
  const locked = (message: string) => new ServiceError('CONFLICT', message, { homeCurrencyLocked: true });
  if (current !== null) {
    if (code === current) return false;
    if (
      (await hasCurrencyDataOtherThan(ctx.db, ctx.companyId, current)) ||
      (await hasCurrencyDataOtherThan(ctx.db, ctx.companyId, code))
    ) {
      throw locked(HOME_CURRENCY_LOCKED_MESSAGE(current));
    }
    return true;
  }
  // No base row, and the list holds the Preferences / USD default as a foreign currency: its rates
  // are in units of a home currency the file never recorded (homeCodeOf).
  const [row] = await ctx.db
    .select({ rateToBase: currencies.rateToBase })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, code), eq(currencies.isBase, false)));
  if (row && !Money.of(row.rateToBase).equals(1)) {
    // One of the list's foreign currencies: making it the home currency is a change (the list is
    // rebased onto it), refused like any other once data carries a currency - its documents were
    // booked at their rates and would silently become home ones.
    if (await hasCurrencyDataOtherThan(ctx.db, ctx.companyId, null)) {
      throw locked(LISTED_FOREIGN_HOME_LOCKED_MESSAGE(code, row.rateToBase));
    }
    return true;
  }
  // Any other code names the currency the list's rates are already in: no rebase. Refused only when
  // data was recorded in that code as a foreign currency (it would silently become home data).
  if (await hasCurrencyDataIn(ctx.db, ctx.companyId, code)) {
    throw locked(
      `This company already has accounts, names or transactions in ${code} as a foreign currency, so ${code} can no longer become the home currency (QuickBooks works the same way).`,
    );
  }
  return false;
}

/**
 * updateCompany hook (review5 fx): while the currency list has no base row, the Preferences
 * currency IS the home currency, so changing it is a home-currency change (see above).
 */
export async function assertPreferenceCurrencyChangeAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  next: unknown,
): Promise<void> {
  const [base] = await ctx.db
    .select({ id: currencies.id })
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isBase, true)));
  if (base) return; // the list's base is the home currency; the Preferences value is display only
  const raw = typeof next === 'string' ? next : '';
  await assertHomeCurrencyChangeAllowed(ctx, raw.trim() || 'USD');
}

/** Foreign-currency data, or foreign currencies set up in the currency list. */
async function hasForeignCurrencySetup(db: DB, companyId: string, settings: Settings): Promise<boolean> {
  const [cur] = await db
    .select({ id: currencies.id })
    .from(currencies)
    .where(and(eq(currencies.companyId, companyId), eq(currencies.isBase, false)))
    .limit(1);
  if (cur) return true;
  return hasForeignCurrencyData(db, companyId, settings);
}

/** The effective "Use multiple currencies" value for a company (see the module comment). */
export async function resolveMultiCurrency(db: DB, companyId: string, settings: Settings): Promise<boolean> {
  const stored = settings?.multiCurrencyEnabled;
  if (typeof stored === 'boolean') return stored;
  return hasForeignCurrencySetup(db, companyId, settings);
}

export interface MultiCurrencyStatus {
  enabled: boolean;
  /** Foreign-currency accounts, names or transactions exist. */
  hasForeignData: boolean;
  /** On and foreign data exists: it can't be turned off. */
  locked: boolean;
}

export async function getMultiCurrencyStatus(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<MultiCurrencyStatus> {
  const settings = await settingsOf(ctx.db, ctx.companyId);
  const enabled = await resolveMultiCurrency(ctx.db, ctx.companyId, settings);
  const hasForeignData = await hasForeignCurrencyData(ctx.db, ctx.companyId, settings);
  return { enabled, hasForeignData, locked: enabled && hasForeignData };
}

/**
 * Refuse a save that uses the FOREIGN currency `code` (already normalised; null / home = no-op)
 * while Multiple Currencies is turned off for the company.
 */
export async function assertForeignCurrencyAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  code: string | null | undefined,
): Promise<void> {
  const cur = (code ?? '').trim().toUpperCase();
  if (!cur) return;
  const settings = await settingsOf(ctx.db, ctx.companyId);
  if (settings?.multiCurrencyEnabled !== false) return;
  if (cur === (await homeCodeOf(ctx.db, ctx.companyId, settings))) return;
  throw validation(multiCurrencyOffMessage(cur));
}

/**
 * updateCompany hook: the QB lock (on + foreign data -> can't turn off). Returns true when the
 * switch is being turned ON (the caller then makes sure a home currency exists).
 */
export async function assertMultiCurrencyChangeAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  current: Settings,
  next: unknown,
): Promise<'on' | 'off' | null> {
  if (typeof next !== 'boolean') return null;
  const wasOn = await resolveMultiCurrency(ctx.db, ctx.companyId, current);
  if (next === wasOn && typeof current?.multiCurrencyEnabled === 'boolean') return null;
  if (!next && (await hasForeignCurrencyData(ctx.db, ctx.companyId, current))) {
    throw new ServiceError('CONFLICT', MULTI_CURRENCY_LOCKED_MESSAGE, { multiCurrencyLocked: true });
  }
  return next ? 'on' : 'off';
}
