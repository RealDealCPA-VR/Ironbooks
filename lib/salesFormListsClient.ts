/**
 * QuickBooks list fields on the sales forms — the client side (team salesar):
 *
 *  - B9 Sales Tax Code column: each line of an invoice, sales receipt, credit memo, estimate or
 *    sales order shows a Sales Tax Code ("Tax", "Non", custom codes) instead of a bare Tax
 *    checkbox. Picking an item defaults the line to the item's code (else Tax / Non by the item's
 *    taxable flag); a non-taxable customer's lines show its non-taxable code; lines saved before
 *    codes existed (no code) show the standard code for their taxable flag. The server makes the
 *    final decision (lib/services/salesFormLists.ts applyLineTaxCodes) — these helpers mirror it so
 *    the live totals match what saves.
 *  - B8 Customer Message picker: active entries plus the message a document was saved with.
 *  - B7 Payment Method: the Sales Receipt picker (list entries, or the bare type of a receipt saved
 *    before the list was used) and the Make Deposits "View payment method type" filter.
 *
 * A row's `salesTaxCodeId` of '' means "the standard code for its taxable flag" — the code list
 * loads after the form, so a saved line without a code is resolved when shown and when sent.
 *
 * Pure (no React, no I/O): tested by lib/services/salesar.formlists.test.ts.
 */
import { Money } from '@/lib/money';

// ---------------------------------------------------------------------------
// List entries (GET /api/lists/:list)
// ---------------------------------------------------------------------------

export interface TaxCodeEntry {
  id: string;
  code: string;
  description?: string | null;
  taxable: boolean;
  isActive?: boolean;
}

export interface CustomerMessageEntry {
  id: string;
  message: string;
  isActive?: boolean;
}

