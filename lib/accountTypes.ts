/**
 * QuickBooks account types (client-safe, no DB imports).
 *
 * The ledger stores two columns per account:
 *  - `type`    — the five-way accounting class (asset / liability / equity / revenue / expense)
 *                that drives the debit/credit sign (DB triggers in 0017 rely on it), and
 *  - `subtype` — the detail type (account_subtype enum).
 *
 * QuickBooks Desktop shows a single "Account Type" list (Bank, Accounts Receivable, Other Current
 * Asset, ... Non-Posting). That list is DERIVED from (type, subtype) here so every screen and
 * service classifies accounts the same way — never infer "bank" / "cash" / "A/P" ad hoc.
 */

export type BaseAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Every value of the account_subtype enum (must match lib/db/schema.ts). */
export const ACCOUNT_SUBTYPES = [
  'checking',
  'savings',
  'accounts_receivable',
  'inventory',
  'fixed_assets',
  'accounts_payable',
  'credit_card',
  'long_term_liability',
  'owners_equity',
  'retained_earnings',
  'sales',
  'service_revenue',
  'other_income',
  'cost_of_goods_sold',
  'operating_expenses',
  'payroll',
  'taxes',
  // wave2 foundation (0025)
  'other_current_asset',
  'undeposited_funds',
  'other_asset',
  'other_current_liability',
  'other_expense',
  'non_posting',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export type QbAccountType =
  | 'bank'
  | 'accounts_receivable'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'equity'
  | 'income'
  | 'cost_of_goods_sold'
  | 'expense'
  | 'other_income'
  | 'other_expense'
  | 'non_posting';

export interface QbAccountTypeInfo {
  value: QbAccountType;
  /** QuickBooks name of the type. */
  label: string;
  /** Plain-language explanation for non-accountants. */
  help: string;
  /** Example accounts of this type. */
  examples: string;
  baseType: BaseAccountType;
  /** Subtype used when the user picks this QB type. */
  defaultSubtype: AccountSubtype;
  /** Detail subtypes that belong to this QB type (first = default). */
  subtypes: AccountSubtype[];
  /** Balance-sheet grouping. */
  section: 'current_asset' | 'fixed_asset' | 'other_asset' | 'current_liability' | 'long_term_liability' | 'equity' | 'income' | 'cogs' | 'expense' | 'other_income' | 'other_expense' | 'non_posting';
}

/** QuickBooks Desktop account-type list, in QB's chart-of-accounts order. */
export const QB_ACCOUNT_TYPES: QbAccountTypeInfo[] = [
  {
    value: 'bank', label: 'Bank', baseType: 'asset', defaultSubtype: 'checking',
    subtypes: ['checking', 'savings'], section: 'current_asset',
    help: 'A checking, savings or money-market account at a bank. Gets a check register.',
    examples: 'Business Checking, Savings, Petty Cash',
  },
  {
    value: 'accounts_receivable', label: 'Accounts Receivable', baseType: 'asset',
    defaultSubtype: 'accounts_receivable', subtypes: ['accounts_receivable'], section: 'current_asset',
    help: 'Money customers owe you for invoices they have not paid yet.',
    examples: 'Accounts Receivable',
  },
  {
    value: 'other_current_asset', label: 'Other Current Asset', baseType: 'asset',
    defaultSubtype: 'other_current_asset', subtypes: ['other_current_asset', 'undeposited_funds', 'inventory'],
    section: 'current_asset',
    help: 'Something you own that will turn into cash or be used up within a year, but is not a bank account.',
    examples: 'Undeposited Funds, Prepaid Insurance, Inventory Asset, Retainage Receivable, Employee Advances',
  },
  {
    value: 'fixed_asset', label: 'Fixed Asset', baseType: 'asset', defaultSubtype: 'fixed_assets',
    subtypes: ['fixed_assets'], section: 'fixed_asset',
    help: 'Equipment, vehicles, furniture or buildings you use for more than a year.',
    examples: 'Vehicles, Computer Equipment, Accumulated Depreciation',
  },
  {
    value: 'other_asset', label: 'Other Asset', baseType: 'asset', defaultSubtype: 'other_asset',
    subtypes: ['other_asset'], section: 'other_asset',
    help: 'Long-term things you own that are not equipment.',
    examples: 'Security Deposits, Long-term Notes Receivable, Goodwill',
  },
  {
    value: 'accounts_payable', label: 'Accounts Payable', baseType: 'liability',
    defaultSubtype: 'accounts_payable', subtypes: ['accounts_payable'], section: 'current_liability',
    help: 'Bills from vendors you have entered but not paid yet.',
    examples: 'Accounts Payable',
  },
  {
    value: 'credit_card', label: 'Credit Card', baseType: 'liability', defaultSubtype: 'credit_card',
    subtypes: ['credit_card'], section: 'current_liability',
    help: 'A business credit card. Gets a register like a bank account.',
    examples: 'Visa, American Express',
  },
  {
    value: 'other_current_liability', label: 'Other Current Liability', baseType: 'liability',
    defaultSubtype: 'other_current_liability', subtypes: ['other_current_liability'], section: 'current_liability',
    help: 'Money you owe and will pay within a year that is not a vendor bill or credit card.',
    examples: 'Sales Tax Payable, Payroll Liabilities, Customer Deposits, Short-term Loans',
  },
  {
    value: 'long_term_liability', label: 'Long Term Liability', baseType: 'liability',
    defaultSubtype: 'long_term_liability', subtypes: ['long_term_liability'], section: 'long_term_liability',
    help: 'Loans you will pay back over more than a year.',
    examples: 'Bank Loan, Mortgage, Vehicle Loan',
  },
  {
    value: 'equity', label: 'Equity', baseType: 'equity', defaultSubtype: 'owners_equity',
    subtypes: ['owners_equity', 'retained_earnings'], section: 'equity',
    help: "The owners' stake in the business: money put in, taken out, and profits kept.",
    examples: "Owner's Equity, Owner's Draw, Retained Earnings",
  },
  {
    value: 'income', label: 'Income', baseType: 'revenue', defaultSubtype: 'sales',
    subtypes: ['sales', 'service_revenue'], section: 'income',
    help: 'Money you earn from your main business: selling products or services.',
    examples: 'Sales, Service Income, Consulting Fees',
  },
  {
    value: 'cost_of_goods_sold', label: 'Cost of Goods Sold', baseType: 'expense',
    defaultSubtype: 'cost_of_goods_sold', subtypes: ['cost_of_goods_sold'], section: 'cogs',
    help: 'What it costs you to make or buy the things you sell.',
    examples: 'Cost of Goods Sold, Materials, Subcontractors',
  },
  {
    value: 'expense', label: 'Expense', baseType: 'expense', defaultSubtype: 'operating_expenses',
    subtypes: ['operating_expenses', 'payroll', 'taxes'], section: 'expense',
    help: 'Everyday costs of running the business.',
    examples: 'Rent, Utilities, Advertising, Payroll Expenses',
  },
  {
    value: 'other_income', label: 'Other Income', baseType: 'revenue', defaultSubtype: 'other_income',
    subtypes: ['other_income'], section: 'other_income',
    help: 'Money you earn outside your main business.',
    examples: 'Interest Income, Gain on Sale of Equipment',
  },
  {
    value: 'other_expense', label: 'Other Expense', baseType: 'expense', defaultSubtype: 'other_expense',
    subtypes: ['other_expense'], section: 'other_expense',
    help: 'Costs that are not part of running the business day to day.',
    examples: 'Interest Expense, Penalties, Loss on Sale of Assets',
  },
  {
    value: 'non_posting', label: 'Non-Posting', baseType: 'asset', defaultSubtype: 'non_posting',
    subtypes: ['non_posting'], section: 'non_posting',
    help: 'Tracks things like estimates or purchase orders that do not change your books. Never on reports.',
    examples: 'Estimates, Purchase Orders, Sales Orders',
  },
];

const BY_VALUE = new Map(QB_ACCOUNT_TYPES.map((t) => [t.value, t]));
const BY_SUBTYPE = new Map<string, QbAccountTypeInfo>();
for (const t of QB_ACCOUNT_TYPES) for (const s of t.subtypes) BY_SUBTYPE.set(s, t);

export const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  checking: 'Checking',
  savings: 'Savings',
  accounts_receivable: 'Accounts Receivable',
  inventory: 'Inventory',
  fixed_assets: 'Fixed Asset',
  accounts_payable: 'Accounts Payable',
  credit_card: 'Credit Card',
  long_term_liability: 'Long Term Liability',
  owners_equity: "Owner's Equity",
  retained_earnings: 'Retained Earnings',
  sales: 'Sales',
  service_revenue: 'Service Income',
  other_income: 'Other Income',
  cost_of_goods_sold: 'Cost of Goods Sold',
  operating_expenses: 'Operating Expense',
  payroll: 'Payroll',
  taxes: 'Taxes',
  other_current_asset: 'Other Current Asset',
  undeposited_funds: 'Undeposited Funds',
  other_asset: 'Other Asset',
  other_current_liability: 'Other Current Liability',
  other_expense: 'Other Expense',
  non_posting: 'Non-Posting',
};

