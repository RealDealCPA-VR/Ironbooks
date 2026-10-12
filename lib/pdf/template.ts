/**
 * Shared form renderer: every customer/vendor form (invoice, estimate, sales receipt, credit memo,
 * sales order, purchase order, statement) prints through renderFormPdf, driven by a FormDesign
 * (lib/pdf/design.ts — the user's template) and a FormDocument (the document's data).
 *
 * New forms plug in by building a FormDocument and calling renderFormPdf (see lib/pdf/invoice.ts
 * for the pattern, and lib/pdf/forms.ts for loading the selected template + logo server-side).
 *
 * pdf-lib standard fonts only (Helvetica / Times / Courier): nothing is downloaded or embedded
 * from outside the app. Long descriptions wrap; long documents continue on new pages with the
 * column headings repeated; "Page x of y" and the footer print on every page.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb, PageSizes, type RGB } from 'pdf-lib';
import {
  MONEY_COLUMNS,
  NUMERIC_COLUMNS,
  defaultDesign,
  normalizeDesign,
  type FormDesign,
  type FormType,
} from './design';

export interface FormDocument {
  formType: FormType;
  company: {
    name: string;
    addressLines?: string[];
    phone?: string | null;
    email?: string | null;
  };
  /** Header field values keyed like FORM_FIELDS (number, date, dueDate, terms, …). */
  fields: Record<string, string | number | null | undefined>;
  /** Address blocks keyed like FORM_FIELDS (billTo, shipTo, vendor). */
  parties?: Record<string, string[] | null | undefined>;
  /** Line rows keyed by column key. Money columns may be numbers or decimal strings. */
  lines: Array<Record<string, string | number | null | undefined>>;
  totals: Array<{ label: string; value: string | number; emphasis?: 'total' | 'balance' }>;
  /** Printed under the lines when the 'memo' field is shown. */
  memo?: string | null;
  /** ISO currency for money formatting (default USD). */
  currency?: string;
}

export interface FormLogo {
  bytes: Uint8Array;
  mimeType: string;
}

const PARTY_KEYS = ['billTo', 'shipTo', 'vendor'];

const PAGE_W = PageSizes.Letter[0];
const PAGE_H = PageSizes.Letter[1];
const MARGIN = 48;
const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = RIGHT - MARGIN;
const FOOTER_RESERVE = 64;

const GRAY = rgb(0.45, 0.45, 0.5);
const LIGHT = rgb(0.9, 0.92, 0.95);
const BLACK = rgb(0, 0, 0);

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Lighten an accent for the balance band. */
function tint(hex: string, amount = 0.88): RGB {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => (v / 255) * (1 - amount) + amount;
  return rgb(ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255));
}

// WinAnsi (standard-font) safe text: keep Latin-1 + the WinAnsi extras; replace the rest.
const WINANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\t]/g, ' ')) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === '\n' || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WINANSI_EXTRAS.has(ch)) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

export function formatMoney(value: string | number | null | undefined, currency = 'USD'): string {
  const n = typeof value === 'string' ? parseFloat(value) : (value ?? 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number.isFinite(n) ? n : 0);
  } catch {
    return (Number.isFinite(n) ? n : 0).toFixed(2);
  }
}

/** Word-wrap text to a width (hard-breaking words longer than the width). */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        // hard-break an over-long token
        let i = w.length - 1;
        while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function fontsFor(design: FormDesign): [StandardFonts, StandardFonts] {
  switch (design.font) {
    case 'times':
      return [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold];
    case 'courier':
      return [StandardFonts.Courier, StandardFonts.CourierBold];
    default:
      return [StandardFonts.Helvetica, StandardFonts.HelveticaBold];
  }
}

function cellText(key: string, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (MONEY_COLUMNS.has(key)) return formatMoney(value as string | number, currency);
  if (key === 'quantity' || key === 'ordered') {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : String(value);
  }
  return String(value);
}

/**
 * Render a form. `design` may be a stored (unnormalized) design or omitted for the form's default
 * layout; `logo` is a PNG or JPEG from the company's attachment store.
 */
