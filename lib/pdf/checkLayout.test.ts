/**
 * Check layouts for any check stock — pure geometry: defaults (= the historical
 * PREPRINTED_FIELDS), overrides, validation of a saved layout and sheet planning (standard checks
 * three per sheet with a partly used first sheet; voucher / wallet one per sheet).
 */
import { describe, it, expect } from 'vitest';
import { PREPRINTED_FIELDS } from './check';
import {
  CHECK_FIELD_KEYS,
  defaultCheckLayout,
  diffCheckLayout,
  normalizeCheckHeight,
  planCheckSheets,
  resolveCheckLayout,
  validateCheckLayout,
} from './checkLayout';

describe('default check layout', () => {
  it('matches PREPRINTED_FIELDS for full-width and wallet checks (existing users see no change)', () => {
    const F = PREPRINTED_FIELDS;
    for (const [style, width] of [['voucher', 8.5], ['standard', 8.5], ['wallet', 6.25]] as const) {
      const L = defaultCheckLayout(style);
      expect(L.date.x).toBeCloseTo(width - F.dateFromRight, 6);
      expect(L.date.y).toBe(F.dateTop);
      expect(L.payee).toMatchObject({ x: F.payeeX, y: F.payeeTop });
      expect(L.amount.x).toBeCloseTo(width - F.amountFromRight, 6);
      expect(L.amount.y).toBe(F.amountTop);
      expect(L.words).toMatchObject({ x: F.wordsX, y: F.wordsTop });
      expect(L.memo).toMatchObject({ x: F.memoX, y: F.memoTop, size: 9 });
      // Optional fields are off by default.
      expect([L.address.show, L.checkNumber.show, L.company.show]).toEqual([false, false, false]);
    }
    expect(resolveCheckLayout('standard', null)).toEqual(defaultCheckLayout('standard'));
  });

  it('applies overrides field by field and only lets the optional fields be switched on/off', () => {
    const L = resolveCheckLayout('standard', {
      payee: { x: 1.1, y: 1.4 },
      memo: { size: 8 },
      address: { show: true, y: 2.0 },
      date: { show: false } as never,
    });
    expect(L.payee).toMatchObject({ x: 1.1, y: 1.4, size: 10 });
    expect(L.memo).toMatchObject({ x: 0.55, y: 2.72, size: 8 });
    expect(L.address).toMatchObject({ show: true, y: 2.0, x: 0.95 });
    expect(L.date.show).toBe(true); // core fields always print
  });

  it('diff keeps only what differs from the style defaults', () => {
    const full = defaultCheckLayout('voucher');
    expect(diffCheckLayout('voucher', full)).toBeNull();
    expect(diffCheckLayout('voucher', { ...full, payee: { ...full.payee, x: 1.25 }, company: { ...full.company, show: true } })).toEqual({
      payee: { x: 1.25 },
      company: { show: true },
    });
  });
});

describe('validateCheckLayout', () => {
  it('accepts numbers / numeric strings in range and null', () => {
    expect(validateCheckLayout(null)).toEqual({ ok: true, value: null });
    expect(validateCheckLayout({ payee: { x: '1.2', y: 1.5, size: 11 }, checkNumber: { show: true } })).toEqual({
      ok: true,
      value: { payee: { x: 1.2, y: 1.5, size: 11 }, checkNumber: { show: true } },
    });
    // Blank inputs mean "standard position".
    expect(validateCheckLayout({ payee: { x: '', y: null } })).toEqual({ ok: true, value: null });
  });

  it.each([
    [{ signature: { x: 1 } }, /Unknown check field/],
    [{ payee: { x: 1, colour: 'red' } }, /unknown setting/],
    [{ payee: { x: -0.1 } }, /between/],
    [{ payee: { x: 9 } }, /between/],
    [{ memo: { y: 4 } }, /between/],
    [{ memo: { size: 40 } }, /between/],
    [{ memo: { x: 'abc' } }, /between/],
    [{ memo: { x: 'Infinity' } }, /between/],
    [{ payee: { show: false } }, /always printed/],
    [{ address: { show: 'yes' } }, /true or false/],
    [[1, 2], /object/],
    ['layout', /object/],
    [{ payee: 5 }, /expected a position/],
  ])('rejects %j', (input, msg) => {
    const r = validateCheckLayout(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it('knows every field', () => {
    for (const k of CHECK_FIELD_KEYS) expect(validateCheckLayout({ [k]: { x: 0.5 } }).ok).toBe(true);
  });
});

describe('planCheckSheets', () => {
  const pages = (p: Array<{ sheet: number }>) => (p.length ? Math.max(...p.map((x) => x.sheet)) + 1 : 0);

  it('standard checks: three per sheet, ceil((n + used) / 3) sheets, first sheet below the used checks', () => {
    for (const remaining of [1, 2, 3]) {
      const used = 3 - remaining;
      for (let n = 1; n <= 10; n++) {
        const plan = planCheckSheets(n, { style: 'standard', firstSheetRemaining: remaining });
        expect(pages(plan)).toBe(Math.ceil((n + used) / 3));
        expect(plan[0]).toEqual({ sheet: 0, slot: used });
        // Slots fill top to bottom, never two checks in one slot.
        expect(new Set(plan.map((p) => `${p.sheet}:${p.slot}`)).size).toBe(n);
      }
    }
    expect(planCheckSheets(4, { style: 'standard', firstSheetRemaining: 1 })).toEqual([
      { sheet: 0, slot: 2 },
      { sheet: 1, slot: 0 },
      { sheet: 1, slot: 1 },
      { sheet: 1, slot: 2 },
    ]);
    // Bad values fall back to a full sheet.
    expect(planCheckSheets(1, { style: 'standard', firstSheetRemaining: 7 })[0]).toEqual({ sheet: 0, slot: 0 });
  });

  it('voucher / wallet: one check per sheet in the chosen third', () => {
    expect(planCheckSheets(3, { style: 'voucher', position: 'middle', firstSheetRemaining: 1 })).toEqual([
      { sheet: 0, slot: 1 },
      { sheet: 1, slot: 1 },
      { sheet: 2, slot: 1 },
    ]);
    expect(planCheckSheets(2, { style: 'wallet', position: 'bottom' }).map((p) => p.slot)).toEqual([2, 2]);
    expect(planCheckSheets(1, { style: 'voucher' })[0].slot).toBe(0);
  });

  it('check height is kept in range', () => {
    expect(normalizeCheckHeight('3.5')).toBe(3.5);
    expect(normalizeCheckHeight(2)).toBe(2.75);
    expect(normalizeCheckHeight(9)).toBe(3.67);
    expect(normalizeCheckHeight('x')).toBe(3.5);
  });
});
