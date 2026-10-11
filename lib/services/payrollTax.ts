/**
 * Federal payroll tax withholding calculator — data-driven by TAX YEAR.
 *
 * DISCLAIMER: These tables encode the IRS percentage-method figures (Publication 15-T,
 * "Percentage Method Tables for Automated Payroll Systems" + Worksheet 1A) and the SSA
 * Social Security contribution and benefit base for each year below. They are provided for
 * after-the-fact payroll record keeping; always verify against the current official IRS / SSA
 * publications before filing or remitting. This code is NOT a substitute for professional
 * tax advice.
 *
 * Updating for a new year = add ONE entry to FEDERAL_TAX_YEARS (wage base, brackets, standard
 * deductions). Nothing else in the codebase hardcodes a year's figures: withholding, employer
 * FICA, W-2 Box 3 / W-3 / 941 all read `ssWageBaseFor(year)` from here.
 *
 * Model (equivalent to Pub 15-T Worksheet 1A for automated systems):
 *   annual wages      = per-period taxable wages × pay periods + W-4 Step 4(a) other income
 *                       − W-4 Step 4(b) deductions
 *   adjusted wages    = annual wages − standard deduction for the filing status
 *                       (half of it, and half-width brackets, when the W-4 Step 2 box is checked)
 *   annual tax        = brackets(adjusted wages) − W-4 Step 3 credits (floor 0)
 *   per-period tax    = annual tax / periods + W-4 Step 4(c) extra withholding
 * Pre-2020 W-4s (allowances) use the IRS computational bridge: married → MFJ schedule,
 * anything else → single, no Step 2/3, and allowances × the year's allowance value instead
 * of the 2020+ line-1g adjustment.
 */

import { Money, toAmountString, toDecimal, type MoneyInput } from '@/lib/money';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Year tables (DATA — append a year to update)
// ---------------------------------------------------------------------------

/** 2020+ Form W-4 filing statuses (Step 1(c)). 'married' = married filing jointly. */
export type FilingStatus = 'single' | 'married' | 'head_of_household';

export const FILING_STATUSES: FilingStatus[] = ['single', 'married', 'head_of_household'];

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: 'Single or Married filing separately',
  married: 'Married filing jointly (or Qualifying surviving spouse)',
  head_of_household: 'Head of household',
};

/** Marginal rates shared by every year since 2018 (TCJA, made permanent in 2025). */
const RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

export interface FederalTaxYear {
  year: number;
  /** Social Security wage base (SSA contribution and benefit base). */
  ssWageBase: number;
  /** Upper edges of the 10%..35% brackets on taxable income, per filing status. */
  bracketEdges: Record<FilingStatus, number[]>;
  /** Standard deduction built into the withholding tables. */
  standardDeduction: Record<FilingStatus, number>;
  /** Pre-2020 W-4: value of one withholding allowance. */
  allowanceValue: number;
  /** Pre-2020 W-4: Worksheet 1A line 1g amount (married / other) NOT subtracted for old forms. */
  legacyAdjustment: { married: number; other: number };
}

/**
 * IRS / SSA figures by year. Sources: Rev. Proc. 2021-45 (2022), 2022-38 (2023), 2023-34 (2024), 2024-40 (2025),
 * 2025-32 (2026, incl. the 2025 reconciliation act's permanent brackets); Pub 15-T for each year;
 * SSA COLA fact sheets for the wage base (2022 $147,000 · 2023 $160,200 · 2024 $168,600 · 2025 $176,100 ·
 * 2026 $184,500). 2025 uses the standard deduction printed in the 2025 Pub 15-T (withholding
 * tables were not reissued mid-year).
 */
