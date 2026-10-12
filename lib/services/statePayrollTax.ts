/**
 * State income tax withholding — a YEAR-KEYED engine (2025 and 2026 tables).
 *
 * Every state is one of:
 *   - 'none'      no state income tax on wages (AK, FL, NV, NH, SD, TN, TX, WA, WY);
 *   - 'formula'   the state's own withholding formula for the year — annualize the check's state
 *                 wages, subtract the state W-4 allowances / standard deduction the formula uses,
 *                 apply the state's rate or brackets, de-annualize, add the employee's extra
 *                 withholding. Modelled: AZ, CA, CO, GA, IL, IN, KY, MA, MI, MS, NC, NJ, NY, OH,
 *                 PA, UT, VA;
 *   - 'employee'  every other state: NOT calculated by the app. The employee record carries a
 *                 user-entered percent of state wages or a fixed amount per check; without one the
 *                 paycheck gets no state withholding and a plain note says so — never a guess.
 *
 * A pay date in a year without its own table uses the nearest year's table AND reports it in
 * `notes` (e.g. a 2027 paycheck: "2027 state tables are not in this version; 2026 figures used").
 * Local taxes (PA EIT/LST, NYC/Yonkers, Ohio municipal, Indiana county, Michigan city) are not
 * calculated — add a local tax payroll item; the result's notes say so for those states.
 *
 * Sources (each state's employer withholding guide for the year): AZ Form A-4; CA EDD DE 44
 * (Method B, exact calculation); CO DR 1098 / DR 0004; GA Employer's Tax Guide + HB 111 (2025);
 * IL-700-T; IN Departmental Notice 1 + HEA 1001 (2023) rate schedule; KY Form 42A003 + HB 1
 * (2025); MA Circular M; MI Form 446; MS Pub 89-700; NC-30 + S.L. 2023-134 rate schedule;
 * NJ-WT rate tables; NYS-50-T-NYS; OH Employer Withholding tables + HB 96 (2025); PA Rev-415;
 * UT Pub 14; VA Employer Withholding Instructions. Verify against the current guide before
 * filing; this module is data — updating a year means editing that year's entry.
 */
import Decimal from 'decimal.js';
import { Money, toAmountString, type MoneyInput } from '@/lib/money';

// ---------------------------------------------------------------------------
// Employee state W-4 (employees.w4.stateW4)
// ---------------------------------------------------------------------------

export type StateFilingStatus = 'single' | 'married' | 'married_separate' | 'head_of_household';

export const STATE_FILING_STATUS_LABELS: Record<StateFilingStatus, string> = {
  single: 'Single',
  married: 'Married (filing jointly)',
  married_separate: 'Married filing separately / married, withhold at single rate',
  head_of_household: 'Head of household',
};

/**
 * The employee's state withholding certificate. Which fields matter depends on the state
 * (see STATE_W4_FIELDS); unused fields are ignored.
 */
export interface StateW4 {
  filingStatus?: StateFilingStatus | null;
  /** Allowances / exemptions claimed (IL-W-4 line 1, NC-4, MI-W4, M-4, VA-4, IT-2104, NJ-W4, DE 4, WH-4, IT 4, 42A804, G-4). */
  allowances?: number | null;
  /** Additional allowances (IL-W-4 line 2, CA DE 4 estimated deduction allowances, G-4 additional allowances). */
  additionalAllowances?: number | null;
  /** Dependents (IN WH-4, GA G-4, MS 89-350). */
  dependents?: number | null;
  /** Extra withholding per paycheck. */
  extraWithholding?: string | number | null;
  /** Exempt from state income tax withholding. */
  exempt?: boolean | null;
  /** Arizona A-4 elected percent of gross wages (0.5, 1, 1.5, 2, 2.5, 3, 3.5). */
  rate?: string | number | null;
  /** Colorado DR 0004 line 2 annual withholding allowance. */
  annualAllowance?: string | number | null;
  /** New Jersey NJ-W4 rate table letter (A or B). */
  njTable?: 'A' | 'B' | null;
  /** States the app does not calculate: percent of state wages per check (e.g. 4.5). */
  fallbackPercent?: string | number | null;
  /** States the app does not calculate: fixed amount per check. */
  fallbackAmount?: string | number | null;
}

