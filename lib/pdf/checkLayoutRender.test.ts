/**
 * Check printing on any stock — rendering: custom field positions move the printed fields,
 * middle / bottom check positions, standard checks three per sheet (with a partly used first
 * sheet), batches in one PDF, optional fields, Legal paper, blank stock in any slot.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { PREPRINTED_FIELDS, renderCheckPdf, renderChecksPdf, type CheckPdfData } from './check';

/** Every text string drawn in the PDF with its position, in drawing order (all pages). */
function drawnText(bytes: Uint8Array): Array<{ text: string; x: number; y: number }> {
  const raw = Buffer.from(bytes).toString('latin1');
  const out: Array<{ text: string; x: number; y: number }> = [];
  // pdf-lib writes 'stream\n…\nendstream'; a compressed stream may itself end in a \r byte, so
  // don't treat \r as part of the delimiter.
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      content = m[1];
    }
    for (const b of content.split('BT').slice(1)) {
      const pos = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td/.exec(b) ?? /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/.exec(b);
      for (const t of b.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        out.push({ text: Buffer.from(t[1], 'hex').toString('latin1'), x: pos ? Number(pos[1]) : NaN, y: pos ? Number(pos[2]) : NaN });
      }
    }
  }
  return out;
}

const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
const pageSize = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).getSize();

const base: CheckPdfData = {
  company: { name: 'Acme Books LLC', addressLines: ['1 Main St', 'Springfield, IL 62701'] },
  payee: 'Office Depot',
  payeeAddress: ['500 Supply Rd', 'Boca Raton, FL 33496'],
  amountNumeric: '250.00',
  date: '2026-10-15',
  memo: 'Toner',
  checkNumber: '2001',
  voucher: [{ account: '6100 – Office Supplies', description: 'Toner', amount: '250.00' }],
};
const find = (t: Array<{ text: string; x: number; y: number }>, s: string) => t.filter((x) => x.text === s);

