/**
 * Local (city / county) income tax: the built-in list and the per-check calculation. Figures are
 * the published 2026 rates (see localPayrollTaxData.ts for the sources); the New York City case
 * is the worked example printed in NYS-50-T-NYC.
 */
import { describe, it, expect } from 'vitest';
import {
  LOCAL_TAX_STATES,
  OTHER_LOCAL,
  calculateLocalWithholding,
  describeLocalTax,
  localJurisdiction,
  localJurisdictionsFor,
  localWageBase,
  localWageBaseForLocality,
  localityOfLine,
  normalizeLocalTaxes,
  type LocalTaxSetup,
} from './localPayrollTax';
import { LOCAL_JURISDICTIONS } from './localPayrollTaxData';
import { stateInfo } from './statePayrollTax';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const setup = (jurisdiction: string, resident = true, extra: Partial<LocalTaxSetup> = {}): LocalTaxSetup => {
  const j = localJurisdiction(jurisdiction)!;
  return { state: j.state, jurisdiction, name: j.name, resident, ...extra };
};
/** A biweekly check: $2,000 gross, $1,900 after Section 125, $1,800 after a 401(k) deferral too. */
const check = (s: LocalTaxSetup, payDate = '2026-03-06', extra: Record<string, unknown> = {}) =>
  calculateLocalWithholding({
    setup: s,
    payDate: d(payDate),
    grossPerPeriod: '2000.00',
    ficaWagesPerPeriod: '1900.00',
    incomeTaxWagesPerPeriod: '1800.00',
    periodsPerYear: 26,
    ...extra,
  });

describe('the built-in list', () => {
  it('has unique ids, real states and well-formed rates', () => {
    const ids = LOCAL_JURISDICTIONS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const j of LOCAL_JURISDICTIONS) {
      expect(stateInfo(j.state), j.id).not.toBeNull();
      expect(j.id.startsWith(`${j.state}-`), j.id).toBe(true);
      expect(j.name).not.toMatch(/[()]/);
      for (const r of j.rates) {
        expect(r.from, j.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const v of [r.resident, r.nonresident]) {
          if (v !== null) {
            expect(Number(v), j.id).toBeGreaterThan(0);
            expect(Number(v), j.id).toBeLessThan(5);
          }
        }
      }
    }
  });

  it('lists the places by state', () => {
    expect(LOCAL_TAX_STATES).toEqual(['AL', 'CO', 'DE', 'IN', 'KY', 'MI', 'MO', 'NY', 'OH', 'PA']);
    expect(localJurisdictionsFor('in')).toHaveLength(92);
    expect(localJurisdictionsFor('MI')).toHaveLength(24);
    expect(localJurisdictionsFor('NY').map((j) => j.name)).toEqual(['New York City', 'Yonkers']);
    expect(localJurisdictionsFor('TX')).toEqual([]);
    // Ids are stored on employees: these must never change.
    for (const id of ['PA-PHILADELPHIA', 'NY-NEW-YORK-CITY', 'NY-YONKERS', 'OH-COLUMBUS', 'MI-DETROIT', 'IN-MARION-COUNTY', 'IN-ST-JOSEPH-COUNTY', 'KY-LOUISVILLE-METRO', 'MO-KANSAS-CITY']) {
      expect(localJurisdiction(id), id).not.toBeNull();
    }
  });

  it('knows which wages each place taxes', () => {
    expect(localWageBase('PA', 'PA-PHILADELPHIA')).toBe('gross');
    expect(localWageBase('PA', 'PA-PITTSBURGH')).toBe('fica');
    expect(localWageBase('OH', 'OH-COLUMBUS')).toBe('fica');
    expect(localWageBase('KY', 'KY-PADUCAH')).toBe('gross');
    expect(localWageBase('MI', 'MI-DETROIT')).toBe('income');
    expect(localWageBase('MO', OTHER_LOCAL)).toBe('income');
    expect(localWageBase('OH', OTHER_LOCAL)).toBe('fica');
    // Springfield is a city in both Ohio and Michigan: the employee's state decides.
    expect(localWageBaseForLocality('Springfield', null, 'OH')).toBe('fica');
    expect(localWageBaseForLocality('Springfield', null, 'MI')).toBe('income');
    expect(localWageBaseForLocality('Philadelphia', null, 'NJ')).toBe('gross');
    expect(localWageBaseForLocality('Smallville', [{ state: 'KY', jurisdiction: OTHER_LOCAL, name: 'smallville', resident: true, percent: '1' }], 'TX')).toBe('gross');
  });
});

