/**
 * Payroll report aggregations.
 *
 * w2Data      — aggregate W-2 wages and withholdings for one employee and one tax year
 *               (Boxes 1-6 incl. SS-wage-base-capped Box 3, plus state Boxes 15-17).
 * form941Data — aggregate Form 941 totals for one quarter and one tax year.
 * form940Data — annual FUTA worksheet (Form 940) with a quarterly liability breakdown.
 * w3Data      — W-3 transmittal totals across all employees' W-2s.
 *
 * All functions query paychecks (for the period) and paycheckLines (for the
 * itemized amounts) so the numbers always stay in sync with the GL-posted records.
 *
 * Also home to the sick/vacation accrual reads (employees.accruals jsonb) and
 * the per-item liability balances powering the QB-style Pay Liabilities screen.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, notLike, or } from 'drizzle-orm';
import {
  accounts,
  employees,
  journalEntries,
  journalEntryLines,
  paychecks,
  paycheckLines,
  payrollItems,
  payrollStateSettings,
  workersCompCodes,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { employeeWorkState, getEmployee, paycheckCountsCondition } from './payroll';
import { FUTA_NET_RATE, FUTA_WAGE_BASE, futaCreditReductionFor, ssWageBaseFor } from './payrollTax';
import {
  inferEmployeeTaxTracking,
  inferEmployerTracking,
  lineTracking,
  paycheckWageBases,
  type TaxTracking,
} from './payrollTaxTracking';
import { getCompany } from './company';

// ---------------------------------------------------------------------------
// Wage bases: the Social Security wage base is YEAR-KEYED data in payrollTax.ts
// (ssWageBaseFor); FUTA's $7,000 base and 0.6% net rate are not indexed.
// ---------------------------------------------------------------------------


/** Pull the employer name/address/EIN out of companies.settings.
 * EIN and address live in settings (`settings.ein`, `settings.address` or the structured
 * addressLine1/city/state/zip parts) because the companies table has no dedicated columns; blank
 * when the settings page hasn't set them. `name` is the legal name when one is set (the IRS forms'
 * "Name (not your trade name)"), `tradeName` the business name when it differs. */