export async function renderFormPdf(
  doc: FormDocument,
  design?: FormDesign | Record<string, unknown> | null,
  logo?: FormLogo | null,
): Promise<Uint8Array> {
  const d = design ? normalizeDesign(doc.formType, design) : defaultDesign(doc.formType);
  const currency = doc.currency || 'USD';
  const pdf = await PDFDocument.create();
  const [regName, boldName] = fontsFor(d);
  const regular = await pdf.embedFont(regName);
  const bold = await pdf.embedFont(boldName);
  const accent = hexToRgb(d.accentColor);
  const ink = hexToRgb(d.textColor);
  const size = d.fontSize;

  let image: PDFImage | null = null;
  if (logo && logo.bytes.length > 0) {
    try {
      image = /png/i.test(logo.mimeType) ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
    } catch {
      image = null; // unreadable logo: print without it rather than fail the form
    }
  }

  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN;

  const text = (
    s: string,
    x: number,
    yy: number,
    opts: { font?: PDFFont; size?: number; color?: RGB; align?: 'left' | 'right' | 'center' } = {},
  ) => {
    const f = opts.font ?? regular;
    const sz = opts.size ?? size;
    const safe = pdfSafe(s);
    const w = f.widthOfTextAtSize(safe, sz);
    const xx = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    page.drawText(safe, { x: xx, y: yy, font: f, size: sz, color: opts.color ?? BLACK });
  };
  const rule = (yy: number, color: RGB = LIGHT, thickness = 0.75, x1 = MARGIN, x2 = RIGHT) =>
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });

  // ---------------- Header: logo + company block | title + meta fields ----------------
  const companySide = d.logoPosition;
  const headerTop = y;
  let leftY = headerTop;
  let companyX = companySide === 'left' ? MARGIN : RIGHT;
  const companyAlign = companySide === 'left' ? 'left' : 'right';
  if (image) {
    const scale = Math.min(110 / image.width, 56 / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    const ix = companySide === 'left' ? MARGIN : RIGHT - w;
    page.drawImage(image, { x: ix, y: headerTop - h + 10, width: w, height: h });
    leftY = headerTop - h - 4;
  }
  const companyLines: Array<{ s: string; font: PDFFont; size: number; color: RGB }> = [];
  if (d.showCompanyName) companyLines.push({ s: doc.company.name, font: bold, size: 16, color: ink });
  if (d.showCompanyAddress)
    for (const l of doc.company.addressLines ?? []) if (l) companyLines.push({ s: l, font: regular, size: size - 1, color: GRAY });
  if (d.showCompanyPhone && doc.company.phone) companyLines.push({ s: doc.company.phone, font: regular, size: size - 1, color: GRAY });
  if (d.showCompanyEmail && doc.company.email) companyLines.push({ s: doc.company.email, font: regular, size: size - 1, color: GRAY });
  for (const l of wrapText(d.headerText, regular, size - 1, CONTENT_W / 2)) {
    if (l) companyLines.push({ s: l, font: regular, size: size - 1, color: GRAY });
  }
  for (const l of companyLines) {
    leftY -= l.size + 3;
    text(l.s.slice(0, 70), companyX, leftY, { font: l.font, size: l.size, color: l.color, align: companyAlign });
  }

  // Title + meta on the opposite side.
  const metaX = companySide === 'left' ? RIGHT : MARGIN;
  const metaAlign = companySide === 'left' ? 'right' : 'left';
  let rightY = headerTop - 18;
  text(d.title, metaX, rightY, { font: bold, size: 18, color: accent, align: metaAlign });
  rightY -= 8;
  const metaKeys = Object.keys(d.fields).filter((k) => !PARTY_KEYS.includes(k) && k !== 'memo');
  for (const k of metaKeys) {
    const f = d.fields[k];
    const v = doc.fields[k];
    if (!f?.show || v === null || v === undefined || v === '') continue;
    rightY -= size + 4;
    const label = `${f.label}: `;
    const value = String(v);
    if (metaAlign === 'right') {
      const vw = bold.widthOfTextAtSize(pdfSafe(value), size);
      text(value, RIGHT, rightY, { font: bold, size, color: ink, align: 'right' });
      text(label, RIGHT - vw, rightY, { size, color: GRAY, align: 'right' });
    } else {
      const lw = regular.widthOfTextAtSize(pdfSafe(label), size);
      text(label, MARGIN, rightY, { size, color: GRAY });
      text(value, MARGIN + lw, rightY, { font: bold, size, color: ink });
    }
  }
  y = Math.min(leftY, rightY) - 22;

  // ---------------- Party blocks (Bill To / Ship To / Vendor) ----------------
  const parties = PARTY_KEYS.filter((k) => d.fields[k]?.show && (doc.parties?.[k]?.filter(Boolean).length ?? 0) > 0);
  if (parties.length > 0) {
    const colW = CONTENT_W / Math.max(parties.length, 2);
    let lowest = y;
    parties.forEach((k, i) => {
      const x = MARGIN + i * colW;
      let py = y;
      text(d.fields[k].label.toUpperCase(), x, py, { font: bold, size: 8, color: GRAY });
      for (const [j, l] of (doc.parties![k] ?? []).filter(Boolean).slice(0, 6).entries()) {
        py -= j === 0 ? size + 5 : size + 2;
        text(l.slice(0, 60), x, py, { font: j === 0 ? bold : regular, size: j === 0 ? size + 1 : size, color: j === 0 ? ink : BLACK });
      }
      lowest = Math.min(lowest, py);
    });
    y = lowest - 18;
  }

  // ---------------- Line table ----------------
  const cols = d.columns.filter((c) => c.show);
  const totalWidth = cols.reduce((s, c) => s + c.width, 0) || 1;
  const gap = 8;
  const colX: Array<{ key: string; label: string; x: number; w: number; numeric: boolean }> = [];
  let cx = MARGIN;
  for (const c of cols) {
    const w = (c.width / totalWidth) * CONTENT_W;
    colX.push({ key: c.key, label: c.label, x: cx, w, numeric: NUMERIC_COLUMNS.has(c.key) });
    cx += w;
  }

  const drawTableHeader = () => {
    rule(y + 10, accent, 1.5);
    y -= 4;
    for (const c of colX) {
      const lx = c.numeric ? c.x + c.w - (c === colX[colX.length - 1] ? 0 : gap) : c.x;
      text(c.label.toUpperCase(), lx, y, { font: bold, size: 8, color: GRAY, align: c.numeric ? 'right' : 'left' });
    }
    y -= 6;
    rule(y);
    y -= size + 6;
  };

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
    text(`${d.title} ${doc.fields.number != null ? `#${doc.fields.number}` : ''} (continued)`, MARGIN, y, {
      font: bold,
      size: size,
      color: GRAY,
    });
    y -= 26;
    drawTableHeader();
  };

  drawTableHeader();
  for (const line of doc.lines) {
    const cells = colX.map((c) => {
      const raw = cellText(c.key, line[c.key], currency);
      const width = c.w - gap;
      return c.numeric ? [pdfSafe(raw)] : wrapText(raw, regular, size, Math.max(width, 10));
    });
    const rowLines = Math.max(1, ...cells.map((ls) => ls.length));
    const rowH = rowLines * (size + 3) + 4;
    if (y - rowH < FOOTER_RESERVE + 20) newPage();
    colX.forEach((c, i) => {
      cells[i].forEach((l, j) => {
        const yy = y - j * (size + 3);
        if (c.numeric) {
          const rx = c.x + c.w - (i === colX.length - 1 ? 0 : gap);
          text(l, rx, yy, { size, align: 'right' });
        } else {
          text(l, c.x, yy, { size });
        }
      });
    });
    y -= rowH;
    rule(y + size - 1);
    y -= 2;
  }

  // ---------------- Totals ----------------
  const totalsNeeded = doc.totals.length * (size + 8) + 30;
  if (y - totalsNeeded < FOOTER_RESERVE) newPage();
  y -= 8;
  const labelX = MARGIN + CONTENT_W * 0.58;
  for (const t of doc.totals) {
    const value = formatMoney(t.value, currency);
    if (t.emphasis === 'balance') {
      page.drawRectangle({ x: labelX - 6, y: y - 5, width: RIGHT - labelX + 12, height: size + 10, color: tint(d.accentColor) });
      text(t.label, labelX, y, { font: bold, size: size + 1, color: accent });
      text(value, RIGHT, y, { font: bold, size: size + 1, color: accent, align: 'right' });
      y -= size + 14;
    } else if (t.emphasis === 'total') {
      rule(y + size + 2, ink, 0.75, labelX, RIGHT);
      y -= 2;
      text(t.label, labelX, y, { font: bold, size: size + 2, color: ink });
      text(value, RIGHT, y, { font: bold, size: size + 2, color: ink, align: 'right' });
      y -= size + 10;
    } else {
      text(t.label, labelX, y, { size, color: GRAY });
      text(value, RIGHT, y, { size, color: GRAY, align: 'right' });
      y -= size + 6;
    }
  }

  // ---------------- Memo / customer message ----------------
  if (d.fields.memo?.show && doc.memo) {
    const memoLines = wrapText(doc.memo, regular, size, CONTENT_W * 0.55);
    if (y - (memoLines.length + 2) * (size + 3) < FOOTER_RESERVE) newPage();
    y -= 6;
    text(d.fields.memo.label.toUpperCase(), MARGIN, y, { font: bold, size: 8, color: GRAY });
    for (const l of memoLines.slice(0, 20)) {
      y -= size + 3;
      text(l, MARGIN, y, { size });
    }
  }

  // ---------------- Footer + page numbers on every page ----------------
  const footerLines = d.footerText ? wrapText(d.footerText, regular, 8, CONTENT_W) .slice(0, 2) : [];
  pages.forEach((p, i) => {
    page = p;
    rule(46, LIGHT, 0.5);
    footerLines.forEach((l, j) => text(l, PAGE_W / 2, 34 - j * 10, { size: 8, color: GRAY, align: 'center' }));
    if (d.showPageNumbers && pages.length > 1) {
      text(`Page ${i + 1} of ${pages.length}`, RIGHT, 20, { size: 7, color: GRAY, align: 'right' });
    }
  });

  return pdf.save();
}

