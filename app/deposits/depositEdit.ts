/**
 * Make Deposits helpers (pure, unit-tested in lib/ui.review5.test.ts).
 */
import { isDepositTargetAccount, isUndepositedFunds } from '@/lib/accountTypes';

export interface DepositAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
  /** p1 fx: bank account currency (null = home). */
  currency?: string | null;
}

export interface UndepositedItem {
  id: string;
  /** invoice_payment = payment-item lines recorded on an invoice (id = the invoice). */
  kind: 'payment' | 'sales_receipt' | 'invoice_payment';
  customerId: string | null;
  customerName: string | null;
  date: string;
  method: string;
  reference: string | null;
  amount: string;
  /** p1 fx: payment currency (null = home). */
  currency?: string | null;
}

export interface DepositLine {
  id: string;
  depositId: string;
  paymentId: string | null;
  description: string | null;
  amount: string;
  /** Account an extra line credits (null on payment / receipt / cash-back lines). */
  accountId?: string | null;
}

export interface Deposit {
  id: string;
  depositAccountId: string;
  accountName: string | null;
  accountCode: string | null;
  date: string;
  total: string;
  memo: string | null;
  voidedAt: string | null;
  createdAt: string;
  lines: DepositLine[];
  /** p1 fx: deposit currency (null = home) and its home value. */
  currency?: string | null;
  homeTotal?: string | null;
}

export interface ExtraLine {
  accountId: string;
  amount: string;
  description: string;
}

/** A saved deposit loaded into the modal for editing. */
export interface DepositEdit {
  id: string;
  depositAccountId: string;
  date: string;
  memo: string;
  /** Payments / sales receipts already on this deposit (shown in the picker, pre-checked). */
  items: UndepositedItem[];
  extraLines: ExtraLine[];
  cashBackAccountId: string;
  cashBackAmount: string;
}

export const RECEIPT_PREFIX = 'salesReceipt:';
export const INVOICE_PAYMENT_PREFIX = 'invoicePayment:';
export const CASHBACK_PREFIX = 'cashback:';

/**
 * Rebuild the form state of a saved deposit from its lines. The payments already on it carry the
 * deposit's currency: the picker only lists items in the bank account's currency, so on a
 * foreign-currency deposit items without one were hidden — the total showed 0.00 and saving
 * with an extra line quietly took every payment back out of the deposit.
 */
export function depositToEdit(dep: Deposit): DepositEdit {
  const items: UndepositedItem[] = [];
  const extraLines: ExtraLine[] = [];
  let cashBackAccountId = '';
  let cashBackAmount = '';
  const currency = dep.currency ?? null;
  const onDeposit = (id: string, kind: UndepositedItem['kind'], method: string, amount: string): UndepositedItem => ({
    id,
    kind,
    customerId: null,
    customerName: 'Already on this deposit',
    date: dep.date,
    method,
    reference: null,
    amount,
    currency,
  });
  for (const l of dep.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) {
      items.push(onDeposit(l.paymentId, 'payment', 'payment', l.amount));
    } else if (desc.startsWith(RECEIPT_PREFIX)) {
      items.push(onDeposit(desc.slice(RECEIPT_PREFIX.length), 'sales_receipt', 'sales receipt', l.amount));
    } else if (desc.startsWith(INVOICE_PAYMENT_PREFIX)) {
      items.push(onDeposit(desc.slice(INVOICE_PAYMENT_PREFIX.length), 'invoice_payment', 'invoice payment', l.amount));
    } else if (desc.startsWith(CASHBACK_PREFIX)) {
      cashBackAccountId = desc.slice(CASHBACK_PREFIX.length);
      cashBackAmount = String(Math.abs(Number(l.amount)).toFixed(2));
    } else {
      // Extra lines keep their description and credited account (deposit_lines.account_id, 0037;
      // older lines without one are re-picked — the form flags it as required).
      extraLines.push({ accountId: l.accountId ?? '', amount: l.amount, description: desc });
    }
  }
  return {
    id: dep.id,
    depositAccountId: dep.depositAccountId,
    date: dep.date.slice(0, 10),
    memo: dep.memo ?? '',
    items,
    extraLines,
    cashBackAccountId,
    cashBackAmount,
  };
}

/**
 * Accounts offered in "Deposit To": bank accounts and other current assets (lib/accountTypes.ts
 * isDepositTargetAccount, as on Receive Payments), never Undeposited Funds itself. The list used to
 * hold every asset account — Accounts Receivable, Inventory Asset, fixed assets — so a deposit
 * could be put "into" A/R or inventory, moving the GL without the customer or stock records.
 * `keepIds`: the account a saved deposit being edited already uses stays listed (as Transfer
 * Funds keeps its saved accounts), so the select shows it and its currency is known.
 */
export function depositToAccounts<T extends DepositAccount>(accounts: T[], keepIds: Array<string | null | undefined> = []): T[] {
  return accounts.filter((a) => {
    if (keepIds.includes(a.id)) return true;
    const like = { type: a.type, subtype: a.subtype ?? null };
    return isDepositTargetAccount(like) && !isUndepositedFunds(like) && a.code !== '1050';
  });
}