export function companyProfile(company: {
  name: string;
  settings?: Record<string, unknown> | null;
}): { name: string; tradeName: string | null; address: string | null; ein: string | null } {
  const s = (company.settings ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' && (s[k] as string).trim() ? (s[k] as string).trim() : null);
  const legal = str('legalName');
  let address = str('address');
  if (!address) {
    const cityStateZip = [str('city'), [str('state'), str('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    address = [str('addressLine1'), str('addressLine2'), cityStateZip].filter(Boolean).join(', ') || null;
  }
  return {
    name: legal ?? company.name,
    tradeName: legal && legal !== company.name ? company.name : null,
    address,
    ein: str('ein'),
  };
}

// ---------------------------------------------------------------------------
// Shared: paycheck lines + per-check wage bases (tax tracking driven)
// ---------------------------------------------------------------------------

type ReportLine = {
  paycheckId: string;
  kind: string;
  name: string;
  amount: string;
  taxTracking: string | null;
};

/** Every line of the given (already company-scoped) paychecks, grouped by paycheck. */
async function linesByPaycheck(ctx: ServiceContext, ids: string[]): Promise<Map<string, ReportLine[]>> {
  const out = new Map<string, ReportLine[]>();
  if (ids.length === 0) return out;
  const rows = await ctx.db
    .select({
      paycheckId: paycheckLines.paycheckId,
      kind: paycheckLines.kind,
      name: paycheckLines.name,
      amount: paycheckLines.amount,
      taxTracking: paycheckLines.taxTracking,
    })
    .from(paycheckLines)
    .where(inArray(paycheckLines.paycheckId, ids));
  for (const r of rows) {
    const arr = out.get(r.paycheckId) ?? [];
    arr.push(r);
    out.set(r.paycheckId, arr);
  }
  return out;
}

/** Sum the lines whose tax tracking type (stamped, else inferred from the name) matches. */
function sumTracking(lines: ReportLine[], tracking: TaxTracking | TaxTracking[]): Dec {
  const set = new Set(Array.isArray(tracking) ? tracking : [tracking]);
  return lines.reduce((s, l) => {
    const t = lineTracking(l);
    return t && set.has(t) ? s.plus(Money.of(l.amount)) : s;
  }, Money.zero());
}

type Dec = ReturnType<typeof Money.zero>;

interface EmployeeYearFigures {
  gross: Dec;
  /** W-2 Box 1: gross − 401(k)/403(b)/457(b)/SIMPLE deferrals − Section 125. */
  incomeTaxWages: Dec;
  /** Box 5 (uncapped Social Security / Medicare wages): gross − Section 125. */
  ficaWages: Dec;
  /** Section 125 amounts (Form 940 line 4 exempt payments). */
  cafeteria: Dec;
  federalWithheld: Dec;
  socialSecurity: Dec;
  medicare: Dec;
  stateWithheld: Dec;
  box10: Dec;
  box12: Map<string, Dec>;
  box14: Map<string, Dec>;
  /** Employee lines that carry a state code "(XX)" for W-2 Box 15 fallback. */
  stateLineNames: string[];
}

function emptyFigures(): EmployeeYearFigures {
  return {
    gross: Money.zero(),
    incomeTaxWages: Money.zero(),
    ficaWages: Money.zero(),
    cafeteria: Money.zero(),
    federalWithheld: Money.zero(),
    socialSecurity: Money.zero(),
    medicare: Money.zero(),
    stateWithheld: Money.zero(),
    box10: Money.zero(),
    box12: new Map(),
    box14: new Map(),
    stateLineNames: [],
  };
}

/** Fold one paycheck into an employee's running figures. */
function addCheck(f: EmployeeYearFigures, grossPay: string, lines: ReportLine[]) {
  const b = paycheckWageBases(grossPay, lines);
  f.gross = f.gross.plus(b.gross);
  f.incomeTaxWages = f.incomeTaxWages.plus(b.incomeTaxWages);
  f.ficaWages = f.ficaWages.plus(b.ficaWages);
  f.cafeteria = f.cafeteria.plus(b.cafeteria);
  f.box10 = f.box10.plus(b.box10);
  for (const [k, v] of b.box12) f.box12.set(k, (f.box12.get(k) ?? Money.zero()).plus(v));
  for (const [k, v] of b.box14) f.box14.set(k, (f.box14.get(k) ?? Money.zero()).plus(v));
  const taxLines = lines.filter((l) => l.kind === 'tax');
  f.federalWithheld = f.federalWithheld.plus(sumTracking(taxLines, 'federal_withholding'));
  f.socialSecurity = f.socialSecurity.plus(sumTracking(taxLines, 'social_security'));
  f.medicare = f.medicare.plus(sumTracking(taxLines, 'medicare'));
  f.stateWithheld = f.stateWithheld.plus(sumTracking(taxLines, 'state_withholding'));
  for (const l of taxLines) if (lineTracking(l) === 'state_withholding') f.stateLineNames.push(l.name);
}

const BOX12_ORDER = ['D', 'E', 'G', 'S', 'W', 'DD'];
function box12List(m: Map<string, Dec>): Array<{ code: string; amount: string }> {
  return [...m.entries()]
    .filter(([, v]) => v.greaterThan(0))
    .sort((a, b) => BOX12_ORDER.indexOf(a[0]) - BOX12_ORDER.indexOf(b[0]))
    .map(([code, v]) => ({ code, amount: toAmountString(v) }));
}
function box14List(m: Map<string, Dec>): Array<{ label: string; amount: string }> {
  return [...m.entries()]
    .filter(([, v]) => v.greaterThan(0))
    .map(([label, v]) => ({ label, amount: toAmountString(v) }));
}

/** Min(a, b) for decimals, floored at zero. */
function capAt(value: Dec, cap: Dec): Dec {
  const v = value.greaterThan(cap) ? cap : value;
  return v.isNegative() ? Money.zero() : v;
}

// ---------------------------------------------------------------------------
// W-2 data
// ---------------------------------------------------------------------------

export interface W2DataInput {
  employeeId: string;
  year: number;
}

export interface W2StateBoxes {
  /** Box 15: two-letter state code (from the employee address, else parsed from the
   * state tax line name, e.g. "State Income Tax (CA)"). Null when unknown. */
  code: string | null;
  /** Box 16: state wages (Box 1 wages when any state withholding/code exists). */
  wages: string;
  /** Box 17: state income tax withheld. */
  withheld: string;
}

export interface W2DataResult {
  company: { name: string; address: string | null; ein: string | null };
  employee: { firstName: string; lastName: string; ssn: string | null };
  year: number;
  /**
   * Box 1: wages, tips, other compensation — gross pay less 401(k)/403(b)/457(b)/SIMPLE
   * deferrals and Section 125 cafeteria deductions.
   */
  wages: string;
  /** Box 2: total federal income tax withheld. */
  federalWithheld: string;
  /** Box 3: Social Security wages — gross less Section 125, capped at the year's SS wage base. */
  ssWages: string;
  /** Box 4: total Social Security tax withheld. */
  socialSecurity: string;
  /** Box 5: Medicare wages — gross less Section 125 (no cap). */
  medicareWages: string;
  /** Box 6: total Medicare tax withheld. */
  medicare: string;
  /** Box 10: dependent care benefits. */
  dependentCare: string;
  /** Box 12: coded amounts (D 401(k), E 403(b), G 457(b), S SIMPLE, AA/BB/EE Roth, W HSA, DD employer health). */
  box12: Array<{ code: string; amount: string }>;
  /** Box 14: other (informational), e.g. Section 125 cafeteria deductions. */
  box14: Array<{ label: string; amount: string }>;
  /** Boxes 15-17: state wages + state income tax withheld. */
  state: W2StateBoxes;
}

/** Live paychecks (and YTD adjustments) of the company in [start, end), optionally one employee. */
async function countedChecks(ctx: ServiceContext, start: Date, end: Date, employeeId?: string) {
  const conds = [
    eq(paychecks.companyId, ctx.companyId),
    paycheckCountsCondition(),
    gte(paychecks.payDate, start),
    lt(paychecks.payDate, end), // half-open [start, end)
  ];
  if (employeeId) conds.push(eq(paychecks.employeeId, employeeId));
  return ctx.db
    .select({
      id: paychecks.id,
      employeeId: paychecks.employeeId,
      grossPay: paychecks.grossPay,
      payDate: paychecks.payDate,
      periodStart: paychecks.periodStart,
      periodEnd: paychecks.periodEnd,
    })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(and(...conds));
}

/**
 * Aggregate W-2 figures for an employee for a given calendar year. Wage boxes come from each
 * check's gross pay and deduction TAX TRACKING types; withholding boxes sum the tax lines by
 * tracking type (federal withholding, Social Security, Medicare, state withholding) — never by
 * free-text line name.
 */
export async function w2Data(
  ctx: ServiceContext,
  input: W2DataInput,
): Promise<W2DataResult> {
  const employee = await getEmployee(ctx, input.employeeId);
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  // Pay dates enter the system as UTC midnight (the API parses 'YYYY-MM-DD' via
  // `new Date(...)`), so the range bounds MUST be built in UTC too — local-time bounds
  // misclassify boundary-day paychecks on any server west of UTC.
  const yearStart = new Date(Date.UTC(input.year,     0, 1));
  const yearEnd   = new Date(Date.UTC(input.year + 1, 0, 1));

  // A voided paycheck must not appear on the W-2.
  const yearPaychecks = await countedChecks(ctx, yearStart, yearEnd, input.employeeId);
  const byCheck = await linesByPaycheck(ctx, yearPaychecks.map((p) => p.id));

  const f = emptyFigures();
  for (const p of yearPaychecks) addCheck(f, p.grossPay, byCheck.get(p.id) ?? []);

  const employerInfo = companyProfile(company);
  const addressState = (() => {
    const addr = (employee.address ?? {}) as Record<string, unknown>;
    return typeof addr.state === 'string' && /^[A-Za-z]{2}$/.test(addr.state.trim())
      ? addr.state.trim().toUpperCase()
      : null;
  })();

  // Box 15 state code: prefer the employee's address state; otherwise parse a
  // "(XX)" suffix from a state tax line name (e.g. "State Income Tax (CA)").
  let stateCode = addressState;
  if (!stateCode) {
    for (const n of f.stateLineNames) {
      const m = n.match(/\(([A-Za-z]{2})\)/);
      if (m) { stateCode = m[1].toUpperCase(); break; }
    }
  }
  const hasStateInfo = yearPaychecks.length > 0 && (stateCode !== null || f.stateWithheld.greaterThan(0));

  // Box 3: Social Security wages capped at the year's wage base.
  const ssBase = Money.of(ssWageBaseFor(input.year));

  return {
    company: employerInfo,
    employee: {
      firstName: employee.firstName,
      lastName:  employee.lastName,
      ssn: (employee.ssn as string | null | undefined) ?? null,
    },
    year: input.year,
    wages: toAmountString(f.incomeTaxWages),
    federalWithheld: toAmountString(f.federalWithheld),
    ssWages: toAmountString(capAt(f.ficaWages, ssBase)),
    socialSecurity: toAmountString(f.socialSecurity),
    medicareWages: toAmountString(f.ficaWages),
    medicare: toAmountString(f.medicare),
    dependentCare: toAmountString(f.box10),
    box12: box12List(f.box12),
    box14: box14List(f.box14),
    state: {
      code: stateCode,
      wages: hasStateInfo ? toAmountString(f.incomeTaxWages) : '0.00',
      withheld: toAmountString(f.stateWithheld),
    },
  };
}

// ---------------------------------------------------------------------------
// Form 941 data
// ---------------------------------------------------------------------------

export type DepositSchedule = 'monthly' | 'semiweekly';

export interface Form941DataInput {
  /** Calendar quarter: 1, 2, 3, or 4. */
  quarter: 1 | 2 | 3 | 4;
  year: number;
  /**
   * Line 16 deposit schedule (from the lookback period — the IRS tells the employer which one).
   * 'monthly' (default) fills the three monthly liabilities; 'semiweekly' also builds Schedule B
   * (daily liabilities). A quarter with less than $2,500 of tax needs neither.
   */
  depositSchedule?: DepositSchedule;
  /**
   * Line 13 override. By default the deposits are the 941 liability payments (federal
   * withholding, Social Security, Medicare items) whose date falls within the quarter's deposit
   * window — see form941Data. Pass an amount when deposits were made outside the app.
   */
  depositsOverride?: string | number | null;
}

/** One 941 liability payment counted on line 13. */
export interface Form941Deposit {
  date: string;
  item: string;
  amount: string;
  entryId: string;
}

/** Every numbered line of Form 941 Part 1 (+ line 16 in Part 2). Money as 2-dp strings. */
export interface Form941Lines {
  /** Line 1: employees who received pay for the pay period including the 12th of the quarter's last month. */
  line1: number;
  line2: string;
  line3: string;
  /** Line 4: no wages subject to Social Security or Medicare tax. */
  line4: boolean;
  line5aWages: string;
  line5aTax: string;
  /** 5a(i) qualified sick leave / 5a(ii) family leave wages — not used after 2021 (always 0). */
  line5bWages: string;
  line5bTax: string;
  line5cWages: string;
  line5cTax: string;
  line5dWages: string;
  line5dTax: string;
  line5e: string;
  /** Section 3121(q) notice and demand — tax due on unreported tips (not tracked: 0). */
  line5f: string;
  line6: string;
  /** Current quarter's adjustment for fractions of cents (actual withheld/accrued − computed). */
  line7: string;
  /** Current quarter's adjustment for sick pay (not tracked: 0). */
  line8: string;
  /** Adjustments for tips and group-term life insurance (not tracked: 0). */
  line9: string;
  line10: string;
  /** Line 11 credits (small business payroll R&D credit etc.) — 0 unless tracked. */
  line11: string;
  line12: string;
  line13: string;
  line14: string;
  line15: string;
}

export interface Form941DataResult {
  company: { name: string; tradeName: string | null; address: string | null; ein: string | null };
  quarter: 1 | 2 | 3 | 4;
  year: number;
  totals: {
    /** Number of employees paid in the quarter (informational; Form 941 line 1 is `lines.line1`). */
    employeeCount: number;
    /**
     * Line 2: wages, tips and other compensation — gross pay less 401(k)-type deferrals and
     * Section 125 deductions (the W-2 Box 1 basis).
     */
    wages: string;
    /** Gross pay before any deductions (informational). */
    grossPay: string;
    federalWithheld: string;
    /** Line 5a column 1: taxable Social Security wages (gross less Section 125, wage base applied per employee). */
    ssWages: string;
    /** Line 5c column 1: taxable Medicare wages (gross less Section 125). */
    medicareWages: string;
    /** Line 5d column 1: wages subject to Additional Medicare Tax withholding (over $200,000 YTD). */
    additionalMedicareWages: string;
    /** TOTAL Social Security tax actually withheld + accrued (employee + employer). */
    socialSecurity: string;
    /** TOTAL Medicare tax actually withheld + accrued (employee + employer, incl. Additional Medicare). */
    medicare: string;
    /** Employee-withheld Social Security only (breakdown of `socialSecurity`). */
    employeeSocialSecurity: string;
    /** Employer Social Security match only (breakdown of `socialSecurity`). */
    employerSocialSecurity: string;
    /** Employee-withheld Medicare only (breakdown of `medicare`). */
    employeeMedicare: string;
    /** Employer Medicare match only (breakdown of `medicare`). */
    employerMedicare: string;
  };
  /** Form 941 lines 1-15. */
  lines: Form941Lines;
  /** Line 16 / Schedule B. */
  schedule: {
    /** 'under2500' when line 12 is less than $2,500 (line 16 box 1). */
    kind: 'under2500' | DepositSchedule;
    /** Monthly tax liability (months 1-3 of the quarter); total equals line 12. */
    months: [string, string, string];
    total: string;
    /** Schedule B: per month, the liability by day of month (only days with a liability). */
    scheduleB: Array<{ month: number; days: Array<{ day: number; amount: string }>; total: string }> | null;
  };
  /** The liability payments counted on line 13 (empty when overridden). */
  deposits: Form941Deposit[];
  depositsOverridden: boolean;
  /** Plain-language notes about figures the app cannot know (shown on the PDF). */
  notes: string[];
}

/** Compute the start and end Date for a given quarter in a given year (UTC, matching
 * how pay dates are stored — see the comment in w2Data). */
function quarterRange(quarter: 1 | 2 | 3 | 4, year: number): { start: Date; end: Date } {
  const qStartMonth = (quarter - 1) * 3; // 0, 3, 6, 9
  const start = new Date(Date.UTC(year, qStartMonth, 1));
  const end   = new Date(Date.UTC(year, qStartMonth + 3, 1)); // exclusive upper bound
  return { start, end };
}

const ADDITIONAL_MEDICARE_WAGE_THRESHOLD = 200000;
/** Combined (employee + employer) Form 941 rates. */
const RATE_5A = '0.124';
const RATE_5C = '0.029';
const RATE_5D = '0.009';
/** Monthly depositors: a month's tax is deposited by the 15th of the following month. */
const DEPOSIT_LAG_DAYS = 15;
/**
 * Semiweekly depositors deposit within 3 business days after the payday's semiweekly period
 * (Wed-Fri paydays by the next Wednesday, Sat-Tue paydays by the next Friday) — at most about a
 * week, plus holidays. A deposit can pay paydays at most this many days earlier.
 */
const SEMIWEEKLY_MATCH_DAYS = 14;
/** How far before the quarter the semiweekly deposit allocation is replayed. */
const SEMIWEEKLY_REPLAY_DAYS = 60;
const DAY_MS = 86_400_000;

const FORM941_EMPLOYEE_TRACKING = new Set(['federal_withholding', 'social_security', 'medicare']);
const FORM941_EMPLOYER_TRACKING = new Set(['employer_social_security', 'employer_medicare']);

/**
 * Form 941 for a quarter, across all employees — every line of Part 1 plus line 16 / Schedule B.
 *
 * - Wages and taxes come from live paychecks by TAX TRACKING type (never free-text names); the
 *   Social Security wage base and the $200,000 Additional Medicare threshold are applied per
 *   employee against their wages earlier in the year.
 * - Line 5 column 2 = column 1 × the combined rates; line 7 is the fractions-of-cents adjustment
 *   = (Social Security + Medicare actually withheld and accrued) − line 5e, so line 12 always
 *   equals the tax that hit the books and the line 16 monthly total.
 * - Line 1 counts employees paid for the pay period that includes the 12th of the quarter's last
 *   month (checks without pay-period dates count when paid in that month).
 * - Line 13 deposits: Pay Liabilities payments of 941 items (federal withholding, Social
 *   Security, Medicare) attributed to the quarter of the liability they pay — see
 *   form941Deposits (monthly window, or the payday each semiweekly deposit pays) — unless
 *   `depositsOverride` is given.
 * - Line 16: liability by month of the pay date; Schedule B by day for semiweekly depositors.
 */
export async function form941Data(
  ctx: ServiceContext,
  input: Form941DataInput,
): Promise<Form941DataResult> {
  if (![1, 2, 3, 4].includes(input.quarter)) throw validation('Pick a quarter from 1 to 4.');
  if (!Number.isInteger(input.year)) throw validation('year must be an integer.');
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  const { start, end } = quarterRange(input.quarter, input.year);
  const yearStart = new Date(Date.UTC(input.year, 0, 1));
  const lastMonth = (input.quarter - 1) * 3 + 2; // 0-based month index of the quarter's last month
  const twelfth = Date.UTC(input.year, lastMonth, 12);

  // Year-to-quarter-end checks: earlier quarters only feed the per-employee wage-base room.
  const checks = await countedChecks(ctx, yearStart, end);
  const byCheck = await linesByPaycheck(ctx, checks.map((c) => c.id));

  interface Acc { ficaBefore: Dec; ficaQ: Dec }
  const perEmployee = new Map<string, Acc>();
  const line1Employees = new Set<string>();
  let wages = Money.zero();
  let gross = Money.zero();
  let medicareWages = Money.zero();
  let fedWithheld = Money.zero();
  let employeeSS = Money.zero();
  let employerSS = Money.zero();
  let employeeMedicare = Money.zero();
  let employerMedicare = Money.zero();
  const monthly: [Dec, Dec, Dec] = [Money.zero(), Money.zero(), Money.zero()];
  const daily: Array<Map<number, Dec>> = [new Map(), new Map(), new Map()];

  for (const c of checks) {
    const lines = byCheck.get(c.id) ?? [];
    const b = paycheckWageBases(c.grossPay, lines);
    const acc = perEmployee.get(c.employeeId) ?? { ficaBefore: Money.zero(), ficaQ: Money.zero() };
    if (c.payDate.getTime() < start.getTime()) {
      acc.ficaBefore = acc.ficaBefore.plus(b.ficaWages);
    } else {
      acc.ficaQ = acc.ficaQ.plus(b.ficaWages);
      wages = wages.plus(b.incomeTaxWages);
      gross = gross.plus(b.gross);
      medicareWages = medicareWages.plus(b.ficaWages);
      const taxLines = lines.filter((l) => l.kind === 'tax');
      const erLines = lines.filter((l) => l.kind === 'employer_contribution');
      const fit = sumTracking(taxLines, 'federal_withholding');
      const eeSS = sumTracking(taxLines, 'social_security');
      const eeMed = sumTracking(taxLines, 'medicare');
      const erSS = sumTracking(erLines, 'employer_social_security');
      const erMed = sumTracking(erLines, 'employer_medicare');
      fedWithheld = fedWithheld.plus(fit);
      employeeSS = employeeSS.plus(eeSS);
      employeeMedicare = employeeMedicare.plus(eeMed);
      employerSS = employerSS.plus(erSS);
      employerMedicare = employerMedicare.plus(erMed);
      // Line 16 / Schedule B: the liability is incurred on the pay date.
      const liability = fit.plus(eeSS).plus(eeMed).plus(erSS).plus(erMed);
      const m = c.payDate.getUTCMonth() - (input.quarter - 1) * 3;
      if (m >= 0 && m < 3) {
        monthly[m] = monthly[m].plus(liability);
        const day = c.payDate.getUTCDate();
        daily[m].set(day, (daily[m].get(day) ?? Money.zero()).plus(liability));
      }
      // Line 1: pay period that includes the 12th of the last month of the quarter.
      if (b.gross.greaterThan(0)) {
        const ps = c.periodStart?.getTime();
        const pe = c.periodEnd?.getTime();
        const covers12th =
          ps != null && pe != null
            ? ps <= twelfth && twelfth <= pe + 86_399_999
            : c.payDate.getUTCMonth() === lastMonth;
        if (covers12th) line1Employees.add(c.employeeId);
      }
    }
    perEmployee.set(c.employeeId, acc);
  }

  const ssBase = Money.of(ssWageBaseFor(input.year));
  const addlThreshold = Money.of(ADDITIONAL_MEDICARE_WAGE_THRESHOLD);
  let ssWages = Money.zero();
  let additionalMedicareWages = Money.zero();
  let employeeCount = 0;
  for (const a of perEmployee.values()) {
    if (a.ficaQ.isZero()) continue;
    employeeCount += 1;
    ssWages = ssWages.plus(capAt(a.ficaQ, ssBase.minus(a.ficaBefore)));
    const over = a.ficaBefore.plus(a.ficaQ).minus(addlThreshold);
    additionalMedicareWages = additionalMedicareWages.plus(capAt(over, a.ficaQ));
  }

  // ---- Part 1 lines ----
  const r2 = (d: Dec) => Money.round2(d);
  const l5aTax = r2(ssWages.times(RATE_5A));
  const l5cTax = r2(medicareWages.times(RATE_5C));
  const l5dTax = r2(additionalMedicareWages.times(RATE_5D));
  const l5e = l5aTax.plus(l5cTax).plus(l5dTax);
  const l6 = fedWithheld.plus(l5e);
  const actualFica = employeeSS.plus(employerSS).plus(employeeMedicare).plus(employerMedicare);
  const l7 = actualFica.minus(l5e);
  const l10 = l6.plus(l7);
  const l11 = Money.zero();
  const l12 = l10.minus(l11);

  // ---- Line 13: deposits ----
  const deposits: Form941Deposit[] = [];
  let l13: Dec;
  const overridden = input.depositsOverride != null && input.depositsOverride !== '';
  if (overridden) {
    l13 = Money.round2(input.depositsOverride!);
    if (l13.isNegative()) throw validation('Deposits cannot be negative.');
  } else {
    deposits.push(...(await form941Deposits(ctx, start, end, input.depositSchedule === 'semiweekly')));
    l13 = deposits.reduce((sum, d) => sum.plus(Money.of(d.amount)), Money.zero());
  }
  const l14 = l12.greaterThan(l13) ? l12.minus(l13) : Money.zero();
  const l15 = l13.greaterThan(l12) ? l13.minus(l12) : Money.zero();

  // ---- Line 16 ----
  const kind: Form941DataResult['schedule']['kind'] =
    l12.lessThan(2500) ? 'under2500' : input.depositSchedule === 'semiweekly' ? 'semiweekly' : 'monthly';
  const scheduleB =
    input.depositSchedule === 'semiweekly'
      ? daily.map((m, i) => ({
          month: i + 1,
          days: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([day, amt]) => ({ day, amount: toAmountString(amt) })),
          total: toAmountString(monthly[i]),
        }))
      : null;

  const notes: string[] = [];
  if (!overridden && deposits.length === 0 && l12.greaterThan(0)) {
    notes.push('No 941 tax payments were found for this quarter. Enter your deposits if you paid them outside the app.');
  }
  notes.push('Lines 5f, 8, 9 and 11 are zero: tips, third-party sick pay and payroll tax credits are not tracked.');

  const s = (d: Dec) => toAmountString(d);
  return {
    company: companyProfile(company),
    quarter: input.quarter,
    year: input.year,
    totals: {
      employeeCount,
      wages: s(wages),
      grossPay: s(gross),
      federalWithheld: s(fedWithheld),
      ssWages: s(ssWages),
      medicareWages: s(medicareWages),
      additionalMedicareWages: s(additionalMedicareWages),
      socialSecurity: s(employeeSS.plus(employerSS)),
      medicare: s(employeeMedicare.plus(employerMedicare)),
      employeeSocialSecurity: s(employeeSS),
      employerSocialSecurity: s(employerSS),
      employeeMedicare: s(employeeMedicare),
      employerMedicare: s(employerMedicare),
    },
    lines: {
      line1: line1Employees.size,
      line2: s(wages),
      line3: s(fedWithheld),
      line4: wages.greaterThan(0) && ssWages.isZero() && medicareWages.isZero(),
      line5aWages: s(ssWages),
      line5aTax: s(l5aTax),
      line5bWages: '0.00',
      line5bTax: '0.00',
      line5cWages: s(medicareWages),
      line5cTax: s(l5cTax),
      line5dWages: s(additionalMedicareWages),
      line5dTax: s(l5dTax),
      line5e: s(l5e),
      line5f: '0.00',
      line6: s(l6),
      line7: s(l7),
      line8: '0.00',
      line9: '0.00',
      line10: s(l10),
      line11: s(l11),
      line12: s(l12),
      line13: s(l13),
      line14: s(l14),
      line15: s(l15),
    },
    schedule: {
      kind,
      months: [s(monthly[0]), s(monthly[1]), s(monthly[2])],
      total: s(monthly[0].plus(monthly[1]).plus(monthly[2])),
      scheduleB,
    },
    deposits,
    depositsOverridden: overridden,
    notes,
  };
}

/**
 * The Pay Liabilities payments that count on line 13 for the quarter [start, end) — each deposit
 * goes to the quarter of the liability it pays (QuickBooks' "for period"):
 * - Monthly (and under-$2,500) depositors: a month's tax is due by the 15th of the next month, so
 *   the quarter's deposits are those dated from the 16th of its first month through the 15th of
 *   the month after it.
 * - Semiweekly depositors: deposits are applied, in date order and by amount, to the unpaid Form
 *   941 liability of the paydays in their lookback (on or before the deposit date, at most
 *   SEMIWEEKLY_MATCH_DAYS earlier), oldest payday first. So a Jan 8 deposit for a Jan 3 payday
 *   is a Q1 deposit, a Jan 2 deposit for a Dec 27 payday is a Q4 deposit, and an off-cycle check
 *   paid between a payday and that payday's deposit does not capture the deposit (the older,
 *   unpaid payday is paid first). A deposit is split between quarters when it pays paydays in
 *   both. Any amount left over (no payday in the lookback, or more than the unpaid liability)
 *   falls back to the monthly window by deposit date.
 */
async function form941Deposits(ctx: ServiceContext, start: Date, end: Date, semiweekly: boolean): Promise<Form941Deposit[]> {
  const winStart = new Date(start.getTime() + DEPOSIT_LAG_DAYS * DAY_MS);
  const winEnd = new Date(end.getTime() + DEPOSIT_LAG_DAYS * DAY_MS);
  if (!semiweekly) return payrollTaxPayments(ctx, winStart, winEnd, is941Item);

  // Replay allocation from well before the quarter so paydays just before it carry the right
  // unpaid balance (earlier deposits have already paid them), through the later of the monthly
  // window's end and a match window past the quarter end.
  const replayFrom = new Date(start.getTime() - SEMIWEEKLY_REPLAY_DAYS * DAY_MS);
  const candTo = new Date(Math.max(winEnd.getTime(), end.getTime() + (SEMIWEEKLY_MATCH_DAYS + 1) * DAY_MS));
  const candidates = await payrollTaxPayments(ctx, replayFrom, candTo, is941Item);
  if (!candidates.length) return [];

  // Unpaid Form 941 liability by payday (voided checks are not counted).
  const checks = await countedChecks(ctx, new Date(replayFrom.getTime() - SEMIWEEKLY_MATCH_DAYS * DAY_MS), candTo);
  const byCheck = await linesByPaycheck(ctx, checks.map((c) => c.id));
  const unpaid = new Map<number, Dec>();
  for (const c of checks) {
    const lines = byCheck.get(c.id) ?? [];
    const tax = sumTracking(lines.filter((l) => l.kind === 'tax'), ['federal_withholding', 'social_security', 'medicare'])
      .plus(sumTracking(lines.filter((l) => l.kind === 'employer_contribution'), ['employer_social_security', 'employer_medicare']));
    if (tax.isZero()) continue;
    const t = c.payDate.getTime();
    unpaid.set(t, (unpaid.get(t) ?? Money.zero()).plus(tax));
  }
  const sortedPaydays = [...unpaid.keys()].sort((a, b) => a - b);

  const inQuarter = (t: number) => t >= start.getTime() && t < end.getTime();
  const out: Form941Deposit[] = [];
  // payrollTaxPayments returns lines in date order; ties keep their posting order.
  for (const dep of candidates) {
    const t = Date.parse(`${dep.date}T00:00:00Z`);
    let left = Money.of(dep.amount);
    let counted = Money.zero();
    for (const p of sortedPaydays) {
      if (p > t) break;
      if (t - p > SEMIWEEKLY_MATCH_DAYS * DAY_MS) continue;
      if (!left.greaterThan(0)) break;
      const owed = unpaid.get(p)!;
      if (!owed.greaterThan(0)) continue;
      const applied = owed.lessThan(left) ? owed : left;
      unpaid.set(p, owed.minus(applied));
      left = left.minus(applied);
      if (inQuarter(p)) counted = counted.plus(applied);
    }
    if (left.greaterThan(0) && t >= winStart.getTime() && t < winEnd.getTime()) counted = counted.plus(left);
    if (counted.greaterThan(0)) out.push({ ...dep, amount: toAmountString(counted) });
  }
  return out;
}

/** A Pay Liabilities line memo names a Form 941 tax (federal withholding, Social Security, Medicare). */
function is941Item(memo: string): boolean {
  const ee = inferEmployeeTaxTracking(memo);
  return (!!ee && FORM941_EMPLOYEE_TRACKING.has(ee)) || FORM941_EMPLOYER_TRACKING.has(inferEmployerTracking(memo));
}

/**
 * Pay Liabilities payments in [from, to): debits to a payroll liability account (other than
 * paycheck postings) whose line memo (the payroll item name) passes `isItem`. Lump-sum payments
 * without an item can't be attributed and are not counted (the forms' notes say so).
 */
async function payrollTaxPayments(
  ctx: ServiceContext,
  from: Date,
  to: Date,
  isItem: (memo: string) => boolean,
): Promise<Form941Deposit[]> {
  // Payroll liability accounts: 2300 plus every account a payroll item posts its liability to.
  const base = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2300')));
  const itemAccts = await ctx.db
    .select({ id: payrollItems.liabilityAccountId })
    .from(payrollItems)
    .where(eq(payrollItems.companyId, ctx.companyId));
  const liabAccounts = [...new Set([...base.map((b) => b.id), ...itemAccts.map((i) => i.id).filter((x): x is string => !!x)])].map((id) => ({ id }));
  if (!liabAccounts.length) return [];
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      debit: journalEntryLines.debit,
      memo: journalEntryLines.memo,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        inArray(journalEntryLines.accountId, liabAccounts.map((a) => a.id)),
        gte(journalEntries.date, from),
        lt(journalEntries.date, to),
        or(isNull(journalEntries.sourceRef), notLike(journalEntries.sourceRef, 'paycheck:%')),
      ),
    )
    .orderBy(asc(journalEntries.date));
  const out: Form941Deposit[] = [];
  for (const r of rows) {
    if (!r.debit || !Money.gt(r.debit, 0)) continue;
    const memo = r.memo?.trim() ?? '';
    if (!memo) continue;
    if (!isItem(memo)) continue;
    out.push({ date: r.date.toISOString().slice(0, 10), item: memo, amount: toAmountString(Money.of(r.debit)), entryId: r.entryId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Form 940 (FUTA) annual worksheet
// ---------------------------------------------------------------------------

export interface Form940DataInput {
  year: number;
  /** Line 13 override: FUTA deposits made outside the app. */
  depositsOverride?: string | number | null;
}

export interface Form940QuarterRow {
  quarter: 1 | 2 | 3 | 4;
  /** FUTA tax accrued in the quarter (sum of per-paycheck FUTA accrual lines; Q4 also carries the credit reduction). */
  futaLiability: string;
}

export interface Form940CreditReductionRow {
  state: string;
  /** FUTA taxable wages paid to employees working in the state. */
  wages: string;
  /** Credit reduction rate (e.g. "0.012" = 1.2%). */
  rate: string;
  amount: string;
}

export interface Form940DataResult {
  company: { name: string; tradeName: string | null; address: string | null; ein: string | null };
  year: number;
  /** Number of employees paid during the year. */
  employeeCount: number;
  /** Line 3: total payments to all employees (gross wages). */
  totalPayments: string;
  /**
   * Line 4: payments exempt from FUTA — Section 125 cafeteria / HSA deductions (fringe benefits,
   * box 4a) and dependent care (box 4d). 401(k) deferrals are NOT exempt.
   */
  exemptPayments: string;
  /** Line 4 breakdown (boxes 4a-4e). */
  exemptBreakdown: { fringeBenefits: string; groupTermLife: string; retirement: string; dependentCare: string; other: string };
  /** Line 5: total of payments over the $7,000 FUTA wage base, per employee (after exempt payments). */
  excessOver7000: string;
  /** Line 6: subtotal (line 4 + line 5). */
  subtotal: string;
  /** Line 7: total taxable FUTA wages (line 3 − line 6). */
  taxableFutaWages: string;
  /** Line 8 (worksheet): taxable FUTA wages × 0.6% net rate. */
  futaTaxCalculated: string;
  /** Line 9: all wages excluded from state unemployment tax (× 5.4%) — not tracked, 0. */
  line9: string;
  /** Line 10: some wages excluded from state unemployment / late state payments — not tracked, 0. */
  line10: string;
  /** Line 11 / Schedule A: credit reduction. */
  creditReduction: {
    rows: Form940CreditReductionRow[];
    total: string;
    /** False when the year's credit reduction list is not published yet (see warnings). */
    known: boolean;
    source: string;
  };
  /** Line 12: total FUTA tax after adjustments (8 + 9 + 10 + 11). */
  line12: string;
  /** Line 13: FUTA tax deposited for the year. */
  line13: string;
  /** Line 14: balance due. */
  line14: string;
  /** Line 15: overpayment. */
  line15: string;
  /** FUTA tax actually accrued on paychecks (employer FUTA lines) — the GL-backed figure. */
  futaTaxAccrued: string;
  /** Part 5: FUTA liability by quarter (from per-paycheck accruals; credit reduction in Q4). */
  quarters: Form940QuarterRow[];
  /** Sum of the four quarterly liabilities (Form 940 line 17; equals line 12 when accruals match). */
  totalQuarterlyLiability: string;
  /** FUTA payments counted on line 13. */
  deposits: Array<{ date: string; item: string; amount: string; entryId: string }>;
  depositsOverridden: boolean;
  /** Plain-language warnings (unknown credit reduction year, employees without a work state). */
  warnings: string[];
}

const CREDIT_REDUCTION_SOURCE =
  'U.S. Department of Labor, "FUTA Credit Reductions" (oui.doleta.gov/unemploy/futa_credit.asp); IRS Schedule A (Form 940) instructions.';

/**
 * Aggregate the Form 940 (FUTA) annual return for a calendar year.
 *
 * Line 3 is gross pay on live checks; line 4 the FUTA-exempt payments by tax tracking (Section 125 /
 * HSA = 4a fringe benefits, dependent care = 4d); line 5 the per-employee excess of FUTA wages over
 * $7,000. Line 8 = taxable wages × 0.6%. Line 11 (Schedule A) applies the year's credit reduction
 * rate to the FUTA taxable wages of employees working in each credit reduction state (the
 * employee's work state). Line 13 sums FUTA payments made through Pay Liabilities from February 1
 * of the year through January 31 of the next (the year's deposit window) unless overridden.
 * Part 5 uses the FUTA accrual lines runPaycheck stamps on each check — the figure that hit the
 * GL — with the credit reduction in the 4th quarter (as the IRS requires).
 */
export async function form940Data(
  ctx: ServiceContext,
  input: Form940DataInput,
): Promise<Form940DataResult> {
  if (!Number.isInteger(input.year)) throw validation('year must be an integer.');
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  const yearStart = new Date(Date.UTC(input.year,     0, 1));
  const yearEnd   = new Date(Date.UTC(input.year + 1, 0, 1));

  const yearChecks = await countedChecks(ctx, yearStart, yearEnd);
  const byCheck = await linesByPaycheck(ctx, yearChecks.map((c) => c.id));

  // FUTA wages per employee (the FUTA base applies per employee, per year).
  const futaWagesByEmployee = new Map<string, Dec>();
  let totalPayments = Money.zero();
  let exemptPayments = Money.zero();
  let dependentCare = Money.zero();
  const quarterTotals: Record<1 | 2 | 3 | 4, Dec> = {
    1: Money.zero(), 2: Money.zero(), 3: Money.zero(), 4: Money.zero(),
  };
  let futaTaxAccrued = Money.zero();
  for (const c of yearChecks) {
    const lines = byCheck.get(c.id) ?? [];
    const b = paycheckWageBases(c.grossPay, lines);
    totalPayments = totalPayments.plus(b.gross);
    const exempt = b.gross.minus(b.ficaWages);
    exemptPayments = exemptPayments.plus(exempt);
    dependentCare = dependentCare.plus(b.box10.greaterThan(exempt) ? exempt : b.box10);
    futaWagesByEmployee.set(
      c.employeeId,
      (futaWagesByEmployee.get(c.employeeId) ?? Money.zero()).plus(b.ficaWages),
    );
    const futa = sumTracking(lines.filter((l) => l.kind === 'employer_contribution'), 'futa');
    if (futa.greaterThan(0)) {
      const quarter = (Math.floor(c.payDate.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
      quarterTotals[quarter] = quarterTotals[quarter].plus(futa);
      futaTaxAccrued = futaTaxAccrued.plus(futa);
    }
  }

  let excessOver7000 = Money.zero();
  const taxableByEmployee = new Map<string, Dec>();
  for (const [id, total] of futaWagesByEmployee) {
    if (total.greaterThan(FUTA_WAGE_BASE)) {
      excessOver7000 = excessOver7000.plus(total.minus(FUTA_WAGE_BASE));
      taxableByEmployee.set(id, Money.of(FUTA_WAGE_BASE));
    } else {
      taxableByEmployee.set(id, total);
    }
  }

  const subtotal = exemptPayments.plus(excessOver7000);
  const taxableFutaWages = totalPayments.minus(subtotal);
  const futaTaxCalculated = Money.round2(taxableFutaWages.times(FUTA_NET_RATE));

  // ---- Line 11 / Schedule A: credit reduction by the employee's work state ----
  const warnings: string[] = [];
  const rates = futaCreditReductionFor(input.year);
  const crRows: Form940CreditReductionRow[] = [];
  let creditReduction = Money.zero();
  if (taxableByEmployee.size > 0) {
    const empRows = await ctx.db
      .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, w4: employees.w4, address: employees.address })
      .from(employees)
      .where(and(eq(employees.companyId, ctx.companyId), inArray(employees.id, [...taxableByEmployee.keys()])));
    const wagesByState = new Map<string, Dec>();
    const noState: string[] = [];
    for (const e of empRows) {
      const st = employeeWorkState(e);
      const w = taxableByEmployee.get(e.id) ?? Money.zero();
      if (!st) {
        if (w.greaterThan(0)) noState.push(`${e.firstName} ${e.lastName}`);
        continue;
      }
      wagesByState.set(st, (wagesByState.get(st) ?? Money.zero()).plus(w));
    }
    if (noState.length) {
      warnings.push(`No work state is set for ${noState.join(', ')}, so their wages were left out of the credit reduction check (Schedule A).`);
    }
    if (!rates) {
      warnings.push(
        `The FUTA credit reduction states for ${input.year} are not published in this app yet (the Department of Labor announces them in November). Line 11 shows 0 — check Schedule A before filing.`,
      );
    } else {
      for (const [st, w] of [...wagesByState.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const rate = rates[st];
        if (!rate) continue;
        const amt = Money.round2(w.times(rate));
        creditReduction = creditReduction.plus(amt);
        crRows.push({ state: st, wages: toAmountString(w), rate, amount: toAmountString(amt) });
      }
    }
  }
  quarterTotals[4] = quarterTotals[4].plus(creditReduction);

  const line12 = futaTaxCalculated.plus(creditReduction);

  // ---- Line 13: deposits ----
  const overridden = input.depositsOverride != null && input.depositsOverride !== '';
  const deposits: Form940DataResult['deposits'] = [];
  let line13: Dec;
  if (overridden) {
    line13 = Money.round2(input.depositsOverride!);
    if (line13.isNegative()) throw validation('Deposits cannot be negative.');
  } else {
    const from = new Date(Date.UTC(input.year, 1, 1));
    const to = new Date(Date.UTC(input.year + 1, 1, 1));
    deposits.push(...(await payrollTaxPayments(ctx, from, to, (memo) => inferEmployerTracking(memo) === 'futa')));
    line13 = deposits.reduce((sum, d) => sum.plus(Money.of(d.amount)), Money.zero());
  }
  const line14 = line12.greaterThan(line13) ? line12.minus(line13) : Money.zero();
  const line15 = line13.greaterThan(line12) ? line13.minus(line12) : Money.zero();

  const totalQuarterly = quarterTotals[1].plus(quarterTotals[2]).plus(quarterTotals[3]).plus(quarterTotals[4]);
  if (!totalQuarterly.equals(line12)) {
    warnings.push(
      `The FUTA tax accrued on paychecks (${toAmountString(totalQuarterly)} with the credit reduction) differs from line 12 (${toAmountString(line12)}). This usually means an employer tax was typed over on a paycheck.`,
    );
  }

  return {
    company: companyProfile(company),
    year: input.year,
    employeeCount: futaWagesByEmployee.size,
    totalPayments: toAmountString(totalPayments),
    exemptPayments: toAmountString(exemptPayments),
    exemptBreakdown: {
      fringeBenefits: toAmountString(exemptPayments.minus(dependentCare)),
      groupTermLife: '0.00',
      retirement: '0.00',
      dependentCare: toAmountString(dependentCare),
      other: '0.00',
    },
    excessOver7000: toAmountString(excessOver7000),
    subtotal: toAmountString(subtotal),
    taxableFutaWages: toAmountString(taxableFutaWages),
    futaTaxCalculated: toAmountString(futaTaxCalculated),
    line9: '0.00',
    line10: '0.00',
    creditReduction: {
      rows: crRows,
      total: toAmountString(creditReduction),
      known: rates !== null,
      source: CREDIT_REDUCTION_SOURCE,
    },
    line12: toAmountString(line12),
    line13: toAmountString(line13),
    line14: toAmountString(line14),
    line15: toAmountString(line15),
    futaTaxAccrued: toAmountString(futaTaxAccrued),
    quarters: ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      futaLiability: toAmountString(quarterTotals[q]),
    })),
    totalQuarterlyLiability: toAmountString(totalQuarterly),
    deposits,
    depositsOverridden: overridden,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// W-3 transmittal worksheet
// ---------------------------------------------------------------------------

export interface W3DataInput {
  year: number;
}

export interface W3DataResult {
  company: { name: string; address: string | null; ein: string | null };
  year: number;
  /** Box c: number of W-2s (employees paid during the year). */
  w2Count: number;
  /** Box 1: total wages, tips, other compensation (sum of W-2 Box 1). */
  wages: string;
  /** Box 2: total federal income tax withheld. */
  federalWithheld: string;
  /** Box 3: total Social Security wages (SS wage base applied per employee). */
  ssWages: string;
  /** Box 4: total Social Security tax withheld. */
  socialSecurity: string;
  /** Box 5: total Medicare wages. */
  medicareWages: string;
  /** Box 6: total Medicare tax withheld. */
  medicare: string;
  /** Box 10: total dependent care benefits. */
  dependentCare: string;
  /** Box 12a: total deferred compensation (codes D, E, F, G, H, S, Y, AA, BB, EE). */
  deferredCompensation: string;
  /** Box 12 totals by code across all W-2s. */
  box12: Array<{ code: string; amount: string }>;
  /** Box 16: total state wages (W-2 Box 1 wages of employees with state withholding). */
  stateWages: string;
  /** Box 17: total state income tax withheld. */
  stateWithheld: string;
}

/**
 * W-3 Transmittal of Wage and Tax Statements: totals across all employees' W-2s
 * for a calendar year. The SS wage base cap (Box 3) is applied per employee, so
 * the result equals the sum of the individual W-2s, not min(total, base).
 */
export async function w3Data(ctx: ServiceContext, input: W3DataInput): Promise<W3DataResult> {
  if (!Number.isInteger(input.year)) throw validation('year must be an integer.');
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  const yearStart = new Date(Date.UTC(input.year,     0, 1));
  const yearEnd   = new Date(Date.UTC(input.year + 1, 0, 1));

  const yearChecks = await countedChecks(ctx, yearStart, yearEnd);
  const byCheck = await linesByPaycheck(ctx, yearChecks.map((c) => c.id));

  const perEmployee = new Map<string, EmployeeYearFigures>();
  for (const c of yearChecks) {
    const f = perEmployee.get(c.employeeId) ?? emptyFigures();
    addCheck(f, c.grossPay, byCheck.get(c.id) ?? []);
    perEmployee.set(c.employeeId, f);
  }

  const ssBase = Money.of(ssWageBaseFor(input.year));
  const t = emptyFigures();
  let ssWages = Money.zero();
  let stateWages = Money.zero();
  for (const f of perEmployee.values()) {
    t.incomeTaxWages = t.incomeTaxWages.plus(f.incomeTaxWages);
    t.ficaWages = t.ficaWages.plus(f.ficaWages);
    t.federalWithheld = t.federalWithheld.plus(f.federalWithheld);
    t.socialSecurity = t.socialSecurity.plus(f.socialSecurity);
    t.medicare = t.medicare.plus(f.medicare);
    t.stateWithheld = t.stateWithheld.plus(f.stateWithheld);
    t.box10 = t.box10.plus(f.box10);
    for (const [k, v] of f.box12) t.box12.set(k, (t.box12.get(k) ?? Money.zero()).plus(v));
    ssWages = ssWages.plus(capAt(f.ficaWages, ssBase));
    // Box 16: state wages of the employees who had state withholding.
    if (f.stateWithheld.greaterThan(0)) stateWages = stateWages.plus(f.incomeTaxWages);
  }
  const deferred = ['D', 'E', 'F', 'G', 'H', 'S', 'Y', 'AA', 'BB', 'EE'].reduce(
    (s, code) => s.plus(t.box12.get(code) ?? Money.zero()),
    Money.zero(),
  );

  return {
    company: companyProfile(company),
    year: input.year,
    w2Count: perEmployee.size,
    wages: toAmountString(t.incomeTaxWages),
    federalWithheld: toAmountString(t.federalWithheld),
    ssWages: toAmountString(ssWages),
    socialSecurity: toAmountString(t.socialSecurity),
    medicareWages: toAmountString(t.ficaWages),
    medicare: toAmountString(t.medicare),
    dependentCare: toAmountString(t.box10),
    deferredCompensation: toAmountString(deferred),
    box12: box12List(t.box12),
    stateWages: toAmountString(stateWages),
    stateWithheld: toAmountString(t.stateWithheld),
  };
}

// ---------------------------------------------------------------------------
// Payroll Summary / Detail / Liability Balances (QB Desktop report parity)
// ---------------------------------------------------------------------------


/** Strip the "(... hrs @ ...)" detail suffix so report columns group across checks. */
function baseName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '');
}

/** Shared loader: posted, non-void paychecks in [from, to] (inclusive, UTC dates). */
async function loadRangePaychecks(
  ctx: ServiceContext,
  from: Date,
  to: Date,
  employeeId?: string,
) {
  if (!(from instanceof Date) || isNaN(from.getTime())) throw validation('Invalid from date.');
  if (!(to instanceof Date) || isNaN(to.getTime())) throw validation('Invalid to date.');
  if (from.getTime() > to.getTime()) throw validation('From date must be on or before the to date.');

  const conditions = [
    eq(paychecks.companyId, ctx.companyId),
    paycheckCountsCondition(),
    gte(paychecks.payDate, from),
    lte(paychecks.payDate, to),
  ];
  if (employeeId) conditions.push(eq(paychecks.employeeId, employeeId));

  const rows = await ctx.db
    .select({
      paycheck: paychecks,
      firstName: employees.firstName,
      lastName: employees.lastName,
    })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(and(...conditions))
    .orderBy(paychecks.payDate);

  const ids = rows.map((r) => r.paycheck.id);
  const lines = ids.length
    ? await ctx.db
        .select()
        .from(paycheckLines)
        .where(inArray(paycheckLines.paycheckId, ids))
    : [];

  return { rows, lines };
}

export interface PayrollRangeInput {
  from: Date;
  to: Date;
  employeeId?: string;
}

export interface PayrollSummaryEmployeeRow {
  employeeId: string;
  employeeName: string;
  paycheckCount: number;
  gross: string;
  /** Federal income-tax wages (gross less 401(k)-type deferrals and Section 125). */
  federalTaxableWages: string;
  /** Social Security / Medicare wages before the wage-base cap (gross less Section 125). */
  ficaWages: string;
  /** Withheld employee taxes by line name (e.g. "Federal Income Tax"). */
  taxes: Record<string, string>;
  totalTaxes: string;
  /** Deductions by line name (e.g. "401k"). */
  deductions: Record<string, string>;
  totalDeductions: string;
  /** Employer accruals by line name (e.g. "Employer Social Security", FUTA). */
  employerTaxes: Record<string, string>;
  totalEmployerTaxes: string;
  net: string;
}

export interface PayrollSummaryResult {
  from: string;
  to: string;
  /** Stable column orders for rendering/CSV. */
  taxNames: string[];
  deductionNames: string[];
  employerTaxNames: string[];
  rows: PayrollSummaryEmployeeRow[];
  totals: {
    gross: string;
    federalTaxableWages: string;
    ficaWages: string;
    totalTaxes: string;
    totalDeductions: string;
    totalEmployerTaxes: string;
    net: string;
  };
}

/**
 * Payroll Summary by employee for a date range: gross, each withheld tax, each
 * deduction, each employer accrual, and net — posted, non-void paychecks only.
 */
export async function payrollSummary(
  ctx: ServiceContext,
  input: PayrollRangeInput,
): Promise<PayrollSummaryResult> {
  const { rows, lines } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);

  const linesByPaycheck = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = linesByPaycheck.get(l.paycheckId) ?? [];
    arr.push(l);
    linesByPaycheck.set(l.paycheckId, arr);
  }

  interface Agg {
    employeeId: string;
    employeeName: string;
    paycheckCount: number;
    gross: Dec;
    fedWages: Dec;
    ficaWages: Dec;
    net: Dec;
    taxes: Map<string, Dec>;
    deductions: Map<string, Dec>;
    employerTaxes: Map<string, Dec>;
  }
  const byEmployee = new Map<string, Agg>();
  const taxNames = new Set<string>();
  const deductionNames = new Set<string>();
  const employerTaxNames = new Set<string>();

  for (const r of rows) {
    const pc = r.paycheck;
    let agg = byEmployee.get(pc.employeeId);
    if (!agg) {
      agg = {
        employeeId: pc.employeeId,
        employeeName: `${r.firstName} ${r.lastName}`,
        paycheckCount: 0,
        gross: Money.zero(),
        fedWages: Money.zero(),
        ficaWages: Money.zero(),
        net: Money.zero(),
        taxes: new Map(),
        deductions: new Map(),
        employerTaxes: new Map(),
      };
      byEmployee.set(pc.employeeId, agg);
    }
    agg.paycheckCount += 1;
    agg.gross = agg.gross.plus(Money.of(pc.grossPay));
    agg.net = agg.net.plus(Money.of(pc.netPay));
    const bases = paycheckWageBases(pc.grossPay, linesByPaycheck.get(pc.id) ?? []);
    agg.fedWages = agg.fedWages.plus(bases.incomeTaxWages);
    agg.ficaWages = agg.ficaWages.plus(bases.ficaWages);

    for (const l of linesByPaycheck.get(pc.id) ?? []) {
      const name = baseName(l.name);
      const amt = Money.of(l.amount);
      if (l.kind === 'tax') {
        taxNames.add(name);
        agg.taxes.set(name, (agg.taxes.get(name) ?? Money.zero()).plus(amt));
      } else if (l.kind === 'deduction') {
        deductionNames.add(name);
        agg.deductions.set(name, (agg.deductions.get(name) ?? Money.zero()).plus(amt));
      } else if (l.kind === 'employer_contribution') {
        employerTaxNames.add(name);
        agg.employerTaxes.set(name, (agg.employerTaxes.get(name) ?? Money.zero()).plus(amt));
      }
    }
  }

  const mapToRecord = (m: Map<string, Dec>): { rec: Record<string, string>; total: Dec } => {
    const rec: Record<string, string> = {};
    let total = Money.zero();
    for (const [k, v] of m) {
      rec[k] = toAmountString(v);
      total = total.plus(v);
    }
    return { rec, total };
  };

  const outRows: PayrollSummaryEmployeeRow[] = [];
  const totals = {
    gross: Money.zero(),
    fedWages: Money.zero(),
    ficaWages: Money.zero(),
    totalTaxes: Money.zero(),
    totalDeductions: Money.zero(),
    totalEmployerTaxes: Money.zero(),
    net: Money.zero(),
  };

  const sorted = [...byEmployee.values()].sort((a, b) =>
    a.employeeName.localeCompare(b.employeeName),
  );
  for (const agg of sorted) {
    const taxes = mapToRecord(agg.taxes);
    const deductions = mapToRecord(agg.deductions);
    const employer = mapToRecord(agg.employerTaxes);
    outRows.push({
      employeeId: agg.employeeId,
      employeeName: agg.employeeName,
      paycheckCount: agg.paycheckCount,
      gross: toAmountString(agg.gross),
      federalTaxableWages: toAmountString(agg.fedWages),
      ficaWages: toAmountString(agg.ficaWages),
      taxes: taxes.rec,
      totalTaxes: toAmountString(taxes.total),
      deductions: deductions.rec,
      totalDeductions: toAmountString(deductions.total),
      employerTaxes: employer.rec,
      totalEmployerTaxes: toAmountString(employer.total),
      net: toAmountString(agg.net),
    });
    totals.gross = totals.gross.plus(agg.gross);
    totals.fedWages = totals.fedWages.plus(agg.fedWages);
    totals.ficaWages = totals.ficaWages.plus(agg.ficaWages);
    totals.totalTaxes = totals.totalTaxes.plus(taxes.total);
    totals.totalDeductions = totals.totalDeductions.plus(deductions.total);
    totals.totalEmployerTaxes = totals.totalEmployerTaxes.plus(employer.total);
    totals.net = totals.net.plus(agg.net);
  }

  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    taxNames: [...taxNames].sort(),
    deductionNames: [...deductionNames].sort(),
    employerTaxNames: [...employerTaxNames].sort(),
    rows: outRows,
    totals: {
      gross: toAmountString(totals.gross),
      federalTaxableWages: toAmountString(totals.fedWages),
      ficaWages: toAmountString(totals.ficaWages),
      totalTaxes: toAmountString(totals.totalTaxes),
      totalDeductions: toAmountString(totals.totalDeductions),
      totalEmployerTaxes: toAmountString(totals.totalEmployerTaxes),
      net: toAmountString(totals.net),
    },
  };
}

