/**
 * State payroll income-tax withholding — approximate 2024 rates.
 *
 * DISCLAIMER: These rates are a DOCUMENTED APPROXIMATION of publicly available
 * ~2024 state income-tax withholding rules. They are provided for ESTIMATION
 * PURPOSES ONLY. State tax law changes frequently, rates vary by filing status,
 * income level, and local jurisdiction, and many states apply additional
 * deductions, credits, exemptions, or surtaxes not modeled here. Progressive
 * (graduated-bracket) states — CA, NY, NJ, MN, OR, VT, HI, CT, ME, SC, IA,
 * MO, MT, NE, ND, OH, OK, RI, VA, WI, AR, KS, LA, MD, NM — are represented
 * by a SINGLE FLAT APPROXIMATION of a mid-range effective rate for a typical
 * wage earner. These approximations can diverge significantly for very low or
 * very high incomes. ALWAYS verify against the current official state revenue
 * department guidance and use full graduated bracket tables before filing or
 * remitting payroll taxes. This code is NOT a substitute for professional tax
 * advice or a certified payroll system.
 *
 * Model used per state:
 *   - 'none'  — no state income tax on wages (rate = 0)
 *   - 'flat'  — single flat rate applied to taxable income
 *               (may be the statutory flat rate OR a mid-range approximation
 *                for a progressive-bracket state — see rateLabel for details)
 *
 * Sources (publicly available, approximate 2024):
 *
 * NO STATE INCOME TAX (wages):
 *   AK  — Alaska: no state income tax
 *   FL  — Florida: no state income tax
 *   NV  — Nevada: no state income tax
 *   NH  — New Hampshire: taxes only interest/dividend income, not wages
 *   SD  — South Dakota: no state income tax
 *   TN  — Tennessee: no state income tax on wages (Hall Tax repealed 2021)
 *   TX  — Texas: no state income tax
 *   WA  — Washington: no state income tax on wages (capital gains tax only)
 *   WY  — Wyoming: no state income tax
 *
 * FLAT-RATE STATES (statutory flat rate):
 *   AZ  — 2.5%   (Prop 132 / SB 1828, effective 2023)
 *   CO  — 4.4%   (HB22-1063)
 *   GA  — 5.39%  (HB 1437, 2024 transitional flat rate) — note: task says 5.39; earlier entry was 5.49; using task-specified 5.39
 *   ID  — 5.695% (enacted 2022)
 *   IL  — 4.95%  (IL Public Act 100-0022)
 *   IN  — 3.05%  (IC 6-3-2-1, effective 2024)
 *   KY  — 4.0%   (HB 1, enacted 2022, effective 2024)
 *   MA  — 5.0%   (Chapter 62 §4; 4% surtax on income >$1M not modeled)
 *   MI  — 4.25%  (MCL 206.51)
 *   MS  — 4.7%   (HB 531, 2024 rate per graduated phase-out; approx)
 *   NC  — 4.5%   (NC GS §105-153.7, effective 2024)
 *   PA  — 3.07%  (72 P.S. §7302)
 *   UT  — 4.55%  (UC §59-10-104)
 *
 * PROGRESSIVE STATES — flat mid-range approximation:
 *   AL  — ~5%    (graduated 2%–5%; top bracket; approx)
 *   AR  — ~5.9%  (graduated up to 5.9% for 2024; approx top-bracket used)
 *   CA  — ~6%    (graduated 1%–13.3%; mid-range approx; verify with FTB DE 4)
 *   CT  — ~6%    (graduated 3%–6.99%; mid-range approx)
 *   DC  — ~8%    (graduated 4%–10.75%; mid-range approx for DC)
 *   DE  — ~5%    (graduated 0%–6.6%; mid-range approx)
 *   HI  — ~8%    (graduated 1.4%–11%; mid-range approx)
 *   IA  — ~6%    (graduated up to 8.53% historically; 2024 flat reform ~5.7% approx)
 *   KS  — ~5%    (graduated 3.1%–5.7%; approx)
 *   LA  — ~4%    (graduated 1.85%–4.25%; approx)
 *   MD  — ~5%    (graduated 2%–5.75%; approx; does not include local piggyback)
 *   ME  — ~7%    (graduated 5.8%–7.15%; approx)
 *   MN  — ~7%    (graduated 5.35%–9.85%; mid-range approx)
 *   MO  — ~5%    (graduated up to 4.95% for 2024 post-reform; approx)
 *   MT  — ~6%    (graduated up to 6.75%; approx)
 *   NE  — ~6%    (graduated up to 6.84%; approx)
 *   NJ  — ~6%    (graduated 1.4%–10.75%; mid-range approx)
 *   NM  — ~5%    (graduated 1.7%–5.9%; approx)
 *   NY  — ~6%    (graduated 4%–10.9%; mid-range approx; verify with IT-2104)
 *   ND  — ~2%    (graduated 1.1%–2.9% post-2023 reform; approx)
 *   OH  — ~3.5%  (graduated up to 3.99% for 2024; approx)
 *   OK  — ~5%    (graduated 0.25%–4.75%; approx top-bracket)
 *   OR  — ~8%    (graduated 4.75%–9.9%; mid-range approx)
 *   RI  — ~5%    (graduated 3.75%–5.99%; approx)
 *   SC  — ~6%    (graduated 0%–6.4%; approx)
 *   VA  — ~5%    (graduated 2%–5.75%; approx)
 *   VT  — ~7%    (graduated 3.35%–8.75%; mid-range approx)
 *   WI  — ~6%    (graduated 3.54%–7.65%; mid-range approx)
 *   WV  — ~5%    (graduated 3%–6.5%; approx)
 */

import Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';

// ---------------------------------------------------------------------------
// State table
// ---------------------------------------------------------------------------

export type StateWithholdingModel = 'none' | 'flat';

export interface StateInfo {
  /** Two-letter state abbreviation (or 'DC' for the District of Columbia). */
  code: string;
  /** Full state/territory name. */
  name: string;
  model: StateWithholdingModel;
  /**
   * For 'flat' model: the rate as a decimal fraction (e.g. 0.0495 = 4.95%).
   * For 'none' model: 0.
   */
  rate: number;
  /** Human-readable rate description for display. */
  rateLabel: string;
}

/**
 * Public ~2024 state income-tax info for all 50 US states + DC.
 *
 * APPROXIMATION — verify before filing; flat rates used for progressive states.
 * Sorted alphabetically by state code.
 */
export const STATES: StateInfo[] = [
  // --- A ---
  { code: 'AK', name: 'Alaska',               model: 'none', rate: 0,       rateLabel: 'No state income tax' },
  { code: 'AL', name: 'Alabama',              model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 2%–5%)' },
  { code: 'AR', name: 'Arkansas',             model: 'flat', rate: 0.059,   rateLabel: '~5.9% (approx; top bracket 2024)' },
  { code: 'AZ', name: 'Arizona',              model: 'flat', rate: 0.025,   rateLabel: '2.5% flat' },
  // --- C ---
  { code: 'CA', name: 'California',           model: 'flat', rate: 0.06,    rateLabel: '~6% (mid-range approx.; verify with FTB DE 4)' },
  { code: 'CO', name: 'Colorado',             model: 'flat', rate: 0.044,   rateLabel: '4.4% flat' },
  { code: 'CT', name: 'Connecticut',          model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated 3%–6.99%)' },
  // --- D ---
  { code: 'DC', name: 'District of Columbia', model: 'flat', rate: 0.08,    rateLabel: '~8% (approx; graduated 4%–10.75%)' },
  { code: 'DE', name: 'Delaware',             model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 0%–6.6%)' },
  // --- F ---
  { code: 'FL', name: 'Florida',              model: 'none', rate: 0,       rateLabel: 'No state income tax' },
  // --- G ---
  { code: 'GA', name: 'Georgia',              model: 'flat', rate: 0.0539,  rateLabel: '5.39% flat (2024 transitional, HB 1437)' },
  // --- H ---
  { code: 'HI', name: 'Hawaii',               model: 'flat', rate: 0.08,    rateLabel: '~8% (approx; graduated 1.4%–11%)' },
  // --- I ---
  { code: 'IA', name: 'Iowa',                 model: 'flat', rate: 0.057,   rateLabel: '~5.7% (approx; 2024 reform)' },
  { code: 'ID', name: 'Idaho',                model: 'flat', rate: 0.05695, rateLabel: '5.695% flat' },
  { code: 'IL', name: 'Illinois',             model: 'flat', rate: 0.0495,  rateLabel: '4.95% flat' },
  { code: 'IN', name: 'Indiana',              model: 'flat', rate: 0.0305,  rateLabel: '3.05% flat (2024)' },
  // --- K ---
  { code: 'KS', name: 'Kansas',               model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 3.1%–5.7%)' },
  { code: 'KY', name: 'Kentucky',             model: 'flat', rate: 0.04,    rateLabel: '4.0% flat (effective 2024)' },
  // --- L ---
  { code: 'LA', name: 'Louisiana',            model: 'flat', rate: 0.04,    rateLabel: '~4% (approx; graduated 1.85%–4.25%)' },
  // --- M ---
  { code: 'MA', name: 'Massachusetts',        model: 'flat', rate: 0.05,    rateLabel: '5.0% flat (4% surtax on income >$1M not modeled)' },
  { code: 'MD', name: 'Maryland',             model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 2%–5.75%; local piggyback not included)' },
  { code: 'ME', name: 'Maine',                model: 'flat', rate: 0.07,    rateLabel: '~7% (approx; graduated 5.8%–7.15%)' },
  { code: 'MI', name: 'Michigan',             model: 'flat', rate: 0.0425,  rateLabel: '4.25% flat' },
  { code: 'MN', name: 'Minnesota',            model: 'flat', rate: 0.07,    rateLabel: '~7% (approx; graduated 5.35%–9.85%)' },
  { code: 'MO', name: 'Missouri',             model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; 2024 top rate 4.95% post-reform)' },
  { code: 'MS', name: 'Mississippi',          model: 'flat', rate: 0.047,   rateLabel: '~4.7% (approx; 2024 graduated phase-out)' },
  { code: 'MT', name: 'Montana',              model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated up to 6.75%)' },
  // --- N ---
  { code: 'NC', name: 'North Carolina',       model: 'flat', rate: 0.045,   rateLabel: '4.5% flat (2024, NC GS §105-153.7)' },
  { code: 'ND', name: 'North Dakota',         model: 'flat', rate: 0.02,    rateLabel: '~2% (approx; graduated 1.1%–2.9% post-2023 reform)' },
  { code: 'NE', name: 'Nebraska',             model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated up to 6.84%)' },
  { code: 'NH', name: 'New Hampshire',        model: 'none', rate: 0,       rateLabel: 'No wage withholding (interest/dividend tax only)' },
  { code: 'NJ', name: 'New Jersey',           model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated 1.4%–10.75%)' },
  { code: 'NM', name: 'New Mexico',           model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 1.7%–5.9%)' },
  { code: 'NV', name: 'Nevada',               model: 'none', rate: 0,       rateLabel: 'No state income tax' },
  { code: 'NY', name: 'New York',             model: 'flat', rate: 0.06,    rateLabel: '~6% (mid-range approx.; verify with IT-2104)' },
  // --- O ---
  { code: 'OH', name: 'Ohio',                 model: 'flat', rate: 0.035,   rateLabel: '~3.5% (approx; graduated up to 3.99% 2024)' },
  { code: 'OK', name: 'Oklahoma',             model: 'flat', rate: 0.0475,  rateLabel: '~4.75% (approx; top bracket)' },
  { code: 'OR', name: 'Oregon',               model: 'flat', rate: 0.08,    rateLabel: '~8% (approx; graduated 4.75%–9.9%)' },
  // --- P ---
  { code: 'PA', name: 'Pennsylvania',         model: 'flat', rate: 0.0307,  rateLabel: '3.07% flat' },
  // --- R ---
  { code: 'RI', name: 'Rhode Island',         model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 3.75%–5.99%)' },
  // --- S ---
  { code: 'SC', name: 'South Carolina',       model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated 0%–6.4%)' },
  { code: 'SD', name: 'South Dakota',         model: 'none', rate: 0,       rateLabel: 'No state income tax' },
  // --- T ---
  { code: 'TN', name: 'Tennessee',            model: 'none', rate: 0,       rateLabel: 'No state income tax on wages' },
  { code: 'TX', name: 'Texas',                model: 'none', rate: 0,       rateLabel: 'No state income tax' },
  // --- U ---
  { code: 'UT', name: 'Utah',                 model: 'flat', rate: 0.0455,  rateLabel: '4.55% flat' },
  // --- V ---
  { code: 'VA', name: 'Virginia',             model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 2%–5.75%)' },
  { code: 'VT', name: 'Vermont',              model: 'flat', rate: 0.07,    rateLabel: '~7% (approx; graduated 3.35%–8.75%)' },
  // --- W ---
  { code: 'WA', name: 'Washington',           model: 'none', rate: 0,       rateLabel: 'No state income tax on wages' },
  { code: 'WI', name: 'Wisconsin',            model: 'flat', rate: 0.06,    rateLabel: '~6% (approx; graduated 3.54%–7.65%)' },
  { code: 'WV', name: 'West Virginia',        model: 'flat', rate: 0.05,    rateLabel: '~5% (approx; graduated 3%–6.5%)' },
  { code: 'WY', name: 'Wyoming',              model: 'none', rate: 0,       rateLabel: 'No state income tax' },
];