describe('field positions', () => {
  it('defaults are unchanged: date / payee / words / memo where PREPRINTED_FIELDS puts them', async () => {
    const F = PREPRINTED_FIELDS;
    const t = drawnText(await renderCheckPdf({ ...base, style: 'standard' }));
    expect(find(t, '2026-10-15')[0].x).toBeCloseTo((8.5 - F.dateFromRight) * 72, 1);
    expect(find(t, '2026-10-15')[0].y).toBeCloseTo(792 - F.dateTop * 72, 1);
    expect(find(t, 'Office Depot')[0].x).toBeCloseTo(F.payeeX * 72, 1);
    expect(find(t, 'Toner')[0]).toMatchObject({ x: expect.closeTo(F.memoX * 72, 1), y: expect.closeTo(792 - F.memoTop * 72, 1) });
    const words = t.find((x) => x.text.startsWith('Two Hundred Fifty and 00/100'))!;
    expect(words.x).toBeCloseTo(F.wordsX * 72, 1);
    // Optional fields stay off: no address, check number or company name on pre-printed stock.
    const all = t.map((x) => x.text).join('|');
    for (const s of ['500 Supply Rd', '2001', 'Acme Books LLC', '1 Main St']) expect(all).not.toContain(s);
  });

  it('layout overrides move each field (inches from the check top-left) and change the font size', async () => {
    const bytes = await renderCheckPdf({
      ...base,
      style: 'standard',
      layout: { payee: { x: 1.5, y: 1.25 }, date: { x: 6, y: 0.7 }, memo: { x: 0.8, y: 2.5, size: 12 }, words: { x: 0.5 } },
    });
    const t = drawnText(bytes);
    expect(find(t, 'Office Depot')[0]).toMatchObject({ x: expect.closeTo(108, 1), y: expect.closeTo(792 - 90, 1) });
    expect(find(t, '2026-10-15')[0]).toMatchObject({ x: expect.closeTo(432, 1), y: expect.closeTo(792 - 50.4, 1) });
    expect(find(t, 'Toner')[0]).toMatchObject({ x: expect.closeTo(57.6, 1), y: expect.closeTo(792 - 180, 1) });
    expect(t.find((x) => x.text.startsWith('Two Hundred'))!.x).toBeCloseTo(36, 1);
    // Memo printed at the overridden 12 pt.
    const raw = Buffer.from(bytes).toString('latin1');
    const content = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)]
      .map((m) => {
        try {
          return zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        } catch {
          return '';
        }
      })
      .join('\n');
    const memoBlock = content.split('BT').find((b) => b.includes(Buffer.from('Toner').toString('hex').toUpperCase()))!;
    expect(memoBlock).toMatch(/ 12 Tf/);
  });

  it('wallet checks measure from the wallet check (right of the 2.25" register stub)', async () => {
    const t = drawnText(await renderCheckPdf({ ...base, style: 'wallet', layout: { payee: { x: 1 } } }));
    expect(find(t, 'Office Depot').some((x) => Math.abs(x.x - (2.25 + 1) * 72) < 1)).toBe(true);
    // Default wallet date: 1.85" from the wallet check's right edge (= the sheet's right edge).
    expect(find(t, '2026-10-15').some((x) => Math.abs(x.x - (8.5 - 1.85) * 72) < 1)).toBe(true);
  });

  it('optional fields: payee address, check number, company name/address when switched on', async () => {
    const t = drawnText(
      await renderCheckPdf({
        ...base,
        style: 'standard',
        layout: { address: { show: true, x: 1, y: 2 }, checkNumber: { show: true, x: 7.4, y: 0.4 }, company: { show: true } },
      }),
    );
    const addr = find(t, '500 Supply Rd')[0];
    expect(addr.x).toBeCloseTo(72, 1);
    // First address line is the payee name on the baseline; street on the next line.
    expect(find(t, 'Office Depot').some((x) => Math.abs(x.y - (792 - 144)) < 0.5)).toBe(true);
    expect(addr.y).toBeLessThan(792 - 144);
    expect(find(t, 'Boca Raton, FL 33496')).toHaveLength(1);
    expect(find(t, '2001')[0]).toMatchObject({ x: expect.closeTo(7.4 * 72, 1), y: expect.closeTo(792 - 0.4 * 72, 1) });
    expect(find(t, 'Acme Books LLC')).toHaveLength(1);
    expect(find(t, '1 Main St')).toHaveLength(1);
  });
});

describe('check position on the sheet', () => {
  it.each([
    ['top', 0],
    ['middle', 3.5],
    ['bottom', 7],
  ] as const)('voucher check at the %s: fields shift down by the slot, stubs fill the other two thirds', async (position, slotTop) => {
    const bytes = await renderCheckPdf({ ...base, style: 'voucher', position });
    expect(await pageCount(bytes)).toBe(1);
    const t = drawnText(bytes);
    const payee = find(t, 'Office Depot')[0];
    expect(payee.y).toBeCloseTo(792 - (slotTop + PREPRINTED_FIELDS.payeeTop) * 72, 1);
    const stubs = find(t, 'VOUCHER');
    expect(stubs).toHaveLength(2);
    // No stub inside the check's own third.
    for (const s of stubs) expect(s.y > 792 - slotTop * 72 || s.y < 792 - (slotTop + 3.5) * 72).toBe(true);
  });

  it('check height changes where the middle / bottom slot starts', async () => {
    const t = drawnText(await renderCheckPdf({ ...base, style: 'voucher', position: 'bottom', checkHeight: '3.25' }));
    expect(find(t, 'Office Depot')[0].y).toBeCloseTo(792 - (6.5 + PREPRINTED_FIELDS.payeeTop) * 72, 1);
  });

  it('Legal paper', async () => {
    const bytes = await renderCheckPdf({ ...base, style: 'voucher', pageSize: 'legal', position: 'middle' });
    expect(await pageSize(bytes)).toEqual({ width: 612, height: 1008 });
    expect(find(drawnText(bytes), 'Office Depot')[0].y).toBeCloseTo(1008 - (3.5 + 1.32) * 72, 1);
  });

  it('alignment offsets still shift the whole page', async () => {
    const bytes = await renderCheckPdf({ ...base, style: 'voucher', position: 'middle', offset: { x: '0.25', y: '0.1' } });
    const raw = Buffer.from(bytes).toString('latin1');
    const inflated = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)]
      .map((m) => {
        try {
          return zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        } catch {
          return m[1];
        }
      })
      .join('\n');
    expect(inflated).toMatch(/1 0 0 1 18 7\.2 cm/);
  });
});

