/**
 * State income tax withholding engine (lib/services/statePayrollTax.ts): year-keyed 2025 / 2026
 * formulas, employee state W-4 inputs, the employee-entered fallback for states the app doesn't
 * model (never a silent guess), nearest-year notes and local-tax notes.
 */
import { describe, it, expect } from 'vitest';
import {
  MODELLED_STATES,
  STATES,
  SUPPORTED_STATE_CODES,
  bracketTax,
  calculateStateWithholding,
  computeStateWithholding,
  statePerPeriod,
  type StateW4,
} from './statePayrollTax';
import Decimal from 'decimal.js';

const calc = (state: string, year: number, wages: string, periods: number, w4: StateW4 = {}, extra: Partial<Parameters<typeof calculateStateWithholding>[0]> = {}) =>
  calculateStateWithholding({ state, year, wagesPerPeriod: wages, periodsPerYear: periods, stateW4: w4, ...extra });

describe('state list', () => {
  it('covers all 50 states + DC with a model for each', () => {
    expect(SUPPORTED_STATE_CODES).toHaveLength(51);
    for (const s of STATES) expect(['none', 'formula', 'employee']).toContain(s.model);
    for (const code of MODELLED_STATES) expect(STATES.find((s) => s.code === code)?.model).toBe('formula');
  });

  it('bracketTax applies marginal rates', () => {
    expect(bracketTax(new Decimal(15000), [[10000, '0.01'], [null, '0.02']]).toString()).toBe('200');
  });
});

describe('no-tax states', () => {
  for (const s of ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']) {
    it(`${s} withholds nothing`, () => {
      const r = calc(s, 2025, '5000', 12);
      expect(r).toMatchObject({ amount: '0.00', method: 'none' });
    });
  }
});

