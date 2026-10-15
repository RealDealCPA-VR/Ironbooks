/**
 * Form prefill handoff (command bar → transaction forms).
 *
 * The command bar resolves "invoice Acme 3 hours consulting" into a FormPrefill on the server,
 * then hands it to the target page through sessionStorage — never through the URL, so customer
 * names and amounts stay out of browser history — and navigates there. The page picks it up
 * (lib/commands/usePrefill.ts), opens its NEW form filled in, and the user reviews and saves as
 * usual: the command bar itself never creates or posts anything.
 *
 * A stashed prefill is single-use and expires after PREFILL_TTL_MS, so a stale one can never
 * pop up later. PURE apart from the injected Storage, so it is unit-testable.
 */
import { z } from 'zod';
import { FORM_KINDS } from './intent';

/** Where each form lives. */
export const PREFILL_PATHS = {
  invoice: '/invoices',
  bill: '/bills',
  expense: '/expenses',
  estimate: '/estimates',
  sales_receipt: '/sales-receipts',
  reconcile: '/reconcile',
  payment: '/payments',
  deposit: '/deposits',
} as const;
export type PrefillKind = keyof typeof PREFILL_PATHS;
export const PREFILL_KINDS = Object.keys(PREFILL_PATHS) as PrefillKind[];

const zAmt = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/);
const zId = z.string().uuid();

export const prefillLineSchema = z.object({
  itemId: zId.optional(),
  itemName: z.string().max(255).optional(),
  itemType: z.string().max(40).optional(),
  accountId: zId.optional(),
  description: z.string().max(1000).optional(),
  quantity: zAmt.optional(),
  rate: zAmt.optional(),
  amount: zAmt.optional(),
  taxable: z.boolean().optional(),
  /** The user typed this price, so automatic price rules must not replace it. */
  rateFromUser: z.boolean().optional(),
});
export type PrefillLine = z.infer<typeof prefillLineSchema>;

export const formPrefillSchema = z.object({
  kind: z.enum([...FORM_KINDS, 'reconcile', 'payment', 'deposit'] as [PrefillKind, ...PrefillKind[]]),
  customerId: zId.optional(),
  vendorId: zId.optional(),
  /** Free-text payee for a check when no vendor matched. */
  payeeName: z.string().max(255).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(1000).optional(),
  /** Checks/expenses: the bank or credit-card GL account paid from. */
  paymentAccountId: zId.optional(),
  /** Reconcile: the bank account (bank_accounts.id) to start with. */
  bankAccountId: zId.optional(),
  lines: z.array(prefillLineSchema).max(50).default([]),
  /** Shown on the form so the user knows where the values came from. */
  note: z.string().max(300).optional(),
});
export type FormPrefill = z.infer<typeof formPrefillSchema>;

export const PREFILL_STORAGE_KEY = 'ironbooks.commandBar.prefill';
/** Fired on window after a prefill is stashed, for a page that is already open. */
export const PREFILL_EVENT = 'ironbooks:prefill';
export const PREFILL_TTL_MS = 2 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Save a prefill for the next page that asks for this kind. Returns false when storage fails. */
export function stashPrefill(storage: StorageLike, prefill: FormPrefill, now = Date.now()): boolean {
  const parsed = formPrefillSchema.safeParse(prefill);
  if (!parsed.success) return false;
  try {
    storage.setItem(PREFILL_STORAGE_KEY, JSON.stringify({ at: now, prefill: parsed.data }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Take (and remove) the stashed prefill when it is for `kind` and still fresh. A prefill for a
 * different form is left for its own page; an expired or malformed one is discarded.
 */
export function takePrefill(storage: StorageLike, kind: PrefillKind, now = Date.now()): FormPrefill | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PREFILL_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    safeRemove(storage);
    return null;
  }
  const e = entry as { at?: unknown; prefill?: unknown };
  if (typeof e?.at !== 'number' || now - e.at > PREFILL_TTL_MS || now < e.at - 5000) {
    safeRemove(storage);
    return null;
  }
  const parsed = formPrefillSchema.safeParse(e.prefill);
  if (!parsed.success) {
    safeRemove(storage);
    return null;
  }
  if (parsed.data.kind !== kind) return null;
  safeRemove(storage);
  return parsed.data;
}

function safeRemove(storage: StorageLike) {
  try {
    storage.removeItem(PREFILL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