describe('calculateLocalWithholding', () => {
  it('uses the resident or nonresident rate in force on the pay date', () => {
    // Philadelphia: on gross pay; the rate changed on July 1, 2026.
    expect(check(setup('PA-PHILADELPHIA')).amount).toBe('74.80'); // 3.74%
    expect(check(setup('PA-PHILADELPHIA', false)).amount).toBe('68.60'); // 3.43%
    expect(check(setup('PA-PHILADELPHIA'), '2026-07-10').amount).toBe('74.70'); // 3.735%
    expect(check(setup('PA-PHILADELPHIA', false), '2026-07-10').amount).toBe('68.50'); // 3.425%
    expect(check(setup('PA-PHILADELPHIA'), '2025-08-01').notes).toEqual([]);
    // Ohio: Medicare-basis wages. Michigan: income-tax wages.
    expect(check(setup('OH-COLUMBUS'))).toMatchObject({ amount: '47.50', base: 'fica', method: 'rate', name: 'Columbus' });
    expect(check(setup('MI-DETROIT')).amount).toBe('43.20'); // 2.4% of 1,800
    expect(check(setup('MI-DETROIT', false)).amount).toBe('21.60'); // 1.2%
    expect(check(setup('KY-LOUISVILLE-METRO')).amount).toBe('44.00'); // 2.2% of gross
    expect(check(setup('KY-LOUISVILLE-METRO', false)).amount).toBe('29.00'); // 1.45%
    // Boone County, Indiana: 1.70% until September 30, 1.71% from October 1.
    expect(check(setup('IN-BOONE-COUNTY'), '2026-09-25').amount).toBe('30.60');
    expect(check(setup('IN-BOONE-COUNTY'), '2026-10-02').amount).toBe('30.78');
  });

  it('Indiana counties: the county rate applies after the state exemptions', () => {
    // 1,800 × 26 = 46,800 − 1,000 − 1,500 = 44,300 × 2.02% ÷ 26
    expect(check(setup('IN-MARION-COUNTY'), '2026-03-06', { stateW4: { allowances: 1, dependents: 1 } }).amount).toBe('34.42');
    expect(check(setup('IN-MARION-COUNTY')).amount).toBe('36.36');
    expect(describeLocalTax(setup('IN-MARION-COUNTY'), d('2026-03-06'))).toBe('2.02% of wages after the state exemptions (built-in rate for people who live there)');
  });

  it("New York City: the state's worked example, residents only", () => {
    // NYS-50-T-NYC: monthly, single, 3 exemptions, $50,000 → $2,070.50.
    const nyc = (extra: Record<string, unknown> = {}, s = setup('NY-NEW-YORK-CITY', true, { allowances: 3 })) =>
      calculateLocalWithholding({
        setup: s,
        payDate: d('2026-02-27'),
        grossPerPeriod: '50000',
        ficaWagesPerPeriod: '50000',
        incomeTaxWagesPerPeriod: '50000',
        periodsPerYear: 12,
        ...extra,
      });
    expect(nyc()).toMatchObject({ amount: '2070.50', method: 'formula', name: 'New York City' });
    // Married: a $5,500 deduction instead of $5,000, the same schedule.
    expect(nyc({ stateW4: { filingStatus: 'married' } }).amount).toBe('2068.73');
    expect(nyc({}, setup('NY-NEW-YORK-CITY', false)).amount).toBe('0.00');
    // Low wages: (26,000 − 5,000) = 21,000 → 388 + 6,000 × 3.95% = 625 a year.
    expect(nyc({ incomeTaxWagesPerPeriod: '1000', periodsPerYear: 26 }, setup('NY-NEW-YORK-CITY')).amount).toBe('24.04');
    expect(nyc({ incomeTaxWagesPerPeriod: '150', periodsPerYear: 26 }, setup('NY-NEW-YORK-CITY')).amount).toBe('0.00');
  });

  it('Yonkers: residents pay a share of the state tax, nonresidents a rate after an exclusion', () => {
    expect(check(setup('NY-YONKERS'), '2026-03-06', { stateTaxPerPeriod: '100.00' }).amount).toBe('16.75');
    const noState = check(setup('NY-YONKERS'));
    expect(noState.amount).toBe('0.00');
    expect(noState.notes.join(' ')).toMatch(/no state tax was calculated/);
    // Nonresident, 46,800 a year: no exclusion → 0.5% of 1,800.
    expect(check(setup('NY-YONKERS', false)).amount).toBe('9.00');
    // 15,600 a year: (15,600 − 2,000) × 0.5% ÷ 26.
    expect(check(setup('NY-YONKERS', false), '2026-03-06', { incomeTaxWagesPerPeriod: '600' }).amount).toBe('2.62');
    // Under 4,000 a year: nothing.
    expect(check(setup('NY-YONKERS', false), '2026-03-06', { incomeTaxWagesPerPeriod: '150' }).amount).toBe('0.00');
  });

  it("the user's own percent or amount always wins", () => {
    expect(check(setup('OH-COLUMBUS', true, { percent: '1' }))).toMatchObject({ amount: '19.00', method: 'employee_percent' });
    expect(check(setup('CO-DENVER', true, { amountPerCheck: '5.75' }))).toMatchObject({ amount: '5.75', method: 'employee_amount' });
    expect(check({ state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true, percent: '1.5' }).amount).toBe('27.00');
  });

  it('never guesses: no rate means nothing withheld and a note; other years say so', () => {
    const tuskegee = check(setup('AL-TUSKEGEE'));
    expect(tuskegee).toMatchObject({ amount: '0.00', method: 'not_set_up' });
    expect(tuskegee.notes.join(' ')).toMatch(/Tuskegee local tax is not calculated by the app/);
    expect(check(setup('OH-COLUMBUS'), '2027-01-08').notes.join(' ')).toMatch(/rates for 2027 are not in this version; the 2026 rate was used/);
    expect(check(setup('OH-COLUMBUS'), '2025-12-26').notes.join(' ')).toMatch(/rates before 2026 are not in this version/);
    expect(check(setup('OH-COLUMBUS')).notes).toEqual([]);
  });

  it('describes each setup in plain words', () => {
    const on = d('2026-03-06');
    expect(describeLocalTax(setup('PA-PHILADELPHIA', false), on)).toBe('3.43% of wages (built-in rate for people who only work there)');
    expect(describeLocalTax(setup('NY-YONKERS'), on)).toBe('16.75% of the state income tax withheld (built-in rate for people who live there)');
    expect(describeLocalTax(setup('NY-NEW-YORK-CITY', false), on)).toMatch(/residents only/);
    expect(describeLocalTax(setup('OH-COLUMBUS', true, { percent: '2.25' }), on)).toBe('2.25% of wages (the rate you entered)');
    expect(describeLocalTax(setup('CO-DENVER'), on)).toMatch(/no rate for this place/);
  });
});

