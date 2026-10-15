/**
 * EasyStep-style setup interview (app/onboarding/page.tsx) — the pure part.
 *
 * The interview asks plain-language questions (company contact details, what kind of business,
 * how it is organized for taxes, when the fiscal and tax years start, the date to start tracking,
 * and yes/no questions for each feature) and this module turns the answers into a setup plan:
 *   - `settings`: company settings / Preferences to save. Every feature question maps to its
 *     on/off preference (inventoryEnabled, salesTaxEnabled, estimatesEnabled, ...), so answering
 *     "No" really turns the feature off (menus hidden, pages and saves blocked — see
 *     FEATURE_GATES in lib/preferences.ts). A feature that is not asked about is left untouched.
 *   - `interview`: interview-only facts kept in companies.settings (entity type, tax-year start,
 *     start date);
 *   - `taxForm`: the income-tax form the entity type files (drives tax-line mapping);
 *   - `accounts`: industry + entity-type (equity) accounts added on top of the default chart that
 *     createCompany seeds, each with its tax line when one fits;
 *   - `summary`: plain-language rows built FROM the values being saved, so the summary can't
 *     disagree with what is saved;
 *   - `nextSteps`: links for the "what now?" checklist on the finish screen.
 *
 * lib/services/setupInterview.ts applies the plan in one transaction.
 */
import { getTaxLine, type IncomeTaxForm } from '@/lib/taxLines';

export type BusinessType =
  | 'service'
  | 'professional'
  | 'retail'
  | 'product'
  | 'construction'
  | 'restaurant'
  | 'nonprofit'
  | 'general';

export interface AccountTemplate {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
}

export interface BusinessTypeOption {
  value: BusinessType;
  label: string;
  /** Plain-language "pick this if…" text. */
  description: string;
  /** Value stored in settings.industry. */
  industry: string;
  /** Payment terms new customers get by default. */
  customerTerms: 'due_on_receipt' | 'net_15' | 'net_30';
  /** Whether this kind of business usually tracks inventory (pre-ticks the question). */
  suggestsInventory: boolean;
  accounts: AccountTemplate[];
}

