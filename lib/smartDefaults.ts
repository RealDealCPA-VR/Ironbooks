/**
 * Smart defaults (QB "recall last transaction" / auto-fill, next check number, default date) —
 * the pure, browser-safe half. The server half (history queries) is lib/services/smartDefaults.ts;
 * forms use it through lib/useSmartDefaults.ts.
 *
 *  - SMART_FORMS: the forms that recall a name's last transaction.
 *  - nextCheckNumberFrom: next check number from the numbers already used on one bank account,
 *    tolerating typed numbers such as "1001A" or "0099".
 *  - Default date: "the last date I entered" is remembered per form type for this session
 *    (sessionStorage), so a check does not inherit the date typed on an invoice.
 */

import { Money } from '@/lib/money';

export const VENDOR_FORMS = ['bill', 'check', 'expense', 'credit_card'] as const;
export const CUSTOMER_FORMS = ['invoice', 'sales_receipt', 'estimate', 'sales_order'] as const;
export const SMART_FORMS = [...VENDOR_FORMS, ...CUSTOMER_FORMS] as const;

export type VendorForm = (typeof VENDOR_FORMS)[number];
export type CustomerForm = (typeof CUSTOMER_FORMS)[number];
export type SmartForm = (typeof SMART_FORMS)[number];

export const SMART_FORM_LABELS: Record<SmartForm, string> = {
  bill: 'bill',
  check: 'check',
  expense: 'expense',
  credit_card: 'credit card charge',
  invoice: 'invoice',
  sales_receipt: 'sales receipt',
  estimate: 'estimate',
  sales_order: 'sales order',
};

export function isSmartForm(v: unknown): v is SmartForm {
  return typeof v === 'string' && (SMART_FORMS as readonly string[]).includes(v);
}

export function isVendorForm(f: SmartForm): f is VendorForm {
  return (VENDOR_FORMS as readonly string[]).includes(f);
}

/** Header fields each form can take from a recalled transaction. */
export type SmartHeaderField = 'terms' | 'classId' | 'salesRepId' | 'taxRateId' | 'memo';

export const FORM_HEADER_FIELDS: Record<SmartForm, SmartHeaderField[]> = {
  bill: ['terms', 'classId', 'memo'],
  check: ['memo'],
  expense: ['memo'],
  credit_card: ['memo'],
  invoice: ['terms', 'salesRepId', 'classId', 'taxRateId', 'memo'],
  sales_receipt: ['classId', 'taxRateId', 'memo'],
  estimate: ['taxRateId', 'memo'],
  sales_order: ['taxRateId', 'memo'],
};

export interface SmartHeader {
  terms: string | null;
  classId: string | null;
  salesRepId: string | null;
  taxRateId: string | null;
  memo: string | null;
}

export interface SmartLine {
  /** 'account' = an expense/income account line; 'item' = an item line. */
  kind: 'account' | 'item';
  accountId: string | null;
  itemId: string | null;
  description: string | null;
  /** Item lines: quantity. */
  quantity: string | null;
  /** Item lines: unit price (sales forms) or unit cost (purchase forms). */
  rate: string | null;
  amount: string;
  taxable: boolean | null;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
}

export interface SmartDefaults {
  form: SmartForm;
  /** False when My Preferences (or, for checks/expenses, Checking Autofill) turned recall off. */
  recallEnabled: boolean;
  /** The transaction the values were recalled from (null = nothing to recall). */
  source: { form: SmartForm; id: string; date: string; number: string | null } | null;
  header: SmartHeader;
  lines: SmartLine[];
  /** Checks: the next check number for the bank account asked about. */
  nextCheckNumber: string | null;
}

export const EMPTY_HEADER: SmartHeader = { terms: null, classId: null, salesRepId: null, taxRateId: null, memo: null };

// ---------------------------------------------------------------------------
// Check numbers
// ---------------------------------------------------------------------------

/**
 * Longer digit runs are confirmation / reference numbers, not check numbers. 10 so the sequence
 * survives the 999999999 -> 1000000000 rollover (a 10-digit check must still count as used).
 */
export const MAX_CHECK_DIGITS = 10;

/**
 * Read a used check number: plain digits ("1001", "0099") or digits with a short letter suffix
 * the user typed for a replacement check ("1001A", "1001-B"). Anything else (EFT, DEBIT,
 * "CHK12", long confirmation numbers) is not part of the sequence.
 */
export function parseCheckNumber(ref: string | null | undefined): { n: number; width: number } | null {
  const v = (ref ?? '').trim();
  const m = /^(\d+)(?:-?[A-Za-z]{1,3})?$/.exec(v);
  if (!m || m[1].length > MAX_CHECK_DIGITS) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n)) return null;
  return { n, width: m[1].length };
}

