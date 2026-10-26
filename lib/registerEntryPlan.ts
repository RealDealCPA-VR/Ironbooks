/**
 * Register entry plan — what typing a transaction straight into an account register saves as
 * (QB "Use Register": the blank row at the bottom of every register).
 *
 * Pure (no database), so the register page can show "Saves as: Check" before Enter and the
 * service (lib/services/registerEntry.ts) applies exactly the same rules.
 *
 * The row names this register's account, one other account and an amount in one of the two
 * columns. From that we know which account is debited and which is credited, and save the
 * document QB would:
 *   - bank → bank                       Transfer
 *   - money out of a bank               Check (written on that bank, line = the other account)
 *   - money into a bank                 Deposit (extra line = the other account)
 *   - a charge on a credit card         Credit card charge
 *   - a credit card paid down (no bank) Credit card credit
 *   - anything else                     General journal entry
 * A/R, A/P and inventory are refused: they need a customer, a vendor or quantities, so they are
 * entered on their own forms.
 */
import { isBankAccount, isCreditCardAccount, isUndepositedFunds } from '@/lib/accountTypes';

export type RegisterSide = 'increase' | 'decrease';

export type RegisterEntryKind = 'check' | 'deposit' | 'transfer' | 'card_charge' | 'card_credit' | 'journal';

export interface PlanAccount {
  id: string;
  type: string;
  subtype: string;
  isActive?: boolean;
  /** Account currency (null / undefined = home). */
  currency?: string | null;
}

export type RegisterEntryPlan =
  | {
      ok: true;
      kind: RegisterEntryKind;
      /** Account debited / credited by the entry. */
      debitAccountId: string;
      creditAccountId: string;
      /** check / card charge / card credit: the bank or card the document is written on. */
      paymentAccountId?: string;
      /** check / card charge / card credit / deposit: the account on the document's line. */
      lineAccountId?: string;
    }
  | { ok: false; message: string };

export const REGISTER_ENTRY_LABELS: Record<RegisterEntryKind, string> = {
  check: 'Check',
  deposit: 'Deposit',
  transfer: 'Transfer',
  card_charge: 'Credit card charge',
  card_credit: 'Credit card credit',
  journal: 'Journal entry',
};

/** Subtypes whose registers are view-only (entries need a customer, vendor or quantities). */
const FORM_ONLY_SUBTYPES: Record<string, string> = {
  accounts_receivable: 'Enter invoices and customer payments on their own forms (Customers menu).',
  accounts_payable: 'Enter bills and bill payments on their own forms (Vendors menu).',
  inventory: 'Change inventory through purchases, sales or an inventory adjustment.',
  // Make Deposits lists the payments, sales receipts and invoice payments waiting in Undeposited
  // Funds — an amount typed into (or out of) it here would be a balance no deposit can ever clear.
  undeposited_funds:
    'Undeposited Funds holds customer payments waiting to be deposited. Record them with Receive Payments or Sales Receipts, and deposit them with Make Deposits.',
};

/** Why this register can't take typed entries, or null when it can. */
export function registerEntryBlockedReason(account: Pick<PlanAccount, 'subtype'>): string | null {
  if (account.subtype === 'non_posting') return 'Non-posting accounts (estimates, purchase orders) have no register entries.';
  return FORM_ONLY_SUBTYPES[account.subtype] ?? null;
}

/**
 * Accounts whose balance is a list another form keeps (QB): Undeposited Funds is the payments
 * waiting in Make Deposits; an inventory asset account is the value of the inventory items. An
 * amount posted there any other way — a transfer, a deposit line, cash back, a bank-feed line —
 * makes the account's balance differ from that list for good. Why `account` can't be used on such
 * a form, or null when it can.
 */
export function subledgerAccountReason(account: { type: string; subtype?: string | null; name?: string | null }): string | null {
  const name = account.name ? `"${account.name}"` : 'That account';
  if (isUndepositedFunds(account)) {
    return `${name} is the Undeposited Funds account: only Receive Payments and Sales Receipts put money there, and Make Deposits takes it out. An amount moved there any other way could never be deposited.`;
  }
  if (account.type === 'asset' && account.subtype === 'inventory') {
    return `${name} is an inventory asset account: its balance is the value of your inventory items, kept by purchases, sales and inventory adjustments. An amount moved there directly would not be in the inventory valuation; use Adjust Quantity/Value on Hand instead.`;
  }
  return null;
}

/** Debit-normal accounts grow with a debit (assets and expenses). */
function debitNormal(a: Pick<PlanAccount, 'type'>): boolean {
  return a.type === 'asset' || a.type === 'expense';
}

export function planRegisterEntry(register: PlanAccount, other: PlanAccount, side: RegisterSide): RegisterEntryPlan {
  if (register.id === other.id) return { ok: false, message: 'Choose a different account. The entry needs two accounts.' };
  for (const a of [register, other]) {
    const blocked = registerEntryBlockedReason(a);
    if (blocked) return { ok: false, message: blocked };
  }
  if (other.isActive === false) return { ok: false, message: 'That account is inactive. Make it active first, or choose another account.' };

  // This register's account takes the debit when it grows and is debit-normal, or shrinks and
  // is credit-normal. The other account takes the opposite side.
  const registerDebited = (side === 'increase') === debitNormal(register);
  const debit = registerDebited ? register : other;
  const credit = registerDebited ? other : register;
  const base = { ok: true as const, debitAccountId: debit.id, creditAccountId: credit.id };

  if (isBankAccount(debit) && isBankAccount(credit)) {
    if ((debit.currency ?? null) !== (credit.currency ?? null)) {
      return { ok: false, message: 'These bank accounts use different currencies. Use Transfer Funds to enter the exchange rate.' };
    }
    return { ...base, kind: 'transfer' };
  }
  if (isBankAccount(credit)) return { ...base, kind: 'check', paymentAccountId: credit.id, lineAccountId: debit.id };
  if (isBankAccount(debit)) {
    if (isUndepositedFunds(credit)) {
      return { ok: false, message: 'Use Make Deposits to deposit the payments waiting in Undeposited Funds.' };
    }
    return { ...base, kind: 'deposit', lineAccountId: credit.id };
  }
  if (isCreditCardAccount(credit)) return { ...base, kind: 'card_charge', paymentAccountId: credit.id, lineAccountId: debit.id };
  if (isCreditCardAccount(debit)) return { ...base, kind: 'card_credit', paymentAccountId: debit.id, lineAccountId: credit.id };
  return { ...base, kind: 'journal' };
}