export function getQbAccountTypeInfo(value: string): QbAccountTypeInfo | undefined {
  return BY_VALUE.get(value as QbAccountType);
}

export function isQbAccountType(value: string): value is QbAccountType {
  return BY_VALUE.has(value as QbAccountType);
}

/** The QuickBooks account type of an account, derived from its (type, subtype). */
export function qbAccountTypeOf(acct: { type: string; subtype?: string | null }): QbAccountType {
  const info = acct.subtype ? BY_SUBTYPE.get(acct.subtype) : undefined;
  if (info && info.baseType === acct.type) return info.value;
  // Mismatched / legacy combinations fall back to the base type's generic QB type.
  switch (acct.type) {
    case 'asset':
      return 'other_current_asset';
    case 'liability':
      return 'other_current_liability';
    case 'equity':
      return 'equity';
    case 'revenue':
      return 'income';
    default:
      return 'expense';
  }
}

export function qbAccountTypeLabel(acct: { type: string; subtype?: string | null }): string {
  return BY_VALUE.get(qbAccountTypeOf(acct))!.label;
}

/** Map a QB account type (+ optional detail subtype) to the stored (type, subtype) pair. */
export function resolveQbAccountType(
  qbType: QbAccountType,
  subtype?: string | null,
): { type: BaseAccountType; subtype: AccountSubtype } {
  const info = BY_VALUE.get(qbType);
  if (!info) throw new Error(`Unknown account type "${qbType}"`);
  const s = subtype && (info.subtypes as string[]).includes(subtype) ? (subtype as AccountSubtype) : info.defaultSubtype;
  return { type: info.baseType, subtype: s };
}

