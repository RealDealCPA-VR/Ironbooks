/**
 * Who may open an account's register (review round 5).
 *
 * The register routes are mapped to Banking (lib/permissions/routes.ts), but a register lists
 * every posted line of its account with names and amounts: the Payroll Liabilities and wage
 * registers show each paycheck by employee, A/R every customer's invoices, A/P every vendor's
 * bills. QuickBooks Enterprise treats those as part of the area that owns the account — bank and
 * credit card registers are Banking; A/R is Customers & Receivables; A/P is Vendors & Payables;
 * other balance-sheet registers are Sensitive Accounting; an income or expense account's register
 * is the same detail the General Ledger report shows, so Sensitive Accounting or Reports —
 * Financial opens it. So on top of the route's Banking check, the caller needs one of these.
 *
 * Pure (no DB): the registers routes use it to filter the list and to guard one register.
 */
import { isBankAccount, isCreditCardAccount, isUndepositedFunds } from '@/lib/accountTypes';
import { can, type Area, type EffectiveAccess } from './model';

export interface RegisterAccountLike {
  type: string;
  subtype: string | null;
}

/** The areas (any one, with 'view') that open this account's register. */
export function registerViewAreas(a: RegisterAccountLike): Area[] {
  const acct = { type: a.type, subtype: a.subtype ?? '' };
  if (isBankAccount(acct) || isCreditCardAccount(acct) || isUndepositedFunds(acct)) return ['banking'];
  if (acct.subtype === 'accounts_receivable') return ['customers'];
  if (acct.subtype === 'accounts_payable') return ['vendors'];
  if (acct.type === 'revenue' || acct.type === 'expense') return ['accounting', 'reports_financial'];
  return ['accounting'];
}

/** True when `access` may open the register (trusted contexts without access: yes). */
export function canViewRegister(access: EffectiveAccess | null | undefined, a: RegisterAccountLike): boolean {
  if (!access) return true;
  return registerViewAreas(a).some((area) => can(access, area, 'view'));
}
