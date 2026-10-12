/**
 * Payroll item TAX TRACKING TYPES (QuickBooks Desktop "Tax tracking type").
 *
 * Every tax, deduction and employer line on a paycheck carries one of these codes
 * (paycheck_lines.tax_tracking, copied from payroll_items.tax_tracking or inferred from the
 * standard line name for legacy rows). The code — never the free-text line name — decides:
 *
 *  - which wage bases a deduction reduces:
 *      401(k) / 403(b) / 457(b) / SIMPLE elective deferrals reduce federal + state INCOME-TAX
 *      wages only; they stay subject to Social Security, Medicare, FUTA and (in most states)
 *      SUI/SDI.
 *      Section 125 cafeteria items (health/dental/vision premiums, FSA, HSA and dependent-care
 *      through the plan) reduce income-tax AND Social Security / Medicare / FUTA / SUI wages.
 *      Post-tax deductions and garnishments ('none') reduce nothing.
 *  - which W-2 box an amount lands in (Box 2/4/6/17, Box 10, Box 12 codes D/E/G/S/W/DD,
 *    Box 14), which 941 line (2, 3, 5a, 5c) and the 940 / state wage worksheet figures.
 *
 * Pure module (no database) so the UI can import the labels too.
 */
import { Money, toAmountString, type MoneyInput } from '@/lib/money';

/** Employee-paid taxes withheld from the check (kind 'tax'). */
export const EMPLOYEE_TAX_TRACKING = [
  'federal_withholding',
  'social_security',
  'medicare',
  'state_withholding',
  'sdi',
  'local_tax',
] as const;
export type EmployeeTaxTracking = (typeof EMPLOYEE_TAX_TRACKING)[number];

/** Employer-paid payroll taxes (kind 'employer_contribution'). */
export const EMPLOYER_TAX_TRACKING = [
  'employer_social_security',
  'employer_medicare',
  'futa',
  'sui',
  'workers_comp',
] as const;
export type EmployerTaxTracking = (typeof EMPLOYER_TAX_TRACKING)[number];

/** Employer contributions that are not taxes (kind 'employer_contribution'). */
export const EMPLOYER_CONTRIBUTION_TRACKING = [
  'employer_health',
  'employer_hsa',
  'employer_retirement',
  'other',
] as const;
export type EmployerContributionTracking = (typeof EMPLOYER_CONTRIBUTION_TRACKING)[number];

/** Deductions withheld from the check (kind 'deduction' / 'garnishment'). */
export const DEDUCTION_TRACKING = [
  'none',
  '401k',
  '403b',
  '457b',
  'simple_ira',
  'section125',
  'hsa',
  'dependent_care',
] as const;
export type DeductionTracking = (typeof DEDUCTION_TRACKING)[number];

export type TaxTracking =
  | EmployeeTaxTracking
  | EmployerTaxTracking
  | EmployerContributionTracking
  | DeductionTracking;

export const ALL_TAX_TRACKING: TaxTracking[] = [
  ...EMPLOYEE_TAX_TRACKING,
  ...EMPLOYER_TAX_TRACKING,
  ...EMPLOYER_CONTRIBUTION_TRACKING,
  ...DEDUCTION_TRACKING,
];

export const TAX_TRACKING_LABELS: Record<TaxTracking, string> = {
  federal_withholding: 'Federal income tax withholding',
  social_security: 'Social Security (employee)',
  medicare: 'Medicare (employee)',
  state_withholding: 'State income tax withholding',
  sdi: 'State disability (SDI)',
  local_tax: 'Local income tax',
  employer_social_security: 'Social Security (employer)',
  employer_medicare: 'Medicare (employer)',
  futa: 'Federal unemployment (FUTA)',
  sui: 'State unemployment (SUI)',
  workers_comp: "Workers' compensation",
  employer_health: 'Employer-paid health coverage (W-2 Box 12 DD)',
  employer_hsa: 'Employer HSA contribution (W-2 Box 12 W)',
  employer_retirement: 'Employer retirement match',
  other: 'Other (no tax effect)',
  none: 'After-tax deduction (reduces no wages)',
  '401k': '401(k) employee deferral (W-2 Box 12 D)',
  '403b': '403(b) employee deferral (W-2 Box 12 E)',
  '457b': '457(b) employee deferral (W-2 Box 12 G)',
  simple_ira: 'SIMPLE IRA deferral (W-2 Box 12 S)',
  section125: 'Section 125 cafeteria (health, dental, vision, FSA)',
  hsa: 'HSA through cafeteria plan (W-2 Box 12 W)',
  dependent_care: 'Dependent care FSA (W-2 Box 10)',
};

/** Which tracking codes are valid for an item / line kind. */
export function trackingChoicesFor(kind: string): readonly TaxTracking[] {
  switch (kind) {
    case 'tax':
      return EMPLOYEE_TAX_TRACKING;
    case 'employer_contribution':
      return [...EMPLOYER_TAX_TRACKING, ...EMPLOYER_CONTRIBUTION_TRACKING];
    case 'deduction':
      return DEDUCTION_TRACKING;
    case 'garnishment':
      return ['none'];
    default:
      return [];
  }
}

