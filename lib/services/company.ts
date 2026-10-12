/**
 * Company service — create/open company files and seed a default Chart of Accounts.
 * A "company file" maps to a PGlite data directory (see lib/db). For now we operate on the
 * active database; multi-file management is layered on in the Electron shell.
 */
import { and, eq } from 'drizzle-orm';
import { accounts, companies, users, userCompanies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { notFound, validation, writeAudit } from './_base';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { assertWrite } from './rbac';
import { requireEffectivePermission } from './access';
import type { DB } from '@/lib/db';
import { logTransaction } from './transactionLog';
import { assertPreferenceAccounts } from './prefAccounts';
import {
  COMPANY_PREFERENCE_KEYS,
  resolveCompanyPreferences,
  type CompanyPreferences,
} from '@/lib/preferences';

type AccountSeed = { code: string; name: string; type: string; subtype: string };

/** A sensible general-business default Chart of Accounts. */
export const DEFAULT_COA: AccountSeed[] = [
  { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
  { code: '1010', name: 'Savings', type: 'asset', subtype: 'savings' },
  { code: '1050', name: 'Undeposited Funds', type: 'asset', subtype: 'undeposited_funds' },
  { code: '1200', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
  { code: '1250', name: 'Retainage Receivable', type: 'asset', subtype: 'other_current_asset' },
  { code: '1300', name: 'Inventory Asset', type: 'asset', subtype: 'inventory' },
  { code: '1500', name: 'Fixed Assets', type: 'asset', subtype: 'fixed_assets' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable' },
  { code: '2100', name: 'Credit Card', type: 'liability', subtype: 'credit_card' },
  { code: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'other_current_liability' },
  { code: '2300', name: 'Payroll Liabilities', type: 'liability', subtype: 'other_current_liability' },
  { code: '3000', name: "Owner's Equity", type: 'equity', subtype: 'owners_equity' },
  { code: '3900', name: 'Retained Earnings', type: 'equity', subtype: 'retained_earnings' },
  { code: '4000', name: 'Sales Income', type: 'revenue', subtype: 'sales' },
  { code: '4100', name: 'Service Income', type: 'revenue', subtype: 'service_revenue' },
  { code: '4900', name: 'Other Income', type: 'revenue', subtype: 'other_income' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cost_of_goods_sold' },
  { code: '6000', name: 'Advertising & Marketing', type: 'expense', subtype: 'operating_expenses' },
  { code: '6100', name: 'Bank & Merchant Fees', type: 'expense', subtype: 'operating_expenses' },
  { code: '6200', name: 'Insurance', type: 'expense', subtype: 'operating_expenses' },
  { code: '6300', name: 'Office Supplies', type: 'expense', subtype: 'operating_expenses' },
  { code: '6400', name: 'Rent', type: 'expense', subtype: 'operating_expenses' },
  { code: '6500', name: 'Payroll Expense', type: 'expense', subtype: 'payroll' },
  { code: '6600', name: 'Utilities', type: 'expense', subtype: 'operating_expenses' },
  { code: '6700', name: 'Taxes & Licenses', type: 'expense', subtype: 'taxes' },
];

export async function listCompanies(db: DB) {
  return db.select().from(companies);
}

/**
 * Companies the given user is an ACTIVE member of (via user_companies). Used by the API layer so
 * an authenticated caller only ever sees their own company files — never other tenants' rows,
 * nor companies they were deactivated in (Users & Roles).
 * Pass excludeArchived to hide soft-deleted files (settings.archived === true).
 */
export async function listCompaniesForUser(
  db: DB,
  userId: string,
  opts?: { excludeArchived?: boolean },
) {
  const rows = await db
    .select({ company: companies })
    .from(companies)
    .innerJoin(userCompanies, eq(userCompanies.companyId, companies.id))
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.isActive, true)));
  const list = rows.map((r) => r.company);
  if (!opts?.excludeArchived) return list;
  return list.filter(
    (c) => (c.settings as Record<string, unknown> | null)?.archived !== true,
  );
}

export async function createCompany(
  db: DB,
  input: { name: string; ownerId: string; seedCoa?: boolean },
) {
  const [company] = await db
    .insert(companies)
    .values({ name: input.name, ownerId: input.ownerId })
    .returning();

  await db
    .insert(userCompanies)
    .values({ userId: input.ownerId, companyId: company.id, role: 'owner' });

  if (input.seedCoa !== false) {
    await db.insert(accounts).values(
      DEFAULT_COA.map((a) => ({
        companyId: company.id,
        code: a.code,
        name: a.name,
        type: a.type as never,
        subtype: a.subtype as never,
      })),
    );
  }
  // Running transaction log: company creation + owner permission (+ seeded chart of accounts).
  await logTransaction(db, {
    companyId: company.id,
    userId: input.ownerId,
    action: 'create',
    entityType: 'company',
    entityId: company.id,
    summary:
      `Created company "${company.name}"` +
      (input.seedCoa !== false ? ` with the default chart of accounts (${DEFAULT_COA.length} accounts)` : ''),
    data: { new: { name: company.name, seededAccounts: input.seedCoa !== false ? DEFAULT_COA.length : 0 } },
  });
  await logTransaction(db, {
    companyId: company.id,
    userId: input.ownerId,
    action: 'create',
    entityType: 'user_company',
    entityId: input.ownerId,
    summary: `Gave the company owner full ('owner') access to "${company.name}"`,
    data: { new: { role: 'owner' } },
  });
  return company;
}

/**
 * Dev/first-run helper: ensure there is at least one user + company so the UI has a context.
 * In production this is replaced by the onboarding wizard + auth.
 */
export async function ensureDevCompany(db: DB): Promise<{ companyId: string; userId: string }> {
  const [existingCompany] = await db.select().from(companies).limit(1);
  if (existingCompany) {
    const [owner] = await db.select().from(users).where(eq(users.id, existingCompany.ownerId));
    return { companyId: existingCompany.id, userId: owner?.id ?? existingCompany.ownerId };
  }
  const [user] = await db
    .insert(users)
    .values({ email: 'demo@bookkeeper.local', name: 'Demo User', passwordHash: 'dev' })
    .returning();
  await logTransaction(db, {
    userId: user.id,
    action: 'create',
    entityType: 'user',
    entityId: user.id,
    summary: 'Created the first-run user "Demo User"',
    data: { new: { name: user.name, email: user.email } },
  });
  const company = await createCompany(db, { name: 'Demo Company', ownerId: user.id });
  return { companyId: company.id, userId: user.id };
}

export async function getCompany(ctx: ServiceContext) {
  const [row] = await ctx.db.select().from(companies).where(eq(companies.id, ctx.companyId));
  return row ?? null;
}

/** One custom-field definition (settings.customFields.<entity>[]). */
export interface CustomFieldDef {
  name: string;
}

/**
 * Typed view of companies.settings — every key the Preferences dialog persists.
 * Keys actually read by services today: fiscalYearEnd (fiscalClose, dashboard),
 * currency/timezone (display), closingDate + closingDatePasswordHash (managed
 * ONLY via setClosingDate, never updateCompany), financeCharges (managed by the
 * finance-charges service). The remaining keys are Preferences defaults that
 * apply to NEW documents (advisory until their consumers land).
 */
export interface CompanySettings {
  // Company info
  legalName?: string;
  ein?: string;
  /**
   * Single-line employer address — read TODAY by payrollReports (W-2/940
   * employer block). The Preferences dialog composes it from the structured
   * addressLine1/city/state/zip fields on save.
   */
  address?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  email?: string;
  industry?: string;
  // Accounting
  fiscalYearEnd?: string;
  currency?: string;
  timezone?: string;
  accountNumbersEnabled?: boolean;
  reportBasis?: 'accrual' | 'cash';
  // Sales & Customers
  defaultCustomerTerms?: string;
  defaultInvoiceMemo?: string;
  // Purchases & Vendors
  defaultVendorTerms?: string;
  defaultExpenseAccountId?: string | null;
  // Payroll
  payrollPayPeriod?: string;
  payrollStandardHours?: number;
  payrollExpenseAccountId?: string | null;
  payrollLiabilityAccountId?: string | null;
  // Inventory
  negativeStockWarning?: boolean;
  // Custom field definitions per entity list
  customFields?: {
    customer?: CustomFieldDef[];
    vendor?: CustomFieldDef[];
    item?: CustomFieldDef[];
    invoice?: CustomFieldDef[];
  };
}

/**
 * Whitelist of settings keys updateCompany will merge. Anything else in the
 * patch is silently dropped — in particular closingDate/closingDatePasswordHash
 * (only setClosingDate may touch those) and financeCharges (finance-charges
 * service owns that subtree).
 */
export const COMPANY_SETTINGS_KEYS = [
  'legalName',
  'ein',
  'address',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'zip',
  'country',
  'phone',
  'email',
  'industry',
  'fiscalYearEnd',
  'currency',
  'timezone',
  'accountNumbersEnabled',
  'reportBasis',
  'defaultCustomerTerms',
  'defaultInvoiceMemo',
  'defaultVendorTerms',
  'defaultExpenseAccountId',
  'payrollPayPeriod',
  'payrollStandardHours',
  'payrollExpenseAccountId',
  'payrollLiabilityAccountId',
  'negativeStockWarning',
  'customFields',
] as const satisfies readonly (keyof CompanySettings)[];

/**
 * wave2 prefs: every categorized Preferences key (lib/preferences.ts) is also whitelisted, so the
 * full QB Preferences dialog (Accounting, Checking, Jobs & Estimates, Items & Inventory,
 * Payments, Reminders, Reports, Sales Tax, Send Forms, Time & Expenses, Multiple Currencies…)
 * persists through updateCompany. Values are validated by lib/validation/company.ts.
 */
const SETTINGS_KEY_SET = new Set<string>([...COMPANY_SETTINGS_KEYS, ...COMPANY_PREFERENCE_KEYS]);

/**
 * Resolved company preferences (stored overrides + defaults) — the one call consumers use to
 * honor Preferences (forms, reports, services). See lib/preferences.ts for the catalogue.
 */
export async function getPreferences(ctx: ServiceContext): Promise<CompanyPreferences> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  return resolveCompanyPreferences(row?.settings ?? {});
}

export interface UpdateCompanyInput {
  name?: string;
  settings?: CompanySettings & { [key: string]: unknown };
}

/**
 * Update the active company's name and/or settings JSONB (shallow-merged).
 * Settings keys outside COMPANY_SETTINGS_KEYS are dropped (closing-date and
 * finance-charge keys have dedicated services). Scoped to ctx.companyId.
 * Writes an audit log row and returns the updated row.
 */
export async function updateCompany(ctx: ServiceContext, input: UpdateCompanyInput) {
  assertWrite(ctx); // early viewer block (writeAudit re-checks centrally)
  const existing = await getCompany(ctx);
  if (!existing) throw notFound('company');

  const settingsPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.settings ?? {})) {
    if (SETTINGS_KEY_SET.has(key) && value !== undefined) settingsPatch[key] = value;
  }
  // Account-valued preferences must name the right kind of account (a paycheck account that is
  // A/R or a wages account that is A/P would break the subledger == control-account rule).
  await assertPreferenceAccounts(ctx, settingsPatch);

  const mergedSettings = {
    ...(existing.settings ?? {}),
    ...settingsPatch,
  };

  const [updated] = await ctx.db
    .update(companies)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      settings: mergedSettings,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, ctx.companyId))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { name: existing.name, settings: existing.settings },
    newValues: { name: updated.name, settings: updated.settings },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Closing date (QB "Set Closing Date" + closing-date password) — books protection.
