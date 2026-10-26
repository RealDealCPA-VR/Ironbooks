/**
 * Make Deposits window (app/deposits/page.tsx): the shapes the page works with and how a saved
 * deposit is loaded back into the form for editing. Pure (no React, no I/O) so it is unit-tested.
 */
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
