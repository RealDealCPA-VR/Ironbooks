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
  payrollStateSettings,
  workersCompCodes,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { employeeWorkState, getEmployee, paycheckCountsCondition } from './payroll';
import { FUTA_NET_RATE, FUTA_WAGE_BASE, ssWageBaseFor } from './payrollTax';
import { getCompany } from './company';

// ---------------------------------------------------------------------------
// Wage bases: the Social Security wage base is YEAR-KEYED data in payrollTax.ts
// (ssWageBaseFor); FUTA's $7,000 base and 0.6% net rate are not indexed.
// ---------------------------------------------------------------------------

/** Matches the FUTA employer-accrual line name emitted by runPaycheck. */
const FUTA_NAME_RE = /futa|federal unemployment/i;
/** Matches state unemployment (SUI/SUTA) employer lines, e.g. "State Unemployment (CA)". */
const SUI_NAME_RE = /state unemployment|suta?|sui/i;
/** State lines that are NOT state income tax withholding (SDI/SUI/workers comp). */
const NOT_STATE_INCOME_RE = /unemploy|disab|sdi|sui|suta|workers/i;
/** State income-tax withholding lines (e.g. "State Income Tax (CA)"), excluding SDI/SUI. */
const STATE_TAX_RE = {
  test: (name: string) => /state/i.test(name) && !NOT_STATE_INCOME_RE.test(name),
};

/** Pull the employer name/address/EIN out of companies.settings.
 * EIN and address live in settings (`settings.ein`, `settings.address`) because the
 * companies table has no dedicated columns; blank when the settings page hasn't set them. */
function companyProfile(company: {
  name: string;
  settings?: Record<string, unknown> | null;
}): { name: string; address: string | null; ein: string | null } {
  const s = (company.settings ?? {}) as Record<string, unknown>;
  return {
    name: company.name,
    address: typeof s.address === 'string' && s.address.trim() ? s.address.trim() : null,
    ein: typeof s.ein === 'string' && s.ein.trim() ? s.ein.trim() : null,
  };
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
  /** Box 1: total gross wages paid in the calendar year. */
  wages: string;
  /** Box 2: total federal income tax withheld. */
  federalWithheld: string;
  /** Box 3: Social Security wages — Box 1 capped at the SS wage base. */
  ssWages: string;
  /** Box 4: total Social Security tax withheld. */
  socialSecurity: string;
  /** Box 5: Medicare wages (no cap). */
  medicareWages: string;
  /** Box 6: total Medicare tax withheld. */
  medicare: string;
  /** Boxes 15-17: state wages + state income tax withheld. */
  state: W2StateBoxes;
}

