/**
 * App-wide behaviour behind the Preferences that are not tied to one form (QB Edit >
 * Preferences > General "My Preferences", Accounting date warnings, Reports refresh). Pure
 * decision helpers live here so they can be unit-tested; components/PreferenceBehaviors.tsx
 * wires them to the DOM and to the API client's write hooks (lib/client.ts setWriteHooks).
 *
 *  - Accounting "Warn if transactions are N days in the past / future": forms that don't call
 *    lib/formPrefs.confirmTransactionDate themselves are covered here, at save time.
 *  - "Warn when editing a transaction": asks before saving changes to a recorded transaction.
 *  - "Beep when recording a transaction": a short local tone after a transaction saves.
 *  - "Default date for new transactions = the last date I entered": remembers the date of the
 *    last transaction saved and fills it into the date of the next new transaction form.
 *  - "Pressing Enter moves between fields" and "Automatically place the decimal point".
 *  - Reports "When report data changes": refresh automatically, ask, or don't.
 */
import { transactionDateWarning, type CompanyPreferences, type MyPreferences } from '@/lib/preferences';

/** Transaction APIs (collection = create, /<id> = edit). */
export const TRANSACTION_APIS = [
  '/api/invoices',
  '/api/bills',
  '/api/expenses',
  '/api/checks',
  '/api/journal-entries',
  '/api/payments',
  '/api/sales-receipts',
  '/api/credit-memos',
  '/api/estimates',
  '/api/sales-orders',
  '/api/purchase-orders',
  '/api/deposits',
  '/api/transfers',
  '/api/item-receipts',
  '/api/vendor-credits',
  '/api/bill-payments',
  // Paychecks: pay runs first (more specific), then single paychecks.
  '/api/payroll/pay-runs',
  '/api/payroll',
] as const;

/**
 * Forms that already ask about past/future dates themselves (lib/formPrefs.ts
 * confirmTransactionDate) — skipped here so nobody is asked twice.
 */
export const FORMS_WITH_OWN_DATE_WARNING = new Set<string>([
  '/api/invoices',
  '/api/bills',
  '/api/expenses',
  '/api/journal-entries',
  '/api/payments',
]);

/** Split a transaction API path into its collection and whether it targets one record. */
export function transactionTarget(path: string): { base: string; record: boolean } | null {
  const clean = path.replace(/\/+$/, '');
  for (const base of TRANSACTION_APIS) {
    if (clean === base) return { base, record: false };
    const rest = clean.startsWith(base + '/') ? clean.slice(base.length + 1) : null;
    if (rest && !rest.includes('/')) return { base, record: true };
  }
  return null;
}

/** The transaction date in a save body ('YYYY-MM-DD'), if any. */
export function bodyDate(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const k of ['date', 'txnDate', 'payDate', 'depositDate']) {
    const v = b[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return null;
}

/** A full form save (lines, date or amounts) — not a one-field status change such as 'mark as sent'. */
function isFormSave(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return ['lines', 'date', 'amount', 'total', 'items', 'splits', 'customerId', 'vendorId'].some((k) => k in (body as object));
}

export type SavePrompt = { kind: 'date' | 'edit'; message: string };

/**
 * Questions to ask before a save, in order (each needs an OK to continue). Empty = just save.
 */
export function promptsBeforeSave(
  info: { method: string; path: string; body: unknown },
  company: Pick<CompanyPreferences, 'warnPastDatesEnabled' | 'warnPastDays' | 'warnFutureDatesEnabled' | 'warnFutureDays'>,
  my: Pick<MyPreferences, 'warnWhenEditing'>,
  todayIso: string,
): SavePrompt[] {
  if (info.method !== 'POST' && info.method !== 'PUT' && info.method !== 'PATCH') return [];
  const target = transactionTarget(info.path);
  if (!target) return [];
  // Creates are POSTs to the collection; edits are PUT/PATCH to one record.
  const isCreate = info.method === 'POST' && !target.record;
  const isEdit = info.method !== 'POST' && target.record;
  if (!isCreate && !isEdit) return [];
  const out: SavePrompt[] = [];
  if (isEdit && my.warnWhenEditing && isFormSave(info.body)) {
    out.push({ kind: 'edit', message: 'You changed a transaction that was already recorded. Save your changes?' });
  }
  if (!FORMS_WITH_OWN_DATE_WARNING.has(target.base)) {
    const date = bodyDate(info.body);
    const warning = date ? transactionDateWarning(date, company, todayIso) : null;
    if (warning) out.push({ kind: 'date', message: `${warning}\n\nSave anyway?` });
  }
  return out;
}

/** True when a successful save recorded a transaction (beep / remember its date). */
export function recordsTransaction(info: { method: string; path: string }): boolean {
  if (info.method === 'DELETE') return false;
  const target = transactionTarget(info.path);
  if (!target) return false;
  return info.method === 'POST' ? !target.record : target.record;
}

/** QB "Automatically place decimal point": 1234 -> 12.34, 5 -> 0.05; anything else unchanged. */
export function autoDecimal(raw: string): string {
  const v = raw.trim();
  const m = /^(-?)(\d+)$/.exec(v);
  if (!m) return raw;
  const digits = m[2].padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  return `${m[1]}${whole}.${digits.slice(-2)}`;
}

/** Amount fields only — never quantities, hours, percentages or day counts. */
export function isMoneyField(el: { placeholder?: string; name?: string; id?: string; ariaLabel?: string | null }): boolean {
  const text = [el.placeholder, el.name, el.id, el.ariaLabel].filter(Boolean).join(' ');
  return !/qty|quantity|hours|percent|%|markup|days|units/i.test(text);
}

/**
 * Is this date field the transaction date of a NEW transaction form? Used for "default date =
 * the last date I entered": only the first date field of a dialog/form on a transaction page,
 * still showing today, and not a due/ship/expiry/report-range date.
 */
export function isNewTransactionDateField(
  el: { name?: string; id?: string; ariaLabel?: string | null; labelText?: string },
): boolean {
  const text = [el.name, el.id, el.ariaLabel, el.labelText].filter(Boolean).join(' ');
  return !/due|ship|expir|from|\bto\b|start|end|through|as of|period|filter|birth|hire/i.test(text);
}

/** Pages whose "new" forms take the remembered date. */
export const TRANSACTION_PAGES = [
  '/invoices',
  '/bills',
  '/expenses',
  '/journal',
  '/payments',
  '/sales-receipts',
  '/credit-memos',
  '/estimates',
  '/sales-orders',
  '/purchase-orders',
  '/deposits',
  '/transfers',
  '/item-receipts',
  '/vendor-credits',
  '/pay-bills',
];

export const LAST_DATE_STORAGE_KEY = 'bka:lastTransactionDate';

/**
 * Accounting > 'Automatically number journal entries': the next Entry No. after the highest
 * numbered one ('GJ-0099' -> 'GJ-0100', 17 -> 18), keeping prefix and leading zeros; '1' when
 * no entry has a number. Reversal references ('REV of #12') are ignored.
 */
export function nextJournalNumber(refs: Array<string | null | undefined>): string {
  let best: { prefix: string; digits: string; n: number } | null = null;
  for (const raw of refs) {
    const ref = (raw ?? '').trim();
    if (!ref || /^REV of #/i.test(ref)) continue;
    const m = /^(.*?)(\d+)$/.exec(ref);
    if (!m) continue;
    const n = Number(m[2]);
    if (!best || n > best.n) best = { prefix: m[1], digits: m[2], n };
  }
  if (!best) return '1';
  return best.prefix + String(best.n + 1).padStart(best.digits.length, '0');
}