export const BUSINESS_TYPES: BusinessTypeOption[] = [
  {
    value: 'service',
    label: 'Services',
    description: 'You do work for customers — cleaning, repairs, design, lawn care, coaching.',
    industry: 'services',
    customerTerms: 'net_15',
    suggestsInventory: false,
    accounts: [
      { code: '4110', name: 'Labor Income', type: 'revenue', subtype: 'service_revenue' },
      { code: '5100', name: 'Supplies & Materials', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '6810', name: 'Vehicle Expenses', type: 'expense', subtype: 'operating_expenses' },
      { code: '6820', name: 'Tools & Equipment', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'professional',
    label: 'Professional / consulting',
    description: 'You sell expertise — accounting, legal, IT, marketing, consulting.',
    industry: 'professional_services',
    customerTerms: 'net_30',
    suggestsInventory: false,
    accounts: [
      { code: '4120', name: 'Consulting Income', type: 'revenue', subtype: 'service_revenue' },
      { code: '4130', name: 'Reimbursed Expenses Income', type: 'revenue', subtype: 'other_income' },
      { code: '6830', name: 'Professional Development', type: 'expense', subtype: 'operating_expenses' },
      { code: '6840', name: 'Software & Subscriptions', type: 'expense', subtype: 'operating_expenses' },
      { code: '6850', name: 'Professional Fees', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'retail',
    label: 'Retail shop',
    description: 'You sell products to the public in a store or online.',
    industry: 'retail',
    customerTerms: 'due_on_receipt',
    suggestsInventory: true,
    accounts: [
      { code: '4010', name: 'Merchandise Sales', type: 'revenue', subtype: 'sales' },
      { code: '4020', name: 'Shipping Income', type: 'revenue', subtype: 'sales' },
      { code: '5010', name: 'Merchandise Purchases', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5020', name: 'Freight In', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '6110', name: 'Merchant Account Fees', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'product',
    label: 'Manufacturing / wholesale',
    description: 'You make or distribute products and sell them to other businesses.',
    industry: 'manufacturing',
    customerTerms: 'net_30',
    suggestsInventory: true,
    accounts: [
      { code: '4030', name: 'Product Sales', type: 'revenue', subtype: 'sales' },
      { code: '5030', name: 'Raw Materials', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5040', name: 'Direct Labor', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5020', name: 'Freight In', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '6860', name: 'Equipment Repairs', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'construction',
    label: 'Construction / contractor',
    description: 'You build, renovate or install — general contractors and trades.',
    industry: 'construction',
    customerTerms: 'net_30',
    suggestsInventory: false,
    accounts: [
      { code: '4140', name: 'Construction Income', type: 'revenue', subtype: 'service_revenue' },
      { code: '5050', name: 'Job Materials', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5060', name: 'Subcontractors', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5070', name: 'Equipment Rental', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '6870', name: 'Permits & Licenses', type: 'expense', subtype: 'taxes' },
    ],
  },
  {
    value: 'restaurant',
    label: 'Restaurant / food service',
    description: 'You serve food or drinks — restaurants, cafes, bars, caterers.',
    industry: 'hospitality',
    customerTerms: 'due_on_receipt',
    suggestsInventory: false,
    accounts: [
      { code: '4040', name: 'Food Sales', type: 'revenue', subtype: 'sales' },
      { code: '4050', name: 'Beverage Sales', type: 'revenue', subtype: 'sales' },
      { code: '5080', name: 'Food Purchases', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '5090', name: 'Beverage Purchases', type: 'expense', subtype: 'cost_of_goods_sold' },
      { code: '6880', name: 'Kitchen Supplies', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'nonprofit',
    label: 'Non-profit',
    description: 'You run a charity, association, club or religious organization.',
    industry: 'nonprofit',
    customerTerms: 'due_on_receipt',
    suggestsInventory: false,
    accounts: [
      { code: '4150', name: 'Donations', type: 'revenue', subtype: 'other_income' },
      { code: '4160', name: 'Grant Income', type: 'revenue', subtype: 'other_income' },
      { code: '4170', name: 'Program Service Revenue', type: 'revenue', subtype: 'service_revenue' },
      { code: '6890', name: 'Program Expenses', type: 'expense', subtype: 'operating_expenses' },
      { code: '6895', name: 'Fundraising Expenses', type: 'expense', subtype: 'operating_expenses' },
    ],
  },
  {
    value: 'general',
    label: 'Something else',
    description: 'Not sure? Start with the general business chart — you can add accounts any time.',
    industry: 'other',
    customerTerms: 'net_30',
    suggestsInventory: false,
    accounts: [],
  },
];

/** Extra accounts switched on by the yes/no questions (deduped against the template). */
const INVENTORY_ACCOUNTS: AccountTemplate[] = [
  { code: '5020', name: 'Freight In', type: 'expense', subtype: 'cost_of_goods_sold' },
  { code: '5095', name: 'Inventory Shrinkage', type: 'expense', subtype: 'cost_of_goods_sold' },
];
const PAYROLL_ACCOUNTS: AccountTemplate[] = [
  { code: '6510', name: 'Payroll Tax Expense', type: 'expense', subtype: 'payroll' },
  { code: '6520', name: 'Employee Benefits', type: 'expense', subtype: 'payroll' },
];

// ---------------------------------------------------------------------------
// Entity type (QB EasyStep "Select your tax form")
// ---------------------------------------------------------------------------

export type EntityType =
  | 'sole_prop'
  | 'llc_single'
  | 'llc_multi'
  | 'partnership'
  | 's_corp'
  | 'c_corp'
  | 'nonprofit'
  | 'other';

export interface EntityTypeOption {
  value: EntityType;
  label: string;
  /** Plain-language "pick this if…" text. */
  description: string;
  /** Income-tax form this kind of business files (null: not supported / not sure). */
  taxForm: IncomeTaxForm | null;
  /** Plain name of the tax return, for the summary. */
  taxFormLabel: string;
  /** Equity accounts this kind of business uses (on top of Owner's Equity + Retained Earnings). */
  equity: AccountTemplate[];
}

const OWNER_EQUITY: AccountTemplate[] = [
  { code: '3010', name: "Owner's Investment", type: 'equity', subtype: 'owners_equity' },
  { code: '3020', name: "Owner's Draw", type: 'equity', subtype: 'owners_equity' },
];
const PARTNER_EQUITY: AccountTemplate[] = [
  { code: '3010', name: 'Partner Contributions', type: 'equity', subtype: 'owners_equity' },
  { code: '3020', name: 'Partner Distributions', type: 'equity', subtype: 'owners_equity' },
];

export const ENTITY_TYPES: EntityTypeOption[] = [
  {
    value: 'sole_prop',
    label: 'Sole proprietor',
    description: 'You own the business yourself and report it on your personal return (Schedule C).',
    taxForm: 'SCHC',
    taxFormLabel: 'Form 1040 Schedule C',
    equity: OWNER_EQUITY,
  },
  {
    value: 'llc_single',
    label: 'LLC with one owner',
    description: 'A single-member LLC. Unless you chose to be taxed as a corporation, it files like a sole proprietor.',
    taxForm: 'SCHC',
    taxFormLabel: 'Form 1040 Schedule C',
    equity: OWNER_EQUITY,
  },
  {
    value: 'llc_multi',
    label: 'LLC with two or more owners',
    description: 'A multi-member LLC. Unless you chose to be taxed as a corporation, it files a partnership return.',
    taxForm: '1065',
    taxFormLabel: 'Form 1065',
    equity: PARTNER_EQUITY,
  },
  {
    value: 'partnership',
    label: 'Partnership',
    description: 'Two or more people own the business together and file a partnership return.',
    taxForm: '1065',
    taxFormLabel: 'Form 1065',
    equity: PARTNER_EQUITY,
  },
  {
    value: 's_corp',
    label: 'S corporation',
    description: 'A corporation (or LLC) that chose S status and files Form 1120-S.',
    taxForm: '1120S',
    taxFormLabel: 'Form 1120-S',
    equity: [
      { code: '3010', name: 'Capital Stock', type: 'equity', subtype: 'owners_equity' },
      { code: '3020', name: 'Additional Paid-in Capital', type: 'equity', subtype: 'owners_equity' },
      { code: '3030', name: 'Shareholder Distributions', type: 'equity', subtype: 'owners_equity' },
    ],
  },
  {
    value: 'c_corp',
    label: 'C corporation',
    description: 'A regular corporation that files Form 1120.',
    taxForm: '1120',
    taxFormLabel: 'Form 1120',
    equity: [
      { code: '3010', name: 'Capital Stock', type: 'equity', subtype: 'owners_equity' },
      { code: '3020', name: 'Additional Paid-in Capital', type: 'equity', subtype: 'owners_equity' },
      { code: '3030', name: 'Dividends Paid', type: 'equity', subtype: 'owners_equity' },
    ],
  },
  {
    value: 'nonprofit',
    label: 'Non-profit organization',
    description: 'A tax-exempt organization that files Form 990. (Tax-line reports do not cover Form 990.)',
    taxForm: null,
    taxFormLabel: 'Form 990 (no tax-line mapping)',
    equity: [
      { code: '3010', name: 'Net Assets Without Donor Restrictions', type: 'equity', subtype: 'owners_equity' },
      { code: '3020', name: 'Net Assets With Donor Restrictions', type: 'equity', subtype: 'owners_equity' },
    ],
  },
  {
    value: 'other',
    label: "Other / I'm not sure",
    description: 'Not sure yet? Ask your accountant, then pick the tax form later in Chart of Accounts.',
    taxForm: null,
    taxFormLabel: 'not chosen yet',
    equity: [],
  },
];

export function entityTypeOption(value: EntityType | undefined | null): EntityTypeOption {
  return ENTITY_TYPES.find((e) => e.value === value) ?? ENTITY_TYPES[ENTITY_TYPES.length - 1];
}

// ---------------------------------------------------------------------------
// Tax-line suggestions (QB maps the starter chart to the tax form's lines)
// ---------------------------------------------------------------------------

type FormLines = Partial<Record<IncomeTaxForm, string>>;
const L = (schc: string, f1065: string, f1120s: string, f1120: string): FormLines => ({
  SCHC: schc,
  '1065': f1065,
  '1120S': f1120s,
  '1120': f1120,
});

const GROSS_RECEIPTS = L('1', '1a', '1a', '1a');
const OTHER_INCOME = L('6', '7', '5', '10');
const COGS = L('4', '2', '2', '2');
const WAGES = L('26', '9', '8', '13');
const OTHER_DEDUCTIONS = L('27a', '21', '19', '26');

/** Expense lines by account-name keyword (first match wins). */
const EXPENSE_RULES: Array<[RegExp, FormLines]> = [
  [/advertis|marketing/i, L('8', '21', '16', '22')],
  [/vehicle|\bcar\b|truck|mileage/i, L('9', '21', '19', '26')],
  [/commission|merchant|bank.*fee/i, L('10', '21', '19', '26')],
  [/subcontract|contract labor/i, L('11', '21', '19', '26')],
  [/depreciation/i, L('13', '16a', '14', '20')],
  [/benefit/i, L('14', '19', '18', '24')],
  [/insurance/i, L('15', '21', '19', '26')],
  [/interest/i, L('16b', '15', '13', '18')],
  [/professional fee|legal|accounting fee/i, L('17', '21', '19', '26')],
  [/office/i, L('18', '21', '19', '26')],
  [/rent|lease/i, L('20b', '13', '11', '16')],
  [/repair/i, L('21', '11', '9', '14')],
  [/suppl/i, L('22', '21', '19', '26')],
  [/tax|license|permit/i, L('23', '14', '12', '17')],
  [/travel/i, L('24a', '21', '19', '26')],
  [/meal/i, L('24b', '21', '19', '26')],
  [/utilit/i, L('25', '21', '19', '26')],
];

/** Schedule L (entity returns only) by subtype. */
const BALANCE_SHEET: Record<string, string> = {
  checking: 'L1',
  savings: 'L1',
  undeposited_funds: 'L1',
  accounts_receivable: 'L2',
  inventory: 'L3',
  other_current_asset: 'L6',
  fixed_assets: 'L10a',
  other_asset: 'L14',
  accounts_payable: 'L16',
  credit_card: 'L18',
  other_current_liability: 'L18',
  long_term_liability: 'L20',
  retained_earnings: 'L24',
};

/**
 * Suggested income-tax line key ("1120S:7") for an account under `form`, or null when nothing
 * fits. Never invents a line: the key must exist in lib/taxLines.ts.
 */
export function suggestTaxLine(
  form: IncomeTaxForm | null,
  account: { name: string; type: string; subtype?: string | null },
): string | null {
  if (!form) return null;
  const subtype = account.subtype ?? '';
  let line: string | undefined;
  if (account.type === 'revenue') {
    line = (subtype === 'other_income' ? OTHER_INCOME : GROSS_RECEIPTS)[form];
  } else if (account.type === 'expense') {
    if (subtype === 'cost_of_goods_sold') line = COGS[form];
    else if (subtype === 'payroll' && !/tax|benefit/i.test(account.name)) line = WAGES[form];
    else {
      const rule = EXPENSE_RULES.find(([re]) => re.test(account.name));
      line = (rule ? rule[1] : OTHER_DEDUCTIONS)[form];
    }
  } else if (form !== 'SCHC') {
    if (account.type === 'equity') {
      if (subtype === 'retained_earnings') line = 'L24';
      else if (/draw|distribution|dividend/i.test(account.name)) line = 'L26';
      else line = 'L22';
    } else {
      line = BALANCE_SHEET[subtype];
    }
  }
  if (!line) return null;
  const key = `${form}:${line}`;
  return getTaxLine(key) ? key : null;
}

// ---------------------------------------------------------------------------
// Interview answers -> setup plan
// ---------------------------------------------------------------------------

/** Company contact details (QB EasyStep "Enter your company information"). */
export interface CompanyInfo {
  /** Name on invoices and reports (companies.name). */
  name?: string;
  /** Legal name for tax forms (W-2, 1099, 941) when different. */
  legalName?: string;
  ein?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  email?: string;
}

export interface InterviewAnswers {
  businessType: BusinessType;
  /** First month of the fiscal year, 1-12 (QB: "What is the first month of your fiscal year?"). */
  fiscalYearStartMonth: number;
  reportBasis: 'accrual' | 'cash';
  salesTax: boolean;
  inventory: boolean;
  employees: boolean;
  /** How the business is organized for income tax (picks equity accounts and tax lines). */
  entityType?: EntityType;
  /** First month of the income-tax year, 1-12 (defaults to the fiscal year's). */
  taxYearStartMonth?: number;
  /** Date you start tracking finances in Ironbooks ('YYYY-MM-DD'). */
  startDate?: string;
  /** Feature questions. Undefined = not asked: the preference is left as it is. */
  estimates?: boolean;
  progressInvoicing?: boolean;
  timeTracking?: boolean;
  classTracking?: boolean;
  multiCurrency?: boolean;
  /** Home currency (ISO code). */
  currency?: string;
  company?: CompanyInfo;
}

export interface SetupStep {
  label: string;
  href: string;
  why: string;
}

export interface PlannedAccount extends AccountTemplate {
  /** Tax line for the chosen form (null when none fits or no form). */
  taxLine?: string | null;
}

export interface SetupPlan {
  /** Company settings / Preferences patch (keys whitelisted by updateCompany). */
  settings: Record<string, unknown>;
  /** Interview-only facts stored in companies.settings (not edited in Preferences). */
  interview: {
    entityType: EntityType;
    taxYearStartMonth: number;
    startDate: string | null;
  };
  /** Income-tax form to set (null: leave as it is). */
  taxForm: IncomeTaxForm | null;
  /** New company name (trimmed), when given. */
  name: string | null;
  /** Accounts to create (after dedupe against the existing chart). */
  accounts: PlannedAccount[];
  /** Plain-language summary of what will be saved (built from `settings`). */
  summary: string[];
  nextSteps: SetupStep[];
}

const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(m: number): string {
  return MONTH_NAMES[m - 1] ?? '';
}

/**
 * Fiscal year END (MM-DD, the settings.fiscalYearEnd format) for a fiscal year that STARTS in
 * `startMonth`: January -> 12-31, July -> 06-30, March -> 02-28.
 */
export function fiscalYearEndFromStartMonth(startMonth: number): string {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError('startMonth must be 1-12');
  }
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  return `${String(endMonth).padStart(2, '0')}-${String(LAST_DAY[endMonth - 1]).padStart(2, '0')}`;
}

/** Inverse of fiscalYearEndFromStartMonth (defaults to January for bad input). */
export function fiscalYearStartMonthFromEnd(fiscalYearEnd: string | undefined | null): number {
  const m = /^(\d{2})-\d{2}$/.exec(fiscalYearEnd ?? '');
  if (!m) return 1;
  const endMonth = Number(m[1]);
  if (endMonth < 1 || endMonth > 12) return 1;
  return endMonth === 12 ? 1 : endMonth + 1;
}

/** Next unused account code at or after `code` (numeric codes step by 1). */
export function nextFreeCode(code: string, taken: Set<string>): string {
  if (!taken.has(code)) return code;
  if (!/^\d+$/.test(code)) {
    let n = 2;
    while (taken.has(`${code}-${n}`)) n++;
    return `${code}-${n}`;
  }
  let n = Number(code);
  while (taken.has(String(n))) n++;
  return String(n);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function businessTypeOption(value: BusinessType): BusinessTypeOption {
  return BUSINESS_TYPES.find((b) => b.value === value) ?? BUSINESS_TYPES[BUSINESS_TYPES.length - 1];
}

/** "12 Main St, Suite 4, Springfield, IL 62701" — the single-line address W-2/940 read. */
export function composeAddress(c: CompanyInfo | undefined): string {
  if (!c) return '';
  const t = (v: string | undefined) => (v ?? '').trim();
  const stateZip = [t(c.state), t(c.zip)].filter(Boolean).join(' ');
  const cityLine = [t(c.city), stateZip].filter(Boolean).join(', ');
  const country = t(c.country);
  const showCountry = country && !/^(us|usa|united states)$/i.test(country);
  return [t(c.addressLine1), t(c.addressLine2), cityLine, showCountry ? country : '']
    .filter(Boolean)
    .join(', ');
}

/** True when `s` is a real calendar date 'YYYY-MM-DD'. */
export function isIsoDate(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Plain-language summary rows built from what will actually be saved. */
export function summarizeSettings(
  settings: Record<string, unknown>,
  extra: {
    businessLabel: string;
    entity: EntityTypeOption;
    accountsAdded: number;
    startDate: string | null;
    taxYearStartMonth: number;
  },
): string[] {
  const onOff = (key: string, label: string, onText = 'on', offText = 'off') =>
    typeof settings[key] === 'boolean' ? `${label}: ${settings[key] ? onText : offText}` : null;
  const fye = settings.fiscalYearEnd as string;
  const rows: Array<string | null> = [
    `${extra.businessLabel} chart of accounts${extra.accountsAdded ? ` (+${extra.accountsAdded} account${extra.accountsAdded === 1 ? '' : 's'})` : ''}`,
    `Organized as: ${extra.entity.label} (tax return: ${extra.entity.taxFormLabel})`,
    `Fiscal year starts in ${monthName(fiscalYearStartMonthFromEnd(fye))} (ends ${fye})`,
    `Income tax year starts in ${monthName(extra.taxYearStartMonth)}`,
    extra.startDate ? `Start tracking on ${extra.startDate}` : null,
    `Reports on ${settings.reportBasis === 'cash' ? 'cash' : 'accrual'} basis (you can switch any report later)`,
    onOff('salesTaxEnabled', 'Sales tax', 'on (set up your tax rates next)', 'off'),
    onOff('inventoryEnabled', 'Inventory tracking', 'on (warns before overselling)', 'off'),
    onOff('purchaseOrdersEnabled', 'Purchase orders'),
    onOff('estimatesEnabled', 'Estimates'),
    onOff('progressInvoicingEnabled', 'Progress invoicing'),
    onOff('timeTrackingEnabled', 'Time tracking'),
    onOff('classTrackingEnabled', 'Class tracking'),
    onOff('multiCurrencyEnabled', 'More than one currency', 'yes', 'no'),
    settings.payrollEnabled === false
      ? 'Payroll: off (pay runs and payroll forms are hidden; your employee list stays)'
      : settings.payrollPayPeriod
        ? 'Payroll: on (every 2 weeks, 40-hour week)'
        : settings.payrollEnabled === true
          ? 'Payroll: on (your pay period is kept)'
          : null,
  ];
  return rows.filter((r): r is string => r !== null);
}

/**
 * Build the setup plan. `existing` is the company's current chart (codes + names); template
 * accounts whose NAME already exists are skipped, and code collisions are moved to the next
 * free code, so running the interview twice never duplicates an account.
 */
export function buildSetupPlan(
  answers: InterviewAnswers,
  existing: { code: string; name: string }[] = [],
): SetupPlan {
  const bt = businessTypeOption(answers.businessType);
  const entity = entityTypeOption(answers.entityType);
  const fiscalYearEnd = fiscalYearEndFromStartMonth(answers.fiscalYearStartMonth);
  const taxYearStartMonth = answers.taxYearStartMonth ?? answers.fiscalYearStartMonth;
  if (!Number.isInteger(taxYearStartMonth) || taxYearStartMonth < 1 || taxYearStartMonth > 12) {
    throw new RangeError('taxYearStartMonth must be 1-12');
  }
  const startDate = isIsoDate(answers.startDate) ? answers.startDate : null;

  const settings: Record<string, unknown> = {
    industry: bt.industry,
    fiscalYearEnd,
    reportBasis: answers.reportBasis,
    defaultCustomerTerms: bt.customerTerms,
    defaultVendorTerms: 'net_30',
    // Items & Inventory: the inventory answer switches the feature itself, the overselling
    // warning and purchase orders (QB turns purchase orders on together with inventory).
    inventoryEnabled: answers.inventory,
    negativeStockWarning: answers.inventory,
    purchaseOrdersEnabled: answers.inventory,
    salesTaxEnabled: answers.salesTax,
  };
  if (answers.estimates !== undefined) {
    settings.estimatesEnabled = answers.estimates;
    settings.progressInvoicingEnabled = answers.estimates && answers.progressInvoicing === true;
  }
  if (answers.timeTracking !== undefined) settings.timeTrackingEnabled = answers.timeTracking;
  if (answers.classTracking !== undefined) settings.classTrackingEnabled = answers.classTracking;
  if (answers.multiCurrency !== undefined) settings.multiCurrencyEnabled = answers.multiCurrency;
  if (answers.currency && /^[A-Z]{3}$/.test(answers.currency)) settings.currency = answers.currency;
  // "Do you have employees?" is QB's Full payroll / No payroll switch.
  settings.payrollEnabled = answers.employees;
  if (answers.employees) {
    settings.payrollPayPeriod = 'biweekly';
    settings.payrollStandardHours = 40;
  }
  // Company information (printed on invoices, W-2, 1099).
  const c = answers.company;
  if (c) {
    for (const k of [
      'legalName', 'ein', 'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'country', 'phone', 'email',
    ] as const) {
      if (c[k] !== undefined) settings[k] = (c[k] ?? '').trim();
    }
    const address = composeAddress(c);
    if (address) settings.address = address;
  }

  const candidates: AccountTemplate[] = [
    ...entity.equity,
    ...bt.accounts,
    ...(answers.inventory ? INVENTORY_ACCOUNTS : []),
    ...(answers.employees ? PAYROLL_ACCOUNTS : []),
  ];
  const takenCodes = new Set(existing.map((a) => a.code));
  const takenNames = new Set(existing.map((a) => norm(a.name)));
  const accounts: PlannedAccount[] = [];
  for (const a of candidates) {
    if (takenNames.has(norm(a.name))) continue;
    const code = nextFreeCode(a.code, takenCodes);
    takenCodes.add(code);
    takenNames.add(norm(a.name));
    accounts.push({ ...a, code, taxLine: suggestTaxLine(entity.taxForm, a) });
  }

  const summary = summarizeSettings(settings, {
    businessLabel: bt.label,
    entity,
    accountsAdded: accounts.length,
    startDate,
    taxYearStartMonth,
  });

  const nextSteps: SetupStep[] = [
    {
      label: 'Add your bank accounts and their balances',
      href: '/accounts',
      why: startDate
        ? `Enter each balance as of ${startDate}, from your bank statement.`
        : 'So deposits and checks land in the right place.',
    },
    { label: 'Add your customers', href: '/customers', why: 'Needed before you can invoice anyone.' },
    { label: 'Add the products and services you sell', href: '/items', why: 'Invoices and receipts are built from items.' },
  ];
  if (answers.salesTax) {
    nextSteps.push({ label: 'Set up sales tax rates', href: '/sales-tax-components', why: 'So invoices charge the right tax.' });
  }
  if (answers.inventory) {
    nextSteps.push({ label: 'Enter starting inventory', href: '/inventory-ops', why: 'Record what you have on hand today.' });
  }
  if (answers.employees) {
    nextSteps.push({ label: 'Add your employees', href: '/employees', why: 'Payroll needs pay rates and tax details.' });
  }
  nextSteps.push({ label: 'Connect or import bank transactions', href: '/bank-feeds', why: 'Saves typing — review and categorize instead.' });

  return {
    settings,
    interview: { entityType: entity.value, taxYearStartMonth, startDate },
    taxForm: entity.taxForm,
    name: c?.name?.trim() ? c.name.trim() : null,
    accounts,
    summary,
    nextSteps,
  };
}