export const FEDERAL_TAX_YEARS: FederalTaxYear[] = [
  {
    year: 2022,
    ssWageBase: 147000,
    bracketEdges: {
      single: [10275, 41775, 89075, 170050, 215950, 539900],
      married: [20550, 83550, 178150, 340100, 431900, 647850],
      head_of_household: [14650, 55900, 89050, 170050, 215950, 539900],
    },
    standardDeduction: { single: 12950, married: 25900, head_of_household: 19400 },
    allowanceValue: 4300,
    legacyAdjustment: { married: 12900, other: 8600 },
  },
  {
    year: 2023,
    ssWageBase: 160200,
    bracketEdges: {
      single: [11000, 44725, 95375, 182100, 231250, 578125],
      married: [22000, 89450, 190750, 364200, 462500, 693750],
      head_of_household: [15700, 59850, 95350, 182100, 231250, 578100],
    },
    standardDeduction: { single: 13850, married: 27700, head_of_household: 20800 },
    allowanceValue: 4300,
    legacyAdjustment: { married: 12900, other: 8600 },
  },
  {
    year: 2024,
    ssWageBase: 168600,
    bracketEdges: {
      single: [11600, 47150, 100525, 191950, 243725, 609350],
      married: [23200, 94300, 201050, 383900, 487450, 731200],
      head_of_household: [16550, 63100, 100500, 191950, 243700, 609350],
    },
    standardDeduction: { single: 14600, married: 29200, head_of_household: 21900 },
    allowanceValue: 4300,
    legacyAdjustment: { married: 12900, other: 8600 },
  },
  {
    year: 2025,
    ssWageBase: 176100,
    bracketEdges: {
      single: [11925, 48475, 103350, 197300, 250525, 626350],
      married: [23850, 96950, 206700, 394600, 501050, 751600],
      head_of_household: [17000, 64850, 103350, 197300, 250500, 626350],
    },
    standardDeduction: { single: 15000, married: 30000, head_of_household: 22500 },
    allowanceValue: 4300,
    legacyAdjustment: { married: 12900, other: 8600 },
  },
  {
    year: 2026,
    ssWageBase: 184500,
    bracketEdges: {
      single: [12400, 50400, 105700, 201775, 256225, 640600],
      married: [24800, 100800, 211400, 403550, 512450, 768700],
      head_of_household: [17700, 67450, 105700, 201750, 256200, 640600],
    },
    standardDeduction: { single: 16100, married: 32200, head_of_household: 24150 },
    allowanceValue: 4300,
    legacyAdjustment: { married: 12900, other: 8600 },
  },
];

/**
 * Year used when a caller does not say which year (legacy pure-function callers and tests).
 * Every posting path passes the pay date's year explicitly.
 */
export const DEFAULT_TAX_YEAR = 2024;

/** Social Security employee/employer rate (6.2%). */
const SS_RATE = new Decimal('0.062');
/** Medicare base rate (1.45%). */
const MEDICARE_BASE_RATE = new Decimal('0.0145');
/** Additional Medicare Tax rate (0.9%) above $200,000 of wages in the calendar year. */
const ADDITIONAL_MEDICARE_RATE = new Decimal('0.009');
/** Annual wage threshold for Additional Medicare Tax withholding (not indexed). */
export const ADDITIONAL_MEDICARE_THRESHOLD = 200000;
/** FUTA wage base — the first $7,000 of wages paid to each employee per year (not indexed). */
export const FUTA_WAGE_BASE = 7000;
/** Net FUTA rate (6.0% statutory minus the full 5.4% state unemployment credit). */
export const FUTA_NET_RATE = '0.006';

/**
 * The table for `year`. Years outside the table use the nearest year we have (the latest
 * table for future years, the earliest for older ones) and report it via `tableYear`.
 */
export function taxYearTable(year?: number | null): FederalTaxYear {
  const y = Number.isInteger(year) ? (year as number) : DEFAULT_TAX_YEAR;
  const exact = FEDERAL_TAX_YEARS.find((t) => t.year === y);
  if (exact) return exact;
  const sorted = [...FEDERAL_TAX_YEARS].sort((a, b) => a.year - b.year);
  if (y > sorted[sorted.length - 1].year) return sorted[sorted.length - 1];
  return sorted[0];
}

/** Social Security wage base for a calendar year (W-2 Box 3 cap, employee + employer SS). */
export function ssWageBaseFor(year?: number | null): number {
  return taxYearTable(year).ssWageBase;
}

/** True when the year has its own table (false = nearest year's figures were used). */
export function hasTaxYearTable(year: number): boolean {
  return FEDERAL_TAX_YEARS.some((t) => t.year === year);
}