/** Which state W-4 inputs each modelled state uses (drives the employee form). */
export const STATE_W4_FIELDS: Record<string, Array<keyof StateW4>> = {
  AZ: ['rate'],
  CA: ['filingStatus', 'allowances', 'additionalAllowances'],
  CO: ['annualAllowance'],
  GA: ['filingStatus', 'dependents', 'additionalAllowances'],
  IL: ['allowances', 'additionalAllowances'],
  IN: ['allowances', 'dependents'],
  KY: [],
  MA: ['filingStatus', 'allowances'],
  MI: ['allowances'],
  MS: ['filingStatus', 'dependents'],
  NC: ['filingStatus', 'allowances'],
  NJ: ['njTable', 'allowances'],
  NY: ['filingStatus', 'allowances'],
  OH: ['allowances'],
  PA: [],
  UT: ['filingStatus'],
  VA: ['allowances'],
};

// ---------------------------------------------------------------------------
// State list
// ---------------------------------------------------------------------------

export type StateWithholdingModel = 'none' | 'formula' | 'employee';

export interface StateInfo {
  code: string;
  name: string;
  model: StateWithholdingModel;
  /** Plain-language description of how the app handles this state. */
  rateLabel: string;
  /** Local income taxes the app does not calculate (shown as a note). */
  localNote?: string;
}

const NONE = 'No state income tax on wages';
const EMPLOYEE = 'Not calculated - enter a percent or amount on the employee';

