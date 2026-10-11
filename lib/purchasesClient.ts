/**
 * Client helpers shared by the purchase / banking pages (wave2 purchases).
 *
 * saveWithDuplicateCheck — QB-style "duplicate number" warning with override (A3/A4): the
 * server refuses a check number / vendor bill number that is already used (409). We show the
 * server's plain-language message, ask "Keep it anyway?", and resend with
 * allowDuplicateNumber: true when the user agrees.
 */
import { ApiError } from '@/lib/client';

const DUPLICATE_RE = /already used on this bank account|already has a bill with reference number/i;

export function isDuplicateNumberError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && DUPLICATE_RE.test(err.message);
}

/**
 * Run `send(false)`; on a duplicate-number refusal ask the user and retry with `send(true)`.
 * Returns null when the user chose not to keep the duplicate.
 */
export async function saveWithDuplicateCheck<T>(send: (allowDuplicate: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await send(false);
  } catch (err) {
    if (!isDuplicateNumberError(err)) throw err;
    const ok =
      typeof window !== 'undefined' &&
      window.confirm(`${err.message}\n\nKeep this number anyway?`);
    if (!ok) return null;
    return send(true);
  }
}

/** Payment terms offered on vendors and bills (the four standard terms plus a discount term). */
export const TERMS_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'due_on_receipt', label: 'Due on receipt' },
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_60', label: 'Net 60' },
  { value: '2_10_net_30', label: '2% 10, Net 30' },
  { value: '1_10_net_30', label: '1% 10, Net 30' },
];

/** Vendor fields the purchase forms use for pre-fill / currency. */
export interface PurchaseVendor {
  id: string;
  displayName: string;
  terms?: string | null;
  currency?: string | null;
  prefillAccountIds?: string[] | null;
  defaultExpenseAccountId?: string | null;
}

/** The vendor's own pre-fill accounts (QB: up to 3), or [] when none are set. */
export function vendorPrefillAccountIds(v: PurchaseVendor | undefined | null): string[] {
  return (v?.prefillAccountIds ?? []).filter(Boolean).slice(0, 3);
}