/** Normalize any stored / legacy filing status text to a W-4 filing status. */
export function normalizeFilingStatus(raw: unknown): FilingStatus {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'married' || s === 'married_jointly' || s === 'married_filing_jointly' || s === 'mfj') {
    return 'married';
  }
  if (s === 'head_of_household' || s === 'hoh' || s === 'head') return 'head_of_household';
  return 'single'; // single, married filing separately, unknown
}

// ---------------------------------------------------------------------------
// W-4 data
// ---------------------------------------------------------------------------

/**
 * Employee W-4 as stored on employees.w4 (all optional). `formYear` < 2020 (or `allowances`
 * without a formYear) selects the pre-2020 computation.
 */
export interface W4Data {
  filingStatus?: FilingStatus | string;
  /** Form version year (2020+ = redesigned form). */
  formYear?: number | null;
  /** Step 2(c) "multiple jobs" checkbox. */
  step2Checkbox?: boolean | null;
  /** Step 3 total annual dependent credits. */
  dependentsAmount?: MoneyInput | null;
  /** Step 4(a) other annual income. */
  otherIncome?: MoneyInput | null;
  /** Step 4(b) annual deductions beyond the standard deduction. */
  deductions?: MoneyInput | null;
  /** Step 4(c) extra withholding per pay period. */
  extraWithholding?: MoneyInput | null;
  /** Pre-2020 forms: number of allowances. */
  allowances?: number | null;
  /** Exempt from federal income tax withholding. */
  exempt?: boolean | null;
}