export interface PayrollDetailRow {
  paycheckId: string;
  employeeId: string;
  employeeName: string;
  payDate: string; // YYYY-MM-DD
  periodStart: string | null;
  periodEnd: string | null;
  gross: string;
  totalTaxes: string;
  totalDeductions: string;
  totalEmployerTaxes: string;
  net: string;
}

export interface PayrollDetailResult {
  from: string;
  to: string;
  rows: PayrollDetailRow[];
}

/** Payroll Detail: one row per posted, non-void paycheck in the range. */
export async function payrollDetail(
  ctx: ServiceContext,
  input: PayrollRangeInput,
): Promise<PayrollDetailResult> {
  const { rows, lines } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);

  const employerByPaycheck = new Map<string, Dec>();
  for (const l of lines) {
    if (l.kind !== 'employer_contribution') continue;
    employerByPaycheck.set(
      l.paycheckId,
      (employerByPaycheck.get(l.paycheckId) ?? Money.zero()).plus(Money.of(l.amount)),
    );
  }

  const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    rows: rows.map((r) => ({
      paycheckId: r.paycheck.id,
      employeeId: r.paycheck.employeeId,
      employeeName: `${r.firstName} ${r.lastName}`,
      payDate: r.paycheck.payDate.toISOString().slice(0, 10),
      periodStart: fmt(r.paycheck.periodStart),
      periodEnd: fmt(r.paycheck.periodEnd),
      gross: r.paycheck.grossPay,
      totalTaxes: r.paycheck.totalTaxes,
      totalDeductions: r.paycheck.totalDeductions,
      totalEmployerTaxes: toAmountString(employerByPaycheck.get(r.paycheck.id) ?? Money.zero()),
      net: r.paycheck.netPay,
    })),
  };
}