describe('normalizeLocalTaxes', () => {
  it('fills in a listed place and keeps only what was entered', () => {
    expect(normalizeLocalTaxes([{ jurisdiction: 'PA-PHILADELPHIA', resident: false }])).toEqual([
      { state: 'PA', jurisdiction: 'PA-PHILADELPHIA', name: 'Philadelphia', resident: false },
    ]);
    expect(normalizeLocalTaxes([{ jurisdiction: 'NY-NEW-YORK-CITY', allowances: '2' }])).toEqual([
      { state: 'NY', jurisdiction: 'NY-NEW-YORK-CITY', name: 'New York City', resident: true, allowances: 2 },
    ]);
    expect(normalizeLocalTaxes([])).toBeNull();
    expect(normalizeLocalTaxes(null)).toBeNull();
  });

  it('asks for a figure when the app has no rate', () => {
    expect(() => normalizeLocalTaxes([{ jurisdiction: 'CO-DENVER' }])).toThrow(/percent of wages or an amount per paycheck for the Denver/);
    expect(() => normalizeLocalTaxes([{ jurisdiction: 'AL-TUSKEGEE' }])).toThrow(/Tuskegee/);
    expect(normalizeLocalTaxes([{ jurisdiction: 'CO-DENVER', amountPerCheck: '5.75' }])).toHaveLength(1);
    expect(() => normalizeLocalTaxes([{ jurisdiction: 'OH-COLUMBUS', percent: '1', amountPerCheck: '5' }])).toThrow(/not both/);
    expect(() => normalizeLocalTaxes('x')).toThrow(/not valid/);
  });
});

describe('paycheck line names', () => {
  it('reads the place back from the line', () => {
    expect(localityOfLine('Local Tax (Philadelphia)')).toBe('Philadelphia');
    expect(localityOfLine('Local Tax (St. Joseph County)')).toBe('St. Joseph County');
    expect(localityOfLine('City Wage Tax')).toBe('City Wage Tax');
  });
});