const dec = (v: MoneyInput | null | undefined): Decimal => {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  try {
    const d = toDecimal(v);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

function isLegacyW4(w4: W4Data | null | undefined): boolean {
  if (!w4) return false;
  if (typeof w4.formYear === 'number' && w4.formYear > 0) return w4.formYear < 2020;
  return w4.allowances != null && w4.allowances !== undefined && Number(w4.allowances) > 0;
}

// ---------------------------------------------------------------------------
// Core computation functions
// ---------------------------------------------------------------------------

export interface FederalIncomeTaxInput {
  /** Annual taxable wages (after the standard deduction / adjustments). */
  annualTaxable: MoneyInput;
  filingStatus: FilingStatus;
  /** Tax year whose brackets apply (default DEFAULT_TAX_YEAR). */
  year?: number;
  /** W-4 Step 2 checkbox: half-width brackets. */
  halfBrackets?: boolean;
}

/**
 * Compute annual federal income tax using the year's brackets. Bracket bases are derived
 * from the edges and rates so the data stays a plain list of thresholds.
 */
export function computeFederalIncomeTax({
  annualTaxable,
  filingStatus,
  year,
  halfBrackets = false,
}: FederalIncomeTaxInput): Decimal {
  const taxable = toDecimal(annualTaxable);
  if (taxable.lessThanOrEqualTo(0)) return new Decimal(0);

  const table = taxYearTable(year);
  const status = normalizeFilingStatus(filingStatus);
  const edges = table.bracketEdges[status].map((e) => new Decimal(e).times(halfBrackets ? 0.5 : 1));

  let tax = new Decimal(0);
  let floor = new Decimal(0);
  for (let i = 0; i < RATES.length; i++) {
    const ceiling = i < edges.length ? edges[i] : null;
    if (ceiling && taxable.greaterThan(ceiling)) {
      tax = tax.plus(ceiling.minus(floor).times(RATES[i]));
      floor = ceiling;
      continue;
    }
    tax = tax.plus(taxable.minus(floor).times(RATES[i]));
    break;
  }
  return Money.round2(tax);
}

export interface WithholdingInput {
  /** Taxable wages for this pay period (gross minus pre-tax deductions). */
  grossPerPeriod: number | string;
  /** Number of pay periods in the year (26 biweekly, 24 semimonthly, 12 monthly, 52 weekly). */
  periodsPerYear: number;
  filingStatus: FilingStatus;
  /**
   * Wages already paid to the employee this calendar year, EXCLUDING the current check
   * (default 0). The Social Security wage base and the Additional Medicare Tax threshold are
   * applied against actual YTD wages — not an annualized projection of the current period.
   */
  ytdGrossBefore?: MoneyInput;
  /** Calendar year of the pay date (selects brackets + SS wage base). */
  year?: number;
  /** The employee's W-4 (Steps 2-4, or pre-2020 allowances). */
  w4?: W4Data | null;
}

export interface WithholdingResult {
  /** Federal income tax withheld this period. */
  federalIncomeTax: string;
  /** Social Security tax withheld this period (6.2%, up to the year's SS wage base). */
  socialSecurity: string;
  /** Medicare tax withheld this period (1.45% + 0.9% over $200,000 YTD). */
  medicare: string;
  /** Total withholding (federalIncomeTax + socialSecurity + medicare). */
  totalPerPeriod: string;
  /** Net take-home pay this period after all withholding. */
  net: string;
  /** Tax year whose table was actually used. */
  tableYear: number;
}

/** Annual federal income tax for an annualized wage under a W-4 — exported for tests/UI. */
export function annualFederalWithholding(
  annualWages: MoneyInput,
  filingStatus: FilingStatus,
  year?: number,
  w4?: W4Data | null,
): Decimal {
  const table = taxYearTable(year);
  if (w4?.exempt) return new Decimal(0);
  const wages = dec(annualWages);
  if (isLegacyW4(w4)) {
    // Computational bridge for 2019-and-earlier W-4s.
    const status: FilingStatus = normalizeFilingStatus(w4?.filingStatus ?? filingStatus) === 'married' ? 'married' : 'single';
    const legacyAdj = status === 'married' ? table.legacyAdjustment.married : table.legacyAdjustment.other;
    const allowances = Math.max(0, Math.floor(Number(w4?.allowances ?? 0)));
    const adjusted = wages
      .minus(new Decimal(table.allowanceValue).times(allowances))
      .minus(new Decimal(table.standardDeduction[status]).minus(legacyAdj));
    return computeFederalIncomeTax({ annualTaxable: Decimal.max(0, adjusted), filingStatus: status, year: table.year });
  }
  const status = normalizeFilingStatus(w4?.filingStatus ?? filingStatus);
  const step2 = !!w4?.step2Checkbox;
  const std = new Decimal(table.standardDeduction[status]).times(step2 ? 0.5 : 1);
  const adjusted = wages.plus(dec(w4?.otherIncome)).minus(dec(w4?.deductions)).minus(std);
  const tax = computeFederalIncomeTax({
    annualTaxable: Decimal.max(0, adjusted),
    filingStatus: status,
    year: table.year,
    halfBrackets: step2,
  });
  return Decimal.max(0, tax.minus(dec(w4?.dependentsAmount)));
}

/**
 * Compute per-period federal withholding for an employee.
 *
 *  1. Annualize the period's taxable wages (× periodsPerYear) — federal income tax ONLY.
 *  2. Apply the year's percentage-method schedule with the employee's W-4.
 *  3. Social Security at 6.2% on this check, capped by actual YTD wages against the year's
 *     wage base.
 *  4. Medicare at 1.45% + 0.9% Additional Medicare Tax on the portion of this check that
 *     pushes actual YTD wages above $200,000.
 */
export function computeWithholding({
  grossPerPeriod,
  periodsPerYear,
  filingStatus,
  ytdGrossBefore = 0,
  year,
  w4,
}: WithholdingInput): WithholdingResult {
  if (periodsPerYear <= 0) {
    throw new Error('periodsPerYear must be greater than 0');
  }
  const table = taxYearTable(year);

  const grossPer = new Decimal(grossPerPeriod);
  const periods = new Decimal(periodsPerYear);
  const ytdBefore = Decimal.max(new Decimal(0), toDecimal(ytdGrossBefore));

  // 1-2. Federal income tax (annual, then per period) + Step 4(c) extra withholding.
  const annualFederal = annualFederalWithholding(grossPer.times(periods), filingStatus, table.year, w4);
  let federalPerPeriod = Money.round2(annualFederal.dividedBy(periods));
  if (!w4?.exempt) {
    const extra = dec(w4?.extraWithholding);
    if (extra.greaterThan(0)) federalPerPeriod = Money.round2(federalPerPeriod.plus(extra));
  }

  // 3. Social Security — the portion of THIS check under the year's wage base.
  const ssPerPeriod = Money.round2(ssTaxableThisCheck(grossPer, ytdBefore, table.year).times(SS_RATE));

  // 4. Medicare — 1.45% on all wages; 0.9% only on the part of this check above $200k YTD.
  const additionalThreshold = new Decimal(ADDITIONAL_MEDICARE_THRESHOLD);
  const additionalTaxableThisPeriod = Decimal.min(
    grossPer,
    Decimal.max(new Decimal(0), ytdBefore.plus(grossPer).minus(additionalThreshold)),
  );
  const medicarePerPeriod = Money.round2(
    grossPer.times(MEDICARE_BASE_RATE).plus(additionalTaxableThisPeriod.times(ADDITIONAL_MEDICARE_RATE)),
  );

  const total = Money.round2(federalPerPeriod.plus(ssPerPeriod).plus(medicarePerPeriod));
  const net = Money.round2(grossPer.minus(total));

  return {
    federalIncomeTax: toAmountString(federalPerPeriod),
    socialSecurity: toAmountString(ssPerPeriod),
    medicare: toAmountString(medicarePerPeriod),
    totalPerPeriod: toAmountString(total),
    net: toAmountString(net),
    tableYear: table.year,
  };
}

/** Portion of a check subject to Social Security given YTD wages before it. */
export function ssTaxableThisCheck(gross: MoneyInput, ytdBefore: MoneyInput, year?: number): Decimal {
  const base = new Decimal(ssWageBaseFor(year));
  return Decimal.max(new Decimal(0), Decimal.min(toDecimal(gross), base.minus(Decimal.max(0, toDecimal(ytdBefore)))));
}

/** Portion of a check under a per-employee annual wage base (FUTA, SUI, SDI). */
export function taxableUnderBase(gross: MoneyInput, ytdBefore: MoneyInput, wageBase: MoneyInput | null): Decimal {
  const g = toDecimal(gross);
  if (wageBase === null || wageBase === undefined || wageBase === '') return Decimal.max(0, g);
  const base = toDecimal(wageBase);
  if (base.lessThanOrEqualTo(0)) return Decimal.max(0, g); // 0 / blank = no wage base
  return Decimal.max(new Decimal(0), Decimal.min(g, base.minus(Decimal.max(0, toDecimal(ytdBefore)))));
}

// ---------------------------------------------------------------------------
// Employer payroll taxes (employer FICA match + FUTA)
// ---------------------------------------------------------------------------

export interface EmployerTaxInput {
  /** Taxable wages for this pay period. */
  grossPerPeriod: number | string;
  /** Wages already paid this calendar year, excluding the current check (default 0). */
  ytdGrossBefore?: MoneyInput;
  /** Calendar year of the pay date (selects the SS wage base). */
  year?: number;
}

export interface EmployerTaxResult {
  /** Employer Social Security match — 6.2% of SS-taxable wages this check. */
  socialSecurity: string;
  /** Employer Medicare match — 1.45% of wages (no employer match on the 0.9% additional tax). */
  medicare: string;
  /** Federal Unemployment (FUTA) — 0.6% net rate on the first $7,000 of YTD wages. */
  futa: string;
  /** Total employer payroll taxes for this check. */
  total: string;
}

/**
 * Employer-side payroll taxes for one paycheck — an EXPENSE of the employer
 * (Dr Payroll Tax Expense / Cr Payroll Liabilities) that never reduces net pay.
 */
export function computeEmployerTaxes({
  grossPerPeriod,
  ytdGrossBefore = 0,
  year,
}: EmployerTaxInput): EmployerTaxResult {
  const grossPer = new Decimal(grossPerPeriod);
  const ytdBefore = Decimal.max(new Decimal(0), toDecimal(ytdGrossBefore));

  const socialSecurity = Money.round2(ssTaxableThisCheck(grossPer, ytdBefore, year).times(SS_RATE));
  const medicare = Money.round2(grossPer.times(MEDICARE_BASE_RATE));
  const futa = Money.round2(taxableUnderBase(grossPer, ytdBefore, FUTA_WAGE_BASE).times(FUTA_NET_RATE));
  const total = Money.round2(socialSecurity.plus(medicare).plus(futa));

  return {
    socialSecurity: toAmountString(socialSecurity),
    medicare: toAmountString(medicare),
    futa: toAmountString(futa),
    total: toAmountString(total),
  };
}