export interface LiabilityBalanceItem {
  name: string;
  kind: 'tax' | 'deduction' | 'employer_contribution';
  accrued: string;
  /** Paid against THIS item: posted 2300 debits whose line memo names the item
   * (payPayrollLiabilities itemized payments stamp the item name as the memo). */
  paid: string;
  /** accrued − paid: what is still owed for this item. */
  balance: string;
}

export interface PayrollLiabilityBalancesResult {
  asOf: string;
  /** Accrued per payroll item (employee withholdings, deductions, employer accruals). */
  items: LiabilityBalanceItem[];
  totalAccrued: string;
  /** Payments recorded against 2300 Payroll Liabilities (posted debits) through asOf. */
  totalPaid: string;
  /** totalAccrued - totalPaid: what is still owed. */
  balance: string;
}

/**
 * Payroll Liability Balances by item: withheld taxes + deductions + employer
 * accruals from posted, non-void paychecks through `asOf`, less payments
 * (posted GL debits) against account 2300 Payroll Liabilities.
 *
 * Itemized payments (payPayrollLiabilities with `items`) stamp the item name as
 * the journal-line memo, so each item also carries `paid`/`balance`. Legacy
 * lump-sum payments (no matching memo) reduce only the TOTAL balance.
 */
export async function payrollLiabilityBalances(
  ctx: ServiceContext,
  opts?: { asOf?: Date },
): Promise<PayrollLiabilityBalancesResult> {
  const asOf = opts?.asOf ?? new Date();
  if (isNaN(asOf.getTime())) throw validation('Invalid asOf date.');

  // 1) Accruals from paycheck lines (posted, non-void checks, payDate <= asOf) plus liability
  //    adjustments. Historical YTD amounts entered WITHOUT affecting accounts are excluded:
  //    their liabilities were settled before the cutover (the GL import carries any balance).
  const checks = await ctx.db
    .select({ id: paychecks.id, entryType: paychecks.entryType, postedEntryId: paychecks.postedEntryId })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        paycheckCountsCondition(),
        lte(paychecks.payDate, asOf),
      ),
    );
  const ids = checks
    .filter((c) => c.postedEntryId != null || c.entryType === 'liability_adjustment')
    .map((c) => c.id);

  const lines = ids.length
    ? await ctx.db
        .select()
        .from(paycheckLines)
        .where(
          and(
            inArray(paycheckLines.paycheckId, ids),
            inArray(paycheckLines.kind, ['tax', 'deduction', 'employer_contribution']),
          ),
        )
    : [];

  const byItem = new Map<string, { kind: LiabilityBalanceItem['kind']; accrued: Dec }>();
  let totalAccrued = Money.zero();
  for (const l of lines) {
    const key = `${l.kind}|${baseName(l.name)}`;
    const item = byItem.get(key) ?? {
      kind: l.kind as LiabilityBalanceItem['kind'],
      accrued: Money.zero(),
    };
    item.accrued = item.accrued.plus(Money.of(l.amount));
    byItem.set(key, item);
    totalAccrued = totalAccrued.plus(Money.of(l.amount));
  }

  // 2) Payments: posted debits against 2300 through asOf. Paycheck entries only
  //    ever CREDIT 2300, so every debit is a liability payment (or manual adjustment).
  //    Itemized payments carry the item name as the line memo — attribute those to
  //    the matching item; memo-less (lump-sum) debits count toward the total only.
  let totalPaid = Money.zero();
  const paidByName = new Map<string, Dec>();
  const [liabAccount] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2300')));
  if (liabAccount) {
    const paymentLines = await ctx.db
      .select({ debit: journalEntryLines.debit, memo: journalEntryLines.memo })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          eq(journalEntryLines.accountId, liabAccount.id),
          lte(journalEntries.date, asOf),
          // Paycheck / payroll-adjustment entries are accruals (already counted from their
          // lines above), never payments — even a negative liability adjustment's debit.
          or(isNull(journalEntries.sourceRef), notLike(journalEntries.sourceRef, 'paycheck:%')),
        ),
      );
    for (const p of paymentLines) {
      if (!p.debit) continue;
      const amt = Money.of(p.debit);
      totalPaid = totalPaid.plus(amt);
      const memo = p.memo?.trim();
      if (memo) {
        paidByName.set(memo, (paidByName.get(memo) ?? Money.zero()).plus(amt));
      }
    }
  }

  const items: LiabilityBalanceItem[] = [...byItem.entries()]
    .map(([key, v]) => {
      const name = key.split('|')[1];
      const paid = paidByName.get(name) ?? Money.zero();
      return {
        name,
        kind: v.kind,
        accrued: toAmountString(v.accrued),
        paid: toAmountString(paid),
        balance: toAmountString(v.accrued.minus(paid)),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return {
    asOf: asOf.toISOString().slice(0, 10),
    items,
    totalAccrued: toAmountString(totalAccrued),
    totalPaid: toAmountString(totalPaid),
    balance: toAmountString(totalAccrued.minus(totalPaid)),
  };
}

// ---------------------------------------------------------------------------
// Sick / vacation accrual (employees.accruals jsonb)
//
// Policy shape stored on the employee row:
//   {
//     sickRateHrsPerHour?: number,  // hourly employees: hrs accrued per hour worked
//     vacRateHrsPerHour?:  number,  //   salary/commission: hrs accrued per PAYCHECK (flat)
//     sickBalance?: number,         // starting balance (hours) as of `asOf`
//     vacBalance?:  number,
//     asOf?: 'YYYY-MM-DD',          // paychecks AFTER this date accrue on top
//   }
//
// Balances are DERIVED at read time: starting balance + accrual over posted,
// non-void paychecks dated after `asOf`. Hourly accrual reads the hours embedded
// in earning line names ("Regular (80.00 hrs @ 25.00)"); salaried employees
// accrue a flat amount per paycheck. Used hours are not yet tracked (no
// sick/vacation pay items exist), so balances only ever grow until the policy's
// asOf/starting balance is re-baselined.
// ---------------------------------------------------------------------------

/** Hours embedded in an earning line name by runPaycheck: "Regular (80.00 hrs @ 25.00)". */
const EARNING_HOURS_RE = /\((\d+(?:\.\d+)?)\s*hrs?\s*@/i;

export interface EmployeeAccrualPolicyInput {
  sickRateHrsPerHour?: number | null;
  vacRateHrsPerHour?: number | null;
  sickBalance?: number | null;
  vacBalance?: number | null;
  /** 'YYYY-MM-DD' — paychecks dated after this accrue on top of the starting balances. */
  asOf?: string | null;
}

export interface AccrualBucket {
  /** Accrual rate (hrs/hour worked for hourly, hrs/paycheck for salary), null when unset. */
  rate: string | null;
  /** Starting balance (hours) as of the policy's asOf date. */
  starting: string;
  /** Hours accrued by paychecks after asOf. */
  accrued: string;
  /** starting + accrued. */
  balance: string;
}

export interface SickVacationBalanceRow {
  employeeId: string;
  employeeName: string;
  payType: string;
  isActive: boolean;
  /** False when the employee has no accruals policy at all (all-zero buckets). */
  hasPolicy: boolean;
  asOf: string | null;
  /** Posted, non-void paychecks counted toward the accrual (dated after asOf). */
  paychecksCounted: number;
  sick: AccrualBucket;
  vacation: AccrualBucket;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const fmtHours = (d: Dec) => d.toFixed(2);

/**
 * Sick/vacation balances for one employee (or every employee when employeeId is
 * omitted). Derived from employees.accruals + posted, non-void paychecks.
 */
export async function sickVacationBalances(
  ctx: ServiceContext,
  opts?: { employeeId?: string },
): Promise<SickVacationBalanceRow[]> {
  const empConditions = [eq(employees.companyId, ctx.companyId)];
  if (opts?.employeeId) empConditions.push(eq(employees.id, opts.employeeId));

  const emps = await ctx.db
    .select()
    .from(employees)
    .where(and(...empConditions))
    .orderBy(employees.lastName, employees.firstName);
  if (opts?.employeeId && emps.length === 0) throw notFound('Employee');

  const checkConditions = [
    eq(paychecks.companyId, ctx.companyId),
    paycheckCountsCondition(),
    // Leave accrues per real paycheck — historical YTD / liability adjustments do not accrue.
    eq(paychecks.entryType, 'paycheck'),
  ];
  if (opts?.employeeId) checkConditions.push(eq(paychecks.employeeId, opts.employeeId));

  const checks = await ctx.db
    .select({ id: paychecks.id, employeeId: paychecks.employeeId, payDate: paychecks.payDate })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(and(...checkConditions));

  // Hours per paycheck from earning line names (hourly accrual basis).
  const ids = checks.map((c) => c.id);
  const hoursByCheck = new Map<string, Dec>();
  if (ids.length > 0) {
    const earningLines = await ctx.db
      .select({ paycheckId: paycheckLines.paycheckId, name: paycheckLines.name })
      .from(paycheckLines)
      .where(and(eq(paycheckLines.kind, 'earning'), inArray(paycheckLines.paycheckId, ids)));
    for (const l of earningLines) {
      const m = l.name.match(EARNING_HOURS_RE);
      if (!m) continue;
      hoursByCheck.set(
        l.paycheckId,
        (hoursByCheck.get(l.paycheckId) ?? Money.zero()).plus(Money.of(m[1])),
      );
    }
  }

  const checksByEmployee = new Map<string, typeof checks>();
  for (const c of checks) {
    const arr = checksByEmployee.get(c.employeeId) ?? [];
    arr.push(c);
    checksByEmployee.set(c.employeeId, arr);
  }

  return emps.map((emp) => {
    const policy = (emp.accruals ?? null) as Record<string, unknown> | null;
    const sickRate = numOrNull(policy?.sickRateHrsPerHour);
    const vacRate = numOrNull(policy?.vacRateHrsPerHour);
    const sickStart = Money.of(numOrNull(policy?.sickBalance) ?? 0);
    const vacStart = Money.of(numOrNull(policy?.vacBalance) ?? 0);
    const asOfStr =
      typeof policy?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(policy.asOf)
        ? policy.asOf
        : null;
    const asOfDate = asOfStr ? new Date(asOfStr) : null; // parses as UTC midnight

    // Paychecks dated strictly AFTER asOf accrue on top of the starting balances.
    const counted = (checksByEmployee.get(emp.id) ?? []).filter(
      (c) => !asOfDate || c.payDate.getTime() > asOfDate.getTime(),
    );

    let sickAccrued = Money.zero();
    let vacAccrued = Money.zero();
    if (policy && (sickRate !== null || vacRate !== null)) {
      if (emp.payType === 'hourly') {
        // Hours-based: rate × hours worked (from earning lines with embedded hours).
        let hours = Money.zero();
        for (const c of counted) hours = hours.plus(hoursByCheck.get(c.id) ?? Money.zero());
        if (sickRate !== null) sickAccrued = Money.round2(hours.times(sickRate));
        if (vacRate !== null) vacAccrued = Money.round2(hours.times(vacRate));
      } else {
        // Salary / commission: flat hours per paycheck.
        const n = counted.length;
        if (sickRate !== null) sickAccrued = Money.round2(Money.of(sickRate).times(n));
        if (vacRate !== null) vacAccrued = Money.round2(Money.of(vacRate).times(n));
      }
    }

    return {
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      payType: emp.payType,
      isActive: emp.isActive,
      hasPolicy: policy !== null && Object.keys(policy).length > 0,
      asOf: asOfStr,
      paychecksCounted: counted.length,
      sick: {
        rate: sickRate !== null ? fmtHours(Money.of(sickRate)) : null,
        starting: fmtHours(sickStart),
        accrued: fmtHours(sickAccrued),
        balance: fmtHours(sickStart.plus(sickAccrued)),
      },
      vacation: {
        rate: vacRate !== null ? fmtHours(Money.of(vacRate)) : null,
        starting: fmtHours(vacStart),
        accrued: fmtHours(vacAccrued),
        balance: fmtHours(vacStart.plus(vacAccrued)),
      },
    };
  });
}

/**
 * Set (replace) an employee's sick/vacation accrual policy. Pass null to clear it.
 * Returns the freshly derived balances row for the employee.
 */
export async function setEmployeeAccrualPolicy(
  ctx: ServiceContext,
  employeeId: string,
  input: EmployeeAccrualPolicyInput | null,
): Promise<SickVacationBalanceRow> {
  const existing = await getEmployee(ctx, employeeId);

  let accruals: Record<string, unknown> | null = null;
  if (input !== null) {
    for (const field of ['sickRateHrsPerHour', 'vacRateHrsPerHour'] as const) {
      const v = input[field];
      if (v != null && (!Number.isFinite(v) || v < 0)) {
        throw validation(`${field} must be a non-negative number.`);
      }
    }
    for (const field of ['sickBalance', 'vacBalance'] as const) {
      const v = input[field];
      if (v != null && !Number.isFinite(v)) {
        throw validation(`${field} must be a finite number of hours.`);
      }
    }
    if (input.asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) {
      throw validation('asOf must be in YYYY-MM-DD format.');
    }
    accruals = {
      ...(input.sickRateHrsPerHour != null ? { sickRateHrsPerHour: input.sickRateHrsPerHour } : {}),
      ...(input.vacRateHrsPerHour != null ? { vacRateHrsPerHour: input.vacRateHrsPerHour } : {}),
      sickBalance: input.sickBalance ?? 0,
      vacBalance: input.vacBalance ?? 0,
      ...(input.asOf != null ? { asOf: input.asOf } : {}),
    };
  }

  await ctx.db
    .update(employees)
    .set({ accruals, updatedAt: new Date() })
    .where(and(eq(employees.id, employeeId), eq(employees.companyId, ctx.companyId)));

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'employee',
    entityId: employeeId,
    oldValues: { accruals: existing.accruals ?? null },
    newValues: { accruals },
  });

  const [row] = await sickVacationBalances(ctx, { employeeId });
  return row;
}

// ---------------------------------------------------------------------------
// wave2 payroll reports — Employee Earnings Summary, Payroll Item Detail,
// Payroll Transactions by Payee, State quarterly wage worksheet, Workers comp summary.
// All read the same population as the rest of this module: posted, non-void paychecks plus
// historical YTD / liability adjustments (paycheckCountsCondition).
// ---------------------------------------------------------------------------

const KIND_ORDER = ['earning', 'deduction', 'tax', 'employer_contribution'];
const KIND_LABEL: Record<string, string> = {
  earning: 'Earnings',
  deduction: 'Deductions from gross pay',
  tax: 'Taxes withheld',
  employer_contribution: 'Employer taxes and contributions',
};
const ENTRY_TYPE_LABEL: Record<string, string> = {
  paycheck: 'Paycheck',
  ytd_adjustment: 'YTD Adjustment',
  liability_adjustment: 'Liability Adjustment',
};
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? 99 : i;
};

export interface EarningsSummaryRow {
  section: string;
  kind: string;
  item: string;
  /** employeeId -> amount */
  amounts: Record<string, string>;
  total: string;
}

export interface EmployeeEarningsSummaryResult {
  from: string;
  to: string;
  employees: Array<{ id: string; name: string }>;
  rows: EarningsSummaryRow[];
  /** Gross pay / net pay per employee. */
  gross: Record<string, string>;
  net: Record<string, string>;
  totalGross: string;
  totalNet: string;
}

/**
 * QB "Employee Earnings Summary": one row per payroll item (grouped by earnings, deductions,
 * taxes, employer items), one column per employee, plus totals.
 */
export async function employeeEarningsSummary(
  ctx: ServiceContext,
  input: PayrollRangeInput,
): Promise<EmployeeEarningsSummaryResult> {
  const { rows, lines } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);
  const empOf = new Map(rows.map((r) => [r.paycheck.id, r.paycheck.employeeId]));
  const empNames = new Map<string, string>();
  const gross = new Map<string, Dec>();
  const net = new Map<string, Dec>();
  for (const r of rows) {
    const id = r.paycheck.employeeId;
    empNames.set(id, `${r.firstName} ${r.lastName}`);
    gross.set(id, (gross.get(id) ?? Money.zero()).plus(Money.of(r.paycheck.grossPay)));
    net.set(id, (net.get(id) ?? Money.zero()).plus(Money.of(r.paycheck.netPay)));
  }
  const cells = new Map<string, Map<string, Dec>>(); // kind|item -> emp -> amount
  for (const l of lines) {
    const key = `${l.kind}|${baseName(l.name)}`;
    const emp = empOf.get(l.paycheckId)!;
    const m = cells.get(key) ?? new Map<string, Dec>();
    m.set(emp, (m.get(emp) ?? Money.zero()).plus(Money.of(l.amount)));
    cells.set(key, m);
  }
  const outRows: EarningsSummaryRow[] = [...cells.entries()]
    .map(([key, m]) => {
      const [kind, item] = key.split('|');
      const amounts: Record<string, string> = {};
      let total = Money.zero();
      for (const [emp, v] of m) {
        amounts[emp] = toAmountString(v);
        total = total.plus(v);
      }
      return { section: KIND_LABEL[kind] ?? kind, kind, item, amounts, total: toAmountString(total) };
    })
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.item.localeCompare(b.item));
  const rec = (m: Map<string, Dec>) => Object.fromEntries([...m].map(([k, v]) => [k, toAmountString(v)]));
  const sum = (m: Map<string, Dec>) => toAmountString([...m.values()].reduce((s, v) => s.plus(v), Money.zero()));
  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    employees: [...empNames.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    rows: outRows,
    gross: rec(gross),
    net: rec(net),
    totalGross: sum(gross),
    totalNet: sum(net),
  };
}

