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
import { and, eq, sql } from 'drizzle-orm';
import { companies, currencies } from '@/lib/db/schema';
import type { DB } from '@/lib/db';
import { ServiceError, validation, type ServiceContext } from './_base';

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

/** The company's home currency code (currency list base, else Preferences currency, else USD). */
async function homeCodeOf(db: DB, companyId: string, settings: Settings): Promise<string> {
  const [base] = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.companyId, companyId), eq(currencies.isBase, true)));
  const fromSettings = typeof settings?.currency === 'string' ? settings.currency : '';
  return (base?.code || fromSettings || 'USD').trim().toUpperCase();
}

/**
 * review5 fx: the company's home currency code even before a currency list exists (the currency
 * list's base, else the Preferences currency, else USD) — so the home code typed on a document
 * (any case) is never taken for a foreign currency in a company that never set up currencies.
 */
export async function effectiveHomeCurrency(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<string> {
  return homeCodeOf(ctx.db, ctx.companyId, await settingsOf(ctx.db, ctx.companyId));
}

/**
 * True when the company has foreign-currency DATA: a bank / credit-card account or vendor in a
 * foreign currency, or any transaction (invoice, payment, bill, bill payment, check, transfer,
 * vendor credit, deposit, loan, journal line) recorded in one.
 */
export async function hasForeignCurrencyData(db: DB, companyId: string, settings?: Settings): Promise<boolean> {
  const home = await homeCodeOf(db, companyId, settings ?? (await settingsOf(db, companyId)));
  const foreign = (table: string) =>
    sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} t WHERE t.company_id = ${companyId} AND t.currency IS NOT NULL AND btrim(t.currency) <> '' AND upper(btrim(t.currency)) <> ${home})`;
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
    sql`EXISTS (SELECT 1 FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = ${companyId} AND l.currency IS NOT NULL AND btrim(l.currency) <> '' AND upper(btrim(l.currency)) <> ${home})`,
  ];
  const res = await db.execute(sql`SELECT (${sql.join(checks, sql` OR `)}) AS found`);
  const row = (res.rows as Array<{ found: boolean }>)[0];
  return Boolean(row?.found);
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
