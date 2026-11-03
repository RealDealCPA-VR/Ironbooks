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
import { canRef, type AccessRef, type Area, type EffectiveAccess } from './model';

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

/**
 * prefsperms: what each of those areas means for a register, per activity. A bank / card register
 * is Banking > Use Register; the General Ledger detail of an income or expense account is Reports
 * — Financial > Accountant & Taxes. A/R, A/P and other balance-sheet registers list every kind of
 * document of their area, so they need the WHOLE area (fail closed for roles built per activity).
 */
function registerViewRefs(a: RegisterAccountLike): AccessRef[] {
  return registerViewAreas(a).map((area): AccessRef =>
    area === 'banking' ? 'banking.registers' : area === 'reports_financial' ? 'reports_financial.accountant' : area,
  );
}

/** True when `access` may open the register (trusted contexts without access: yes). */
export function canViewRegister(access: EffectiveAccess | null | undefined, a: RegisterAccountLike): boolean {
  if (!access) return true;
  return registerViewRefs(a).some((ref) => canRef(access, ref, 'view'));
}