/**
 * Aggregate W-2 figures for an employee for a given calendar year.
 * Wages = sum of gross_pay on paychecks.
 * Federal / SS / Medicare = sum of matching paycheck_lines rows by name
 * (case-insensitive contains match on the standard names emitted by computeWithholding).
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

  // 1. Fetch paychecks for the employee in the year whose GL entry is still posted
  //    (a voided paycheck must not appear on the W-2).
  const yearPaychecks = await ctx.db
    .select({ id: paychecks.id, grossPay: paychecks.grossPay })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        eq(paychecks.employeeId, input.employeeId),
        paycheckCountsCondition(),
        gte(paychecks.payDate, yearStart),
        lt(paychecks.payDate, yearEnd), // half-open [start, end): exclude Jan-1 of next year
      ),
    );

  const paycheckIds = yearPaychecks.map((p) => p.id);

  // Aggregate gross wages (decimal-exact, never IEEE-754 floats).
  const wages = toAmountString(
    yearPaychecks.reduce((sum, p) => sum.plus(Money.of(p.grossPay)), Money.zero()),
  );

  const employerInfo = companyProfile(company);
  const addressState = (() => {
    const addr = (employee.address ?? {}) as Record<string, unknown>;
    return typeof addr.state === 'string' && /^[A-Za-z]{2}$/.test(addr.state.trim())
      ? addr.state.trim().toUpperCase()
      : null;
  })();

  if (paycheckIds.length === 0) {
    return {
      company: employerInfo,
      employee: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        ssn: (employee.ssn as string | null | undefined) ?? null,
      },
      year: input.year,
      wages: '0.00',
      federalWithheld: '0.00',
      ssWages: '0.00',
      socialSecurity: '0.00',
      medicareWages: '0.00',
      medicare: '0.00',
      state: { code: addressState, wages: '0.00', withheld: '0.00' },
    };
  }

  // 2. Fetch the tax lines for THIS company's paychecks only (paycheck_lines has no
  // companyId column, so scope by the already-company-scoped paycheckIds).
  const relevantTaxLines = await ctx.db
    .select({
      paycheckId: paycheckLines.paycheckId,
      name: paycheckLines.name,
      amount: paycheckLines.amount,
    })
    .from(paycheckLines)
    .where(and(eq(paycheckLines.kind, 'tax'), inArray(paycheckLines.paycheckId, paycheckIds)));

  function sumByName(pattern: { test(s: string): boolean }): string {
    return toAmountString(
      relevantTaxLines
        .filter((l) => pattern.test(l.name))
        .reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero()),
    );
  }

  const federalWithheld = sumByName(/federal income tax/i);
  const socialSecurity  = sumByName(/social security/i);
  const medicare        = sumByName(/medicare/i);
  const stateWithheld   = sumByName(STATE_TAX_RE);

  // Box 15 state code: prefer the employee's address state; otherwise parse a
  // "(XX)" suffix from a state tax line name (e.g. "State Income Tax (CA)").
  let stateCode = addressState;
  if (!stateCode) {
    const stateLine = relevantTaxLines.find((l) => STATE_TAX_RE.test(l.name));
    const m = stateLine?.name.match(/\(([A-Za-z]{2})\)/);
    if (m) stateCode = m[1].toUpperCase();
  }
  const hasStateInfo = stateCode !== null || Money.gt(stateWithheld, 0);

  // Box 3: SS wages are Box 1 capped at the annual SS wage base.
  const grossDec = Money.of(wages);
  const ssBase = ssWageBaseFor(input.year);
  const ssWages = toAmountString(grossDec.greaterThan(ssBase) ? Money.of(ssBase) : grossDec);

  return {
    company: employerInfo,
    employee: {
      firstName: employee.firstName,
      lastName:  employee.lastName,
      ssn: (employee.ssn as string | null | undefined) ?? null,
    },
    year: input.year,
    wages,
    federalWithheld,
    ssWages,
    socialSecurity,
    medicareWages: wages,
    medicare,
    state: {
      code: stateCode,
      wages: hasStateInfo ? wages : '0.00',
      withheld: stateWithheld,
    },
  };
}

// ---------------------------------------------------------------------------
// Form 941 data
// ---------------------------------------------------------------------------

export interface Form941DataInput {
  /** Calendar quarter: 1, 2, 3, or 4. */
  quarter: 1 | 2 | 3 | 4;
  year: number;
}

