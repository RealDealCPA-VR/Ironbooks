/**
 * Zod schemas for /api/company (Preferences) and /api/company/closing-date.
 * The persisted settings shape is documented in lib/services/company.ts
 * (CompanySettings + COMPANY_SETTINGS_KEYS whitelist).
 */
import { z } from 'zod';
import { zUuid } from './helpers';

const FISCAL_YEAR_END_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** '' clears an optional text setting. */
const zOptionalText = z.string().optional();

/** Legacy built-in terms codes — the Terms list (lib/services/lists) now holds the real entries. */
export const TERMS_OPTIONS = ['due_on_receipt', 'net_15', 'net_30', 'net_60'] as const;
export const PAY_PERIOD_OPTIONS = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export const CUSTOM_FIELD_ENTITIES = ['customer', 'vendor', 'item', 'invoice'] as const;

/** One custom-field definition. QBD caps name fields at 7 per list. */
const customFieldDefSchema = z.object({
  name: z.string().trim().min(1, 'custom field name is required').max(31),
});

export const customFieldsSettingSchema = z.object({
  customer: z.array(customFieldDefSchema).max(7).default([]),
  vendor: z.array(customFieldDefSchema).max(7).default([]),
  item: z.array(customFieldDefSchema).max(7).default([]),
  invoice: z.array(customFieldDefSchema).max(7).default([]),
});
export type CustomFieldsSetting = z.infer<typeof customFieldsSettingSchema>;

/**
 * Every settings key the Preferences dialog may persist. All optional — PATCH
 * sends only the tab being saved. Unknown keys are stripped here AND dropped by
 * the updateCompany whitelist (defense in depth).
 */
export const companySettingsSchema = z.object({
  // Company
  legalName: zOptionalText,
  ein: z
    .union([z.literal(''), z.string().regex(/^\d{2}-?\d{7}$/, 'EIN must look like 12-3456789')])
    .optional(),
  /** Single-line employer address (read by payroll W-2/940 reports). */
  address: zOptionalText,
  addressLine1: zOptionalText,
  addressLine2: zOptionalText,
  city: zOptionalText,
  state: zOptionalText,
  zip: zOptionalText,
  country: zOptionalText,
  phone: zOptionalText,
  email: z.union([z.literal(''), z.string().email('is not a valid email address')]).optional(),
  industry: zOptionalText,
  // Accounting
  currency: z.string().trim().length(3, 'currency must be a 3-letter ISO 4217 code').optional(),
  fiscalYearEnd: z
    .string()
    .regex(FISCAL_YEAR_END_RE, 'fiscalYearEnd must be MM-DD (e.g. 12-31)')
    .optional(),
  timezone: zOptionalText,
  accountNumbersEnabled: z.boolean().optional(),
  reportBasis: z.enum(['accrual', 'cash']).optional(),
  // Sales & Customers
  /** A Terms list entry (id, legacy code such as 'net_30', or name) — see lib/services/lists/terms.ts. */
  defaultCustomerTerms: z.string().trim().min(1).max(100).optional(),
  defaultInvoiceMemo: zOptionalText,
  // Purchases & Vendors
  defaultVendorTerms: z.string().trim().min(1).max(100).optional(),
  defaultExpenseAccountId: zUuid.nullable().optional(),
  // Payroll
  payrollPayPeriod: z.enum(PAY_PERIOD_OPTIONS).optional(),
  payrollStandardHours: z.number().positive().max(168).optional(),
  payrollExpenseAccountId: zUuid.nullable().optional(),
  payrollLiabilityAccountId: zUuid.nullable().optional(),
  // Inventory
  negativeStockWarning: z.boolean().optional(),
  // Custom fields (shape read by custom-field consumers: settings.customFields)
  customFields: customFieldsSettingSchema.optional(),
});
export type CompanySettingsBody = z.infer<typeof companySettingsSchema>;

/**
 * PATCH /api/company body. Accepts the new `{ name?, settings? }` shape and,
 * for backwards compatibility (onboarding wizard), the legacy flat keys
 * currency/fiscalYearEnd/timezone/industry at the top level.
 */
export const updateCompanyBodySchema = companySettingsSchema
  .pick({ currency: true, fiscalYearEnd: true, timezone: true, industry: true })
  .extend({
    name: z.string().trim().min(1, 'name must be a non-empty string').optional(),
    settings: companySettingsSchema.optional(),
  });
export type UpdateCompanyBody = z.infer<typeof updateCompanyBodySchema>;

/** PATCH /api/company/closing-date body. */
export const setClosingDateSchema = z.object({
  closingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "closingDate must be 'YYYY-MM-DD' or null")
    .nullable(),
  password: z.string().nullish(),
});
export type SetClosingDateBody = z.infer<typeof setClosingDateSchema>;
