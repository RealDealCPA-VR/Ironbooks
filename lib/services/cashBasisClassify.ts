/**
 * Shared A/R and A/P classification for the cash-basis reports.
 *
 * The cash-basis Balance Sheet (balanceSheetCashBasis.ts) removes these accounts and the
 * cash-basis P&L (cashBasisReports.ts) backs their period change out of accrual income /
 * expenses. Both MUST use the same classifier, otherwise cash-basis retained earnings on
 * the sheet and cash-basis net income to date disagree (e.g. Retainage Receivable).
 */

// ---- COA codes for legacy files without subtypes ----
export const AR_CODE = '1200'; // Accounts Receivable (asset, debit-normal)
export const AP_CODE = '2000'; // Accounts Payable     (liability, credit-normal)

export interface ClassifiableAccount {
  code: string;
  name: string;
  subtype: string | null;
}

/** Is this an Accounts Receivable account (A/R, Retainage Receivable, …)? Excluded on a cash basis. */
export function isReceivable(a: ClassifiableAccount): boolean {
  return a.code === AR_CODE || a.subtype === 'accounts_receivable';
}

/**
 * Is this an Accounts Payable account? Excluded on a cash basis. The subtype alone is not
 * trusted — 'accounts_payable' is the default for any liability created without a subtype
 * (e.g. a loan) — so it also needs a name that says "Accounts Payable".
 */
export function isPayable(a: ClassifiableAccount): boolean {
  return a.code === AP_CODE || (a.subtype === 'accounts_payable' && /accounts\s*payable/i.test(a.name));
}
