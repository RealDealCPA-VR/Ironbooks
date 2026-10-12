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

/** Retainage Receivable: an Other Current Asset (as in QB), but money customers will owe. */
export const RETAINAGE_CODE = '1250';

/**
 * Is this a receivable that a cash basis excludes? Every Accounts Receivable account, plus
 * Retainage Receivable (code 1250, an Other Current Asset like QB's contractor setup): retainage
 * held back on an unpaid invoice is revenue not yet received in cash.
 */
export function isReceivable(a: ClassifiableAccount): boolean {
  return (
    a.code === AR_CODE ||
    a.subtype === 'accounts_receivable' ||
    (a.code === RETAINAGE_CODE && a.subtype === 'other_current_asset' && /retainage/i.test(a.name))
  );
}

/**
 * Is this an Accounts Payable account? Excluded on a cash basis. The subtype alone is not
 * trusted — 'accounts_payable' is the default for any liability created without a subtype
 * (e.g. a loan) — so it also needs a name that says "Accounts Payable".
 */
export function isPayable(a: ClassifiableAccount): boolean {
  return a.code === AP_CODE || (a.subtype === 'accounts_payable' && /accounts\s*payable/i.test(a.name));
}