// Stored in companies.settings as { closingDate: 'YYYY-MM-DD', closingDatePasswordHash }.
// assertPeriodOpen (lib/services/fiscalPeriods.ts) blocks postings dated on/before the
// closing date unless ctx.closingDateOverride is set (x-closing-password header verified
// by getServerContext against the hash).
// ---------------------------------------------------------------------------

export interface ClosingDateSettings {
  /** 'YYYY-MM-DD' or null when no closing date is set. */
  closingDate: string | null;
  /** Whether a closing-date password is configured. The hash itself is never returned. */
  hasPassword: boolean;
}

export async function getClosingDateSettings(ctx: ServiceContext): Promise<ClosingDateSettings> {
  const company = await getCompany(ctx);
  if (!company) throw notFound('company');
  const s = (company.settings ?? {}) as Record<string, unknown>;
  return {
    closingDate: typeof s.closingDate === 'string' ? s.closingDate : null,
    hasPassword: Boolean(s.closingDatePasswordHash),
  };
}

export interface SetClosingDateInput {
  /** 'YYYY-MM-DD' to set, or null to clear the closing date (also clears the password). */
  closingDate: string | null;
  /**
   * Closing-date password: a string sets/replaces it, null/'' removes it,
   * undefined keeps the existing one.
   */
  password?: string | null;
}

