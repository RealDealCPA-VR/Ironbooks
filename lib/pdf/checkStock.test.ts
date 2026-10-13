/**
 * P1 purchases — check paper modes: pre-printed stock prints only the variable fields at the QB
 * field positions (shifted by the alignment offsets); blank stock draws the full check without
 * a fake MICR line.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { PREPRINTED_FIELDS, renderCheckPdf, type CheckPdfData } from './check';

/** Every text string drawn in the PDF with its position (Tm / Td origin), in drawing order. */
function drawnText(bytes: Uint8Array): Array<{ text: string; x: number; y: number }> {
  const raw = Buffer.from(bytes).toString('latin1');
  const out: Array<{ text: string; x: number; y: number }> = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const m of raw.matchAll(re)) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      content = m[1];
    }
    // pdf-lib writes: BT ... x y Td (or 1 0 0 1 x y Tm) <hex> Tj ET
    const blocks = content.split('BT').slice(1);
    for (const b of blocks) {
      const pos = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td/.exec(b) ?? /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/.exec(b);
      for (const t of b.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        out.push({ text: Buffer.from(t[1], 'hex').toString('latin1'), x: pos ? Number(pos[1]) : NaN, y: pos ? Number(pos[2]) : NaN });
      }
    }
  }
  return out;
}

const base: CheckPdfData = {
  company: { name: 'Acme Books LLC' },
  payee: 'State Revenue Dept',
  amountNumeric: '1234.56',
  date: '2026-10-15',
  memo: 'Q3 sales tax',
  checkNumber: '1042',
  voucher: [{ account: '2200 – Sales Tax Payable', description: 'Q3', amount: '1234.56' }],
};

describe('check PDF paper modes', () => {
  it('pre-printed (default): only the variable fields, at the QB positions', async () => {
    const texts = drawnText(await renderCheckPdf({ ...base, style: 'standard' }));
    const all = texts.map((t) => t.text).join('|');
    expect(all).toContain('State Revenue Dept');
    expect(all).toContain('2026-10-15');
    expect(all).toContain('**1,234.56');
    expect(all).toContain('One Thousand Two Hundred Thirty-Four and 56/100');
    expect(all).toContain('Q3 sales tax');
    // Nothing the check paper already carries.
    for (const label of ['Pay to the Order of', 'DOLLARS', 'Memo', 'Authorized Signature', 'Payer', 'ROUTING', 'Acme Books LLC', 'Check #']) {
      expect(all).not.toContain(label);
    }
    const payee = texts.find((t) => t.text === 'State Revenue Dept')!;
    expect(payee.x).toBeCloseTo(PREPRINTED_FIELDS.payeeX * 72, 0);
    expect(payee.y).toBeCloseTo(792 - PREPRINTED_FIELDS.payeeTop * 72, 0);
  });

  it('pre-printed honours the alignment offsets and the wallet / voucher layouts', async () => {
    // pdf-lib applies the offset as a page translation (cm) — the field origin stays the same, so
    // compare the translated layout through the content-stream "cm" operator.
    const bytes = await renderCheckPdf({ ...base, style: 'standard', offset: { x: '0.5', y: '-0.25' } });
    const raw = Buffer.from(bytes).toString('latin1');
    const inflated = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => {
        try {
          return zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        } catch {
          return m[1];
        }
      })
      .join('\n');
    expect(inflated).toMatch(/1 0 0 1 36 -18 cm/);

    const wallet = drawnText(await renderCheckPdf({ ...base, style: 'wallet' }));
    const walletPayee = wallet.filter((t) => t.text === 'State Revenue Dept');
    // Payee on the check (right of the 2.25" stub) and on the register stub.
    expect(walletPayee.some((t) => Math.abs(t.x - (PREPRINTED_FIELDS.walletStubWidth + PREPRINTED_FIELDS.payeeX) * 72) < 1)).toBe(true);
    expect(walletPayee.length).toBe(2);

    const voucher = drawnText(await renderCheckPdf({ ...base, style: 'voucher' }));
    // Two voucher stubs with the detail lines.
    expect(voucher.filter((t) => t.text.startsWith('2200')).length).toBe(2);
  });

  it('blank stock draws the full check but no fake MICR line', async () => {
    const all = drawnText(await renderCheckPdf({ ...base, style: 'standard', stock: 'blank' }))
      .map((t) => t.text)
      .join('|');
    expect(all).toContain('Pay to the Order of');
    expect(all).toContain('Authorized Signature');
    expect(all).toContain('Acme Books LLC');
    expect(all).not.toContain('ROUTING');
    expect(all).not.toContain('|:');
  });
});