/** Map of state code -> StateInfo for O(1) lookup. */
const STATE_MAP = new Map<string, StateInfo>(STATES.map((s) => [s.code, s]));

/** List of supported state codes (alphabetical by code). */
export const SUPPORTED_STATE_CODES: string[] = STATES.map((s) => s.code);

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export interface StateWithholdingInput {
  /** Two-letter state code (e.g. 'CA', 'TX', 'DC'). */
  state: string;
  /** Annual taxable income for state purposes (e.g. annualized gross). */
  annualTaxable: number | string;
}

/**
 * Compute annual state income tax for the given state and annual taxable income.
 * Returns the annual state tax as a 2-decimal-place string.
 *
 * APPROXIMATION — verify before filing; flat rates used for progressive states.
 */
export function computeStateWithholding({ state, annualTaxable }: StateWithholdingInput): string {
  const info = STATE_MAP.get(state.toUpperCase());
  if (!info) {
    throw new Error(`State '${state}' is not supported. Supported states: ${SUPPORTED_STATE_CODES.join(', ')}`);
  }

  if (info.model === 'none') {
    return '0.00';
  }

  // 'flat' model
  const taxable = new Decimal(annualTaxable);
  if (taxable.lessThanOrEqualTo(0)) return '0.00';

  const annualTax = Money.round2(taxable.times(info.rate));
  return toAmountString(annualTax);
}