/**
 * The next check number after the highest one used: "1005" after 1001..1004 (gaps are not
 * back-filled, like QB), "1002" after "1001A", "0100" after "0099". `fallback` when no
 * numbered check exists yet.
 */
export function nextCheckNumberFrom(refs: Iterable<string | null | undefined>, fallback = '1001'): string {
  let best: { n: number; width: number } | null = null;
  for (const ref of refs) {
    const p = parseCheckNumber(ref);
    if (p && (!best || p.n > best.n || (p.n === best.n && p.width > best.width))) best = p;
  }
  if (!best) return fallback;
  return String(best.n + 1).padStart(best.width, '0');
}

// ---------------------------------------------------------------------------
// Default date: the last date entered on this form type (this session)
// ---------------------------------------------------------------------------

export const FORM_DATE_STORAGE_PREFIX = 'bka:lastDate:';

/** API collection → form key, for remembering the date a saved transaction used. */
const API_FORM_KEYS: Record<string, string> = {
  '/api/invoices': 'invoice',
  '/api/bills': 'bill',
  '/api/sales-receipts': 'sales_receipt',
  '/api/estimates': 'estimate',
  '/api/sales-orders': 'sales_order',
  '/api/journal-entries': 'journal',
  '/api/payments': 'payment',
  '/api/credit-memos': 'credit_memo',
  '/api/purchase-orders': 'purchase_order',
  '/api/deposits': 'deposit',
  '/api/transfers': 'transfer',
  '/api/item-receipts': 'item_receipt',
  '/api/vendor-credits': 'vendor_credit',
  '/api/bill-payments': 'bill_payment',
  '/api/payroll/pay-runs': 'paycheck',
  '/api/payroll': 'paycheck',
};

/** Page → form key for pages whose new-transaction date is filled generically. */
export const PAGE_FORM_KEYS: Record<string, string> = {
  '/journal': 'journal',
  '/payments': 'payment',
  '/credit-memos': 'credit_memo',
  '/purchase-orders': 'purchase_order',
  '/deposits': 'deposit',
  '/transfers': 'transfer',
  '/item-receipts': 'item_receipt',
  '/vendor-credits': 'vendor_credit',
  '/pay-bills': 'bill_payment',
};

/** Pages whose forms set their own default date through useSmartDefaults. */
export const SMART_DATE_PAGES = ['/bills', '/expenses', '/invoices', '/sales-receipts', '/estimates', '/sales-orders'];

/** Write Checks / Expenses saves → the form key by payment method (a CC credit is its own form). */
export function expenseFormKey(method: unknown, isRefund?: unknown): string {
  if (method === 'check') return 'check';
  if (method === 'credit_card') return isRefund ? 'credit_card_credit' : 'credit_card';
  return 'expense';
}

/** The form key a successful save of `base` (a transaction API collection) belongs to. */
export function formKeyForSave(base: string, body: unknown): string | null {
  if (base === '/api/expenses') {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return expenseFormKey(b.method, b.isRefund);
  }
  return API_FORM_KEYS[base] ?? null;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): KV | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function rememberFormDate(formKey: string, date: string, store: KV | null = sessionStore()): void {
  if (!store || !ISO_DATE.test(date)) return;
  try {
    store.setItem(FORM_DATE_STORAGE_PREFIX + formKey, date);
  } catch {
    /* storage unavailable */
  }
}