export const STATES: StateInfo[] = [
  { code: 'AK', name: 'Alaska', model: 'none', rateLabel: NONE },
  { code: 'AL', name: 'Alabama', model: 'employee', rateLabel: EMPLOYEE, localNote: 'Some Alabama cities and counties levy occupational tax.' },
  { code: 'AR', name: 'Arkansas', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'AZ', name: 'Arizona', model: 'formula', rateLabel: 'Employee-elected percent of gross wages (Form A-4; 2.0% when no A-4)' },
  { code: 'CA', name: 'California', model: 'formula', rateLabel: 'EDD DE 44 exact calculation (brackets, allowances)' },
  { code: 'CO', name: 'Colorado', model: 'formula', rateLabel: 'Flat 4.4% after the DR 0004 allowance', localNote: 'Denver, Aurora and other Colorado occupational privilege taxes are not calculated.' },
  { code: 'CT', name: 'Connecticut', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'DC', name: 'District of Columbia', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'DE', name: 'Delaware', model: 'employee', rateLabel: EMPLOYEE, localNote: 'Wilmington city wage tax is not calculated.' },
  { code: 'FL', name: 'Florida', model: 'none', rateLabel: NONE },
  { code: 'GA', name: 'Georgia', model: 'formula', rateLabel: 'Flat rate after standard deduction and dependents (G-4)' },
  { code: 'HI', name: 'Hawaii', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'IA', name: 'Iowa', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'ID', name: 'Idaho', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'IL', name: 'Illinois', model: 'formula', rateLabel: 'Flat 4.95% after IL-W-4 allowances' },
  { code: 'IN', name: 'Indiana', model: 'formula', rateLabel: 'Flat state rate after WH-4 exemptions', localNote: 'Indiana county tax is not calculated - add a local tax item.' },
  { code: 'KS', name: 'Kansas', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'KY', name: 'Kentucky', model: 'formula', rateLabel: 'Flat rate after the standard deduction', localNote: 'Kentucky city / county occupational taxes are not calculated.' },
  { code: 'LA', name: 'Louisiana', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'MA', name: 'Massachusetts', model: 'formula', rateLabel: 'Circular M: 5% after exemptions and FICA, plus 4% surtax on very high wages' },
  { code: 'MD', name: 'Maryland', model: 'employee', rateLabel: EMPLOYEE, localNote: 'Maryland county tax is part of state withholding there.' },
  { code: 'ME', name: 'Maine', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'MI', name: 'Michigan', model: 'formula', rateLabel: 'Flat 4.25% after MI-W4 exemptions', localNote: 'Michigan city income taxes (Detroit and others) are not calculated.' },
  { code: 'MN', name: 'Minnesota', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'MO', name: 'Missouri', model: 'employee', rateLabel: EMPLOYEE, localNote: 'Kansas City and St. Louis earnings taxes are not calculated.' },
  { code: 'MS', name: 'Mississippi', model: 'formula', rateLabel: 'Flat rate above $10,000 after exemptions and standard deduction' },
  { code: 'MT', name: 'Montana', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'NC', name: 'North Carolina', model: 'formula', rateLabel: 'Flat rate after standard deduction and NC-4 allowances' },
  { code: 'ND', name: 'North Dakota', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'NE', name: 'Nebraska', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'NH', name: 'New Hampshire', model: 'none', rateLabel: NONE },
  { code: 'NJ', name: 'New Jersey', model: 'formula', rateLabel: 'NJ-WT rate table A or B after allowances' },
  { code: 'NM', name: 'New Mexico', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'NV', name: 'Nevada', model: 'none', rateLabel: NONE },
  { code: 'NY', name: 'New York', model: 'formula', rateLabel: 'NYS brackets after the deduction and IT-2104 allowances', localNote: 'New York City and Yonkers taxes are not calculated - add a local tax item.' },
  { code: 'OH', name: 'Ohio', model: 'formula', rateLabel: 'Ohio brackets after IT 4 exemptions', localNote: 'Ohio municipal and school district taxes are not calculated.' },
  { code: 'OK', name: 'Oklahoma', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'OR', name: 'Oregon', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'PA', name: 'Pennsylvania', model: 'formula', rateLabel: 'Flat 3.07% (no allowances)', localNote: 'Pennsylvania local earned income tax (EIT) and local services tax (LST) are not calculated - add a local tax item.' },
  { code: 'RI', name: 'Rhode Island', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'SC', name: 'South Carolina', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'SD', name: 'South Dakota', model: 'none', rateLabel: NONE },
  { code: 'TN', name: 'Tennessee', model: 'none', rateLabel: NONE },
  { code: 'TX', name: 'Texas', model: 'none', rateLabel: NONE },
  { code: 'UT', name: 'Utah', model: 'formula', rateLabel: 'Flat rate less the phased-out withholding allowance (Pub 14)' },
  { code: 'VA', name: 'Virginia', model: 'formula', rateLabel: 'Virginia brackets after the standard deduction and VA-4 exemptions' },
  { code: 'VT', name: 'Vermont', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'WA', name: 'Washington', model: 'none', rateLabel: NONE },
  { code: 'WI', name: 'Wisconsin', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'WV', name: 'West Virginia', model: 'employee', rateLabel: EMPLOYEE },
  { code: 'WY', name: 'Wyoming', model: 'none', rateLabel: NONE },
];

const STATE_MAP = new Map<string, StateInfo>(STATES.map((s) => [s.code, s]));
export const SUPPORTED_STATE_CODES: string[] = STATES.map((s) => s.code);

export function stateInfo(code: string | null | undefined): StateInfo | null {
  return code ? STATE_MAP.get(code.trim().toUpperCase()) ?? null : null;
}

// ---------------------------------------------------------------------------
// Year tables
// ---------------------------------------------------------------------------

/** Marginal brackets: [upper edge (null = no limit), rate]. */
type Brackets = Array<[number | null, string]>;

