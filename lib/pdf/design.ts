/**
 * Form template designs (QB "Templates" list + Basic Customization / Layout Designer).
 *
 * Pure module (no pdf-lib, no DB) shared by the template renderer (lib/pdf/template.ts), the
 * form-templates service and the template designer page (app/templates).
 *
 * A design says HOW a form prints: title, font, colors, which header fields and line columns
 * appear and with what labels, header/footer text and the logo position. WHAT prints (the
 * document's numbers) comes from the FormDocument the per-form builders produce.
 */
import { FORM_TYPES, FORM_TYPE_LABELS, type FormType } from '@/lib/preferences';

export { FORM_TYPES, FORM_TYPE_LABELS, type FormType };

export type FormFont = 'helvetica' | 'times' | 'courier';

export interface FieldSetting {
  show: boolean;
  label: string;
}

export interface ColumnSetting {
  key: string;
  label: string;
  show: boolean;
  /** Relative width (any positive number; columns share the page width proportionally). */
  width: number;
}

export interface FormDesign {
  title: string;
  font: FormFont;
  /** Body text size in points (8–12). */
  fontSize: number;
  /** '#rrggbb' — title, rules and the balance band. */
  accentColor: string;
  /** '#rrggbb' — company name and totals. */
  textColor: string;
  showCompanyName: boolean;
  showCompanyAddress: boolean;
  showCompanyPhone: boolean;
  showCompanyEmail: boolean;
  logoPosition: 'left' | 'right';
  /** Header fields (number, date, due date, terms, P.O. number, ship via, …) keyed by field key. */
  fields: Record<string, FieldSetting>;
  /** Line-item columns in print order. */
  columns: ColumnSetting[];
  /** Extra text printed under the company block (e.g. license number, tagline). */
  headerText: string;
  /** Text printed at the bottom of every page (e.g. thank-you note, remit-to). */
  footerText: string;
  showPageNumbers: boolean;
}

/** Header fields each form offers (key → default label), in print order. */
export const FORM_FIELDS: Record<FormType, Array<[key: string, label: string]>> = {
  invoice: [
    ['number', 'Invoice #'],
    ['date', 'Date'],
    ['dueDate', 'Due Date'],
    ['terms', 'Terms'],
    ['poNumber', 'P.O. Number'],
    ['rep', 'Rep'],
    ['shipDate', 'Ship Date'],
    ['shipVia', 'Ship Via'],
    ['fob', 'F.O.B.'],
    ['project', 'Project'],
    ['billTo', 'Bill To'],
    ['shipTo', 'Ship To'],
    ['memo', 'Customer Message'],
  ],
  estimate: [
    ['number', 'Estimate #'],
    ['date', 'Date'],
    ['expirationDate', 'Expires'],
    ['rep', 'Rep'],
    ['project', 'Project'],
    ['billTo', 'Prepared For'],
    ['memo', 'Customer Message'],
  ],
  sales_receipt: [
    ['number', 'Sale #'],
    ['date', 'Date'],
    ['method', 'Payment Method'],
    ['reference', 'Check / Ref #'],
    ['billTo', 'Sold To'],
    ['memo', 'Customer Message'],
  ],
  credit_memo: [
    ['number', 'Credit #'],
    ['date', 'Date'],
    ['poNumber', 'P.O. Number'],
    ['billTo', 'Customer'],
    ['memo', 'Customer Message'],
  ],
  sales_order: [
    ['number', 'S.O. #'],
    ['date', 'Date'],
    ['poNumber', 'P.O. Number'],
    ['shipVia', 'Ship Via'],
    ['billTo', 'Bill To'],
    ['shipTo', 'Ship To'],
    ['memo', 'Customer Message'],
  ],
  purchase_order: [
    ['number', 'P.O. #'],
    ['date', 'Date'],
    ['expectedDate', 'Expected'],
    ['status', 'Status'],
    ['shipVia', 'Ship Via'],
    ['fob', 'F.O.B.'],
    ['vendor', 'Vendor'],
    ['shipTo', 'Ship To'],
    ['memo', 'Memo'],
  ],
  statement: [
    ['date', 'Statement Date'],
    ['period', 'Period'],
    ['billTo', 'To'],
    ['memo', 'Message'],
  ],
};

/** Line columns each form offers (key, label, default shown, width). */
export const FORM_COLUMNS: Record<FormType, Array<[string, string, boolean, number]>> = {
  invoice: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 5],
    ['quantity', 'Qty', true, 1.2],
    ['unit', 'U/M', false, 1],
    ['rate', 'Rate', true, 1.6],
    ['serviceDate', 'Serviced', false, 1.6],
    ['amount', 'Amount', true, 1.8],
  ],
  estimate: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 5],
    ['quantity', 'Qty', true, 1.2],
    ['rate', 'Rate', true, 1.6],
    ['amount', 'Total', true, 1.8],
  ],
  sales_receipt: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 5],
    ['quantity', 'Qty', true, 1.2],
    ['rate', 'Rate', true, 1.6],
    ['amount', 'Amount', true, 1.8],
  ],
  credit_memo: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 5],
    ['quantity', 'Qty', true, 1.2],
    ['rate', 'Rate', true, 1.6],
    ['amount', 'Amount', true, 1.8],
  ],
  sales_order: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 5],
    ['ordered', 'Ordered', true, 1.2],
    ['rate', 'Rate', true, 1.6],
    ['amount', 'Amount', true, 1.8],
  ],
  purchase_order: [
    ['item', 'Item', false, 2],
    ['description', 'Description', true, 4.5],
    ['account', 'Account', true, 1.4],
    ['quantity', 'Qty', true, 1.1],
    ['rate', 'Rate', true, 1.5],
    ['amount', 'Amount', true, 1.7],
  ],
  statement: [
    ['date', 'Date', true, 1.6],
    ['type', 'Transaction', true, 2],
    ['ref', 'Ref #', true, 1.6],
    ['charges', 'Charges', true, 1.6],
    ['credits', 'Credits', true, 1.6],
    ['balance', 'Balance', true, 1.8],
  ],
};