/** Sample document for template previews (the designer page). */
export function sampleFormDocument(formType: FormType, companyName = 'Your Company'): FormDocument {
  const company = {
    name: companyName,
    addressLines: ['123 Main Street', 'Springfield, IL 62701'],
    phone: '(555) 555-0100',
    email: 'billing@example.com',
  };
  if (formType === 'statement') {
    return {
      formType,
      company,
      fields: { date: '2026-06-30', period: '2026-06-01 to 2026-06-30' },
      parties: { billTo: ['Jane Customer', '456 Oak Ave', 'Springfield, IL 62702'] },
      lines: [
        { date: '2026-06-01', type: 'Balance forward', ref: '', charges: '', credits: '', balance: '250.00' },
        { date: '2026-06-05', type: 'Invoice', ref: '1001', charges: '1200.00', credits: '', balance: '1450.00' },
        { date: '2026-06-20', type: 'Payment', ref: 'CHK 2201', charges: '', credits: '250.00', balance: '1200.00' },
      ],
      totals: [{ label: 'Amount Due', value: '1200.00', emphasis: 'balance' }],
      memo: 'Thank you for your prompt payment.',
    };
  }
  const isPo = formType === 'purchase_order';
  return {
    formType,
    company,
    fields: {
      number: isPo ? 'PO-1042' : '1042',
      date: '2026-06-15',
      dueDate: '2026-07-15',
      expirationDate: '2026-07-15',
      expectedDate: '2026-06-30',
      terms: 'Net 30',
      poNumber: 'A-778',
      rep: 'JS',
      shipDate: '2026-06-16',
      shipVia: 'UPS Ground',
      fob: 'Origin',
      project: 'Kitchen remodel',
      method: 'Check',
      reference: '2201',
      status: 'Open',
    },
    parties: isPo
      ? { vendor: ['Acme Supply Co.', '9 Industrial Way', 'Peoria, IL 61602'], shipTo: [companyName, '123 Main Street'] }
      : {
          billTo: ['Jane Customer', '456 Oak Ave', 'Springfield, IL 62702'],
          shipTo: ['Jane Customer', '789 Job Site Rd', 'Springfield, IL 62703'],
        },
    lines: [
      { item: 'Consulting', description: 'Design consultation and site visit, including measurements and a written summary of recommendations', quantity: 4, unit: 'hr', rate: '125.00', amount: '500.00', ordered: 4, account: '6300', serviceDate: '2026-06-10' },
      { item: 'Cabinet', description: 'Maple base cabinet, 36 inch', quantity: 2, unit: 'ea', rate: '350.00', amount: '700.00', ordered: 2, account: '1300', serviceDate: '2026-06-12' },
    ],
    totals: [
      { label: 'Subtotal', value: '1200.00' },
      { label: 'Sales Tax', value: '96.00' },
      { label: 'Total', value: '1296.00', emphasis: 'total' },
      ...(formType === 'invoice' ? [{ label: 'Balance Due', value: '1296.00', emphasis: 'balance' as const }] : []),
    ],
    memo: 'Thank you for your business!',
  };
}
