/**
 * Year-keyed federal payroll tables (E1/E2): Social Security wage base by year, 2025/2026
 * percentage-method withholding incl. head of household, the 2020+ W-4 Steps 2-4, pre-2020
 * allowances, and the nearest-year fallback. Pure — no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  computeEmployerTaxes,
  computeWithholding,
  hasTaxYearTable,
  normalizeFilingStatus,
  ssWageBaseFor,
  taxYearTable,
} from './payrollTax';

describe('Social Security wage base by year', () => {
  it('has the published bases', () => {
    expect(ssWageBaseFor(2022)).toBe(147000);
    expect(ssWageBaseFor(2023)).toBe(160200);
    expect(ssWageBaseFor(2024)).toBe(168600);
    expect(ssWageBaseFor(2025)).toBe(176100);
    expect(ssWageBaseFor(2026)).toBe(184500);
  });

  it('uses the nearest year for years without a table', () => {
    expect(hasTaxYearTable(2031)).toBe(false);
    expect(taxYearTable(2031).year).toBe(2026);
    expect(taxYearTable(2010).year).toBe(2022);
  });

  it('caps employee and employer SS at the pay year\'s base', () => {
    const w26 = computeWithholding({ grossPerPeriod: 1000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: 184000, year: 2026 });
    expect(w26.socialSecurity).toBe('31.00'); // 500 under the 2026 base × 6.2%
    expect(w26.tableYear).toBe(2026);
    const w25 = computeWithholding({ grossPerPeriod: 1000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: 184000, year: 2025 });
    expect(w25.socialSecurity).toBe('0.00'); // already past 176,100
    const er = computeEmployerTaxes({ grossPerPeriod: 1000, ytdGrossBefore: 184000, year: 2026 });
    expect(er.socialSecurity).toBe('31.00');
  });
});

describe('2025 / 2026 withholding and filing statuses', () => {
  it('single 2025, $5,000 monthly', () => {
    // 60,000 − 15,000 std = 45,000 → 1,192.50 + 33,075 × 12% = 5,161.50 / 12
    const r = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 12, filingStatus: 'single', year: 2025 });
    expect(r.federalIncomeTax).toBe('430.13');
  });

  it('head of household 2025 withholds less than single', () => {
    // 60,000 − 22,500 = 37,500 → 1,700 + 20,500 × 12% = 4,160 / 12
    const r = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 12, filingStatus: 'head_of_household', year: 2025 });
    expect(r.federalIncomeTax).toBe('346.67');
  });

  it('married filing jointly 2026', () => {
    // 96,000 − 32,200 = 63,800 → 2,480 + 39,000 × 12% = 7,160 / 12
    const r = computeWithholding({ grossPerPeriod: 8000, periodsPerYear: 12, filingStatus: 'married', year: 2026 });
    expect(r.federalIncomeTax).toBe('596.67');
  });

  it('normalizes stored filing statuses', () => {
    expect(normalizeFilingStatus('Head of Household')).toBe('head_of_household');
    expect(normalizeFilingStatus('married')).toBe('married');
    expect(normalizeFilingStatus('married_separately')).toBe('single');
    expect(normalizeFilingStatus(undefined)).toBe('single');
  });
});

describe('2020+ W-4 Steps 2-4', () => {
  const base = { grossPerPeriod: 5000, periodsPerYear: 12, filingStatus: 'single' as const, year: 2025 };

  it('Step 2 checkbox halves the standard deduction and bracket widths', () => {
    // 60,000 − 7,500 = 52,500 on half-width brackets → 9,023.50 / 12
    const r = computeWithholding({ ...base, w4: { step2Checkbox: true } });
    expect(r.federalIncomeTax).toBe('751.96');
  });

  it('Step 3 credits reduce the annual tax; Step 4(c) adds per period', () => {
    // (5,161.50 − 2,000) / 12 = 263.46, + 50 extra
    const r = computeWithholding({ ...base, w4: { dependentsAmount: '2000', extraWithholding: '50' } });
    expect(r.federalIncomeTax).toBe('313.46');
  });

  it('Step 4(a) other income raises and 4(b) deductions lower the taxable wages', () => {
    const more = computeWithholding({ ...base, w4: { otherIncome: '12000' } });
    expect(more.federalIncomeTax).toBe('621.17'); // 7,454 / 12
    const less = computeWithholding({ ...base, w4: { deductions: '10000' } });
    expect(less.federalIncomeTax).toBe('330.13'); // 3,961.50 / 12
  });

  it('exempt employees have no income tax withheld but still pay FICA', () => {
    const r = computeWithholding({ ...base, w4: { exempt: true, extraWithholding: '50' } });
    expect(r.federalIncomeTax).toBe('0.00');
    expect(r.socialSecurity).toBe('310.00');
  });
});

describe('pre-2020 W-4 (allowances)', () => {
  it('uses the computational bridge: allowances × $4,300', () => {
    // 2024 single, 60,000 − 2 × 4,300 − (14,600 − 8,600) = 45,400 → 5,216 / 12
    const r = computeWithholding({
      grossPerPeriod: 5000,
      periodsPerYear: 12,
      filingStatus: 'single',
      year: 2024,
      w4: { formYear: 2019, allowances: 2 },
    });
    expect(r.federalIncomeTax).toBe('434.67');
  });
});