export function recallFormDate(formKey: string, store: KV | null = sessionStore()): string | null {
  if (!store) return null;
  try {
    const v = store.getItem(FORM_DATE_STORAGE_PREFIX + formKey);
    return v && ISO_DATE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * My Preferences > General "Default date for new transactions": 'last' = the last date entered
 * on this form type this session (today when there is none); 'today' = today.
 */
export function defaultFormDate(
  pref: 'today' | 'last',
  formKey: string,
  today: string,
  store: KV | null = sessionStore(),
): string {
  if (pref !== 'last') return today;
  return recallFormDate(formKey, store) ?? today;
}

/**
 * Recalled sales lines as plain line rows (sales receipts, estimates, sales orders): item,
 * description, qty, rate, taxable, class. `rateManual` keeps the recalled rate from being
 * replaced by automatic pricing (QB recall keeps last time's rates).
 */
export function salesRowsFromRecall(lines: SmartLine[]): Array<{
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  rateManual: boolean;
  classId: string;
}> {
  return lines.map((l) => ({
    itemId: l.itemId ?? '',
    description: l.description ?? '',
    quantity: recallQuantity(l.quantity),
    rate: recallNumber(l.rate),
    taxable: l.taxable ?? true,
    rateManual: true,
    classId: l.classId ?? '',
  }));
}

/**
 * A recalled decimal (quantity, rate, unit cost: numeric strings from the DB) as the text a form
 * field shows: Decimal, never a JS float, trailing zeros dropped ("9.5000" -> "9.5"), always in
 * plain notation (no "1e-8"). '' for null / blank / unparseable.
 */
export function recallNumber(v: string | null | undefined): string {
  if (v == null || String(v).trim() === '') return '';
  try {
    return Money.of(v).toFixed();
  } catch {
    return '';
  }
}

/** A recalled quantity: as recallNumber, '1' when there is none. */
export function recallQuantity(v: string | null | undefined): string {
  return recallNumber(v) || '1';
}

/**
 * The class a recalled line keeps on its own. The services store `line.classId ?? header classId`
 * on every line, so a line whose class equals the header's is just inheriting it: leave it blank
 * so a header class change still flows to it; only a genuinely different line class is kept.
 */
export function lineClassOverride(lineClassId: string | null | undefined, headerClassId: string | null | undefined): string {
  return lineClassId && lineClassId !== (headerClassId ?? null) ? lineClassId : '';
}

/**
 * Recalled invoice line fields. The item id is kept even when `items` does not have it yet (the
 * list is still loading): dropping it would turn the line into a description-only line that still
 * carries a rate. The name / type / unit are filled once the list arrives (fillRecalledItems).
 */
export function invoiceFieldsFromRecall<T extends RecallItem>(
  l: SmartLine,
  items: readonly T[],
  headerClassId: string | null | undefined,
): {
  itemName: string;
  itemId: string | null;
  itemType: T['type'] | null;
  unitOfMeasure: string | null;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  jobId: string;
  classId: string;
  rateManual: true;
} {
  const item = l.itemId ? items.find((it) => it.id === l.itemId) : undefined;
  return {
    itemName: item?.name ?? '',
    itemId: l.itemId ?? null,
    itemType: item?.type ?? null,
    unitOfMeasure: item?.unitOfMeasure ?? null,
    description: l.description ?? '',
    quantity: recallQuantity(l.quantity),
    rate: recallNumber(l.rate),
    taxable: l.taxable ?? true,
    jobId: l.jobId ?? '',
    classId: lineClassOverride(l.classId, headerClassId),
    // QB recall keeps last time's rates: automatic pricing must not replace them.
    rateManual: true,
  };
}

export interface RecallItem {
  id: string;
  name: string;
  type: string;
  unitOfMeasure?: string | null;
}

/**
 * Rows that hold an item id but no item name yet (recalled before the item list loaded): fill
 * name / type / unit from `items`. Returns the same array when nothing changed (no re-render).
 */
export function fillRecalledItems<
  R extends { itemId: string | null; itemName: string; itemType: string | null; unitOfMeasure: string | null },
  T extends RecallItem,
>(rows: R[], items: readonly T[]): R[] {
  let changed = false;
  const next = rows.map((r) => {
    if (!r.itemId || r.itemName) return r;
    const it = items.find((i) => i.id === r.itemId);
    if (!it) return r;
    changed = true;
    return { ...r, itemName: it.name, itemType: it.type, unitOfMeasure: it.unitOfMeasure ?? null } as R;
  });
  return changed ? next : rows;
}

/**
 * A recalled bill line as a bill form row: account or item line, with its own class (when it
 * differs from the bill's class) and billable customer:job, as the service returned them.
 */
export function billRowFromRecall(
  l: SmartLine,
  headerClassId: string | null | undefined,
): {
  mode: 'expense' | 'item';
  accountId: string;
  amount: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  description: string;
  classId: string;
  customerId: string;
  jobId: string;
} {
  const shared = {
    description: l.description ?? '',
    classId: lineClassOverride(l.classId, headerClassId),
    customerId: l.customerId ?? '',
    jobId: l.customerId ? (l.jobId ?? '') : '',
  };
  if (l.kind === 'item' && l.itemId) {
    return {
      mode: 'item',
      accountId: '',
      amount: '',
      itemId: l.itemId,
      quantity: recallQuantity(l.quantity),
      unitCost: recallNumber(l.rate),
      ...shared,
    };
  }
  return { mode: 'expense', accountId: l.accountId ?? '', amount: l.amount, itemId: '', quantity: '', unitCost: '', ...shared };
}