export interface Form941DataResult {
  company: { name: string; address: string | null };
  quarter: 1 | 2 | 3 | 4;
  year: number;
  totals: {
    wages: string;
    federalWithheld: string;
    /**
     * TOTAL Social Security tax for the quarter (employee withheld + employer match),
     * i.e. Form 941 line 5a column 2 (taxable SS wages × 12.4%).
     */
    socialSecurity: string;
    /**
     * TOTAL Medicare tax for the quarter (employee withheld + employer match),
     * i.e. Form 941 line 5c column 2 (Medicare wages × 2.9%) plus any Additional
     * Medicare Tax withheld.
     */
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
}

/** Compute the start and end Date for a given quarter in a given year (UTC, matching
 * how pay dates are stored — see the comment in w2Data). */
function quarterRange(quarter: 1 | 2 | 3 | 4, year: number): { start: Date; end: Date } {
  const qStartMonth = (quarter - 1) * 3; // 0, 3, 6, 9
  const start = new Date(Date.UTC(year, qStartMonth, 1));
  const end   = new Date(Date.UTC(year, qStartMonth + 3, 1)); // exclusive upper bound
  return { start, end };
}

/**
 * Aggregate Form 941 totals for a specific quarter and year.
 * Covers all employees in the company for that period.
 */
export async function form941Data(
  ctx: ServiceContext,
  input: Form941DataInput,
): Promise<Form941DataResult> {
  const company = await getCompany(ctx);
  if (!company) throw notFound('Company');

  const { start, end } = quarterRange(input.quarter, input.year);

  // Fetch all paychecks in the quarter whose GL entry is still posted (a voided
  // paycheck must not appear on the 941).
  const quarterPaychecks = await ctx.db
    .select({ id: paychecks.id, grossPay: paychecks.grossPay })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        paycheckCountsCondition(),
        gte(paychecks.payDate, start),
        lt(paychecks.payDate, end), // exclusive upper bound (quarterRange.end is exclusive)
      ),
    );

  const paycheckIds = quarterPaychecks.map((p) => p.id);

  const wages = toAmountString(
    quarterPaychecks.reduce((sum, p) => sum.plus(Money.of(p.grossPay)), Money.zero()),
  );

  if (paycheckIds.length === 0) {
    return {
      company: { name: company.name, address: null },
      quarter: input.quarter,
      year: input.year,
      totals: {
        wages: '0.00',
        federalWithheld: '0.00',
        socialSecurity: '0.00',
        medicare: '0.00',
        employeeSocialSecurity: '0.00',
        employerSocialSecurity: '0.00',
        employeeMedicare: '0.00',
        employerMedicare: '0.00',
      },
    };
  }

  // Both employee withholdings (kind='tax') AND the employer FICA match
  // (kind='employer_contribution') feed the 941 — lines 5a/5c are taxable wages ×
  // 12.4% / 2.9%, i.e. employee + employer shares combined. FUTA employer lines are
  // excluded by the name patterns (FUTA is Form 940, not 941).
  const relevantTaxLines = await ctx.db
    .select({
      paycheckId: paycheckLines.paycheckId,
      kind: paycheckLines.kind,
      name: paycheckLines.name,
      amount: paycheckLines.amount,
    })
    .from(paycheckLines)
    .where(
      and(
        inArray(paycheckLines.kind, ['tax', 'employer_contribution']),
        inArray(paycheckLines.paycheckId, paycheckIds),
      ),
    );

  function sumByName(pattern: RegExp, kind: 'tax' | 'employer_contribution') {
    return relevantTaxLines
      .filter((l) => l.kind === kind && pattern.test(l.name))
      .reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());
  }

  const employeeSS       = sumByName(/social security/i, 'tax');
  const employerSS       = sumByName(/social security/i, 'employer_contribution');
  const employeeMedicare = sumByName(/medicare/i, 'tax');
  const employerMedicare = sumByName(/medicare/i, 'employer_contribution');

  return {
    company: { name: company.name, address: null },
    quarter: input.quarter,
    year: input.year,
    totals: {
      wages,
      federalWithheld: toAmountString(sumByName(/federal income tax/i, 'tax')),
      socialSecurity:  toAmountString(employeeSS.plus(employerSS)),
      medicare:        toAmountString(employeeMedicare.plus(employerMedicare)),
      employeeSocialSecurity: toAmountString(employeeSS),
      employerSocialSecurity: toAmountString(employerSS),
      employeeMedicare:       toAmountString(employeeMedicare),
      employerMedicare:       toAmountString(employerMedicare),
    },
  };
}

// ---------------------------------------------------------------------------
// Form 940 (FUTA) annual worksheet
// ---------------------------------------------------------------------------

export interface Form940DataInput {
  year: number;
}

export interface Form940QuarterRow {
  quarter: 1 | 2 | 3 | 4;
  /** FUTA tax accrued in the quarter (sum of per-paycheck FUTA accrual lines). */
  futaLiability: string;
}

export interface Form940DataResult {
  company: { name: string; address: string | null; ein: string | null };
  year: number;
  /** Number of employees paid during the year. */
  employeeCount: number;
  /** Line 3: total payments to all employees (gross wages). */
  totalPayments: string;
  /** Line 4: payments exempt from FUTA. Always 0.00 — no exempt pay categories are tracked. */
  exemptPayments: string;
  /** Line 5: total of payments over the $7,000 FUTA wage base, per employee. */
  excessOver7000: string;
  /** Line 6: subtotal (line 4 + line 5). */
  subtotal: string;
  /** Line 7: total taxable FUTA wages (line 3 − line 6). */
  taxableFutaWages: string;
  /** Line 8 (worksheet): taxable FUTA wages × 0.6% net rate. */
  futaTaxCalculated: string;
  /** FUTA tax actually accrued on paychecks (employer FUTA lines) — the GL-backed figure. */
  futaTaxAccrued: string;
  /** Part 5: FUTA liability by quarter (from per-paycheck accruals). */
  quarters: Form940QuarterRow[];
  /** Sum of the four quarterly liabilities (= futaTaxAccrued). */
  totalQuarterlyLiability: string;
}