/** Tax on `income` under marginal brackets. */
export function bracketTax(income: Decimal, brackets: Brackets): Decimal {
  let tax = new Decimal(0);
  let lower = new Decimal(0);
  for (const [edge, rate] of brackets) {
    if (income.lte(lower)) break;
    const top = edge === null ? income : Decimal.min(income, edge);
    tax = tax.plus(top.minus(lower).times(rate));
    if (edge === null) break;
    lower = new Decimal(edge);
  }
  return tax;
}

interface CalcCtx {
  /** Annualized state wages. */
  annual: Decimal;
  /** Annualized employee Social Security + Medicare (Massachusetts deduction). */
  annualFica: Decimal;
  w4: StateW4;
  status: StateFilingStatus;
  allowances: number;
  additional: number;
  dependents: number;
}

type AnnualTaxFn = (c: CalcCtx) => Decimal;

const pos = (d: Decimal) => (d.isNegative() ? new Decimal(0) : d);

/** Flat rate after a fixed annual deduction. */
const flat = (rate: string, deduction: (c: CalcCtx) => number | Decimal = () => 0): AnnualTaxFn => (c) =>
  pos(c.annual.minus(deduction(c))).times(rate);

// ---- California (DE 44 Method B) ----
const CA_RATES = ['0.011', '0.022', '0.044', '0.066', '0.088', '0.1023', '0.1133', '0.1243', '0.1353', '0.1463'];
const caBrackets = (edges: number[]): Brackets => CA_RATES.map((r, i) => [i < edges.length ? edges[i] : null, r]);
const CA_2025 = {
  single: caBrackets([11079, 26264, 41452, 57542, 72724, 371479, 445771, 742953, 1000000]),
  married: caBrackets([22158, 52528, 82904, 115084, 145448, 742958, 891542, 1000000, 1485906]),
  head_of_household: caBrackets([22173, 52530, 67716, 83805, 98990, 505208, 606251, 1000000, 1010417]),
  stdLow: 5706,
  stdHigh: 11412,
  exemptionCredit: '158.40',
};
const caTax = (t: typeof CA_2025): AnnualTaxFn => (c) => {
  const married = c.status === 'married';
  const std = c.status === 'head_of_household' || (married && c.allowances >= 2) ? t.stdHigh : t.stdLow;
  const taxable = pos(c.annual.minus(std).minus(c.additional * 1000));
  const brackets = c.status === 'head_of_household' ? t.head_of_household : married ? t.married : t.single;
  return pos(bracketTax(taxable, brackets).minus(new Decimal(t.exemptionCredit).times(c.allowances)));
};

// ---- New York (NYS-50-T-NYS) ----
const NY_SINGLE_EDGES = [8500, 11700, 13900, 80650, 215400, 1077550, 5000000, 25000000];
const NY_MARRIED_EDGES = [17150, 23600, 27900, 161550, 323200, 2155350, 5000000, 25000000];
const nyTax = (rates: string[]): AnnualTaxFn => (c) => {
  const married = c.status === 'married';
  const edges = married ? NY_MARRIED_EDGES : NY_SINGLE_EDGES;
  const brackets: Brackets = rates.map((r, i) => [i < edges.length ? edges[i] : null, r]);
  const taxable = pos(c.annual.minus(married ? 7950 : 7400).minus(c.allowances * 1000));
  return bracketTax(taxable, brackets);
};
const NY_RATES_2025 = ['0.04', '0.045', '0.0525', '0.055', '0.06', '0.0685', '0.0965', '0.103', '0.109'];
const NY_RATES_2026 = ['0.039', '0.044', '0.0515', '0.054', '0.059', '0.0685', '0.0965', '0.103', '0.109'];

