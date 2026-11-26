/**
 * Local (city / county) income tax data: the places the app knows and their rates. See
 * localPayrollTax.ts for how they are used. Only taxes WITHHELD FROM THE EMPLOYEE are listed
 * (employer-only payroll taxes are not).
 *
 * Checked in November 2026 against each government's own publication, for pay dates in 2026:
 *   NY  NYS-50-T-NYC (1/26) and NYS-50-T-Y (1/26), NYS Department of Taxation and Finance;
 *   PA  City of Philadelphia wage tax page; PA DCED EIT register (reporting year 2026);
 *   MI  Michigan Treasury, "Michigan Cities Levying an Income Tax" (2025 Taxpayer Assistance
 *       Manual — no 2026 edition was out; no change found);
 *   OH  Ohio Department of Taxation, The Finder municipal rate table (Nov 2026);
 *   KY  each city's revenue page or code (Lexington's school portion and Owensboro's rate from
 *       the USDA NFC bulletin of Mar 3, 2026);
 *   IN  Indiana DOR Departmental Notice #1 (R47, effective Oct 1, 2026);
 *   MO  Kansas City and St. Louis earnings tax pages; RSMo 92.113 (wage base);
 *   DE  22 Del. C. ch. 9 (the 1.25% limit; the city's own regulations were not readable);
 *   AL  each city's code, form or revenue page; Ala. Code 45-44-244.31 (Macon County);
 *   CO  each city's occupational privilege tax page.
 * Wage bases: Ohio R.C. 718.01(R), KRS 67.750, RSMo 92.113 and Philadelphia's wage tax guidance
 * are read from the source; Pennsylvania EIT, Michigan, Indiana, Wilmington and Alabama follow
 * the usual rule for those taxes and are NOT confirmed from a primary source.
 *
 * To update a rate, add a dated entry to the place's `rates` (the entry in force on the pay
 * date is used) and move LOCAL_RATES_THROUGH_YEAR on once the whole list has been checked.
 */
import Decimal from 'decimal.js';

/**
 * Which of a check's wages a local tax is figured on:
 *   'income' — income-tax wages (gross less pre-tax retirement deferrals and Section 125);
 *   'fica'   — Social Security / Medicare wages (gross less Section 125 only): places that tax
 *              401(k) deferrals but not cafeteria-plan premiums;
 *   'gross'  — gross pay: places that tax both.
 */
export type LocalWageBase = 'income' | 'fica' | 'gross';

export interface LocalRate {
  /** First pay date the rate applies to (YYYY-MM-DD). */
  from: string;
  /** Percent of wages for a person who lives there; null = no tax on residents. */
  resident: string | null;
  /** Percent of wages for a person who only works there; null = no tax on nonresidents. */
  nonresident: string | null;
  /** Residents instead pay this percent of their state income tax withheld (Yonkers). */
  residentPercentOfStateTax?: string;
  /**
   * Nonresidents: an amount taken off the YEAR's wages before the rate, by size of the year's
   * wages (Yonkers). First tier whose `upTo` the annual wages do not pass; `exclusion: null` =
   * no tax at all. Wages above the last tier have no exclusion.
   */
  nonresidentExclusions?: Array<{ upTo: number; exclusion: number | null }>;
}

export interface LocalJurisdiction {
  /** "ST-NAME" (stored on the employee: never change an id once shipped). */
  id: string;
  state: string;
  name: string;
  /** 'rate' (default): a percent of wages. 'nyc': New York City's resident withholding formula. */
  method?: 'rate' | 'nyc';
  /** Dated rates; empty = the app has no rate and the user enters a percent or an amount. */
  rates: LocalRate[];
  /** Wage base when it differs from the state's usual one (LOCAL_WAGE_BASE_BY_STATE). */
  base?: LocalWageBase;
  /**
   * 'indiana': the county rate applies after the state WH-4 exemptions ($1,000 a year for each
   * exemption, $1,500 for each dependent) — the same taxable wages as Indiana's own withholding.
   */
  exemptions?: 'indiana';
  /** Plain-language note shown with the place on the employee form. */
  note?: string;
}

/** New York City's annual schedule: for net wages of at least `over`, (net − over) × rate + add. */
export interface NycResidentTable {
  deductionSingle: number;
  deductionMarried: number;
  exemptionPerAllowance: number;
  rows: Array<{ over: number; rate: string; add: string }>;
}