/**
 * Aggregate the Form 940 (FUTA) annual worksheet for a calendar year.
 *
 * Wage lines (3/5/7) derive from gross pay on posted, non-void paychecks with the
 * $7,000-per-employee FUTA wage base applied. The tax itself is reported two ways:
 * the worksheet computation (taxable wages × 0.6%) and the sum of the FUTA accrual
 * lines runPaycheck stamps on each check — the accrued figure is what hit the GL
 * and feeds the Part 5 quarterly breakdown.
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

  const yearChecks = await ctx.db
    .select({
      id: paychecks.id,
      employeeId: paychecks.employeeId,
      grossPay: paychecks.grossPay,
      payDate: paychecks.payDate,
    })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        paycheckCountsCondition(),
        gte(paychecks.payDate, yearStart),
        lt(paychecks.payDate, yearEnd),
      ),
    );

  // Gross wages per employee (the FUTA base applies per employee, per year).
  const grossByEmployee = new Map<string, ReturnType<typeof Money.zero>>();
  let totalPayments = Money.zero();
  for (const c of yearChecks) {
    const g = Money.of(c.grossPay);
    grossByEmployee.set(
      c.employeeId,
      (grossByEmployee.get(c.employeeId) ?? Money.zero()).plus(g),
    );
    totalPayments = totalPayments.plus(g);
  }

  let excessOver7000 = Money.zero();
  for (const total of grossByEmployee.values()) {
    if (total.greaterThan(FUTA_WAGE_BASE)) {
      excessOver7000 = excessOver7000.plus(total.minus(FUTA_WAGE_BASE));
    }
  }

  const exemptPayments = Money.zero(); // no exempt pay categories tracked
  const subtotal = exemptPayments.plus(excessOver7000);
  const taxableFutaWages = totalPayments.minus(subtotal);
  const futaTaxCalculated = Money.round2(taxableFutaWages.times(FUTA_NET_RATE));

  // FUTA accrual lines (kind employer_contribution, name "Federal Unemployment (FUTA)")
  // summed per quarter for Part 5.
  const ids = yearChecks.map((c) => c.id);
  const quarterTotals: Record<1 | 2 | 3 | 4, ReturnType<typeof Money.zero>> = {
    1: Money.zero(), 2: Money.zero(), 3: Money.zero(), 4: Money.zero(),
  };
  let futaTaxAccrued = Money.zero();
  if (ids.length > 0) {
    const futaLines = await ctx.db
      .select({
        paycheckId: paycheckLines.paycheckId,
        name: paycheckLines.name,
        amount: paycheckLines.amount,
      })
      .from(paycheckLines)
      .where(
        and(
          eq(paycheckLines.kind, 'employer_contribution'),
          inArray(paycheckLines.paycheckId, ids),
        ),
      );
    const payDateById = new Map(yearChecks.map((c) => [c.id, c.payDate]));
    for (const l of futaLines) {
      if (!FUTA_NAME_RE.test(l.name)) continue;
      const payDate = payDateById.get(l.paycheckId);
      if (!payDate) continue;
      const quarter = (Math.floor(payDate.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
      const amt = Money.of(l.amount);
      quarterTotals[quarter] = quarterTotals[quarter].plus(amt);
      futaTaxAccrued = futaTaxAccrued.plus(amt);
    }
  }

  return {
    company: companyProfile(company),
    year: input.year,
    employeeCount: grossByEmployee.size,
    totalPayments: toAmountString(totalPayments),
    exemptPayments: toAmountString(exemptPayments),
    excessOver7000: toAmountString(excessOver7000),
    subtotal: toAmountString(subtotal),
    taxableFutaWages: toAmountString(taxableFutaWages),
    futaTaxCalculated: toAmountString(futaTaxCalculated),
    futaTaxAccrued: toAmountString(futaTaxAccrued),
    quarters: ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      futaLiability: toAmountString(quarterTotals[q]),
    })),
    totalQuarterlyLiability: toAmountString(futaTaxAccrued),
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
  /** Box 1: total wages, tips, other compensation. */
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
  /** Box 16: total state wages (wages of employees with state withholding). */
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

  const yearChecks = await ctx.db
    .select({ id: paychecks.id, employeeId: paychecks.employeeId, grossPay: paychecks.grossPay })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        paycheckCountsCondition(),
        gte(paychecks.payDate, yearStart),
        lt(paychecks.payDate, yearEnd),
      ),
    );

  const grossByEmployee = new Map<string, ReturnType<typeof Money.zero>>();
  let wages = Money.zero();
  for (const c of yearChecks) {
    const g = Money.of(c.grossPay);
    grossByEmployee.set(
      c.employeeId,
      (grossByEmployee.get(c.employeeId) ?? Money.zero()).plus(g),
    );
    wages = wages.plus(g);
  }

  // Box 3: cap per employee at the SS wage base, then sum.
  const ssBase = ssWageBaseFor(input.year);
  let ssWages = Money.zero();
  for (const total of grossByEmployee.values()) {
    ssWages = ssWages.plus(total.greaterThan(ssBase) ? Money.of(ssBase) : total);
  }

  const ids = yearChecks.map((c) => c.id);
  const taxLines = ids.length
    ? await ctx.db
        .select({
          paycheckId: paycheckLines.paycheckId,
          name: paycheckLines.name,
          amount: paycheckLines.amount,
        })
        .from(paycheckLines)
        .where(and(eq(paycheckLines.kind, 'tax'), inArray(paycheckLines.paycheckId, ids)))
    : [];

  const sumByName = (pattern: { test(s: string): boolean }) =>
    taxLines
      .filter((l) => pattern.test(l.name))
      .reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero());

  const federalWithheld = sumByName(/federal income tax/i);
  const socialSecurity  = sumByName(/social security/i);
  const medicare        = sumByName(/medicare/i);
  const stateWithheld   = sumByName(STATE_TAX_RE);

  // Box 16: state wages = total wages of the employees who had state withholding.
  const employeeById = new Map(yearChecks.map((c) => [c.id, c.employeeId]));
  const stateEmployeeIds = new Set<string>();
  for (const l of taxLines) {
    if (!STATE_TAX_RE.test(l.name)) continue;
    const empId = employeeById.get(l.paycheckId);
    if (empId) stateEmployeeIds.add(empId);
  }
  let stateWages = Money.zero();
  for (const empId of stateEmployeeIds) {
    stateWages = stateWages.plus(grossByEmployee.get(empId) ?? Money.zero());
  }

  return {
    company: companyProfile(company),
    year: input.year,
    w2Count: grossByEmployee.size,
    wages: toAmountString(wages),
    federalWithheld: toAmountString(federalWithheld),
    ssWages: toAmountString(ssWages),
    socialSecurity: toAmountString(socialSecurity),
    medicareWages: toAmountString(wages),
    medicare: toAmountString(medicare),
    stateWages: toAmountString(stateWages),
    stateWithheld: toAmountString(stateWithheld),
  };
}