// ---- New Jersey (NJ-WT) ----
const NJ_A: Brackets = [[20000, '0.015'], [35000, '0.02'], [40000, '0.035'], [75000, '0.05525'], [500000, '0.0637'], [1000000, '0.0897'], [null, '0.1075']];
const NJ_B: Brackets = [[20000, '0.015'], [50000, '0.02'], [70000, '0.0245'], [80000, '0.035'], [150000, '0.05525'], [500000, '0.0637'], [1000000, '0.0897'], [null, '0.1075']];
const njTax: AnnualTaxFn = (c) => {
  const table = c.w4.njTable === 'B' || (!c.w4.njTable && c.status === 'married') ? NJ_B : NJ_A;
  return bracketTax(pos(c.annual.minus(c.allowances * 1000)), table);
};

// ---- Virginia ----
const VA_BRACKETS: Brackets = [[3000, '0.02'], [5000, '0.03'], [17000, '0.05'], [null, '0.0575']];
const vaTax = (std: number): AnnualTaxFn => (c) => bracketTax(pos(c.annual.minus(std).minus(c.allowances * 930)), VA_BRACKETS);

// ---- Ohio ----
const ohTax = (brackets: Brackets): AnnualTaxFn => (c) => bracketTax(pos(c.annual.minus(c.allowances * 650)), brackets);

// ---- North Carolina ----
const NC_STD: Record<StateFilingStatus, number> = { single: 12750, married_separate: 12750, married: 25500, head_of_household: 19125 };
const ncTax = (rate: string): AnnualTaxFn => (c) => pos(c.annual.minus(NC_STD[c.status]).minus(c.allowances * 2500)).times(rate);

// ---- Georgia ----
const GA_STD: Record<StateFilingStatus, number> = { single: 12000, married_separate: 12000, married: 24000, head_of_household: 12000 };
const gaTax = (rate: string): AnnualTaxFn => (c) =>
  pos(c.annual.minus(GA_STD[c.status]).minus(c.dependents * 4000).minus(c.additional * 3000)).times(rate);

// ---- Massachusetts (Circular M) ----
const maTax = (surtaxThreshold: number): AnnualTaxFn => (c) => {
  const exemptions = c.allowances > 0 ? 4400 + 1000 * (c.allowances - 1) : 0;
  const hoh = c.status === 'head_of_household' ? 2400 : 0;
  const fica = Decimal.min(c.annualFica, 2000);
  const taxable = pos(c.annual.minus(exemptions).minus(hoh).minus(fica));
  const surtax = pos(taxable.minus(surtaxThreshold)).times('0.04');
  return taxable.times('0.05').plus(surtax);
};

// ---- Mississippi ----
const MS_EXEMPT: Record<StateFilingStatus, number> = { single: 6000, married_separate: 6000, married: 12000, head_of_household: 9500 };
const MS_STD: Record<StateFilingStatus, number> = { single: 2300, married_separate: 2300, married: 4600, head_of_household: 3400 };
const msTax = (rate: string): AnnualTaxFn => (c) =>
  bracketTax(pos(c.annual.minus(MS_EXEMPT[c.status]).minus(MS_STD[c.status]).minus(c.dependents * 1500)), [[10000, '0'], [null, rate]]);

// ---- Utah (Pub 14) ----
const UT_ALLOW: Record<StateFilingStatus, number> = { single: 900, married_separate: 900, married: 1800, head_of_household: 1350 };
const UT_PHASE: Record<StateFilingStatus, number> = { single: 9160, married_separate: 9160, married: 18320, head_of_household: 13740 };
const utTax = (rate: string, allow: Record<StateFilingStatus, number>, phase: Record<StateFilingStatus, number>): AnnualTaxFn => (c) => {
  const gross = c.annual.times(rate);
  const reduced = pos(new Decimal(allow[c.status]).minus(pos(c.annual.minus(phase[c.status])).times('0.013')));
  return pos(gross.minus(reduced));
};

// ---- Arizona (A-4) ----
const AZ_RATES = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5'];
const azTax: AnnualTaxFn = (c) => {
  const pct = c.w4.rate != null && c.w4.rate !== '' ? String(Number(c.w4.rate)) : '2';
  if (!AZ_RATES.includes(pct)) throw new Error(`Arizona withholding must be one of ${AZ_RATES.join(', ')} percent.`);
  return c.annual.times(pct).dividedBy(100);
};