export interface PayrollItemDetailLine {
  paycheckId: string;
  date: string;
  type: string;
  employeeId: string;
  employeeName: string;
  kind: string;
  item: string;
  /** Full line name (incl. hours @ rate detail). */
  detail: string;
  amount: string;
}

export interface PayrollItemDetailResult {
  from: string;
  to: string;
  groups: Array<{ item: string; kind: string; lines: PayrollItemDetailLine[]; total: string }>;
}

/** QB "Payroll Item Detail": every paycheck line grouped by payroll item, with subtotals. */
export async function payrollItemDetail(
  ctx: ServiceContext,
  input: PayrollRangeInput & { item?: string },
): Promise<PayrollItemDetailResult> {
  const { rows, lines } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);
  const pcById = new Map(rows.map((r) => [r.paycheck.id, r]));
  const groups = new Map<string, { item: string; kind: string; lines: PayrollItemDetailLine[]; total: Dec }>();
  for (const l of lines) {
    const item = baseName(l.name);
    if (input.item && item.toLowerCase() !== input.item.toLowerCase()) continue;
    const r = pcById.get(l.paycheckId)!;
    const key = `${l.kind}|${item}`;
    const g = groups.get(key) ?? { item, kind: l.kind, lines: [], total: Money.zero() };
    g.lines.push({
      paycheckId: l.paycheckId,
      date: r.paycheck.payDate.toISOString().slice(0, 10),
      type: ENTRY_TYPE_LABEL[r.paycheck.entryType] ?? r.paycheck.entryType,
      employeeId: r.paycheck.employeeId,
      employeeName: `${r.firstName} ${r.lastName}`,
      kind: l.kind,
      item,
      detail: l.name,
      amount: toAmountString(l.amount),
    });
    g.total = g.total.plus(Money.of(l.amount));
    groups.set(key, g);
  }
  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    groups: [...groups.values()]
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.item.localeCompare(b.item))
      .map((g) => ({
        item: g.item,
        kind: g.kind,
        lines: g.lines.sort((a, b) => a.date.localeCompare(b.date)),
        total: toAmountString(g.total),
      })),
  };
}