/** Set or clear the company closing date + optional password. Admin/owner only. */
export async function setClosingDate(
  ctx: ServiceContext,
  input: SetClosingDateInput,
): Promise<ClosingDateSettings> {
  // Enterprise roles: Closing Date / Periods — modify (Admin, Accountant, External Accountant,
  // custom roles), same rule as the route map for PATCH /api/company/closing-date.
  await requireEffectivePermission(ctx, 'closing', 'modify');
  const existing = await getCompany(ctx);
  if (!existing) throw notFound('company');

  if (input.closingDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.closingDate)) {
    throw validation('closingDate must be in YYYY-MM-DD format (or null to clear).');
  }

  const settings = { ...((existing.settings ?? {}) as Record<string, unknown>) };
  const before: ClosingDateSettings = {
    closingDate: typeof settings.closingDate === 'string' ? (settings.closingDate as string) : null,
    hasPassword: Boolean(settings.closingDatePasswordHash),
  };

  if (input.closingDate === null) {
    delete settings.closingDate;
    delete settings.closingDatePasswordHash;
  } else {
    settings.closingDate = input.closingDate;
    if (input.password === null || input.password === '') {
      delete settings.closingDatePasswordHash;
    } else if (typeof input.password === 'string') {
      settings.closingDatePasswordHash = await hashPassword(input.password);
    }
  }

  const [updated] = await ctx.db
    .update(companies)
    .set({ settings, updatedAt: new Date() })
    .where(eq(companies.id, ctx.companyId))
    .returning();

  const after: ClosingDateSettings = {
    closingDate: typeof updated.settings?.closingDate === 'string' ? updated.settings.closingDate : null,
    hasPassword: Boolean(updated.settings?.closingDatePasswordHash),
  };

  // Audit without ever logging the hash.
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { closingDate: before.closingDate, hasPassword: before.hasPassword },
    newValues: { closingDate: after.closingDate, hasPassword: after.hasPassword },
  });

  return after;
}

/**
 * Verify a request-supplied closing-date password. Used by getServerContext to set
 * ctx.closingDateOverride from the x-closing-password header.
 * When no password is configured, any explicit override attempt succeeds (QB's
 * warn-and-continue behavior when the closing date has no password).
 */
export async function verifyClosingDatePassword(
  db: DB,
  companyId: string,
  password: string,
): Promise<boolean> {
  const [row] = await db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  const hash = (row?.settings as Record<string, unknown> | null)?.closingDatePasswordHash;
  if (typeof hash !== 'string' || !hash) return true;
  return verifyPassword(password, hash);
}