/**
 * Per state, per year: the annual-tax function. A year missing from a state's entry uses the
 * nearest year (with a note). Only modelled states appear here.
 */
const TABLES: Record<string, Record<number, AnnualTaxFn>> = {
  AZ: { 2025: azTax, 2026: azTax },
  // California 2026 DE 44 figures are not entered yet: 2026 checks use 2025 with a note.
  CA: { 2025: caTax(CA_2025) },
  CO: {
    2025: flat('0.044', (c) => Number(c.w4.annualAllowance ?? 0) || 0),
    2026: flat('0.044', (c) => Number(c.w4.annualAllowance ?? 0) || 0),
  },
  GA: { 2025: gaTax('0.0519'), 2026: gaTax('0.0499') },
  IL: {
    2025: flat('0.0495', (c) => c.allowances * 2850 + c.additional * 1000),
    2026: flat('0.0495', (c) => c.allowances * 2925 + c.additional * 1000),
  },
  IN: {
    2025: flat('0.03', (c) => c.allowances * 1000 + c.dependents * 1500),
    2026: flat('0.0295', (c) => c.allowances * 1000 + c.dependents * 1500),
  },
  KY: { 2025: flat('0.04', () => 3270), 2026: flat('0.035', () => 3360) },
  MA: { 2025: maTax(1083150), 2026: maTax(1107750) },
  MI: { 2025: flat('0.0425', (c) => c.allowances * 5800), 2026: flat('0.0425', (c) => c.allowances * 5900) },
  MS: { 2025: msTax('0.044'), 2026: msTax('0.04') },
  NC: { 2025: ncTax('0.0425'), 2026: ncTax('0.0399') },
  NJ: { 2025: njTax, 2026: njTax },
  NY: { 2025: nyTax(NY_RATES_2025), 2026: nyTax(NY_RATES_2026) },
  OH: {
    2025: ohTax([[26050, '0'], [100000, '0.0275'], [null, '0.035']]),
    2026: ohTax([[26050, '0'], [null, '0.0275']]),
  },
  PA: { 2025: flat('0.0307'), 2026: flat('0.0307') },
  // Utah 2026 Pub 14 figures are not entered yet: 2026 checks use 2025 with a note.
  UT: { 2025: utTax('0.045', UT_ALLOW, UT_PHASE) },
  VA: { 2025: vaTax(8500), 2026: vaTax(8500) },
};

/** Years with any state table. */
export const STATE_TABLE_YEARS = [2025, 2026];

/** The states the engine calculates (others need an employee-entered rate or amount). */
export const MODELLED_STATES = Object.keys(TABLES).sort();

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

export interface StateWithholdingCalcInput {
  /** Two-letter work state. */
  state: string;
  /** Tax year (the pay date's year). */
  year: number;
  /** This check's state wages (income-tax wages: gross less pre-tax retirement / Section 125). */
  wagesPerPeriod: MoneyInput;
  /**
   * This check's Social Security / Medicare wages (gross less Section 125). Pennsylvania taxes
   * 401(k) deferrals, so its base is these wages.
   */
  ficaWagesPerPeriod?: MoneyInput;
  /** Employee Social Security + Medicare withheld on this check (Massachusetts FICA deduction). */
  ficaTaxPerPeriod?: MoneyInput;
  periodsPerYear: number;
  stateW4?: StateW4 | null;
}

export type StateWithholdingMethod = 'none' | 'formula' | 'employee_percent' | 'employee_amount' | 'exempt' | 'not_set_up';

export interface StateWithholdingCalc {
  state: string;
  /** Amount to withhold on this check (2-dp, includes extra withholding). */
  amount: string;
  method: StateWithholdingMethod;
  /** The table year used (null when nothing is calculated). */
  tableYear: number | null;
  /** Plain-language notes (missing setup, nearest-year table, local taxes not calculated). */
  notes: string[];
}