describe('2025 / 2026 formulas', () => {
  it('PA 3.07% flat, no allowances; base includes 401(k) deferrals; local EIT note', () => {
    const r = calc('PA', 2025, '2000', 26);
    expect(r.amount).toBe('61.40');
    expect(r.notes.join(' ')).toMatch(/earned income tax/);
    // PA taxes 401(k) deferrals: the Social Security wage base is used.
    expect(calc('PA', 2025, '1800', 26, {}, { ficaWagesPerPeriod: '2000' }).amount).toBe('61.40');
    expect(calc('PA', 2026, '2000', 26, { extraWithholding: '5' }).amount).toBe('66.40');
  });

  it('IL 4.95% after IL-W-4 allowances (2025 $2,850, 2026 $2,925)', () => {
    expect(calc('IL', 2025, '2000', 26, { allowances: 1 }).amount).toBe('93.57');
    expect(calc('IL', 2026, '2000', 26, { allowances: 1 }).amount).toBe('93.43');
    // Line 2 additional allowances are $1,000 each.
    expect(calc('IL', 2025, '2000', 26, { allowances: 1, additionalAllowances: 1 }).amount).toBe('91.67');
  });

  it('NC flat rate after the standard deduction (2025 4.25%, 2026 3.99%)', () => {
    expect(calc('NC', 2025, '5000', 12, { filingStatus: 'single' }).amount).toBe('167.34');
    expect(calc('NC', 2026, '5000', 12, { filingStatus: 'single' }).amount).toBe('157.11');
  });

  it('NY brackets after the deduction', () => {
    expect(calc('NY', 2025, '6000', 12, { filingStatus: 'single' }).amount).toBe('282.33');
    expect(calc('NY', 2025, '6000', 12).notes.join(' ')).toMatch(/New York City/);
  });

  it('CA DE 44 Method B; 2026 uses 2025 figures with a note', () => {
    expect(calc('CA', 2025, '3000', 26, { filingStatus: 'single', allowances: 1 }).amount).toBe('127.92');
    const r26 = calc('CA', 2026, '3000', 26, { filingStatus: 'single', allowances: 1 });
    expect(r26.amount).toBe('127.92');
    expect(r26.tableYear).toBe(2025);
    expect(r26.notes.join(' ')).toMatch(/2026 are not in this version; the 2025 figures were used/);
  });

  it('NJ rate table A / B after allowances', () => {
    expect(calc('NJ', 2025, '5000', 12, { njTable: 'A', allowances: 1 }).amount).toBe('152.06');
    expect(Number(calc('NJ', 2025, '5000', 12, { njTable: 'B', allowances: 1 }).amount)).toBeLessThan(152.06);
  });

  it('MA 5% after exemptions and up to $2,000 of FICA', () => {
    expect(calc('MA', 2025, '1500', 52, { allowances: 1 }, { ficaTaxPerPeriod: '114.75' }).amount).toBe('68.85');
  });

  it('AZ employee-elected percent (2.0% default; invalid percent refused)', () => {
    expect(calc('AZ', 2025, '2000', 26).amount).toBe('40.00');
    expect(calc('AZ', 2026, '2000', 26, { rate: '3.5' }).amount).toBe('70.00');
    expect(() => calc('AZ', 2025, '2000', 26, { rate: '4' })).toThrow(/Arizona/);
  });

  it('GA, VA, MS, OH, KY, MI, IN, CO', () => {
    expect(calc('GA', 2025, '5000', 12, { filingStatus: 'single', dependents: 1 }).amount).toBe('190.30');
    expect(calc('VA', 2025, '5000', 12, { allowances: 1 }).amount).toBe('220.86');
    expect(calc('MS', 2025, '5000', 12, { filingStatus: 'single' }).amount).toBe('152.90');
    expect(calc('OH', 2025, '5000', 12, { allowances: 1 }).amount).toBe('76.31');
    expect(calc('OH', 2026, '5000', 12, { allowances: 1 }).amount).toBe('76.31');
    expect(calc('KY', 2025, '5000', 12).amount).toBe('189.10');
    expect(calc('KY', 2026, '5000', 12).amount).toBe('165.20');
    expect(calc('MI', 2025, '5000', 12, { allowances: 1 }).amount).toBe('191.96');
    expect(calc('IN', 2025, '5000', 12, { allowances: 1, dependents: 1 }).amount).toBe('143.75');
    const co = calc('CO', 2025, '5000', 12);
    expect(co.amount).toBe('220.00');
    expect(co.notes.join(' ')).toMatch(/DR 0004/);
    expect(calc('CO', 2025, '5000', 12, { annualAllowance: '6000' }).amount).toBe('198.00');
  });

  it('UT flat rate less the phased-out allowance', () => {
    const low = Number(calc('UT', 2025, '1500', 12, { filingStatus: 'single' }).amount);
    const high = Number(calc('UT', 2025, '15000', 12, { filingStatus: 'single' }).amount);
    expect(low).toBeGreaterThan(0);
    // At high wages the allowance is fully phased out: plain 4.5%.
    expect(high).toBe(675);
  });

  it('a later year uses the latest table and says so', () => {
    const r = calc('IL', 2027, '2000', 26, { allowances: 1 });
    expect(r.amount).toBe('93.43');
    expect(r.tableYear).toBe(2026);
    expect(r.notes.join(' ')).toMatch(/2027/);
  });

  it('an exempt employee withholds nothing', () => {
    expect(calc('NY', 2025, '6000', 12, { exempt: true })).toMatchObject({ amount: '0.00', method: 'exempt' });
  });
});

describe('states the app does not model', () => {
  it('never guesses: no rate on the employee = no withholding + a note', () => {
    const r = calc('OR', 2025, '2000', 26);
    expect(r).toMatchObject({ amount: '0.00', method: 'not_set_up' });
    expect(r.notes.join(' ')).toMatch(/Oregon income tax is not calculated/);
  });

  it('uses the employee-entered percent or amount (plus extra withholding)', () => {
    expect(calc('OR', 2025, '2000', 26, { fallbackPercent: '5' })).toMatchObject({ amount: '100.00', method: 'employee_percent' });
    expect(calc('MN', 2026, '2000', 26, { fallbackAmount: '75', extraWithholding: '10' })).toMatchObject({ amount: '85.00', method: 'employee_amount' });
  });
});

describe('calculator helpers', () => {
  it('statePerPeriod uses the same engine', () => {
    const r = statePerPeriod({ grossPerPeriod: 2000, periodsPerYear: 26, state: 'pa', year: 2025 });
    expect(r.stateTax).toBe('61.40');
    expect(r.annualStateTax).toBe('1596.40');
    expect(r.stateInfo.name).toBe('Pennsylvania');
    expect(computeStateWithholding({ state: 'TX', annualTaxable: 80000, year: 2025 })).toBe('0.00');
    expect(computeStateWithholding({ state: 'PA', annualTaxable: 50000, year: 2025 })).toBe('1535.00');
  });

  it('rejects unknown states and bad pay frequencies', () => {
    expect(() => calc('XX', 2025, '100', 26)).toThrow();
    expect(() => calc('PA', 2025, '100', 0)).toThrow();
  });
});