/** The last calendar year the list below was checked against the places' published rates. */
export const LOCAL_RATES_THROUGH_YEAR = 2026;

/** The usual wage base of local taxes in a state (a place can override it). Default 'income'. */
export const LOCAL_WAGE_BASE_BY_STATE: Record<string, LocalWageBase> = {
  AL: 'gross',
  DE: 'fica',
  KY: 'gross',
  OH: 'fica',
  PA: 'fica',
};

/** New York City resident withholding (NYS-50-T-NYC Method II, exact calculation), by year. */
export const NYC_RESIDENT_TABLES: Record<number, NycResidentTable> = {
  2026: {
    deductionSingle: 5000,
    deductionMarried: 5500,
    exemptionPerAllowance: 1000,
    // The same schedule for single and married.
    rows: [
      { over: 0, rate: '0.0205', add: '0' },
      { over: 8000, rate: '0.028', add: '164' },
      { over: 8700, rate: '0.0325', add: '184' },
      { over: 15000, rate: '0.0395', add: '388' },
      { over: 25000, rate: '0.0415', add: '783' },
      { over: 60000, rate: '0.0425', add: '2236' },
    ],
  },
};

const Y2026 = '2026-01-01';
const idOf = (state: string, name: string) =>
  `${state}-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** A place with one resident and one nonresident percent for all of 2026. */
function place(
  state: string,
  name: string,
  resident: string | null,
  nonresident: string | null,
  extra: Partial<Pick<LocalJurisdiction, 'base' | 'note' | 'exemptions'>> = {},
): LocalJurisdiction {
  return { id: idOf(state, name), state, name, rates: [{ from: Y2026, resident, nonresident }], ...extra };
}
/** A place the app lists by name but has no rate for (the user enters the figure). */
function manual(state: string, name: string, note: string): LocalJurisdiction {
  return { id: idOf(state, name), state, name, rates: [], note };
}

const PA_NOTE =
  'Pennsylvania: when the home and work municipality both tax wages, withhold the higher of the home resident rate and the work nonresident rate, not both. The Local Services Tax is separate.';
const OH_NOTE =
  "Ohio: this is the tax of the city where the work is done. A home city's tax and a school district tax are separate: add them as their own lines if you withhold them.";
const KY_CAP_NOTE =
  "This city stops the tax once the year's wages pass the Social Security wage limit. The app does not stop it for you.";

// ---- Michigan: 20 cities at 1% / 0.5% ----
const MI_STANDARD = [
  'Albion', 'Battle Creek', 'Benton Harbor', 'Big Rapids', 'East Lansing', 'Flint', 'Grayling', 'Hamtramck', 'Hudson',
  'Ionia', 'Jackson', 'Lansing', 'Lapeer', 'Muskegon', 'Muskegon Heights', 'Pontiac', 'Port Huron', 'Portland',
  'Springfield', 'Walker',
];

// ---- Ohio: one rate per city (percent) ----
const OH_CITIES: Array<[string, string]> = [
  ['Akron', '2.5'], ['Canton', '2.5'], ['Cincinnati', '1.8'], ['Cleveland', '2.5'], ['Columbus', '2.5'],
  ['Cuyahoga Falls', '2'], ['Dayton', '2.5'], ['Dublin', '2'], ['Elyria', '2.25'], ['Euclid', '2.85'],
  ['Hamilton', '2'], ['Kettering', '2.25'], ['Lakewood', '1.5'], ['Lorain', '2.5'], ['Mansfield', '2.25'],
  ['Middletown', '2'], ['Newark', '1.75'], ['Parma', '2.5'], ['Springfield', '2.4'], ['Toledo', '2.5'],
  ['Westerville', '2'], ['Youngstown', '2.75'],
];

// ---- Indiana: county rates as the notice prints them (decimals), in county-number order ----
const IN_COUNTIES: Array<[string, string]> = [
  ['Adams', '0.016'], ['Allen', '0.0159'], ['Bartholomew', '0.0175'], ['Benton', '0.0179'], ['Blackford', '0.025'],
  ['Boone', '0.0171'], ['Brown', '0.025234'], ['Carroll', '0.024733'], ['Cass', '0.0295'], ['Clark', '0.02'],
  ['Clay', '0.0235'], ['Clinton', '0.0265'], ['Crawford', '0.0165'], ['Daviess', '0.015'], ['Dearborn', '0.014'],
  ['Decatur', '0.0245'], ['DeKalb', '0.0213'], ['Delaware', '0.015'], ['Dubois', '0.012'], ['Elkhart', '0.02'],
  ['Fayette', '0.0282'], ['Floyd', '0.0189'], ['Fountain', '0.021'], ['Franklin', '0.017'], ['Fulton', '0.0288'],
  ['Gibson', '0.013'], ['Grant', '0.0275'], ['Greene', '0.0235'], ['Hamilton', '0.011'], ['Hancock', '0.0194'],
  ['Harrison', '0.01'], ['Hendricks', '0.017'], ['Henry', '0.0202'], ['Howard', '0.0235'], ['Huntington', '0.0195'],
  ['Jackson', '0.021'], ['Jasper', '0.02864'], ['Jay', '0.025'], ['Jefferson', '0.0103'], ['Jennings', '0.025'],
  ['Johnson', '0.014'], ['Knox', '0.017'], ['Kosciusko', '0.01'], ['LaGrange', '0.0165'], ['Lake', '0.015'],
  ['LaPorte', '0.0145'], ['Lawrence', '0.0175'], ['Madison', '0.0225'], ['Marion', '0.0202'], ['Marshall', '0.0125'],
  ['Martin', '0.025'], ['Miami', '0.0254'], ['Monroe', '0.0214'], ['Montgomery', '0.0265'], ['Morgan', '0.0272'],
  ['Newton', '0.01'], ['Noble', '0.0175'], ['Ohio', '0.02'], ['Orange', '0.0175'], ['Owen', '0.025'],
  ['Parke', '0.0265'], ['Perry', '0.014'], ['Pike', '0.012'], ['Porter', '0.005'], ['Posey', '0.0145'],
  ['Pulaski', '0.0285'], ['Putnam', '0.023'], ['Randolph', '0.03'], ['Ripley', '0.0238'], ['Rush', '0.0215'],
  ['St. Joseph', '0.0175'], ['Scott', '0.0216'], ['Shelby', '0.017'], ['Spencer', '0.008'], ['Starke', '0.0171'],
  ['Steuben', '0.0199'], ['Sullivan', '0.017'], ['Switzerland', '0.0145'], ['Tippecanoe', '0.0128'], ['Tipton', '0.026'],
  ['Union', '0.0275'], ['Vanderburgh', '0.0125'], ['Vermillion', '0.015'], ['Vigo', '0.02'], ['Wabash', '0.029'],
  ['Warren', '0.0212'], ['Warrick', '0.01'], ['Washington', '0.02'], ['Wayne', '0.0125'], ['Wells', '0.021'],
  ['White', '0.0232'], ['Whitley', '0.016829'],
];
const asPercent = (decimal: string) => new Decimal(decimal).times(100).toString();

function indianaCounty([name, rate]: [string, string]): LocalJurisdiction {
  const j = place('IN', `${name} County`, asPercent(rate), asPercent(rate), { exemptions: 'indiana' });
  // Boone is the one county whose rate changed during 2026 (1.70% until Sep 30, 1.71% from Oct 1).
  if (name === 'Boone') {
    j.rates = [
      { from: Y2026, resident: '1.7', nonresident: '1.7' },
      { from: '2026-10-01', resident: '1.71', nonresident: '1.71' },
    ];
  }
  return j;
}

export const LOCAL_JURISDICTIONS: LocalJurisdiction[] = [
  // ---- Alabama (occupational tax on work done in the place; gross wages) ----
  place('AL', 'Auburn', '1', '1'),
  place('AL', 'Bessemer', '1', '1'),
  place('AL', 'Birmingham', '1', '1'),
  place('AL', 'Gadsden', '2', '2'),
  place('AL', 'Macon County', '1', '1'),
  place('AL', 'Opelika', '1', '1'),
  manual('AL', 'Tuskegee', "The app has no confirmed rate for Tuskegee (the city's form and the state survey differ). Enter the percent the city gives you."),

  // ---- Colorado (occupational privilege tax: a flat amount a month, not a percent) ----
  manual('CO', 'Denver', 'Denver takes a flat $5.75 a month from each employee who earns $500 or more there in the month. Enter the amount to take from a paycheck, and take it once a month.'),
  manual('CO', 'Glendale', 'Glendale takes a flat $5.00 a month from each employee who earns more than $750 there in the month. Enter the amount to take from a paycheck, and take it once a month.'),
  manual('CO', 'Greenwood Village', 'Greenwood Village takes a flat $2.00 a month from each employee who earns $250 or more there in the month. Enter the amount to take from a paycheck, and take it once a month.'),
  manual('CO', 'Sheridan', 'Sheridan takes a flat $3.00 a month from each employee. Enter the amount to take from a paycheck, and take it once a month.'),

  // ---- Delaware ----
  place('DE', 'Wilmington', '1.25', '1.25'),

  // ---- Indiana (county income tax; the county the employee lived in on January 1) ----
  ...IN_COUNTIES.map(indianaCounty),

  // ---- Kentucky (occupational license tax; gross wages including 401(k) and cafeteria-plan amounts) ----
  place('KY', 'Bowling Green', '2', '2'),
  place('KY', 'Covington', '2.45', '2.45', { note: KY_CAP_NOTE }),
  place('KY', 'Florence', '2', '2', { note: KY_CAP_NOTE }),
  place('KY', 'Frankfort', '1.95', '1.95'),
  place('KY', 'Lexington-Fayette', '2.75', '2.25', { note: 'The resident rate includes the 0.5% Fayette County school tax.' }),
  place('KY', 'Louisville Metro', '2.2', '1.45', { note: 'The resident rate includes the 0.75% school boards tax.' }),
  place('KY', 'Owensboro', '1.78', '1.78'),
  place('KY', 'Paducah', '2', '2'),
  place('KY', 'Richmond', '2', '2'),

  // ---- Michigan (city income tax) ----
  place('MI', 'Detroit', '2.4', '1.2'),
  place('MI', 'Grand Rapids', '1.5', '0.75'),
  place('MI', 'Highland Park', '2', '1'),
  place('MI', 'Saginaw', '1.5', '0.75'),
  ...MI_STANDARD.map((name) => place('MI', name, '1', '0.5')),

  // ---- Missouri (earnings tax) ----
  place('MO', 'Kansas City', '1', '1'),
  place('MO', 'St. Louis', '1', '1'),

  // ---- New York ----
  { id: 'NY-NEW-YORK-CITY', state: 'NY', name: 'New York City', method: 'nyc', rates: [] },
  {
    id: 'NY-YONKERS',
    state: 'NY',
    name: 'Yonkers',
    rates: [
      {
        from: Y2026,
        resident: null,
        residentPercentOfStateTax: '16.75',
        nonresident: '0.5',
        nonresidentExclusions: [
          { upTo: 3999.99, exclusion: null },
          { upTo: 10000, exclusion: 3000 },
          { upTo: 20000, exclusion: 2000 },
          { upTo: 30000, exclusion: 1000 },
        ],
      },
    ],
  },

  // ---- Ohio (municipal income tax on Medicare-basis wages) ----
  ...OH_CITIES.map(([name, rate]) => place('OH', name, rate, rate, { note: OH_NOTE })),

  // ---- Pennsylvania ----
  place('PA', 'Allentown', '1.975', '1.28', { note: PA_NOTE }),
  place('PA', 'Erie', '1.65', '1.65', { note: PA_NOTE }),
  {
    id: 'PA-PHILADELPHIA',
    state: 'PA',
    name: 'Philadelphia',
    // The wage tax is on gross pay: 401(k) and cafeteria-plan amounts are taxed.
    base: 'gross',
    rates: [
      { from: '2025-07-01', resident: '3.74', nonresident: '3.43' },
      { from: '2026-07-01', resident: '3.735', nonresident: '3.425' },
    ],
    note: "Philadelphia's rate usually changes every July 1.",
  },
  place('PA', 'Pittsburgh', '3', '1', { note: PA_NOTE }),
  place('PA', 'Reading', '3.6', '1', { note: PA_NOTE }),
  place('PA', 'Scranton', '3.4', '1', { note: PA_NOTE }),
];