export function isTrackingValidForKind(kind: string, tracking: string): tracking is TaxTracking {
  return (trackingChoicesFor(kind) as readonly string[]).includes(tracking);
}

export function isEmployeeTaxTracking(t: string | null | undefined): t is EmployeeTaxTracking {
  return !!t && (EMPLOYEE_TAX_TRACKING as readonly string[]).includes(t);
}
export function isEmployerTaxTracking(t: string | null | undefined): t is EmployerTaxTracking {
  return !!t && (EMPLOYER_TAX_TRACKING as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Deduction treatment
// ---------------------------------------------------------------------------

export interface DeductionTreatment {
  /** Reduces federal (and state) income-tax wages — W-2 Box 1 / 16, 941 line 2. */
  reducesIncomeTaxWages: boolean;
  /** Reduces Social Security / Medicare / FUTA / SUI / SDI wages — W-2 Box 3 / 5, 941 5a/5c, 940. */
  reducesFicaWages: boolean;
  /** W-2 Box 12 code, if any. */
  w2Box12?: 'D' | 'E' | 'G' | 'S' | 'W';
  /** Reported in W-2 Box 10 (dependent care benefits). */
  w2Box10?: boolean;
  /** Shown in W-2 Box 14 (informational) with this label. */
  w2Box14?: string;
}

export const DEDUCTION_TREATMENT: Record<DeductionTracking, DeductionTreatment> = {
  none: { reducesIncomeTaxWages: false, reducesFicaWages: false },
  '401k': { reducesIncomeTaxWages: true, reducesFicaWages: false, w2Box12: 'D' },
  '403b': { reducesIncomeTaxWages: true, reducesFicaWages: false, w2Box12: 'E' },
  '457b': { reducesIncomeTaxWages: true, reducesFicaWages: false, w2Box12: 'G' },
  simple_ira: { reducesIncomeTaxWages: true, reducesFicaWages: false, w2Box12: 'S' },
  section125: { reducesIncomeTaxWages: true, reducesFicaWages: true, w2Box14: 'Sec 125' },
  hsa: { reducesIncomeTaxWages: true, reducesFicaWages: true, w2Box12: 'W' },
  dependent_care: { reducesIncomeTaxWages: true, reducesFicaWages: true, w2Box10: true },
};

export function deductionTreatment(tracking: string | null | undefined): DeductionTreatment {
  return (tracking && DEDUCTION_TREATMENT[tracking as DeductionTracking]) || DEDUCTION_TREATMENT.none;
}

/** True when the deduction tracking reduces income-tax wages (the legacy `pretax` flag). */
export function isPretaxTracking(tracking: string | null | undefined): boolean {
  return deductionTreatment(tracking).reducesIncomeTaxWages;
}

// ---------------------------------------------------------------------------
// Inference (legacy rows / items without an explicit tracking type)
// ---------------------------------------------------------------------------

/**
 * Default tracking for a DEDUCTION item from its name and legacy pre-tax flag.
 * Retirement deferrals are recognized by name; any other pre-tax deduction is treated as a
 * Section 125 cafeteria item; everything else is after-tax.
 */
export function inferDeductionTracking(name: string, pretax: boolean): DeductionTracking {
  const n = name.toLowerCase();
  if (/\b401\s*\(?k\)?|401k/.test(n)) return '401k';
  if (/\b403\s*\(?b\)?|403b/.test(n)) return '403b';
  if (/\b457\s*\(?b\)?|457b|\b457\b/.test(n)) return '457b';
  if (/simple\s*ira/.test(n)) return 'simple_ira';
  if (!pretax) return 'none';
  if (/\bhsa\b|health savings/.test(n)) return 'hsa';
  if (/dependent\s*care|\bdcap\b|\bdcfsa\b/.test(n)) return 'dependent_care';
  if (/retire|pension|deferred comp/.test(n)) return '401k';
  return 'section125';
}

/** Recognize an employee tax line by its name (legacy lines without a tracking code). */
export function inferEmployeeTaxTracking(name: string): EmployeeTaxTracking | null {
  const n = name.trim().toLowerCase();
  if (/federal\s+(income\s+tax|withholding|tax)|^fit$|^fwt$|^fitw$/.test(n)) return 'federal_withholding';
  if (/medicare|^med$|^mcare$/.test(n)) return 'medicare';
  if (/social\s+security|oasdi|^ss$|^soc\s*sec$/.test(n)) return 'social_security';
  if (/disab|\bsdi\b/.test(n)) return 'sdi';
  if (/unemploy|\bsui\b|\bsuta\b|workers/.test(n)) return null;
  if (/state|^sit$|^swt$/.test(n)) return 'state_withholding';
  if (/\blocal\b|\bcity\b|\bcounty\b|school district/.test(n)) return 'local_tax';
  return null;
}

/** Recognize an employer line by its name (legacy lines without a tracking code). */
export function inferEmployerTracking(name: string): EmployerTaxTracking | EmployerContributionTracking {
  const n = name.trim().toLowerCase();
  if (/futa|federal unemployment/.test(n)) return 'futa';
  if (/state unemployment|\bsuta?\b|\bsui\b/.test(n)) return 'sui';
  if (/workers/.test(n)) return 'workers_comp';
  if (/social security|oasdi/.test(n)) return 'employer_social_security';
  if (/medicare/.test(n)) return 'employer_medicare';
  if (/\bhsa\b|health savings/.test(n)) return 'employer_hsa';
  if (/health|medical|dental|vision/.test(n)) return 'employer_health';
  if (/401|403|457|match|retire|pension/.test(n)) return 'employer_retirement';
  return 'other';
}

/**
 * The tracking code of a stored paycheck line: the stamped code when present, otherwise
 * inferred from kind + name (rows written before tax tracking existed).
 */
export function lineTracking(line: {
  kind: string;
  name: string;
  taxTracking?: string | null;
}): TaxTracking | null {
  if (line.taxTracking) return line.taxTracking as TaxTracking;
  if (line.kind === 'tax') return inferEmployeeTaxTracking(line.name);
  if (line.kind === 'employer_contribution') return inferEmployerTracking(line.name);
  if (line.kind === 'deduction') return 'none';
  return null;
}

// ---------------------------------------------------------------------------
// Wage bases for one paycheck
// ---------------------------------------------------------------------------

type Dec = ReturnType<typeof Money.zero>;

export interface PaycheckWageBases {
  gross: Dec;
  /** Federal / state income-tax wages: gross − retirement deferrals − Section 125. */
  incomeTaxWages: Dec;
  /** Social Security / Medicare / FUTA / SUI wages (before wage-base caps): gross − Section 125. */
  ficaWages: Dec;
  /** Section 125 (cafeteria) amounts — exempt from FUTA (Form 940 line 4). */
  cafeteria: Dec;
  /** W-2 Box 12 amounts by code (D, E, G, S, W, DD). */
  box12: Map<string, Dec>;
  /** W-2 Box 10 dependent care benefits. */
  box10: Dec;
  /** W-2 Box 14 informational amounts by label. */
  box14: Map<string, Dec>;
}

/**
 * Compute the wage bases of one paycheck from its gross pay and lines. Bases never go below 0.
 */
export function paycheckWageBases(
  gross: MoneyInput,
  lines: Array<{ kind: string; name: string; amount: MoneyInput; taxTracking?: string | null }>,
): PaycheckWageBases {
  const g = Money.of(gross);
  let incomeReduce = Money.zero();
  let ficaReduce = Money.zero();
  let cafeteria = Money.zero();
  let box10 = Money.zero();
  const box12 = new Map<string, Dec>();
  const box14 = new Map<string, Dec>();
  const add = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? Money.zero()).plus(v));

  for (const l of lines) {
    const amt = Money.of(l.amount);
    if (l.kind === 'deduction') {
      const tr = deductionTreatment(lineTracking(l));
      if (tr.reducesIncomeTaxWages) incomeReduce = incomeReduce.plus(amt);
      if (tr.reducesFicaWages) {
        ficaReduce = ficaReduce.plus(amt);
        cafeteria = cafeteria.plus(amt);
      }
      if (tr.w2Box12) add(box12, tr.w2Box12, amt);
      if (tr.w2Box10) box10 = box10.plus(amt);
      if (tr.w2Box14) add(box14, tr.w2Box14, amt);
    } else if (l.kind === 'employer_contribution') {
      const t = lineTracking(l);
      if (t === 'employer_hsa') add(box12, 'W', amt);
      else if (t === 'employer_health') add(box12, 'DD', amt);
    }
  }
  const floor0 = (d: Dec) => (d.isNegative() ? Money.zero() : d);
  // Wage bases never exceed gross: a wage-less entry (a liability adjustment) moves no wages.
  const capped = (d: Dec) => (d.greaterThan(g) ? g : floor0(d));
  return {
    gross: g,
    incomeTaxWages: capped(g.minus(incomeReduce)),
    ficaWages: capped(g.minus(ficaReduce)),
    cafeteria: g.isZero() ? Money.zero() : cafeteria,
    box12,
    box10,
    box14,
  };
}

/** Sum a list of amounts by tracking code (convenience for reports). */
export function sumByTracking(
  lines: Array<{ kind: string; name: string; amount: MoneyInput; taxTracking?: string | null }>,
  tracking: TaxTracking,
  kind?: string,
): string {
  return toAmountString(
    lines
      .filter((l) => (!kind || l.kind === kind) && lineTracking(l) === tracking)
      .reduce((s, l) => s.plus(Money.of(l.amount)), Money.zero()),
  );
}