export interface PayeeTransaction {
  paycheckId: string;
  date: string;
  type: string;
  reference: string;
  memo: string | null;
  gross: string;
  taxes: string;
  deductions: string;
  net: string;
}

export interface PayrollTransactionsByPayeeResult {
  from: string;
  to: string;
  payees: Array<{
    employeeId: string;
    employeeName: string;
    transactions: PayeeTransaction[];
    totalGross: string;
    totalNet: string;
  }>;
  totalGross: string;
  totalNet: string;
}

/** QB "Payroll Transactions by Payee": every paycheck / adjustment grouped by employee. */
export async function payrollTransactionsByPayee(
  ctx: ServiceContext,
  input: PayrollRangeInput,
): Promise<PayrollTransactionsByPayeeResult> {
  const { rows } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);
  const byEmp = new Map<string, { employeeId: string; employeeName: string; transactions: PayeeTransaction[]; g: Dec; n: Dec }>();
  let tg = Money.zero();
  let tn = Money.zero();
  for (const r of rows) {
    const pc = r.paycheck;
    const e = byEmp.get(pc.employeeId) ?? {
      employeeId: pc.employeeId,
      employeeName: `${r.firstName} ${r.lastName}`,
      transactions: [],
      g: Money.zero(),
      n: Money.zero(),
    };
    e.transactions.push({
      paycheckId: pc.id,
      date: pc.payDate.toISOString().slice(0, 10),
      type: ENTRY_TYPE_LABEL[pc.entryType] ?? pc.entryType,
      reference: pc.id.slice(0, 8),
      memo: pc.memo ?? null,
      gross: pc.grossPay,
      taxes: pc.totalTaxes,
      deductions: pc.totalDeductions,
      net: pc.netPay,
    });
    e.g = e.g.plus(Money.of(pc.grossPay));
    e.n = e.n.plus(Money.of(pc.netPay));
    tg = tg.plus(Money.of(pc.grossPay));
    tn = tn.plus(Money.of(pc.netPay));
    byEmp.set(pc.employeeId, e);
  }
  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    payees: [...byEmp.values()]
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName))
      .map((e) => ({
        employeeId: e.employeeId,
        employeeName: e.employeeName,
        transactions: e.transactions,
        totalGross: toAmountString(e.g),
        totalNet: toAmountString(e.n),
      })),
    totalGross: toAmountString(tg),
    totalNet: toAmountString(tn),
  };
}