export interface PaymentMethodEntry {
  id: string;
  name: string;
  /** cash | check | credit_card | ach | bank_transfer | other */
  type: string;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// B9 — Sales Tax Code per line
// ---------------------------------------------------------------------------

/** The customer's tax status a form knows (its Sales Tax Code). null = no customer / not loaded. */
export interface CustomerTaxStatus {
  /** false = the customer's tax code is non-taxable: nothing on the form is taxed. */
  taxable: boolean;
  salesTaxCodeId?: string | null;
}

/** The item fields that decide a line's default code (GET /api/items rows). */
export interface TaxCodeItem {
  type?: string | null;
  taxable?: boolean | null;
  salesTaxCodeId?: string | null;
}

/** A form row: its code ('' = the standard code for `taxable`) and its taxable flag. */
export interface TaxCodedRow {
  salesTaxCodeId?: string | null;
  taxable: boolean;
  /** Item type of the row's item (subtotal / payment / sales tax lines carry no code). */
  itemType?: string | null;
}

export interface LineTaxCode {
  /** The code shown and sent ('' when the code list is not available). */
  salesTaxCodeId: string;
  taxable: boolean;
}

/** Subtotal, payment and sales-tax item lines are never taxed and carry no code. */
const NO_CODE_TYPES = new Set(['subtotal', 'payment', 'sales_tax']);

export function lineTakesTaxCode(itemType?: string | null): boolean {
  return !itemType || !NO_CODE_TYPES.has(itemType);
}

/**
 * QB's standard code for a taxable flag: the active "Tax" / "Non" entry, else the first active
 * code with that flag, else any code with it.
 */
export function standardTaxCode(codes: readonly TaxCodeEntry[], taxable: boolean): TaxCodeEntry | null {
  const name = taxable ? 'tax' : 'non';
  const active = codes.filter((c) => c.isActive !== false);
  return (
    active.find((c) => c.taxable === taxable && c.code.trim().toLowerCase() === name) ??
    active.find((c) => c.taxable === taxable) ??
    codes.find((c) => c.taxable === taxable) ??
    null
  );
}

/** The code's taxable flag, or `fallback` when the code is unknown. */
export function taxableForCode(codeId: string | null | undefined, codes: readonly TaxCodeEntry[], fallback: boolean): boolean {
  const code = codeId ? codes.find((c) => c.id === codeId) : undefined;
  return code ? code.taxable : fallback;
}

/**
 * The code a line gets when an item is picked: the item's own code (items.salesTaxCodeId), else
 * Tax / Non by the item's taxable flag. Subtotal / payment / sales-tax items: no code, not taxed.
 * No item (a typed line): '' / taxable, i.e. the standard "Tax" code.
 */
export function itemLineTaxCode(item: TaxCodeItem | null | undefined, codes: readonly TaxCodeEntry[]): LineTaxCode {
  if (!item) return { salesTaxCodeId: '', taxable: true };
  if (!lineTakesTaxCode(item.type)) return { salesTaxCodeId: '', taxable: false };
  const flag = item.taxable !== false;
  if (item.salesTaxCodeId) {
    const own = codes.find((c) => c.id === item.salesTaxCodeId);
    if (own) return { salesTaxCodeId: own.id, taxable: own.taxable };
    // The code list has not loaded yet: keep the item's code (items.taxable follows it).
    if (codes.length === 0) return { salesTaxCodeId: item.salesTaxCodeId, taxable: flag };
  }
  return { salesTaxCodeId: standardTaxCode(codes, flag)?.id ?? '', taxable: flag };
}

/**
 * The code of a row filled in for the user (command bar prefill, scanned item, bundle component):
 * a taxable flag the source states is kept ('' = the standard code for it); otherwise the item's
 * own code, as when the item is picked by hand — so a "Non" item never starts out taxed.
 */
export function filledLineTaxCode(
  item: TaxCodeItem | null | undefined,
  codes: readonly TaxCodeEntry[],
  statedTaxable?: boolean | null,
): LineTaxCode {
  if (typeof statedTaxable === 'boolean') return { salesTaxCodeId: '', taxable: statedTaxable };
  return itemLineTaxCode(item, codes);
}

/** The non-taxable code a non-taxable customer's line shows. */
function customerNonCode(
  own: TaxCodeEntry | undefined,
  codes: readonly TaxCodeEntry[],
  customer: CustomerTaxStatus,
): TaxCodeEntry | null {
  if (own && !own.taxable) return own;
  const cust = customer.salesTaxCodeId ? codes.find((c) => c.id === customer.salesTaxCodeId) : undefined;
  if (cust && !cust.taxable) return cust;
  return standardTaxCode(codes, false);
}

/**
 * The code a line shows and saves with, and whether it is taxed — as the server will store it:
 *  1. a non-taxable customer: the line's own non-taxable code, else the customer's, else "Non";
 *  2. the code the row holds;
 *  3. otherwise (a line saved before codes, a typed line) the standard code for its flag.
 */
export function shownLineTaxCode(
  row: TaxCodedRow,
  codes: readonly TaxCodeEntry[],
  customer: CustomerTaxStatus | null | undefined,
): LineTaxCode {
  if (!lineTakesTaxCode(row.itemType)) return { salesTaxCodeId: '', taxable: false };
  const own = row.salesTaxCodeId ? codes.find((c) => c.id === row.salesTaxCodeId) : undefined;
  if (customer && !customer.taxable) {
    return { salesTaxCodeId: customerNonCode(own, codes, customer)?.id ?? '', taxable: false };
  }
  if (own) return { salesTaxCodeId: own.id, taxable: own.taxable };
  // Code list not loaded (or not readable): keep what the row holds.
  if (row.salesTaxCodeId && codes.length === 0) return { salesTaxCodeId: row.salesTaxCodeId, taxable: row.taxable };
  return { salesTaxCodeId: standardTaxCode(codes, row.taxable)?.id ?? '', taxable: row.taxable };
}

/** Request-body fields of a line: the code it shows (null when none) and its taxable flag. */
export function lineTaxPayload(
  row: TaxCodedRow,
  codes: readonly TaxCodeEntry[],
  customer: CustomerTaxStatus | null | undefined,
): { taxable: boolean; salesTaxCodeId: string | null } {
  const shown = shownLineTaxCode(row, codes, customer);
  return { taxable: shown.taxable, salesTaxCodeId: shown.salesTaxCodeId || null };
}

/** Rows with the taxable flag their code gives (feed the live total math). */
export function withShownTaxable<T extends TaxCodedRow>(
  rows: readonly T[],
  codes: readonly TaxCodeEntry[],
  customer: CustomerTaxStatus | null | undefined,
): T[] {
  return rows.map((r) => {
    const taxable = shownLineTaxCode(r, codes, customer).taxable;
    return taxable === r.taxable ? r : { ...r, taxable };
  });
}

/**
 * The codes a line's picker offers: the active codes (only the non-taxable ones for a
 * non-taxable customer) plus the code the line shows, even when it was made inactive later.
 */
export function taxCodeChoices(
  codes: readonly TaxCodeEntry[],
  currentId: string,
  customer: CustomerTaxStatus | null | undefined,
): TaxCodeEntry[] {
  const nonOnly = !!customer && !customer.taxable;
  return codes.filter(
    (c) => c.id === currentId || (c.isActive !== false && (!nonOnly || !c.taxable)),
  );
}

export function taxCodeLabel(c: TaxCodeEntry): string {
  return `${c.code}${c.isActive === false ? ' (inactive)' : ''}`;
}

// ---------------------------------------------------------------------------
// Sales tax items (the form's "Tax" item: GET /api/tax-rates?includeInactive=true)
// ---------------------------------------------------------------------------

export interface TaxItemEntry {
  id: string;
  name: string;
  /** Fraction, e.g. "0.082500". */
  rate: string;
  isActive?: boolean | null;
}

/**
 * The sales tax items the form's Tax picker offers: the active items plus the one the document
 * has, even when that item was made inactive after it was saved — so an edit still shows (and
 * previews the tax of) the saved item. A new document only ever sees active items.
 */
export function taxItemChoices<T extends TaxItemEntry>(rates: readonly T[], currentId: string | null | undefined): T[] {
  return rates.filter((t) => t.isActive !== false || (!!currentId && t.id === currentId));
}

/** "State Tax (8.25%)", "(inactive)" after an item made inactive. */
export function taxItemLabel(t: TaxItemEntry): string {
  let pct: string;
  try {
    pct = Money.mul(t.rate, 100).toFixed(2);
  } catch {
    pct = '?';
  }
  return `${t.name} (${pct}%)${t.isActive === false ? ' (inactive)' : ''}`;
}

/**
 * A tax item a NEW document may start with (the customer's tax item, the one recalled from the
 * last document): kept while it is active, or not in the list yet (still loading); null when it
 * has been made inactive, as QB never fills an inactive item into a new form.
 */
export function activeTaxItemId(id: string | null | undefined, rates: readonly TaxItemEntry[]): string | null {
  if (!id) return null;
  const t = rates.find((r) => r.id === id);
  return t && t.isActive === false ? null : id;
}

// ---------------------------------------------------------------------------
// B8 — Customer Message
// ---------------------------------------------------------------------------

/** Active messages plus the one the document was saved with (even if made inactive later). */
export function customerMessageChoices(
  entries: readonly CustomerMessageEntry[],
  currentId: string | null | undefined,
): CustomerMessageEntry[] {
  return entries.filter((m) => m.isActive !== false || m.id === currentId);
}

/** The request-body value: the picked entry, or null (no message / clears a saved one). */
export function customerMessagePayload(value: string | null | undefined): string | null {
  return value ? value : null;
}

// ---------------------------------------------------------------------------
// B7 — Payment Method
// ---------------------------------------------------------------------------

export const PAYMENT_TYPES = ['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  credit_card: 'Credit card',
  ach: 'ACH / e-check',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

/** Plain-language label of a payment method type ("credit_card" -> "Credit card"). */
export function paymentTypeLabel(type: string | null | undefined): string {
  if (!type) return '';
  const known = PAYMENT_TYPE_LABELS[type];
  if (known) return known;
  const s = type.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The picker value of a document: `pm:<entry id>` for a Payment Method list entry, `type:<type>`
 * for a receipt saved with a bare type (before the list was used).
 */
export function paymentMethodValue(doc: { paymentMethodId?: string | null; method?: string | null }): string {
  if (doc.paymentMethodId) return `pm:${doc.paymentMethodId}`;
  return `type:${doc.method || 'cash'}`;
}

/** A new sales receipt starts on the "Cash" entry (else the first active cash entry, else the bare type). */
export function defaultPaymentMethodValue(entries: readonly PaymentMethodEntry[]): string {
  const active = entries.filter((e) => e.isActive !== false);
  const cash =
    active.find((e) => e.type === 'cash' && e.name.trim().toLowerCase() === 'cash') ??
    active.find((e) => e.type === 'cash');
  return cash ? `pm:${cash.id}` : 'type:cash';
}

export interface PaymentMethodChoice {
  value: string;
  label: string;
}

/**
 * The Payment Method picker: every active list entry with its type ("Visa — Credit card"), the
 * entry the document was saved with even if inactive now, and — for a receipt saved with a bare
 * type, or when the list cannot be read — the bare types.
 */
export function paymentMethodChoices(entries: readonly PaymentMethodEntry[], value: string): PaymentMethodChoice[] {
  const out: PaymentMethodChoice[] = entries
    .filter((e) => e.isActive !== false || value === `pm:${e.id}`)
    .map((e) => ({
      value: `pm:${e.id}`,
      label: `${e.name} — ${paymentTypeLabel(e.type)}${e.isActive === false ? ' (inactive)' : ''}`,
    }));
  if (entries.length === 0) {
    return PAYMENT_TYPES.map((t) => ({ value: `type:${t}`, label: paymentTypeLabel(t) }));
  }
  if (value.startsWith('type:')) {
    const t = value.slice(5);
    out.unshift({ value, label: `${paymentTypeLabel(t)} (no payment method picked)` });
  }
  return out;
}

/** Request-body fields for a picker value. */
export function paymentMethodPayload(
  value: string,
  entries: readonly PaymentMethodEntry[],
): { paymentMethodId: string | null; method?: string } {
  if (value.startsWith('pm:')) {
    const id = value.slice(3);
    const entry = entries.find((e) => e.id === id);
    // The server stores the entry's type as the method whatever is sent.
    return entry ? { paymentMethodId: id, method: entry.type } : { paymentMethodId: id };
  }
  const t = value.startsWith('type:') ? value.slice(5) : value;
  return { paymentMethodId: null, method: (PAYMENT_TYPES as readonly string[]).includes(t) ? t : 'other' };
}

/** What a list row shows: the entry's name ("Visa"), else the type ("Check"). */
export function paymentMethodDisplay(
  doc: { paymentMethodId?: string | null; paymentMethodName?: string | null; method?: string | null },
  entries: readonly PaymentMethodEntry[] = [],
): string {
  if (doc.paymentMethodName) return doc.paymentMethodName;
  const entry = doc.paymentMethodId ? entries.find((e) => e.id === doc.paymentMethodId) : undefined;
  return entry?.name ?? paymentTypeLabel(doc.method);
}

// ---------------------------------------------------------------------------
// B7 — Make Deposits: "View payment method type"
// ---------------------------------------------------------------------------

export interface DepositMethodItem {
  id: string;
  method: string;
  paymentMethodId?: string | null;
  paymentMethodName?: string | null;
}

export type DepositMethodGroup = 'cash_check' | 'credit_card' | 'other';

/** QB groups cash with checks (they go to the bank together) and card receipts apart. */
export function depositMethodGroup(item: Pick<DepositMethodItem, 'method'>): DepositMethodGroup {
  if (item.method === 'cash' || item.method === 'check') return 'cash_check';
  if (item.method === 'credit_card') return 'credit_card';
  return 'other';
}

/** One payment method of the list: the entry ("pm:<id>"), else the bare type ("type:check"). */
export function depositMethodKey(item: DepositMethodItem): string {
  return item.paymentMethodId ? `pm:${item.paymentMethodId}` : `type:${item.method}`;
}

export function depositMethodLabel(item: DepositMethodItem): string {
  return item.paymentMethodName || paymentTypeLabel(item.method);
}

export interface DepositMethodView {
  value: string;
  label: string;
  count: number;
}

/**
 * The views offered over Payments to Deposit: all; cash and checks; credit cards; and each
 * payment method found in the list ("Visa", "MasterCard", "E-Check", a bare "Check"). Empty when
 * every item has the same method (nothing to tell apart).
 */
export function depositMethodViews(items: readonly DepositMethodItem[]): DepositMethodView[] {
  const byKey = new Map<string, { label: string; count: number }>();
  const groups: Record<DepositMethodGroup, number> = { cash_check: 0, credit_card: 0, other: 0 };
  for (const it of items) {
    groups[depositMethodGroup(it)] += 1;
    const key = depositMethodKey(it);
    const cur = byKey.get(key);
    if (cur) cur.count += 1;
    else byKey.set(key, { label: depositMethodLabel(it), count: 1 });
  }
  if (byKey.size < 2) return [];
  const views: DepositMethodView[] = [{ value: 'all', label: 'All payment methods', count: items.length }];
  const groupCount = Object.values(groups).filter((n) => n > 0).length;
  // A group view only helps when the list mixes groups (e.g. checks and cards).
  if (groupCount > 1) {
    if (groups.cash_check > 0) views.push({ value: 'group:cash_check', label: 'Cash and checks', count: groups.cash_check });
    if (groups.credit_card > 0) views.push({ value: 'group:credit_card', label: 'Credit cards', count: groups.credit_card });
  }
  const each = [...byKey.entries()]
    .map(([value, v]) => ({ value, label: v.label, count: v.count }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...views, ...each];
}

/** Whether an item is listed in a view ('all', 'group:<group>', or one method key). */
export function matchesDepositMethodView(item: DepositMethodItem, view: string): boolean {
  if (!view || view === 'all') return true;
  if (view.startsWith('group:')) return depositMethodGroup(item) === view.slice(6);
  return depositMethodKey(item) === view;
}
