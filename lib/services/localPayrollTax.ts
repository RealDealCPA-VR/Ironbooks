/**
 * Local (city / county) income tax withholding — taxes taken out of an employee's pay for the
 * city or county they live or work in (Philadelphia wage tax, New York City resident tax, Ohio
 * municipal tax, Michigan city tax, Indiana county tax, Kentucky occupational tax and the like).
 *
 * The employee record carries a short list of local taxes (employees.w4.localTaxes). Each names
 * a place from the built-in list (localPayrollTaxData.ts) or one the user typed in ("Other"):
 *
 *   - a listed place uses the built-in rate in force on the pay date — the resident rate for a
 *     person who lives there, the nonresident rate for one who only works there — unless the
 *     user typed their own percent or amount, which always wins;
 *   - New York City uses the state's withholding formula for city residents (NYS-50-T-NYC);
 *   - Yonkers residents pay a percent of their New York State withholding;
 *   - a place the app has no rate for (and every "Other") needs a percent of wages or an amount
 *     per paycheck from the user. Without one nothing is withheld and a note says so — never a
 *     guess.
 *
 * A pay date after the last year the list was checked for uses the latest rate AND says so in
 * the paycheck's notes. This module is data plus arithmetic: updating a rate means adding a
 * dated entry to that place in localPayrollTaxData.ts.
 */
import Decimal from 'decimal.js';
import { Money, toAmountString, type MoneyInput } from '@/lib/money';
import { stateInfo, type StateW4 } from './statePayrollTax';
import {
  LOCAL_JURISDICTIONS,
  LOCAL_RATES_THROUGH_YEAR,
  LOCAL_WAGE_BASE_BY_STATE,
  NYC_RESIDENT_TABLES,
  type LocalJurisdiction,
  type LocalRate,
  type LocalWageBase,
} from './localPayrollTaxData';

export type { LocalJurisdiction, LocalRate, LocalWageBase };
export { LOCAL_RATES_THROUGH_YEAR };

/** The jurisdiction id of a place the user typed in. */
export const OTHER_LOCAL = 'OTHER';

/** At most this many local taxes on one employee (work city, home city, school district...). */
export const MAX_LOCAL_TAXES = 4;

/** One local tax on an employee (employees.w4.localTaxes[]). */
export interface LocalTaxSetup {
  /** Two-letter state the place is in. */
  state: string;
  /** Id from the built-in list (e.g. "PA-PHILADELPHIA"), or OTHER_LOCAL. */
  jurisdiction: string;
  /** Name printed on the paycheck and the W-2 (Box 20). */
  name: string;
  /** The employee lives there (resident rate). False = only works there (nonresident rate). */
  resident: boolean;
  /** The user's own percent of local wages per paycheck; wins over the built-in rate. */
  percent?: string;
  /** The user's own fixed amount per paycheck; used when no percent is entered. */
  amountPerCheck?: string;
  /** New York City: allowances claimed for the city on Form IT-2104. */
  allowances?: number;
}

const BY_ID = new Map<string, LocalJurisdiction>(LOCAL_JURISDICTIONS.map((j) => [j.id, j]));

export function localJurisdiction(id: string | null | undefined): LocalJurisdiction | null {
  return id ? BY_ID.get(id) ?? null : null;
}

/** The built-in places in a state, by name. */
export function localJurisdictionsFor(state: string | null | undefined): LocalJurisdiction[] {
  const code = (state ?? '').trim().toUpperCase();
  return LOCAL_JURISDICTIONS.filter((j) => j.state === code).sort((a, b) => a.name.localeCompare(b.name));
}

/** States with at least one built-in local tax. */
export const LOCAL_TAX_STATES: string[] = [...new Set(LOCAL_JURISDICTIONS.map((j) => j.state))].sort();

/** Which wages a place's tax is figured on (see LocalWageBase). */
export function localWageBase(state: string, jurisdictionId?: string | null): LocalWageBase {
  return localJurisdiction(jurisdictionId)?.base ?? LOCAL_WAGE_BASE_BY_STATE[state.toUpperCase()] ?? 'income';
}

/**
 * The wage base of a place named on a paycheck line (W-2 Box 18): the employee's own setup for
 * that place if they still have one, else a built-in place of that name, else the state's usual
 * base.
 */