/** The base type a subtype belongs to (undefined for unknown subtypes). */
export function baseTypeOfSubtype(subtype: string): BaseAccountType | undefined {
  return BY_SUBTYPE.get(subtype)?.baseType;
}

// ---- predicates used by services + UI (single source of truth) ----------------

type AcctLike = { type: string; subtype?: string | null };

/** Bank accounts (checking / savings). These get check registers and can write checks. */
export const BANK_SUBTYPES: readonly string[] = ['checking', 'savings'];
export function isBankAccount(a: AcctLike): boolean {
  return a.type === 'asset' && BANK_SUBTYPES.includes(a.subtype ?? '');
}
/** Cash and cash equivalents: banks plus Undeposited Funds (QB cash-flow "cash"). */
export function isCashAccount(a: AcctLike): boolean {
  return isBankAccount(a) || (a.type === 'asset' && a.subtype === 'undeposited_funds');
}
export function isUndepositedFunds(a: AcctLike): boolean {
  return a.type === 'asset' && a.subtype === 'undeposited_funds';
}
export function isAccountsReceivable(a: AcctLike): boolean {
  return a.type === 'asset' && a.subtype === 'accounts_receivable';
}
export function isAccountsPayable(a: AcctLike): boolean {
  return a.type === 'liability' && a.subtype === 'accounts_payable';
}
export function isCreditCardAccount(a: AcctLike): boolean {
  return a.type === 'liability' && a.subtype === 'credit_card';
}
export function isNonPosting(a: { subtype?: string | null }): boolean {
  return a.subtype === 'non_posting';
}
/**
 * Accounts that get a QB register: every balance-sheet type except equity (bank, credit card,
 * A/R, A/P, other current asset incl. Undeposited Funds and inventory, fixed / other asset,
 * other current and long-term liabilities).
 */
export const REGISTER_SUBTYPES: readonly AccountSubtype[] = [
  'checking', 'savings', 'credit_card', 'accounts_receivable', 'accounts_payable',
  'undeposited_funds', 'other_current_asset', 'inventory', 'fixed_assets', 'other_asset',
  'other_current_liability', 'long_term_liability',
];
/**
 * Accounts money can be paid FROM (Write Checks / Pay Bills / Expenses): banks and credit cards.
 * QB parity: checks come from bank accounts, card charges from credit-card accounts. Legacy
 * charts where a cash-like account was given an unusual subtype are not supported here on purpose.
 */
export function isPaymentSourceAccount(a: AcctLike): boolean {
  return isBankAccount(a) || isCreditCardAccount(a);
}
/**
 * Accounts money can be deposited TO (Receive Payments / Sales Receipts / refunds): banks,
 * Undeposited Funds and other current assets — never A/R, inventory, fixed or non-posting.
 */
export function isDepositTargetAccount(a: AcctLike): boolean {
  if (a.type !== 'asset') return false;
  return ['checking', 'savings', 'undeposited_funds', 'other_current_asset'].includes(a.subtype ?? '');
}
/** Current assets (classified balance sheet). */
export function isCurrentAsset(a: AcctLike): boolean {
  return a.type === 'asset' && BY_SUBTYPE.get(a.subtype ?? '')?.section === 'current_asset';
}
/** Current liabilities (classified balance sheet / cash-flow operating section). */
export function isCurrentLiability(a: AcctLike): boolean {
  if (a.type !== 'liability') return false;
  return BY_SUBTYPE.get(a.subtype ?? '')?.section !== 'long_term_liability';
}
export function isLongTermLiability(a: AcctLike): boolean {
  return a.type === 'liability' && a.subtype === 'long_term_liability';
}
