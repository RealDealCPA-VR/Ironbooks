/**
 * Inline field validation for the transaction forms (invoices, bills, checks/expenses, journal
 * entries, payments, deposits): plain-language messages shown next to the field BEFORE saving,
 * so the most common mistakes never reach the server.
 *
 * Pure (no React) and Decimal-safe; amounts follow the same rules as the API (lib/validation
 * zMoney: at most 2 decimals, thousands commas allowed in groups of three). Unit-tested in
 * lib/fieldValidation.test.ts. The forms render the messages with components/FieldError.tsx.
 */
import Decimal from 'decimal.js';

/** field key → message. Keys are form-specific ("customer", "date", "line-2-amount"). */
export type FieldErrors = Record<string, string>;

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;
const GROUPED_RE = /^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = new Decimal('9999999999999.99');

/** "Choose a customer." when the value is blank. */
export function requiredMessage(value: unknown, message: string): string | null {
  if (value === null || value === undefined) return message;
  if (typeof value === 'string' && value.trim() === '') return message;
  return null;
}

/** Parse a typed amount ("1,250.50") to a Decimal; null when blank, 'invalid' when not money. */
export function parseTypedAmount(raw: string | number | null | undefined): Decimal | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const plain = GROUPED_RE.test(s) ? s.replace(/,/g, '') : s;
  if (!AMOUNT_RE.test(plain)) return 'invalid';
  return new Decimal(plain);
}

export interface AmountRules {
  /** What the amount is, for the message: "Amount", "Line 2 amount". */
  label: string;
  required?: boolean;
  /** Allow 0 (default false: must be more than zero when entered). */
  allowZero?: boolean;
  allowNegative?: boolean;
  /** Upper limit (e.g. an invoice's balance due) and how to describe it. */
  max?: { value: Decimal.Value; what: string };
}

/** Plain message for an amount field, or null when it is fine. */
export function amountMessage(raw: string | number | null | undefined, rules: AmountRules): string | null {
  const v = parseTypedAmount(raw);
  if (v === null) return rules.required ? `Enter the ${rules.label.toLowerCase()}.` : null;
  if (v === 'invalid') {
    return `${rules.label} must be a number like 1250.50 (two decimals at most).`;
  }
  if (v.abs().greaterThan(MAX)) return `${rules.label} is too large.`;
  if (v.isNegative() && !rules.allowNegative) return `${rules.label} can't be negative.`;
  if (v.isZero() && !rules.allowZero) return `${rules.label} must be more than zero.`;
  if (rules.max && v.greaterThan(new Decimal(rules.max.value))) {
    return `${rules.label} is more than ${rules.max.what}.`;
  }
  return null;
}

/** Plain message for a date field (yyyy-mm-dd from <input type="date">), or null. */
export function dateMessage(
  raw: string | null | undefined,
  label: string,
  opts: { required?: boolean; notBefore?: { value: string; what: string } } = {},
): string | null {
  const s = (raw ?? '').trim();
  if (!s) return opts.required === false ? null : `Enter the ${label.toLowerCase()}.`;
  if (!DATE_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
    return `${label} isn't a real date. Pick one from the calendar.`;
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return `${label} isn't a real date. Pick one from the calendar.`;
  if (y < 1900 || y > 2200) return `${label} looks wrong (year ${y}).`;
  if (opts.notBefore && s < opts.notBefore.value) return `${label} can't be before ${opts.notBefore.what}.`;
  return null;
}

/** Build a FieldErrors object, dropping null messages. */
export function collectErrors(entries: Record<string, string | null | undefined>): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(entries)) if (v) out[k] = v;
  return out;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** One-line summary for the Save button / screen readers: "3 fields need fixing: …". */
export function errorSummary(errors: FieldErrors): string | null {
  const msgs = Object.values(errors);
  if (msgs.length === 0) return null;
  return msgs.length === 1 ? msgs[0] : `${msgs.length} fields need fixing. First: ${msgs[0]}`;
}

/** DOM id for a field's message (aria-describedby target). */
export function fieldErrorId(formId: string, key: string): string {
  return `${formId}-${key}-error`.replace(/[^A-Za-z0-9_-]/g, '-');
}