export interface StatePerPeriodInput {
  /** Gross wages for this pay period (before any deductions). */
  grossPerPeriod: number | string;
  /** Number of pay periods in the year (e.g. 26 = biweekly, 12 = monthly). */
  periodsPerYear: number;
  /** Two-letter state code. */
  state: string;
}

export interface StatePerPeriodResult {
  /** Per-period state income tax withheld (2-dp string). */
  stateTax: string;
  /** Annual state income tax (2-dp string). */
  annualStateTax: string;
  /** State info for the requested state. */
  stateInfo: StateInfo;
}

/**
 * Compute per-period state income-tax withholding for an employee.
 *
 * Steps:
 *  1. Annualize grossPerPeriod (× periodsPerYear).
 *  2. Apply the state's withholding model to get annual state tax.
 *  3. Divide by periodsPerYear to get the per-period amount.
 *
 * APPROXIMATION — verify before filing; flat rates used for progressive states.
 */
export function statePerPeriod({
  grossPerPeriod,
  periodsPerYear,
  state,
}: StatePerPeriodInput): StatePerPeriodResult {
  if (periodsPerYear <= 0) {
    throw new Error('periodsPerYear must be greater than 0');
  }

  const info = STATE_MAP.get(state.toUpperCase());
  if (!info) {
    throw new Error(`State '${state}' is not supported. Supported states: ${SUPPORTED_STATE_CODES.join(', ')}`);
  }

  const grossPer = new Decimal(grossPerPeriod);
  const periods = new Decimal(periodsPerYear);
  const annualGross = grossPer.times(periods);

  const annualStateTaxStr = computeStateWithholding({ state: state.toUpperCase(), annualTaxable: annualGross.toString() });
  const annualStateTax = new Decimal(annualStateTaxStr);
  const stateTaxPerPeriod = Money.round2(annualStateTax.dividedBy(periods));

  return {
    stateTax: toAmountString(stateTaxPerPeriod),
    annualStateTax: annualStateTaxStr,
    stateInfo: info,
  };
}
