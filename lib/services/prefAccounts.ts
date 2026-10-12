/**
 * Preferences that name a GL account (Checking, Payroll & Employees, Purchases & Vendors) must
 * name the right KIND of account. Otherwise a paycheck could be paid "from" Accounts Receivable
 * or wages could post to Accounts Payable, and the control account would stop matching its
 * customer/vendor subledger. Checked when the preference is saved (updateCompany) and again
 * when a service uses it (a stored value may predate the rule, or the account may have changed).
 */
import { and, eq } from 'drizzle-orm';
import { accounts } from '@/lib/db/schema';
import { type ServiceContext, validation } from './_base';

export type PrefAccountKind = 'bank' | 'expense' | 'payroll_liability';

/** Preference key -> the kind of account it may name. */
export const PREFERENCE_ACCOUNT_KINDS: Readonly<Record<string, PrefAccountKind>> = {
  defaultCheckAccountId: 'bank',
  defaultBillPaymentAccountId: 'bank',
  defaultDepositAccountId: 'bank',
  defaultPaycheckAccountId: 'bank',
  defaultExpenseAccountId: 'expense',
  payrollExpenseAccountId: 'expense',
  payrollLiabilityAccountId: 'payroll_liability',
};

// 'bank' is accepted too so a later QB account-type subtype named that way keeps working.
const BANK_SUBTYPES = new Set(['checking', 'savings', 'bank']);
// Liabilities that have their own subledger or register must never receive payroll withholdings.
const NOT_PAYROLL_LIABILITY_SUBTYPES = new Set(['accounts_payable', 'credit_card']);

/**
 * System accounts that look like an ordinary bank/liability by type but are control accounts
 * with their own subledger, resolved by code elsewhere (deposits.ts / payments.ts use 1050,
 * sales-tax services use 2200). A preference must never point money at them.
 * - 1050 Undeposited Funds is refused for EVERY bank preference, including the Make Deposits
 *   default: Make Deposits moves payments OUT of Undeposited Funds into a real bank account, so
 *   depositing "into" it would be a no-op loop. (Receiving payments into Undeposited Funds is a
 *   separate setting, useUndepositedFunds.)
 * - 2200 Sales Tax Payable is reserved for sales tax owed to agencies.
 */
export const UNDEPOSITED_FUNDS_CODE = '1050';
export const SALES_TAX_PAYABLE_CODE = '2200';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_LABEL: Record<PrefAccountKind, string> = {
  bank: 'a bank account (checking or savings)',
  expense: 'an expense account',
  payroll_liability: 'a liability account other than Accounts Payable or a credit card',
};

export function accountFitsKind(
  acct: { type: string; subtype: string; code?: string | null },
  kind: PrefAccountKind,
): boolean {
  switch (kind) {
    case 'bank':
      return acct.type === 'asset' && BANK_SUBTYPES.has(acct.subtype) && acct.code !== UNDEPOSITED_FUNDS_CODE;
    case 'expense':
      return acct.type === 'expense';
    case 'payroll_liability':
      return (
        acct.type === 'liability' &&
        !NOT_PAYROLL_LIABILITY_SUBTYPES.has(acct.subtype) &&
        acct.code !== SALES_TAX_PAYABLE_CODE
      );
  }
}

/** Plain-language reason a system account is refused (null when the generic message fits). */
function systemAccountReason(acct: { code?: string | null }, kind: PrefAccountKind): string | null {
  if (kind === 'bank' && acct.code === UNDEPOSITED_FUNDS_CODE) {
    return 'Undeposited Funds holds payments waiting to be deposited; choose a checking or savings account.';
  }
  if (kind === 'payroll_liability' && acct.code === SALES_TAX_PAYABLE_CODE) {
    return 'Sales Tax Payable is kept for sales tax you owe; choose a payroll liabilities account.';
  }
  return null;
}

/**
 * Throws VALIDATION unless `accountId` is an active account of this company of the given kind.
 * Returns the account row.
 */
export async function assertPreferenceAccount(
  ctx: ServiceContext,
  accountId: string,
  kind: PrefAccountKind,
  label = 'This setting',
): Promise<{ id: string; type: string; subtype: string; code: string | null; isActive: boolean }> {
  if (!UUID_RE.test(accountId)) throw validation(`${label}: the chosen account was not found in this company.`);
  const [row] = await ctx.db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      code: accounts.code,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!row) throw validation(`${label}: the chosen account was not found in this company.`);
  if (!row.isActive) throw validation(`${label}: the chosen account is inactive.`);
  if (!accountFitsKind(row, kind)) {
    const reason = systemAccountReason(row, kind);
    throw validation(reason ? `${label}: ${reason}` : `${label} must be ${KIND_LABEL[kind]}.`);
  }
  return row;
}

/** Validate every account-valued preference in a settings patch (null clears and is always fine). */
export async function assertPreferenceAccounts(ctx: ServiceContext, patch: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    const kind = PREFERENCE_ACCOUNT_KINDS[key];
    if (!kind || value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') throw validation(`${key} must be an account id.`);
    await assertPreferenceAccount(ctx, value, kind, key);
  }
}