const intOf = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Per-check state income tax withholding for the employee's work state and the pay date's year.
 * Never guesses: a state the app doesn't model uses the employee's own percent / amount, or
 * withholds nothing with a note asking for one.
 */
export function calculateStateWithholding(input: StateWithholdingCalcInput): StateWithholdingCalc {
  const code = input.state.trim().toUpperCase();
  const info = STATE_MAP.get(code);
  if (!info) throw new Error(`"${input.state}" is not a US state code.`);
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    throw new Error('periodsPerYear must be a positive whole number.');
  }
  const w4 = input.stateW4 ?? {};
  const notes: string[] = [];
  const result = (amount: Decimal, method: StateWithholdingMethod, tableYear: number | null): StateWithholdingCalc => ({
    state: code,
    amount: toAmountString(Money.round2(pos(amount))),
    method,
    tableYear,
    notes,
  });

  if (info.model === 'none') return result(new Decimal(0), 'none', null);
  if (w4.exempt) {
    notes.push(`The employee is exempt from ${info.name} withholding.`);
    return result(new Decimal(0), 'exempt', null);
  }
  if (info.localNote) notes.push(info.localNote);
  const extra = w4.extraWithholding != null && w4.extraWithholding !== '' ? Money.of(w4.extraWithholding) : new Decimal(0);
  const wages = Money.of(input.wagesPerPeriod);

  const table = TABLES[code];
  if (!table) {
    if (w4.fallbackPercent != null && w4.fallbackPercent !== '' && Money.gt(w4.fallbackPercent, 0)) {
      notes.push(`${info.name} withholding is not calculated by the app; the employee's ${Money.of(w4.fallbackPercent).toString()}% was used.`);
      return result(wages.times(Money.of(w4.fallbackPercent)).dividedBy(100).plus(extra), 'employee_percent', null);
    }
    if (w4.fallbackAmount != null && w4.fallbackAmount !== '' && Money.gt(w4.fallbackAmount, 0)) {
      notes.push(`${info.name} withholding is not calculated by the app; the employee's fixed amount was used.`);
      return result(Money.of(w4.fallbackAmount).plus(extra), 'employee_amount', null);
    }
    if (extra.greaterThan(0)) return result(extra, 'employee_amount', null);
    notes.push(
      `${info.name} income tax is not calculated by the app. Enter the employee's ${info.name} withholding as a percent or an amount per paycheck on the employee record (State tax section).`,
    );
    return result(new Decimal(0), 'not_set_up', null);
  }

  const years = Object.keys(table).map(Number).sort((a, b) => a - b);
  let tableYear = input.year;
  if (!table[tableYear]) {
    tableYear = input.year > years[years.length - 1] ? years[years.length - 1] : years.find((y) => y >= input.year) ?? years[0];
    notes.push(
      `${info.name} withholding tables for ${input.year} are not in this version; the ${tableYear} figures were used. Check the amount against the state's ${input.year} guide.`,
    );
  }
  const base = code === 'PA' && input.ficaWagesPerPeriod != null ? Money.of(input.ficaWagesPerPeriod) : wages;
  const periods = input.periodsPerYear;
  const c: CalcCtx = {
    annual: base.times(periods),
    annualFica: Money.of(input.ficaTaxPerPeriod ?? 0).times(periods),
    w4,
    status: (w4.filingStatus as StateFilingStatus) || 'single',
    allowances: intOf(w4.allowances),
    additional: intOf(w4.additionalAllowances),
    dependents: intOf(w4.dependents),
  };
  if (code === 'CO' && (w4.annualAllowance == null || w4.annualAllowance === '')) {
    notes.push('No Colorado DR 0004 allowance is entered for this employee, so none was subtracted.');
  }
  const annualTax = table[tableYear](c);
  const perPeriod = Money.round2(annualTax.dividedBy(periods));
  return result(perPeriod.plus(extra), 'formula', tableYear);
}

