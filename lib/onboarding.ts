/**
 * EasyStep-style setup interview (app/onboarding/page.tsx) — the pure part.
 *
 * The wizard asks plain-language questions (what kind of business, when does your year
 * start, do you charge sales tax / track inventory / have employees) and this module turns
 * the answers into a setup plan:
 *   - `settings`: Preferences keys to switch on (PATCH /api/company { settings }), limited to
 *     keys the company service already whitelists (COMPANY_SETTINGS_KEYS);
 *   - `accounts`: industry chart-of-accounts additions on top of the default chart that
 *     createCompany seeds (POST /api/accounts, one per account, skipping any that exist);
 *   - `nextSteps`: links for the "what now?" checklist on the finish screen.
 *
 * No schema changes: everything goes through existing APIs.
 *
 * Known gap: "Do you charge sales tax?" switches on no preference — there is no sales-tax
 * key in COMPANY_SETTINGS_KEYS and this team may not add settings/schema. A "yes" only adds
 * the "Set up sales tax rates" next step (tax applies per item/rate once rates exist).
 */

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

export interface InterviewAnswers {
  businessType: BusinessType;
  /** First month of the fiscal year, 1-12 (QB: "What is the first month of your fiscal year?"). */
  fiscalYearStartMonth: number;
  reportBasis: 'accrual' | 'cash';
  salesTax: boolean;
  inventory: boolean;
  employees: boolean;
}

export interface SetupStep {
  label: string;
  href: string;
  why: string;
}

export interface SetupPlan {
  /** Preferences patch for PATCH /api/company { settings }. */
  settings: Record<string, unknown>;
  /** Accounts to create (after dedupe against the existing chart). */
  accounts: AccountTemplate[];
  /** Plain-language summary of what will be switched on. */
  summary: string[];
  nextSteps: SetupStep[];
}

const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

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

  const settings: Record<string, unknown> = {
    industry: bt.industry,
    fiscalYearEnd: fiscalYearEndFromStartMonth(answers.fiscalYearStartMonth),
    reportBasis: answers.reportBasis,
    defaultCustomerTerms: bt.customerTerms,
    defaultVendorTerms: 'net_30',
    // Inventory preference: warn before selling stock you don't have.
    negativeStockWarning: answers.inventory,
  };
  if (answers.employees) {
    settings.payrollPayPeriod = 'biweekly';
    settings.payrollStandardHours = 40;
  }

  const candidates = [
    ...bt.accounts,
    ...(answers.inventory ? INVENTORY_ACCOUNTS : []),
    ...(answers.employees ? PAYROLL_ACCOUNTS : []),
  ];
  const takenCodes = new Set(existing.map((a) => a.code));
  const takenNames = new Set(existing.map((a) => norm(a.name)));
  const accounts: AccountTemplate[] = [];
  for (const a of candidates) {
    if (takenNames.has(norm(a.name))) continue;
    const code = nextFreeCode(a.code, takenCodes);
    takenCodes.add(code);
    takenNames.add(norm(a.name));
    accounts.push({ ...a, code });
  }

  const summary: string[] = [
    `${bt.label} chart of accounts${accounts.length ? ` (+${accounts.length} account${accounts.length === 1 ? '' : 's'})` : ''}`,
    `Fiscal year ends ${settings.fiscalYearEnd as string}`,
    `Reports on ${answers.reportBasis === 'cash' ? 'cash' : 'accrual'} basis (you can switch any report later)`,
    answers.salesTax ? 'Sales tax: set up your tax rates next (see below)' : 'Sales tax: not charged',
    answers.inventory ? 'Inventory tracking: on (warns before overselling)' : 'Inventory tracking: off',
    answers.employees ? 'Payroll: on (bi-weekly, 40-hour default)' : 'Payroll: off',
  ];

  const nextSteps: SetupStep[] = [
    { label: 'Add your bank accounts', href: '/accounts', why: 'So deposits and checks land in the right place.' },
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

  return { settings, accounts, summary, nextSteps };
}