describe('batches in one PDF', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...base, payee: `Payee ${i + 1}`, checkNumber: String(3000 + i) }));

  it('standard: three per sheet, ceil((n + used) / 3) sheets honouring the checks left on the first sheet', async () => {
    for (const [n, remaining] of [[1, 3], [3, 3], [4, 3], [7, 3], [1, 1], [2, 1], [4, 2], [5, 1]] as const) {
      const bytes = await renderChecksPdf(many(n), { style: 'standard', firstSheetRemaining: remaining });
      expect(await pageCount(bytes)).toBe(Math.ceil((n + 3 - remaining) / 3));
      const t = drawnText(bytes);
      for (let i = 1; i <= n; i++) expect(find(t, `Payee ${i}`)).toHaveLength(1);
    }
  });

  it('standard: the three checks on a sheet are one check height apart; a partly used sheet starts lower', async () => {
    const t = drawnText(await renderChecksPdf(many(3), { style: 'standard' }));
    const ys = [1, 2, 3].map((i) => find(t, `Payee ${i}`)[0].y);
    expect(ys[0]).toBeCloseTo(792 - 1.32 * 72, 1);
    expect(ys[0] - ys[1]).toBeCloseTo(252, 1);
    expect(ys[1] - ys[2]).toBeCloseTo(252, 1);

    const partial = drawnText(await renderChecksPdf(many(1), { style: 'standard', firstSheetRemaining: 1 }));
    expect(find(partial, 'Payee 1')[0].y).toBeCloseTo(792 - (7 + 1.32) * 72, 1);
  });

  it('voucher and wallet: one check per sheet', async () => {
    expect(await pageCount(await renderChecksPdf(many(4), { style: 'voucher', position: 'bottom' }))).toBe(4);
    expect(await pageCount(await renderChecksPdf(many(2), { style: 'wallet', firstSheetRemaining: 1 }))).toBe(2);
  });

  it('blank stock works three per sheet and in the middle slot (full check inside its slot, no MICR)', async () => {
    const bytes = await renderChecksPdf(many(3), { style: 'standard', stock: 'blank' });
    expect(await pageCount(bytes)).toBe(1);
    const t = drawnText(bytes);
    expect(find(t, 'Pay to the Order of')).toHaveLength(3);
    expect(find(t, 'Authorized Signature')).toHaveLength(3);
    // Every check's text stays inside its own 3.5" slot.
    for (let i = 0; i < 3; i++) {
      const top = 792 - i * 252;
      const bottom = top - 252;
      const label = find(t, 'Pay to the Order of')[i];
      expect(label.y).toBeLessThan(top);
      expect(label.y).toBeGreaterThan(bottom);
      expect(find(t, 'Authorized Signature')[i].y).toBeGreaterThan(bottom);
    }
    const mid = drawnText(await renderCheckPdf({ ...base, style: 'voucher', stock: 'blank', position: 'middle' }));
    const payee = find(mid, 'Office Depot')[0];
    expect(payee.y).toBeCloseTo(792 - (3.5 + 1.32) * 72, 1);
    expect(find(mid, 'VOUCHER')).toHaveLength(2);
    const all = mid.map((x) => x.text).join('|');
    expect(all).not.toContain('ROUTING');
  });

  it('refuses an empty batch', async () => {
    await expect(renderChecksPdf([], {})).rejects.toThrow();
  });
});