// ---------------------------------------------------------------------------
// Payroll Summary / Detail / Liability Balances (QB Desktop report parity)
// ---------------------------------------------------------------------------

type Dec = ReturnType<typeof Money.zero>;

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
      taxes: taxes.rec,
      totalTaxes: toAmountString(taxes.total),
      deductions: deductions.rec,
      totalDeductions: toAmountString(deductions.total),
      employerTaxes: employer.rec,
      totalEmployerTaxes: toAmountString(employer.total),
      net: toAmountString(agg.net),
    });
    totals.gross = totals.gross.plus(agg.gross);
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
    const g = Money.of(pc.grossPay);
    if (pc.payDate.getTime() < start.getTime()) {
      a.before = a.before.plus(g);
    } else {
      a.q = a.q.plus(g);
      for (const l of linesByCheck.get(pc.id) ?? []) {
        if (l.kind === 'employer_contribution' && SUI_NAME_RE.test(l.name)) a.sui = a.sui.plus(Money.of(l.amount));
        else if (l.kind === 'tax' && /disab|\bsdi\b/i.test(l.name)) a.sdi = a.sdi.plus(Money.of(l.amount));
        else if (l.kind === 'tax' && STATE_TAX_RE.test(l.name)) a.st = a.st.plus(Money.of(l.amount));
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