export function localWageBaseForLocality(
  locality: string,
  setups?: LocalTaxSetup[] | null,
  state?: string | null,
): LocalWageBase {
  const want = locality.trim().toLowerCase();
  const own = (setups ?? []).find((s) => s.name.trim().toLowerCase() === want);
  if (own) return localWageBase(own.state, own.jurisdiction);
  const code = (state ?? '').trim().toUpperCase();
  const named = LOCAL_JURISDICTIONS.filter((j) => j.name.toLowerCase() === want);
  const place = named.find((j) => j.state === code) ?? (named.length === 1 ? named[0] : null);
  if (place) return localWageBase(place.state, place.id);
  return LOCAL_WAGE_BASE_BY_STATE[code] ?? 'income';
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** The built-in rate entry in force on `date` (the earliest one for a date before the list starts). */
export function localRateOn(j: LocalJurisdiction, date: Date): LocalRate | null {
  if (!j.rates.length) return null;
  const day = isoDate(date);
  const sorted = [...j.rates].sort((a, b) => a.from.localeCompare(b.from));
  let found = sorted[0];
  for (const r of sorted) if (r.from <= day) found = r;
  return found;
}

const pct = (v: string) => `${new Decimal(v).toString()}%`;

/**
 * How the app will withhold for one setup on `date`, in plain words — shown under the picker on
 * the employee form ("3.74% of wages (built-in rate for people who live there)").
 */
export function describeLocalTax(setup: LocalTaxSetup, date: Date = new Date()): string {
  if (setup.percent) return `${pct(setup.percent)} of wages (the rate you entered)`;
  if (setup.amountPerCheck) return `$${Money.of(setup.amountPerCheck).toFixed(2)} per paycheck (the amount you entered)`;
  const j = localJurisdiction(setup.jurisdiction);
  if (!j) return 'Enter a percent of wages or an amount per paycheck.';
  const who = setup.resident ? 'people who live there' : 'people who only work there';
  if (j.method === 'nyc') {
    return setup.resident
      ? "New York City resident tax, from the state's withholding formula"
      : 'New York City taxes residents only: nothing is withheld for people who only work there.';
  }
  const rate = localRateOn(j, date);
  if (!rate) return 'The app has no rate for this place: enter a percent of wages or an amount per paycheck.';
  if (setup.resident && rate.residentPercentOfStateTax) {
    return `${pct(rate.residentPercentOfStateTax)} of the state income tax withheld (built-in rate for ${who})`;
  }
  const r = setup.resident ? rate.resident : rate.nonresident;
  if (r == null) return `No tax for ${who}.`;
  const after = j.exemptions === 'indiana' ? ' after the state exemptions' : '';
  return `${pct(r)} of wages${after} (built-in rate for ${who})`;
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

export interface LocalWithholdingInput {
  setup: LocalTaxSetup;
  payDate: Date;
  /** This check's income-tax wages (gross less pre-tax retirement and Section 125). */
  incomeTaxWagesPerPeriod: MoneyInput;
  /** This check's Social Security / Medicare wages (gross less Section 125). */
  ficaWagesPerPeriod: MoneyInput;
  /** This check's gross pay. */
  grossPerPeriod: MoneyInput;
  periodsPerYear: number;
  /** State income tax calculated for this check, before any extra withholding (Yonkers). */
  stateTaxPerPeriod?: MoneyInput | null;
  /** The employee's state W-4 (New York City: filing status; Indiana: exemptions and dependents). */
  stateW4?: StateW4 | null;
}

export type LocalWithholdingMethod = 'rate' | 'formula' | 'employee_percent' | 'employee_amount' | 'none' | 'not_set_up';

export interface LocalWithholdingCalc {
  /** The place's name (paycheck line "Local Tax (name)", W-2 Box 20). */
  name: string;
  /** Amount to withhold on this check (2-dp). */
  amount: string;
  method: LocalWithholdingMethod;
  /** The wages the tax was figured on. */
  base: LocalWageBase;
  notes: string[];
}

/** The paycheck line name for a local tax. */
export const localTaxLineName = (name: string) => `Local Tax (${name})`;

/** The place a paycheck line was for: "Local Tax (Philadelphia)" → "Philadelphia"; else the name. */
export function localityOfLine(lineName: string): string {
  const m = /^Local Tax \((.+)\)$/.exec(lineName.trim());
  return (m ? m[1] : lineName).trim();
}

/**
 * Per-check local tax for one setup. Never guesses: a place without a built-in rate uses the
 * employee's own percent / amount, or withholds nothing with a note asking for one.
 */
export function calculateLocalWithholding(input: LocalWithholdingInput): LocalWithholdingCalc {
  const { setup } = input;
  const j = localJurisdiction(setup.jurisdiction);
  const name = (j?.name ?? setup.name ?? '').trim() || 'Local';
  const base = localWageBase(setup.state, setup.jurisdiction);
  const wages = Money.of(
    base === 'gross' ? input.grossPerPeriod : base === 'fica' ? input.ficaWagesPerPeriod : input.incomeTaxWagesPerPeriod,
  );
  const periods = input.periodsPerYear;
  if (!Number.isInteger(periods) || periods <= 0) throw new Error('periodsPerYear must be a positive whole number.');
  const notes: string[] = [];
  const done = (amount: Decimal, method: LocalWithholdingMethod): LocalWithholdingCalc => ({
    name,
    amount: toAmountString(Money.round2(amount.isNegative() ? new Decimal(0) : amount)),
    method,
    base,
    notes,
  });

  // The user's own figures always win.
  if (setup.percent != null && setup.percent !== '') {
    return done(wages.times(Money.of(setup.percent)).dividedBy(100), 'employee_percent');
  }
  if (setup.amountPerCheck != null && setup.amountPerCheck !== '') {
    return done(Money.of(setup.amountPerCheck), 'employee_amount');
  }

  const notSetUp = () => {
    notes.push(
      `${name} local tax is not calculated by the app. Enter a percent of wages or an amount per paycheck for it on the employee record (Local taxes section).`,
    );
    return done(new Decimal(0), 'not_set_up');
  };
  if (!j) return notSetUp();

  const year = input.payDate.getUTCFullYear();
  if (year > LOCAL_RATES_THROUGH_YEAR) {
    notes.push(
      `${name} local tax rates for ${year} are not in this version; the ${LOCAL_RATES_THROUGH_YEAR} rate was used. Check the amount against the current rate.`,
    );
  }
  const earlier = (firstYear: number) =>
    notes.push(
      `${name} local tax rates before ${firstYear} are not in this version; the ${firstYear} rate was used. Check the amount against the rate for ${year}.`,
    );

  if (j.method === 'nyc') {
    if (!setup.resident) return done(new Decimal(0), 'none');
    const years = Object.keys(NYC_RESIDENT_TABLES).map(Number).sort((a, b) => a - b);
    if (!years.length) return notSetUp();
    const tableYear = NYC_RESIDENT_TABLES[year] ? year : year > years[years.length - 1] ? years[years.length - 1] : years[0];
    if (tableYear > year) earlier(tableYear);
    const t = NYC_RESIDENT_TABLES[tableYear];
    const married = input.stateW4?.filingStatus === 'married';
    const allowances = Number.isInteger(setup.allowances) && (setup.allowances ?? 0) > 0 ? setup.allowances! : 0;
    const net = wages
      .times(periods)
      .minus(married ? t.deductionMarried : t.deductionSingle)
      .minus(new Decimal(t.exemptionPerAllowance).times(allowances));
    if (!net.greaterThan(0)) return done(new Decimal(0), 'formula');
    // The schedule row for these net wages: (net − over) × rate + add.
    let row = t.rows[0];
    for (const r of t.rows) if (net.greaterThanOrEqualTo(r.over)) row = r;
    const annual = net.minus(row.over).times(row.rate).plus(row.add);
    return done(annual.dividedBy(periods), 'formula');
  }

  const rate = localRateOn(j, input.payDate);
  if (!rate) return notSetUp();
  const firstFrom = [...j.rates].sort((a, b) => a.from.localeCompare(b.from))[0].from;
  if (isoDate(input.payDate) < firstFrom) earlier(Number(firstFrom.slice(0, 4)));

  if (setup.resident && rate.residentPercentOfStateTax) {
    if (input.stateTaxPerPeriod == null) {
      notes.push(`${name} resident tax is a percent of the state income tax withheld, and no state tax was calculated for this check.`);
      return done(new Decimal(0), 'rate');
    }
    return done(Money.of(input.stateTaxPerPeriod).times(rate.residentPercentOfStateTax).dividedBy(100), 'rate');
  }
  const r = setup.resident ? rate.resident : rate.nonresident;
  if (r == null) return done(new Decimal(0), 'none');

  let annual = wages.times(periods);
  // Indiana counties: the same taxable wages as the state's withholding (WH-4 exemptions).
  if (j.exemptions === 'indiana') {
    const whole = (v: unknown) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    annual = annual.minus(whole(input.stateW4?.allowances) * 1000 + whole(input.stateW4?.dependents) * 1500);
  }
  // Yonkers nonresidents: an exclusion by the size of the year's wages (none at all when small).
  if (!setup.resident && rate.nonresidentExclusions) {
    const tier = rate.nonresidentExclusions.find((t) => annual.lessThanOrEqualTo(t.upTo));
    if (tier) {
      if (tier.exclusion === null) return done(new Decimal(0), 'none');
      annual = annual.minus(tier.exclusion);
    }
  }
  if (!annual.greaterThan(0)) return done(new Decimal(0), 'rate');
  return done(annual.times(r).dividedBy(100).dividedBy(periods), 'rate');
}

// ---------------------------------------------------------------------------
// Validation of the employee's local taxes
// ---------------------------------------------------------------------------

/**
 * Validate + normalize the local taxes from the employee form. Throws an Error with a plain
 * message (the service turns it into a validation error). Returns null when there are none.
 */
export function normalizeLocalTaxes(raw: unknown): LocalTaxSetup[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error('The local tax settings are not valid.');
  if (raw.length > MAX_LOCAL_TAXES) throw new Error(`An employee can have at most ${MAX_LOCAL_TAXES} local taxes.`);
  const out: LocalTaxSetup[] = [];
  const seen = new Set<string>();
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The local tax settings are not valid.');
    const r = item as Record<string, unknown>;
    const id = String(r.jurisdiction ?? '').trim();
    const j = localJurisdiction(id);
    if (!j && id !== OTHER_LOCAL) throw new Error('Choose the city or county for each local tax, or "Other" to type one in.');
    const state = (j?.state ?? String(r.state ?? '')).trim().toUpperCase();
    if (!stateInfo(state)) throw new Error('Choose the state for each local tax.');
    const name = (j?.name ?? String(r.name ?? '')).trim();
    if (!name) throw new Error('Enter the name of the city or county for the local tax.');
    if (name.length > 60) throw new Error('The name of a local tax can be at most 60 characters.');
    if (/[()]/.test(name)) throw new Error('The name of a local tax cannot contain brackets.');
    const setup: LocalTaxSetup = { state, jurisdiction: j ? j.id : OTHER_LOCAL, name, resident: r.resident !== false };
    if (!blank(r.percent)) {
      const s = String(r.percent).trim();
      if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) > 100) throw new Error(`The ${name} local tax percent must be between 0 and 100.`);
      setup.percent = s;
    }
    if (!blank(r.amountPerCheck)) {
      const s = String(r.amountPerCheck).trim();
      if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`The ${name} local tax amount must be an amount like 5.75.`);
      setup.amountPerCheck = s;
    }
    if (setup.percent && setup.amountPerCheck) {
      throw new Error(`Enter a percent or an amount per paycheck for the ${name} local tax, not both.`);
    }
    if (!blank(r.allowances)) {
      const n = Number(r.allowances);
      if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error('Local tax allowances must be a whole number from 0 to 99.');
      if (n > 0) setup.allowances = n;
    }
    const needsOwnFigure = !j || (j.method !== 'nyc' && j.rates.length === 0);
    if (needsOwnFigure && !setup.percent && !setup.amountPerCheck) {
      throw new Error(`Enter a percent of wages or an amount per paycheck for the ${name} local tax.`);
    }
    const key = `${setup.state}|${setup.name.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`${name} is listed twice in the local taxes.`);
    seen.add(key);
    out.push(setup);
  }
  return out.length ? out : null;
}