export interface StateWageWorksheetRow {
  employeeId: string;
  employeeName: string;
  ssnLast4: string | null;
  /** Gross wages paid in the quarter. */
  quarterWages: string;
  /** Wages above the SUI wage base (excess wages) in the quarter. */
  excessWages: string;
  /** SUI-taxable wages in the quarter. */
  taxableWages: string;
  /** SUI accrued on paychecks in the quarter (employer). */
  suiAccrued: string;
  /** SDI withheld from the employee in the quarter. */
  sdiWithheld: string;
  /** State income tax withheld in the quarter. */
  stateWithheld: string;
}

export interface StateWageWorksheetResult {
  state: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  company: { name: string; address: string | null; ein: string | null };
  accountNumber: string | null;
  suiRate: string;
  suiWageBase: string;
  employees: StateWageWorksheetRow[];
  totals: {
    quarterWages: string;
    excessWages: string;
    taxableWages: string;
    suiAccrued: string;
    sdiWithheld: string;
    stateWithheld: string;
    /** Worksheet computation: taxable wages x SUI rate. */
    suiCalculated: string;
  };
}

/**
 * State quarterly wage worksheet (the data behind a state unemployment wage report): per
 * employee working in `state`, quarter wages, excess over the SUI wage base (based on YTD
 * wages before the quarter), taxable wages, and SUI / SDI / state income tax amounts.
 */
