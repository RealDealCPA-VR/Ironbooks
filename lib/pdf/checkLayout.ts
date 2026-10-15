/**
 * Check layout geometry (pure, no pdf-lib) — shared by the check PDF renderer, the check printer
 * setup service (validation) and the Print Checks page (field-position editor).
 *
 * Coordinates are inches. Every field position is measured from the TOP-LEFT corner of the check
 * itself (not the sheet): `x` is the left edge of the text (for the numeric amount it is the RIGHT
 * edge, since the amount is right-aligned against the amount box), `y` is the text baseline.
 *
 * Check widths: voucher / standard checks span the sheet (8.5"); a wallet check sits right of a
 * 2.25" register stub and is 6.25" wide, so its default date / amount positions differ.
 *
 * Sheets: a check occupies one "slot" `checkHeight` inches tall (default 3.5"). Slot i starts
 * i × checkHeight below the top of the sheet. Standard checks are packed three to a sheet;
 * voucher and wallet checks print one per sheet in the slot chosen by `position`
 * (top / middle / bottom), and voucher stubs fill the other slots.
 */

export type CheckFieldKey = 'date' | 'payee' | 'amount' | 'words' | 'memo' | 'address' | 'checkNumber' | 'company';
export const CHECK_FIELD_KEYS: CheckFieldKey[] = ['date', 'payee', 'amount', 'words', 'memo', 'address', 'checkNumber', 'company'];
/** Fields most pre-printed stock already carries (or that are only for window envelopes): off by default. */
export const OPTIONAL_CHECK_FIELDS: CheckFieldKey[] = ['address', 'checkNumber', 'company'];

export const CHECK_FIELD_LABELS: Record<CheckFieldKey, string> = {
  date: 'Date',
  payee: 'Pay to the order of (payee)',
  amount: 'Amount in numbers (right end)',
  words: 'Amount in words',
  memo: 'Memo',
  address: 'Payee address (window envelopes)',
  checkNumber: 'Check number',
  company: 'Your company name and address',
};

export interface CheckFieldPos {
  /** Inches from the check's left edge (amount: its right edge). */
  x: number;
  /** Inches from the check's top edge to the text baseline. */
  y: number;
  /** Font size in points. */
  size: number;
  /** Printed at all (only meaningful for the optional fields; the core fields always print). */
  show: boolean;
}
export type CheckLayout = Record<CheckFieldKey, CheckFieldPos>;
/** What is stored per company: only the fields / properties that differ from the defaults. */
export type CheckLayoutOverrides = Partial<Record<CheckFieldKey, Partial<CheckFieldPos>>>;

export type CheckPosition = 'top' | 'middle' | 'bottom';
export const CHECK_POSITIONS: CheckPosition[] = ['top', 'middle', 'bottom'];
export type CheckPageSize = 'letter' | 'legal';
export const CHECK_PAGE_SIZES: CheckPageSize[] = ['letter', 'legal'];
/** Sheet sizes in inches. */
export const PAGE_SIZE_IN: Record<CheckPageSize, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  legal: { w: 8.5, h: 14 },
};

export const DEFAULT_CHECK_HEIGHT_IN = 3.5;
export const MIN_CHECK_HEIGHT_IN = 2.75;
export const MAX_CHECK_HEIGHT_IN = 3.67;
export const CHECKS_PER_STANDARD_SHEET = 3;
export const WALLET_STUB_WIDTH_IN = 2.25;

/** Limits accepted for a field position. */
export const LAYOUT_LIMITS = {
  x: { min: 0, max: 8.5 },
  y: { min: 0, max: MAX_CHECK_HEIGHT_IN },
  size: { min: 6, max: 16 },
} as const;

type StyleLike = 'voucher' | 'standard' | 'wallet';

/** Width of the check itself (inches). */
export function checkWidthIn(style: StyleLike | string | null | undefined): number {
  return style === 'wallet' ? 8.5 - WALLET_STUB_WIDTH_IN : 8.5;
}

/**
 * QB's field positions on pre-printed check paper (the historical PREPRINTED_FIELDS, with the
 * date / amount positions converted from right-edge-relative to left-edge-relative for the
 * style's check width). Existing companies with no saved layout print exactly here.
 */