// ---------------------------------------------------------------------------
// Legacy helpers (Payroll Tax calculator page)
// ---------------------------------------------------------------------------

export interface StatePerPeriodInput {
  grossPerPeriod: number | string;
  periodsPerYear: number;
  state: string;
  /** Tax year (default: the current year). */
  year?: number;
  stateW4?: StateW4 | null;
}

export interface StatePerPeriodResult {
  stateTax: string;
  annualStateTax: string;
  stateInfo: StateInfo;
  notes: string[];
  method: StateWithholdingMethod;
}

/** Per-period state withholding for the calculator page (same engine as paychecks). */
export function statePerPeriod({ grossPerPeriod, periodsPerYear, state, year, stateW4 }: StatePerPeriodInput): StatePerPeriodResult {
  const info = STATE_MAP.get(state.toUpperCase());
  if (!info) throw new Error(`State '${state}' is not supported. Supported states: ${SUPPORTED_STATE_CODES.join(', ')}`);
  const calc = calculateStateWithholding({
    state,
    year: year ?? new Date().getUTCFullYear(),
    wagesPerPeriod: grossPerPeriod,
    ficaWagesPerPeriod: grossPerPeriod,
    periodsPerYear,
    stateW4,
  });
  return {
    stateTax: calc.amount,
    annualStateTax: toAmountString(Money.of(calc.amount).times(periodsPerYear)),
    stateInfo: info,
    notes: calc.notes,
    method: calc.method,
  };
}

/** Annual state tax on annual wages (single filer, no allowances) — kept for older callers. */
export function computeStateWithholding({ state, annualTaxable, year }: { state: string; annualTaxable: number | string; year?: number }): string {
  const r = statePerPeriod({ grossPerPeriod: annualTaxable, periodsPerYear: 1, state, year });
  return r.annualStateTax;
}

// ---------------------------------------------------------------------------
// Validation of the employee's state W-4
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a state W-4 from the employee form. Throws an Error with a plain message
 * (the service turns it into a validation error). Blank fields are dropped.
 */
export function normalizeStateW4(raw: unknown): StateW4 | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The state tax settings are not valid.');
  const r = raw as Record<string, unknown>;
  const out: StateW4 = {};
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (!blank(r.filingStatus)) {
    if (!['single', 'married', 'married_separate', 'head_of_household'].includes(String(r.filingStatus))) {
      throw new Error('State filing status must be single, married, married filing separately or head of household.');
    }
    out.filingStatus = r.filingStatus as StateFilingStatus;
  }
  for (const k of ['allowances', 'additionalAllowances', 'dependents'] as const) {
    if (blank(r[k])) continue;
    const n = Number(r[k]);
    if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('State allowances and dependents must be whole numbers from 0 to 99.');
    out[k] = n;
  }
  for (const k of ['extraWithholding', 'annualAllowance', 'fallbackAmount'] as const) {
    if (blank(r[k])) continue;
    const s = String(r[k]).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('State tax amounts must be positive amounts like 25.00.');
    out[k] = s;
  }
  if (!blank(r.fallbackPercent)) {
    const s = String(r.fallbackPercent).trim();
    const n = Number(s);
    if (!/^\d+(\.\d{1,4})?$/.test(s) || n > 100) throw new Error('The state withholding percent must be between 0 and 100.');
    out.fallbackPercent = s;
  }
  if (!blank(r.rate)) {
    const s = String(Number(r.rate));
    if (!AZ_RATES.includes(s)) throw new Error(`Arizona withholding must be one of ${AZ_RATES.join(', ')} percent.`);
    out.rate = s;
  }
  if (!blank(r.njTable)) {
    if (r.njTable !== 'A' && r.njTable !== 'B') throw new Error('The New Jersey rate table must be A or B.');
    out.njTable = r.njTable;
  }
  if (r.exempt === true) out.exempt = true;
  return Object.keys(out).length ? out : null;
}