export async function stateWageWorksheet(
  ctx: ServiceContext,
  input: { state: string; year: number; quarter: 1 | 2 | 3 | 4 },
): Promise<StateWageWorksheetResult> {
  const state = (input.state ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw validation('State must be a two-letter code.');
  if (!Number.isInteger(input.year)) throw validation('year must be an integer.');
  if (![1, 2, 3, 4].includes(input.quarter)) throw validation('quarter must be 1-4.');
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  const allSettings = await ctx.db
    .select()
    .from(payrollStateSettings)
    .where(and(eq(payrollStateSettings.companyId, ctx.companyId), eq(payrollStateSettings.state, state)))
    .orderBy(asc(payrollStateSettings.year));
  const eff = allSettings.filter((r) => r.year <= input.year).pop() ?? null;
  const wageBase = eff ? Money.of(eff.suiWageBase) : Money.zero();
  const rate = eff ? Money.of(eff.suiRate) : Money.zero();

  const yearStart = new Date(Date.UTC(input.year, 0, 1));
  const { start, end } = quarterRange(input.quarter, input.year);
  const endInclusive = new Date(end.getTime() - 1);
  const { rows, lines } = await loadRangePaychecks(ctx, yearStart, endInclusive);

  const emps = await ctx.db.select().from(employees).where(eq(employees.companyId, ctx.companyId));
  const inState = new Map(emps.filter((e) => employeeWorkState(e) === state).map((e) => [e.id, e]));

  const linesByCheck = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = linesByCheck.get(l.paycheckId) ?? [];
    arr.push(l);
    linesByCheck.set(l.paycheckId, arr);
  }

  interface Acc { before: Dec; q: Dec; sui: Dec; sdi: Dec; st: Dec }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const pc = r.paycheck;
    if (!inState.has(pc.employeeId)) continue;
    const a = acc.get(pc.employeeId) ?? {
      before: Money.zero(), q: Money.zero(), sui: Money.zero(), sdi: Money.zero(), st: Money.zero(),
    };
    // SUI wages = gross less Section 125 deductions (401(k) deferrals stay SUI-taxable in
    // most states), the same basis the paycheck engine accrues SUI on.
    const checkLines = linesByCheck.get(pc.id) ?? [];
    const g = paycheckWageBases(pc.grossPay, checkLines).ficaWages;
    if (pc.payDate.getTime() < start.getTime()) {
      a.before = a.before.plus(g);
    } else {
      a.q = a.q.plus(g);
      for (const l of checkLines) {
        const t = lineTracking(l);
        if (l.kind === 'employer_contribution' && t === 'sui') a.sui = a.sui.plus(Money.of(l.amount));
        else if (l.kind === 'tax' && t === 'sdi') a.sdi = a.sdi.plus(Money.of(l.amount));
        else if (l.kind === 'tax' && t === 'state_withholding') a.st = a.st.plus(Money.of(l.amount));
      }
    }
    acc.set(pc.employeeId, a);
  }

  const out: StateWageWorksheetRow[] = [];
  const t = { q: Money.zero(), ex: Money.zero(), tx: Money.zero(), sui: Money.zero(), sdi: Money.zero(), st: Money.zero() };
  for (const [empId, a] of acc) {
    if (a.q.isZero() && a.sui.isZero()) continue;
    const emp = inState.get(empId)!;
    let taxable = a.q;
    if (wageBase.greaterThan(0)) {
      const room = wageBase.minus(a.before);
      taxable = room.lessThanOrEqualTo(0) ? Money.zero() : room.lessThan(a.q) ? room : a.q;
    }
    const excess = a.q.minus(taxable);
    const ssn = typeof emp.ssn === 'string' ? emp.ssn.replace(/\D/g, '') : '';
    out.push({
      employeeId: empId,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      ssnLast4: ssn.length >= 4 ? ssn.slice(-4) : null,
      quarterWages: toAmountString(a.q),
      excessWages: toAmountString(excess),
      taxableWages: toAmountString(taxable),
      suiAccrued: toAmountString(a.sui),
      sdiWithheld: toAmountString(a.sdi),
      stateWithheld: toAmountString(a.st),
    });
    t.q = t.q.plus(a.q);
    t.ex = t.ex.plus(excess);
    t.tx = t.tx.plus(taxable);
    t.sui = t.sui.plus(a.sui);
    t.sdi = t.sdi.plus(a.sdi);
    t.st = t.st.plus(a.st);
  }
  out.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  return {
    state,
    year: input.year,
    quarter: input.quarter,
    company: companyProfile(company),
    accountNumber: eff?.accountNumber ?? null,
    suiRate: eff ? eff.suiRate : '0',
    suiWageBase: eff ? toAmountString(eff.suiWageBase) : '0.00',
    employees: out,
    totals: {
      quarterWages: toAmountString(t.q),
      excessWages: toAmountString(t.ex),
      taxableWages: toAmountString(t.tx),
      suiAccrued: toAmountString(t.sui),
      sdiWithheld: toAmountString(t.sdi),
      stateWithheld: toAmountString(t.st),
      suiCalculated: toAmountString(Money.round2(t.tx.times(rate))),
    },
  };
}

export interface WorkersCompSummaryRow {
  code: string;
  description: string | null;
  ratePer100: string;
  /** Wages of the checks that accrued this code's premium. */
  wages: string;
  premium: string;
  employees: number;
}

/** Workers compensation summary by class code for a date range. */
export async function workersCompSummary(
  ctx: ServiceContext,
  input: PayrollRangeInput,
): Promise<{ from: string; to: string; rows: WorkersCompSummaryRow[]; totalWages: string; totalPremium: string }> {
  const { rows, lines } = await loadRangePaychecks(ctx, input.from, input.to, input.employeeId);
  const codes = await ctx.db.select().from(workersCompCodes).where(eq(workersCompCodes.companyId, ctx.companyId));
  const byCode = new Map(codes.map((c) => [c.code.toUpperCase(), c]));
  const pcById = new Map(rows.map((r) => [r.paycheck.id, r.paycheck]));
  const agg = new Map<string, { wages: Dec; premium: Dec; emps: Set<string> }>();
  for (const l of lines) {
    if (l.kind !== 'employer_contribution') continue;
    const m = /workers comp(?:ensation)?\s*\(([^)]+)\)/i.exec(l.name);
    if (!m) continue;
    const code = m[1].trim().toUpperCase();
    const pc = pcById.get(l.paycheckId)!;
    const a = agg.get(code) ?? { wages: Money.zero(), premium: Money.zero(), emps: new Set<string>() };
    a.wages = a.wages.plus(Money.of(pc.grossPay));
    a.premium = a.premium.plus(Money.of(l.amount));
    a.emps.add(pc.employeeId);
    agg.set(code, a);
  }
  let tw = Money.zero();
  let tp = Money.zero();
  const out: WorkersCompSummaryRow[] = [...agg.entries()]
    .map(([code, a]) => {
      tw = tw.plus(a.wages);
      tp = tp.plus(a.premium);
      const def = byCode.get(code);
      return {
        code,
        description: def?.description ?? null,
        ratePer100: def ? def.ratePer100 : '',
        wages: toAmountString(a.wages),
        premium: toAmountString(a.premium),
        employees: a.emps.size,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    from: input.from.toISOString().slice(0, 10),
    to: input.to.toISOString().slice(0, 10),
    rows: out,
    totalWages: toAmountString(tw),
    totalPremium: toAmountString(tp),
  };
}