export function defaultCheckLayout(style: StyleLike | string | null | undefined): CheckLayout {
  const w = checkWidthIn(style);
  return {
    date: { x: round3(w - 1.85), y: 0.82, size: 10, show: true },
    payee: { x: 0.95, y: 1.32, size: 10, show: true },
    amount: { x: round3(w - 0.45), y: 1.32, size: 10, show: true },
    words: { x: 0.35, y: 1.68, size: 10, show: true },
    memo: { x: 0.55, y: 2.72, size: 9, show: true },
    address: { x: 0.95, y: 1.95, size: 9, show: false },
    checkNumber: { x: round3(w - 1.0), y: 0.45, size: 10, show: false },
    company: { x: 0.35, y: 0.45, size: 10, show: false },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Defaults for the style with the saved overrides on top. */
export function resolveCheckLayout(
  style: StyleLike | string | null | undefined,
  overrides?: CheckLayoutOverrides | null,
): CheckLayout {
  const out = defaultCheckLayout(style);
  if (!overrides || typeof overrides !== 'object') return out;
  for (const k of CHECK_FIELD_KEYS) {
    const o = overrides[k];
    if (!o || typeof o !== 'object') continue;
    const f = out[k];
    if (typeof o.x === 'number' && Number.isFinite(o.x)) f.x = clamp(o.x, LAYOUT_LIMITS.x.min, LAYOUT_LIMITS.x.max);
    if (typeof o.y === 'number' && Number.isFinite(o.y)) f.y = clamp(o.y, LAYOUT_LIMITS.y.min, LAYOUT_LIMITS.y.max);
    if (typeof o.size === 'number' && Number.isFinite(o.size)) f.size = clamp(o.size, LAYOUT_LIMITS.size.min, LAYOUT_LIMITS.size.max);
    if (typeof o.show === 'boolean' && OPTIONAL_CHECK_FIELDS.includes(k)) f.show = o.show;
  }
  return out;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Only what differs from the style defaults (null when nothing does). */
export function diffCheckLayout(
  style: StyleLike | string | null | undefined,
  layout: CheckLayoutOverrides | null | undefined,
): CheckLayoutOverrides | null {
  if (!layout) return null;
  const resolved = resolveCheckLayout(style, layout);
  const defaults = defaultCheckLayout(style);
  const out: CheckLayoutOverrides = {};
  for (const k of CHECK_FIELD_KEYS) {
    const d: Partial<CheckFieldPos> = {};
    for (const p of ['x', 'y', 'size', 'show'] as const) {
      if (resolved[k][p] !== defaults[k][p]) (d as Record<string, unknown>)[p] = resolved[k][p];
    }
    if (Object.keys(d).length > 0) out[k] = d;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export type LayoutValidation = { ok: true; value: CheckLayoutOverrides | null } | { ok: false; error: string };

/**
 * Validate a layout from the client: known fields and properties only, numbers in range,
 * `show` only on the optional fields. Numeric strings are accepted (form inputs).
 */
export function validateCheckLayout(input: unknown): LayoutValidation {
  if (input == null) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Field positions must be an object.' };
  const out: CheckLayoutOverrides = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!CHECK_FIELD_KEYS.includes(key as CheckFieldKey)) return { ok: false, error: `Unknown check field "${key}".` };
    const k = key as CheckFieldKey;
    if (raw == null) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${CHECK_FIELD_LABELS[k]}: expected a position.` };
    const field: Partial<CheckFieldPos> = {};
    for (const [prop, v] of Object.entries(raw as Record<string, unknown>)) {
      if (prop === 'show') {
        if (!OPTIONAL_CHECK_FIELDS.includes(k)) return { ok: false, error: `${CHECK_FIELD_LABELS[k]} is always printed.` };
        if (typeof v !== 'boolean') return { ok: false, error: `${CHECK_FIELD_LABELS[k]}: show must be true or false.` };
        field.show = v;
        continue;
      }
      if (prop !== 'x' && prop !== 'y' && prop !== 'size') {
        return { ok: false, error: `${CHECK_FIELD_LABELS[k]}: unknown setting "${prop}".` };
      }
      if (v == null || v === '') continue;
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
      const lim = LAYOUT_LIMITS[prop];
      if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
        const what = prop === 'x' ? 'Across' : prop === 'y' ? 'Down' : 'Font size';
        const unit = prop === 'size' ? ' pt' : '"';
        return { ok: false, error: `${CHECK_FIELD_LABELS[k]}: ${what} must be between ${lim.min}${unit} and ${lim.max}${unit}.` };
      }
      field[prop] = prop === 'size' ? Math.round(n * 10) / 10 : round3(n);
    }
    if (Object.keys(field).length > 0) out[k] = field;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

/** Clamp a check height (inches) into the supported range; invalid → default. */
export function normalizeCheckHeight(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CHECK_HEIGHT_IN;
  return clamp(n, MIN_CHECK_HEIGHT_IN, MAX_CHECK_HEIGHT_IN);
}

/** Inches from the top of the sheet to the top of the given slot (0, 1, 2). */
export function slotTopIn(slot: number, checkHeight: number): number {
  return slot * checkHeight;
}

export function positionSlot(position: CheckPosition | string | null | undefined): number {
  return position === 'middle' ? 1 : position === 'bottom' ? 2 : 0;
}

export interface CheckPlacement {
  /** 0-based sheet (PDF page) index. */
  sheet: number;
  /** 0-based slot on that sheet (0 = top third). */
  slot: number;
}

/**
 * Where each of `count` checks goes. Standard checks: three per sheet, the first sheet starting
 * below the `3 - firstSheetRemaining` checks already used (they are at the top of the sheet).
 * Voucher / wallet checks: one per sheet in the `position` slot.
 */
export function planCheckSheets(
  count: number,
  opts: { style: StyleLike | string | null | undefined; position?: CheckPosition | string | null; firstSheetRemaining?: number | null },
): CheckPlacement[] {
  const out: CheckPlacement[] = [];
  if (opts.style === 'standard') {
    const used = CHECKS_PER_STANDARD_SHEET - normalizeFirstSheetRemaining(opts.firstSheetRemaining);
    for (let i = 0; i < count; i++) {
      const n = i + used;
      out.push({ sheet: Math.floor(n / CHECKS_PER_STANDARD_SHEET), slot: n % CHECKS_PER_STANDARD_SHEET });
    }
    return out;
  }
  const slot = positionSlot(opts.position);
  for (let i = 0; i < count; i++) out.push({ sheet: i, slot });
  return out;
}

export function normalizeFirstSheetRemaining(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return n === 1 || n === 2 || n === 3 ? n : CHECKS_PER_STANDARD_SHEET;
}