/** Columns rendered as money and right-aligned. */
export const MONEY_COLUMNS = new Set(['rate', 'amount', 'charges', 'credits', 'balance']);
/** Columns right-aligned (numbers). */
export const NUMERIC_COLUMNS = new Set([...MONEY_COLUMNS, 'quantity', 'ordered']);

const ACCENTS: Record<FormType, string> = {
  invoice: '#3378f5',
  estimate: '#0d998c',
  sales_receipt: '#2f855a',
  credit_memo: '#c05621',
  sales_order: '#6b46c1',
  purchase_order: '#d96b14',
  statement: '#7b3fa0',
};

const DEFAULT_FOOTERS: Record<FormType, string> = {
  invoice: 'Thank you for your business.',
  estimate: 'We look forward to working with you.',
  sales_receipt: 'Thank you for your business.',
  credit_memo: '',
  sales_order: 'Thank you for your order.',
  purchase_order: 'Please reference this P.O. number on all invoices and packages.',
  statement: 'Please remit payment for any balance due.',
};

/** Fields shown by default (the rest are available but hidden). */
const DEFAULT_SHOWN_FIELDS = new Set([
  'number',
  'date',
  'dueDate',
  'terms',
  'expirationDate',
  'expectedDate',
  'method',
  'reference',
  'billTo',
  'shipTo',
  'vendor',
  'memo',
  'period',
]);

export function defaultDesign(formType: FormType): FormDesign {
  return {
    title: FORM_TYPE_LABELS[formType].toUpperCase(),
    font: 'helvetica',
    fontSize: 10,
    accentColor: ACCENTS[formType],
    textColor: '#171f45',
    showCompanyName: true,
    showCompanyAddress: true,
    showCompanyPhone: true,
    showCompanyEmail: false,
    logoPosition: 'left',
    fields: Object.fromEntries(
      FORM_FIELDS[formType].map(([key, label]) => [key, { show: DEFAULT_SHOWN_FIELDS.has(key), label }]),
    ),
    columns: FORM_COLUMNS[formType].map(([key, label, show, width]) => ({ key, label, show, width })),
    headerText: '',
    footerText: DEFAULT_FOOTERS[formType],
    showPageNumbers: true,
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function str(v: unknown, fallback: string, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Normalize a stored/submitted design against the form's defaults: unknown fields/columns are
 * dropped, missing ones are added (hidden for columns added after the template was saved), bad
 * colors/fonts fall back. Always returns a complete, safe design.
 */
export function normalizeDesign(formType: FormType, raw: unknown): FormDesign {
  const def = defaultDesign(formType);
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const fields: Record<string, FieldSetting> = {};
  const rf = (r.fields && typeof r.fields === 'object' ? r.fields : {}) as Record<string, unknown>;
  for (const [key, d] of Object.entries(def.fields)) {
    const f = (rf[key] && typeof rf[key] === 'object' ? rf[key] : {}) as Record<string, unknown>;
    fields[key] = { show: bool(f.show, d.show), label: str(f.label, d.label, 40) || d.label };
  }
  const known = new Map(def.columns.map((c) => [c.key, c]));
  const columns: ColumnSetting[] = [];
  if (Array.isArray(r.columns)) {
    for (const c of r.columns as Array<Record<string, unknown>>) {
      const k = typeof c?.key === 'string' ? c.key : '';
      const d = known.get(k);
      if (!d || columns.some((x) => x.key === k)) continue;
      const width = typeof c.width === 'number' && c.width > 0 && c.width <= 20 ? c.width : d.width;
      columns.push({ key: k, label: str(c.label, d.label, 30) || d.label, show: bool(c.show, d.show), width });
    }
  }
  for (const d of def.columns) {
    if (!columns.some((c) => c.key === d.key)) columns.push({ ...d, show: Array.isArray(r.columns) ? false : d.show });
  }
  if (!columns.some((c) => c.show)) columns[0].show = true;
  const fontSize = typeof r.fontSize === 'number' && r.fontSize >= 8 && r.fontSize <= 12 ? r.fontSize : def.fontSize;
  return {
    title: str(r.title, def.title, 40) || def.title,
    font: r.font === 'times' || r.font === 'courier' || r.font === 'helvetica' ? r.font : def.font,
    fontSize,
    accentColor: typeof r.accentColor === 'string' && HEX_RE.test(r.accentColor) ? r.accentColor : def.accentColor,
    textColor: typeof r.textColor === 'string' && HEX_RE.test(r.textColor) ? r.textColor : def.textColor,
    showCompanyName: bool(r.showCompanyName, def.showCompanyName),
    showCompanyAddress: bool(r.showCompanyAddress, def.showCompanyAddress),
    showCompanyPhone: bool(r.showCompanyPhone, def.showCompanyPhone),
    showCompanyEmail: bool(r.showCompanyEmail, def.showCompanyEmail),
    logoPosition: r.logoPosition === 'right' ? 'right' : 'left',
    fields,
    columns,
    headerText: str(r.headerText, def.headerText, 500),
    footerText: str(r.footerText, def.footerText, 500),
    showPageNumbers: bool(r.showPageNumbers, def.showPageNumbers),
  };
}

export function isFormType(v: unknown): v is FormType {
  return typeof v === 'string' && (FORM_TYPES as readonly string[]).includes(v);
}
