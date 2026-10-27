/**
 * Make Deposits window (app/deposits/page.tsx): the shapes the page works with, how a saved
 * deposit is loaded back into the form for editing, and which accounts "Deposit To" offers.
 * Pure (no React, no I/O) so it is unit-tested (lib/depositEdit.review5.test.ts,
 * lib/ui.review5.test.ts).
 */
import { Money, toAmountString } from '@/lib/money';
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

export function emptyExtraLine(): ExtraLine {
  return { accountId: '', amount: '', description: '' };
}

const RECEIPT_PREFIX = 'salesReceipt:';
const INVOICE_PAYMENT_PREFIX = 'invoicePayment:';
const CASHBACK_PREFIX = 'cashback:';

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

/** Rebuild the form state of a saved deposit from its lines. */
export function depositToEdit(dep: Deposit): DepositEdit {
  const items: UndepositedItem[] = [];
  const extraLines: ExtraLine[] = [];
  // The payments on a deposit are in the deposit's currency (p1 fx). The picker only lists the
  // items in the bank account's currency, so items without it vanished from a foreign-currency
  // deposit being edited — and saving the edit (even a memo change) took them OFF the deposit.
  const currency = dep.currency ?? null;
  let cashBackAccountId = '';
  let cashBackAmount = '';
  for (const l of dep.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) {
      items.push({
        id: l.paymentId,
        kind: 'payment',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'payment',
        reference: null,
        amount: l.amount,
        currency,
      });
    } else if (desc.startsWith(RECEIPT_PREFIX)) {
      items.push({
        id: desc.slice(RECEIPT_PREFIX.length),
        kind: 'sales_receipt',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'sales receipt',
        reference: null,
        amount: l.amount,
        currency,
      });
    } else if (desc.startsWith(INVOICE_PAYMENT_PREFIX)) {
      items.push({
        id: desc.slice(INVOICE_PAYMENT_PREFIX.length),
        kind: 'invoice_payment',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'invoice payment',
        reference: null,
        amount: l.amount,
        currency,
      });
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
 * The "Payments to Deposit" a deposit into a bank account of currency `depositCurrency` (null =
 * home) can hold: QB Make Deposits lists only the payments in the account's currency.
 */
export function itemsForDepositCurrency(items: UndepositedItem[], depositCurrency: string | null): UndepositedItem[] {
  return items.filter((p) => (p.currency || null) === (depositCurrency || null));
}

/**
 * "Total deposited" under the deposit list, in HOME currency: voided deposits left out, a
 * foreign-currency deposit counted at its home value. The footer used to add each deposit's own
 * amount, so EUR 1,000 + USD 500 showed as "$1,500.00".
 */
export function depositListHomeTotal(deposits: ReadonlyArray<Pick<Deposit, 'total' | 'homeTotal' | 'currency' | 'voidedAt'>>): string {
  let sum = Money.zero();
  for (const d of deposits) {
    if (d.voidedAt) continue;
    try {
      sum = sum.plus(Money.of(d.currency && d.homeTotal != null ? d.homeTotal : d.total));
    } catch {
      /* a malformed amount is left out of the footer */
    }
  }
  return toAmountString(sum);
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
