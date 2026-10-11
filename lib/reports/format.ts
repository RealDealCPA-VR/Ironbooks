/**
 * Report fonts & number formats (QB "Customize Report → Fonts & Numbers").
 *
 * PURE module. Formatting is done on the decimal STRING (no float round-trip for the digits), so
 * large amounts never pick up binary-float noise. Options:
 *  - thousands separators on/off
 *  - negative style: -1.00, (1.00) or 1.00-
 *  - red negatives
 *  - without cents (rounds half-up to whole dollars)
 *  - divide by 1000 (shows amounts in thousands)
 *  - font family / size for the on-screen and printed report
 */
import type { CellValue, ColumnType } from './types';

export type NegativeStyle = 'minus' | 'parens' | 'trailing';

export interface NumberFormat {
  thousands: boolean;
  negative: NegativeStyle;
  redNegatives: boolean;
  withoutCents: boolean;
  divideBy1000: boolean;
  /** Show zero amounts as blank (QB "Show zero amounts as" off). */
  hideZero: boolean;
  /** Prefix money with the currency symbol. */
  currencySymbol: boolean;
  font: 'sans' | 'serif' | 'mono';
  fontSize: 'sm' | 'md' | 'lg';
}

export const DEFAULT_NUMBER_FORMAT: NumberFormat = {
  thousands: true,
  negative: 'minus',
  redNegatives: false,
  withoutCents: false,
  divideBy1000: false,
  hideZero: false,
  currencySymbol: false,
  font: 'sans',
  fontSize: 'md',
};

/** Merge a partial (e.g. from a memorized report) over the defaults, ignoring junk. */
export function normalizeNumberFormat(input: unknown): NumberFormat {
  const out = { ...DEFAULT_NUMBER_FORMAT };
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  for (const k of ['thousands', 'redNegatives', 'withoutCents', 'divideBy1000', 'hideZero', 'currencySymbol'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  if (o.negative === 'minus' || o.negative === 'parens' || o.negative === 'trailing') out.negative = o.negative;
  if (o.font === 'sans' || o.font === 'serif' || o.font === 'mono') out.font = o.font;
  if (o.fontSize === 'sm' || o.fontSize === 'md' || o.fontSize === 'lg') out.fontSize = o.fontSize;
  return out;
}

/** Split a decimal string into sign / integer digits / fraction digits. */
function parseDecimal(s: string): { neg: boolean; int: string; frac: string } | null {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?\s*$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  return { neg: m[1] === '-', int: m[2] || '0', frac: m[3] ?? '' };
}

/** Add one unit to a digit string (for half-up rounding). */
function incDigits(d: string): string {
  const a = d.split('');
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] === '9') {
      a[i] = '0';
      i--;
    } else {
      a[i] = String(Number(a[i]) + 1);
      return a.join('');
    }
  }
  return '1' + a.join('');
}

/** Round a decimal string to `places` fraction digits, half-up (away from zero). */
export function roundDecimalString(s: string, places: number): string {
  const p = parseDecimal(s);
  if (!p) return s;
  const frac = (p.frac + '0'.repeat(places + 1)).slice(0, places + 1);
  let digits = p.int + frac.slice(0, places);
  if (Number(frac[places]) >= 5) digits = incDigits(digits);
  const intPart = digits.slice(0, digits.length - places).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = places > 0 ? digits.slice(digits.length - places) : '';
  const isZero = /^0*$/.test(intPart + fracPart);
  return `${p.neg && !isZero ? '-' : ''}${intPart}${places > 0 ? '.' + fracPart : ''}`;
}

/** Divide a decimal string by 1000 exactly (shift the point). */
function shiftThousands(s: string): string {
  const p = parseDecimal(s);
  if (!p) return s;
  const int = p.int.padStart(4, '0');
  return `${p.neg ? '-' : ''}${int.slice(0, -3)}.${int.slice(-3)}${p.frac}`;
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormattedCell {
  text: string;
  negative: boolean;
}

/** Format a money/number cell value per the options. Non-numeric values pass through. */
export function formatAmount(value: CellValue, fmt: NumberFormat, type: ColumnType = 'money'): FormattedCell {
  if (value === null || value === '') return { text: '', negative: false };
  let s = typeof value === 'number' ? String(value) : value;
  if (!parseDecimal(s)) return { text: s, negative: false };
  if (type === 'percent') {
    const r = roundDecimalString(s, 1);
    const neg = r.startsWith('-');
    return { text: `${r}%`, negative: neg };
  }
  if (type === 'money' && fmt.divideBy1000) s = shiftThousands(s);
  const places = type === 'number' ? Math.min(4, (parseDecimal(s)!.frac.replace(/0+$/, '')).length) : fmt.withoutCents ? 0 : 2;
  const rounded = roundDecimalString(s, places);
  const p = parseDecimal(rounded)!;
  const isZero = /^0*$/.test(p.int + p.frac);
  if (isZero && fmt.hideZero && type === 'money') return { text: '', negative: false };
  const int = fmt.thousands ? groupThousands(p.int) : p.int;
  const body = `${type === 'money' && fmt.currencySymbol ? '$' : ''}${int}${places > 0 ? '.' + p.frac : ''}`;
  if (!p.neg) return { text: body, negative: false };
  const text = fmt.negative === 'parens' ? `(${body})` : fmt.negative === 'trailing' ? `${body}-` : `-${body}`;
  return { text, negative: true };
}

export const FONT_CLASS: Record<NumberFormat['font'], string> = {
  sans: 'font-sans',
  serif: 'font-serif',
  mono: 'font-mono',
};

export const FONT_SIZE_CLASS: Record<NumberFormat['fontSize'], string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
};
