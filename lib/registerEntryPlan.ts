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
};

/** Why this register can't take typed entries, or null when it can. */
export function registerEntryBlockedReason(account: Pick<PlanAccount, 'subtype'>): string | null {
  if (account.subtype === 'non_posting') return 'Non-posting accounts (estimates, purchase orders) have no register entries.';
  return FORM_ONLY_SUBTYPES[account.subtype] ?? null;
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
    if (currencyOf(debit) !== currencyOf(credit)) {
      return { ok: false, message: 'These bank accounts use different currencies. Use Transfer Funds to enter the exchange rate.' };
    }
    return { ...base, kind: 'transfer' };
  }
  let plan: RegisterEntryPlan;
  if (isBankAccount(credit)) plan = { ...base, kind: 'check', paymentAccountId: credit.id, lineAccountId: debit.id };
  else if (isBankAccount(debit)) {
    if (isUndepositedFunds(credit)) {
      return { ok: false, message: 'Use Make Deposits to deposit the payments waiting in Undeposited Funds.' };
    }
    plan = { ...base, kind: 'deposit', lineAccountId: credit.id };
  } else if (isCreditCardAccount(credit)) plan = { ...base, kind: 'card_charge', paymentAccountId: credit.id, lineAccountId: debit.id };
  else if (isCreditCardAccount(debit)) plan = { ...base, kind: 'card_credit', paymentAccountId: debit.id, lineAccountId: credit.id };
  else plan = { ...base, kind: 'journal' };

  // review5 fx: the amount is typed in THIS register's currency. The document must be written on
  // an account in that currency, and the other account must be in it or in home currency —
  // otherwise a EUR amount would be saved as a home-currency check (or the other way round) with
  // no exchange rate.
  const regCur = currencyOf(register);
  const docAccountId = plan.kind === 'deposit' ? plan.debitAccountId : (plan.paymentAccountId ?? register.id);
  const docCur = docAccountId === register.id ? regCur : currencyOf(other);
  const otherCur = currencyOf(other);
  if (docCur !== regCur || (otherCur && otherCur !== regCur)) {
    return {
      ok: false,
      message: 'These accounts use different currencies, so the amount can’t be entered in this register. Use Write Checks, Make Deposits or Transfer Funds, where you can enter the exchange rate.',
    };
  }
  return plan;
}

/** Account currency as the plan compares it (blank = home; callers pass home as null). */
function currencyOf(a: Pick<PlanAccount, 'currency'>): string | null {
  return (a.currency ?? '').trim().toUpperCase() || null;
}
