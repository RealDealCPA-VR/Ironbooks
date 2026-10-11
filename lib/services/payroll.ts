/**
 * Payroll service.
 *
 * Employees + paychecks (with itemized paycheck lines). Every runPaycheck call posts
 * a balanced journal entry via postJournalEntry:
 *
 *   Dr  6500 Payroll Expense      grossPay
 *   Dr  6510/6500 Payroll Tax Exp employer taxes (employer FICA match + FUTA)
 *   Cr  2300 Payroll Liabilities  totalTaxes + totalDeductions + employer taxes
 *   Cr  1000 Checking             netPay
 *
 * Because grossPay = netPay + totalTaxes + totalDeductions (and employer taxes appear
 * on BOTH sides) the entry always balances. Employer taxes never reduce net pay.
 * postedEntryId is stamped on the paycheck row after posting.
 *
 * Payroll items (payroll-suite): any line may carry a payrollItemId; the item's
 * mapped expense/liability accounts then replace the hardcoded 6500/2300 for that
 * line (1000 Checking still pays the net). Pre-tax deduction items reduce the wage
 * base before computeWithholding; garnishment items are post-tax deductions with
 * their own liability account. Batch payroll lives in createPayRun/listPayRuns,
 * and unpaidTimeForPayroll + the [payroll:<id>] description tag link time entries
 * to paychecks (time_entries has no paycheck FK — see timeTracking.ts).
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  employees,
  journalEntries,
  paychecks,
  paycheckLines,
  payRuns,
  timeEntries,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry } from './posting';
import { maskForContext } from './access';
import {
  computeEmployerTaxes,
  computeWithholding,
  type FilingStatus,
} from '@/lib/services/payrollTax';
import { getPayrollItemsByIds, type PayrollItem } from './payrollItems';
import { sickVacationBalances } from './payrollReports';
import { PAYROLL_PAID_TAG, markTimeEntriesPaidInPayroll } from './timeTracking';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PayType = 'hourly' | 'salary' | 'commission';

export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  payType: PayType;
  payRate: string | number;
}

/** Fields that may be changed after an employee is created. Omitted fields are untouched. */
export interface UpdateEmployeeInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  payType?: PayType;
  payRate?: string | number;
  /** Pass a 9-digit SSN (with or without dashes) to set; null/'' clears it. */
  ssn?: string | null;
  /** W-4 payroll info: { filingStatus, dependents, extraWithholding, ... }. */
  w4?: Record<string, unknown> | null;
  /** Mailing address: { line1, line2, city, state, zip }. */
  address?: Record<string, unknown> | null;
  /** Deactivate (false) / reactivate (true). Inactive employees cannot be paid. */
  isActive?: boolean;
}

export interface PaycheckLineInput {
  kind: 'earning' | 'tax' | 'deduction' | 'employer_contribution';
  name: string;
  amount: string | number;
  /**
   * Optional payroll item (payrollItems service). When set, GL posting uses the
   * item's mapped expense/liability accounts instead of the hardcoded 6500/2300,
   * and PRE-TAX deduction items reduce the wage base before auto-withholding.
   * A deduction line pointing at a `garnishment` item is a post-tax deduction
   * credited to the garnishment's own liability account.
   */
  payrollItemId?: string | null;
}

export type EarningKind = 'regular' | 'overtime' | 'bonus' | 'commission';

/**
 * One itemized earning row. `amount` wins when provided; otherwise it is computed
 * as hours x rate (both must then be present). Hours/rate are embedded in the
 * persisted line name (paycheck_lines has only kind/name/amount columns).
 */
export interface EarningLineInput {
  kind: EarningKind;
  hours?: string | number | null;
  rate?: string | number | null;
  amount?: string | number | null;
  /** Optional earning payroll item — wages debit its mapped expense account. */
  payrollItemId?: string | null;
}

const EARNING_LABELS: Record<EarningKind, string> = {
  regular: 'Regular',
  overtime: 'Overtime',
  bonus: 'Bonus',
  commission: 'Commission',
};

export interface RunPaycheckInput {
  employeeId: string;
  payDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /**
   * Single-amount gross pay. IGNORED when `earnings` has at least one line
   * (gross then = sum of earning lines). Required when `earnings` is omitted/empty;
   * persists as one 'Gross Pay' earning line (legacy behavior).
   */
  grossPay?: string | number;
  /** Itemized earnings (regular / overtime / bonus / commission). Gross = sum. */
  earnings?: EarningLineInput[];
  /**
   * Itemized tax withholdings. When OMITTED (undefined), taxes are AUTO-COMPUTED via
   * computeWithholding using the employee's filing status and periodsPerYear. An explicit
   * empty array (`[]`) means "no taxes" and is respected (e.g. contractor / reimbursement).
   */
  taxes?: PaycheckLineInput[];
  /**
   * Itemized EMPLOYER payroll taxes (employer FICA match, FUTA). When OMITTED while
   * employee taxes are auto-computed, these are AUTO-COMPUTED too (employer SS match
   * 6.2%, employer Medicare 1.45%, FUTA 0.6% on the first $7,000 of YTD wages). An
   * explicit empty array means "no employer taxes". These never reduce net pay; they
   * post Dr Payroll Tax Expense / Cr Payroll Liabilities.
   */
  employerTaxes?: PaycheckLineInput[];
  /** Itemized deductions (e.g. 401k, health insurance). */
  deductions?: PaycheckLineInput[];
  /**
   * Filing status used for auto-computed taxes (default: 'single').
   * Ignored when taxes are explicitly supplied.
   */
  filingStatus?: FilingStatus;
  /**
   * Number of pay periods per year used for annualizing wages (default: 26 biweekly).
   * Ignored when taxes are explicitly supplied.
   */
  periodsPerYear?: number;
  /** Batch pay run this check belongs to (stamped on paychecks.pay_run_id). */
  payRunId?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helper: resolve account id by COA code, scoped to company
// ---------------------------------------------------------------------------

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function listEmployees(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const rows = await ctx.db
    .select()
    .from(employees)
    .where(eq(employees.companyId, ctx.companyId))
    .orderBy(employees.lastName, employees.firstName);

  // SSNs leave this service masked unless the caller may view sensitive payroll data.
  if (opts?.includeInactive) return maskForContext(ctx, rows);
  return maskForContext(ctx, rows.filter((e) => e.isActive));
}

/** One employee; the SSN is masked unless the caller may view sensitive payroll data. */
export async function getEmployee(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.id, id)));
  if (!row) throw notFound('Employee');
  return maskForContext(ctx, row);
}

export async function createEmployee(ctx: ServiceContext, input: CreateEmployeeInput) {
  if (!input.firstName?.trim()) throw validation('First name is required.');
  if (!input.lastName?.trim()) throw validation('Last name is required.');
  if (!input.payType) throw validation('Pay type is required.');
  const payRate = Money.of(input.payRate ?? 0);
  if (payRate.isNegative()) throw validation('Pay rate cannot be negative.');

  const [row] = await ctx.db
    .insert(employees)
    .values({
      companyId: ctx.companyId,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email: input.email?.trim() ?? null,
      payType: input.payType,
      payRate: toAmountString(payRate),
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'employee',
    entityId: row.id,
    newValues: row,
  });

  return row;
}

/** Mask an SSN for audit/API output: keep only the last 4 digits. */
function maskSsn(ssn: string | null | undefined): string | null {
  if (!ssn) return null;
  const digits = ssn.replace(/\D/g, '');
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : '***-**-****';
}

/**
 * Update employee master data (names, pay info, SSN, W-4, address) and
 * deactivate / reactivate via `isActive`. Only provided fields change.
 * SSN is stored normalized as XXX-XX-XXXX and is masked in the audit trail.
 */
export async function updateEmployee(
  ctx: ServiceContext,
  id: string,
  input: UpdateEmployeeInput,
) {
  const existing = await getEmployee(ctx, id);

  const updates: Partial<typeof employees.$inferInsert> = {};

  if (input.firstName !== undefined) {
    if (!input.firstName.trim()) throw validation('First name is required.');
    updates.firstName = input.firstName.trim();
  }
  if (input.lastName !== undefined) {
    if (!input.lastName.trim()) throw validation('Last name is required.');
    updates.lastName = input.lastName.trim();
  }
  if (input.email !== undefined) {
    updates.email = input.email?.trim() || null;
  }
  if (input.payType !== undefined) {
    if (!['hourly', 'salary', 'commission'].includes(input.payType)) {
      throw validation('Pay type must be hourly, salary, or commission.');
    }
    updates.payType = input.payType;
  }
  if (input.payRate !== undefined) {
    const rate = Money.of(input.payRate);
    if (rate.isNegative()) throw validation('Pay rate cannot be negative.');
    updates.payRate = toAmountString(rate);
  }
  if (input.ssn !== undefined) {
    if (input.ssn === null || input.ssn.trim() === '') {
      updates.ssn = null;
    } else {
      const digits = input.ssn.replace(/\D/g, '');
      if (digits.length !== 9) throw validation('SSN must contain exactly 9 digits.');
      updates.ssn = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    }
  }
  if (input.w4 !== undefined) updates.w4 = input.w4;
  if (input.address !== undefined) updates.address = input.address;
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  if (Object.keys(updates).length === 0) return existing; // already masked by getEmployee
  updates.updatedAt = new Date();

  const [row] = await ctx.db
    .update(employees)
    .set(updates)
    .where(and(eq(employees.id, id), eq(employees.companyId, ctx.companyId)))
    .returning();

  // Never write a raw SSN into the audit trail.
  const auditOld: Record<string, unknown> = {};
  const auditNew: Record<string, unknown> = {};
  for (const key of Object.keys(updates)) {
    if (key === 'updatedAt') continue;
    const oldVal = (existing as Record<string, unknown>)[key];
    const newVal = (updates as Record<string, unknown>)[key];
    auditOld[key] = key === 'ssn' ? maskSsn(oldVal as string | null) : oldVal;
    auditNew[key] = key === 'ssn' ? maskSsn(newVal as string | null) : newVal;
  }

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'employee',
    entityId: id,
    oldValues: auditOld,
    newValues: auditNew,
  });

  return maskForContext(ctx, row);
}

// ---------------------------------------------------------------------------
// Paychecks
// ---------------------------------------------------------------------------

export interface ListPaychecksOptions {
  employeeId?: string;
  /** Include voided paychecks (flagged `isVoid: true`). Default: excluded. */
  includeVoided?: boolean;
}

/**
 * List paychecks, newest pay date first. Voided paychecks (voided_at set or GL
 * entry no longer 'posted') are excluded by default; pass `includeVoided` to get
 * them flagged. Every non-void row carries calendar-year-to-date aggregates
 * (`ytdGross` / `ytdNet`) computed through that row's pay date.
 */
export async function listPaychecks(ctx: ServiceContext, opts?: ListPaychecksOptions) {
  const rows = await ctx.db
    .select({ paycheck: paychecks, jeStatus: journalEntries.status })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(eq(paychecks.companyId, ctx.companyId))
    .orderBy(desc(paychecks.payDate));

  const all = rows.map((r) => ({
    ...r.paycheck,
    isVoid:
      r.paycheck.voidedAt != null ||
      (r.paycheck.postedEntryId != null && r.jeStatus !== 'posted'),
  }));

  // Cumulative YTD per employee per UTC calendar year over NON-VOID checks,
  // ordered chronologically (pay date, then creation order for same-day checks).
  const live = all
    .filter((p) => !p.isVoid)
    .slice()
    .sort(
      (a, b) =>
        a.payDate.getTime() - b.payDate.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  const running = new Map<string, { gross: ReturnType<typeof Money.zero>; net: ReturnType<typeof Money.zero> }>();
  const ytdById = new Map<string, { gross: string; net: string }>();
  for (const p of live) {
    const key = `${p.employeeId}:${p.payDate.getUTCFullYear()}`;
    const prev = running.get(key) ?? { gross: Money.zero(), net: Money.zero() };
    const next = {
      gross: prev.gross.plus(Money.of(p.grossPay)),
      net: prev.net.plus(Money.of(p.netPay)),
    };
    running.set(key, next);
    ytdById.set(p.id, { gross: toAmountString(next.gross), net: toAmountString(next.net) });
  }

  let list = all.map((p) => ({
    ...p,
    ytdGross: ytdById.get(p.id)?.gross ?? null,
    ytdNet: ytdById.get(p.id)?.net ?? null,
  }));

  if (!opts?.includeVoided) list = list.filter((p) => !p.isVoid);
  if (opts?.employeeId) list = list.filter((p) => p.employeeId === opts.employeeId);
  return list;
}

/**
 * Void a paycheck: voids the underlying GL entry (which enforces the closed-period
 * and completed-reconciliation guards) and stamps paychecks.voided_at so the check
 * drops out of W-2 / 941 / pay-stub aggregations.
 */
export async function voidPaycheck(ctx: ServiceContext, paycheckId: string) {
  return inTransaction(ctx, async (tx) => {
    const [pc] = await tx.db
      .select()
      .from(paychecks)
      .where(and(eq(paychecks.id, paycheckId), eq(paychecks.companyId, tx.companyId)));
    if (!pc) throw notFound('Paycheck');
    if (pc.voidedAt) throw validation('Paycheck is already voided.');

    // Void the GL posting first — voidJournalEntry throws CONFLICT when a line was
    // cleared in a completed reconciliation and PERIOD_CLOSED for closed periods,
    // so a guarded failure leaves the paycheck untouched (same transaction).
    if (pc.postedEntryId) {
      await voidJournalEntry(tx, pc.postedEntryId);
    }

    const [updated] = await tx.db
      .update(paychecks)
      .set({ voidedAt: new Date() })
      .where(eq(paychecks.id, paycheckId))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'paycheck',
      entityId: paycheckId,
      oldValues: { voidedAt: null, postedEntryId: pc.postedEntryId },
      newValues: { voidedAt: updated.voidedAt },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Pay stub data (single check + calendar-YTD aggregates)
// ---------------------------------------------------------------------------

/** Strip the "(… hrs @ …)" detail suffix so YTD grouping matches across checks. */
function lineGroupName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '');
}

export interface PayStubLineWithYtd {
  kind: string;
  name: string;
  amount: string;
  /** Calendar-YTD total for this line (grouped by kind + base name) through the stub's pay date. */
  ytdAmount: string;
}

export interface PayStubData {
  paycheck: typeof paychecks.$inferSelect;
  employee: typeof employees.$inferSelect;
  lines: PayStubLineWithYtd[];
  ytd: { gross: string; taxes: string; deductions: string; net: string };
  /**
   * Current sick/vacation balances in hours (employees.accruals policy, derived by
   * payrollReports.sickVacationBalances). Null when the employee has no accrual policy.
   */
  accruals: { sickBalance: string; vacationBalance: string } | null;
}

/**
 * Load one paycheck with its lines plus year-to-date aggregates: all POSTED,
 * NON-VOID paychecks for the same employee in the same UTC calendar year with
 * payDate <= the stub's payDate (the stub itself included when non-void).
 */
export async function payStubData(ctx: ServiceContext, paycheckId: string): Promise<PayStubData> {
  const [pc] = await ctx.db
    .select()
    .from(paychecks)
    .where(and(eq(paychecks.id, paycheckId), eq(paychecks.companyId, ctx.companyId)));
  if (!pc) throw notFound('Paycheck');

  const employee = await getEmployee(ctx, pc.employeeId);

  const lines = await ctx.db
    .select()
    .from(paycheckLines)
    .where(eq(paycheckLines.paycheckId, paycheckId));

  const year = pc.payDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));

  const ytdChecks = await ctx.db
    .select({
      id: paychecks.id,
      grossPay: paychecks.grossPay,
      totalTaxes: paychecks.totalTaxes,
      totalDeductions: paychecks.totalDeductions,
      netPay: paychecks.netPay,
    })
    .from(paychecks)
    .innerJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        eq(paychecks.employeeId, pc.employeeId),
        eq(journalEntries.status, 'posted'),
        isNull(paychecks.voidedAt),
        gte(paychecks.payDate, yearStart),
        lte(paychecks.payDate, pc.payDate),
      ),
    );

  const ytdIds = ytdChecks.map((c) => c.id);
  const ytdLines = ytdIds.length
    ? await ctx.db
        .select()
        .from(paycheckLines)
        .where(inArray(paycheckLines.paycheckId, ytdIds))
    : [];

  const ytdByKey = new Map<string, ReturnType<typeof Money.zero>>();
  for (const l of ytdLines) {
    const key = `${l.kind}|${lineGroupName(l.name)}`;
    ytdByKey.set(key, (ytdByKey.get(key) ?? Money.zero()).plus(Money.of(l.amount)));
  }

  const sumCol = (col: 'grossPay' | 'totalTaxes' | 'totalDeductions' | 'netPay') =>
    toAmountString(ytdChecks.reduce((s, c) => s.plus(Money.of(c[col])), Money.zero()));

  // Sick/vacation balances (hours) — informational only; never block stub rendering.
  let accruals: PayStubData['accruals'] = null;
  try {
    const [balanceRow] = await sickVacationBalances(ctx, { employeeId: pc.employeeId });
    if (balanceRow?.hasPolicy) {
      accruals = {
        sickBalance: balanceRow.sick.balance,
        vacationBalance: balanceRow.vacation.balance,
      };
    }
  } catch {
    /* balances are an additive extra on the stub */
  }

  return {
    paycheck: pc,
    employee,
    lines: lines.map((l) => {
      const key = `${l.kind}|${lineGroupName(l.name)}`;
      // A voided stub's own lines are excluded from the YTD set — fall back to the
      // line's own amount so the stub still renders sensibly.
      const ytd = ytdByKey.get(key) ?? Money.of(l.amount);
      return { kind: l.kind, name: l.name, amount: l.amount, ytdAmount: toAmountString(ytd) };
    }),
    ytd: {
      gross: sumCol('grossPay'),
      taxes: sumCol('totalTaxes'),
      deductions: sumCol('totalDeductions'),
      net: sumCol('netPay'),
    },
    accruals,
  };
}

/**
 * Sum gross wages already paid to an employee in the given UTC calendar year
 * (paychecks whose GL entry is still posted; voided checks don't count toward the
 * SS / FUTA wage bases or the Additional Medicare threshold).
 */
async function ytdGrossPaid(
  ctx: ServiceContext,
  employeeId: string,
  payDate: Date,
): Promise<string> {
  const year = payDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd   = new Date(Date.UTC(year + 1, 0, 1));

  const rows = await ctx.db
    .select({ grossPay: paychecks.grossPay })
    .from(paychecks)
    .innerJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        eq(paychecks.employeeId, employeeId),
        eq(journalEntries.status, 'posted'),
        gte(paychecks.payDate, yearStart),
        lt(paychecks.payDate, yearEnd),
      ),
    );

  return toAmountString(rows.reduce((s, r) => s.plus(Money.of(r.grossPay)), Money.zero()));
}

export async function runPaycheck(ctx: ServiceContext, input: RunPaycheckInput) {
  // --- Validate employee ---
  const employee = await getEmployee(ctx, input.employeeId);
  if (!employee.isActive) throw validation('Cannot run paycheck for an inactive employee.');

  // --- Compute gross from itemized earnings (or the legacy single amount) ---
  const earningsInput = input.earnings ?? [];
  const earningLines: Array<{
    kind: 'earning';
    name: string;
    amount: string;
    payrollItemId: string | null;
  }> = [];
  let gross: ReturnType<typeof Money.zero>;

  if (earningsInput.length > 0) {
    let total = Money.zero();
    for (const e of earningsInput) {
      const label = EARNING_LABELS[e.kind];
      if (!label) throw validation(`Unknown earning kind "${e.kind}".`);
      const hours = e.hours != null && e.hours !== '' ? Money.of(e.hours) : null;
      const rate = e.rate != null && e.rate !== '' ? Money.of(e.rate) : null;
      if (hours?.isNegative()) throw validation(`Earning "${label}": hours cannot be negative.`);
      if (rate?.isNegative()) throw validation(`Earning "${label}": rate cannot be negative.`);

      let amount =
        e.amount != null && e.amount !== '' ? Money.round2(e.amount) : null;
      if (amount === null) {
        if (!hours || !rate) {
          throw validation(`Earning "${label}" needs an amount, or both hours and rate.`);
        }
        amount = Money.round2(hours.times(rate));
      }
      if (amount.isNegative()) throw validation(`Earning "${label}" cannot be negative.`);
      total = total.plus(amount);

      // hours x rate ride along in the name — paycheck_lines has only kind/name/amount.
      const name =
        hours && rate ? `${label} (${hours.toFixed(2)} hrs @ ${rate.toFixed(2)})` : label;
      earningLines.push({
        kind: 'earning',
        name,
        amount: toAmountString(amount),
        payrollItemId: e.payrollItemId ?? null,
      });
    }
    gross = Money.round2(total);
  } else {
    if (input.grossPay == null || input.grossPay === '') {
      throw validation('Provide grossPay or at least one earnings line.');
    }
    gross = Money.round2(input.grossPay);
    earningLines.push({
      kind: 'earning',
      name: 'Gross Pay',
      amount: toAmountString(gross),
      payrollItemId: null,
    });
  }

  if (gross.lessThanOrEqualTo(0)) throw validation('Gross pay must be greater than zero.');

  // --- Resolve payroll items referenced by any line (GL mapping + pre-tax flags) ---
  const deductionLines: PaycheckLineInput[] = input.deductions ?? [];
  const referencedItemIds = [
    ...earningLines.map((l) => l.payrollItemId),
    ...deductionLines.map((l) => l.payrollItemId),
    ...(input.taxes ?? []).map((l) => l.payrollItemId),
    ...(input.employerTaxes ?? []).map((l) => l.payrollItemId),
  ].filter((id): id is string => !!id);
  const itemMap = await getPayrollItemsByIds(ctx, referencedItemIds);

  const itemFor = (id: string | null | undefined): PayrollItem | null =>
    id ? itemMap.get(id) ?? null : null;

  // Kind sanity: a line may only reference an item of a compatible kind.
  for (const l of earningLines) {
    const item = itemFor(l.payrollItemId);
    if (item && item.kind !== 'earning') {
      throw validation(`Earning line "${l.name}" references a ${item.kind} payroll item.`);
    }
  }
  for (const t of input.taxes ?? []) {
    const item = itemFor(t.payrollItemId);
    if (item && item.kind !== 'tax') {
      throw validation(`Tax line "${t.name}" references a ${item.kind} payroll item.`);
    }
  }
  for (const d of deductionLines) {
    const item = itemFor(d.payrollItemId);
    if (item && item.kind !== 'deduction' && item.kind !== 'garnishment') {
      throw validation(`Deduction line "${d.name}" references a ${item.kind} payroll item.`);
    }
  }
  for (const t of input.employerTaxes ?? []) {
    const item = itemFor(t.payrollItemId);
    if (item && item.kind !== 'employer_contribution') {
      throw validation(`Employer tax line "${t.name}" references a ${item.kind} payroll item.`);
    }
  }

  // PRE-TAX deductions (item.pretax) reduce the wage base used for auto-withholding.
  // Garnishment items are always post-tax. Simplified model: pre-tax reduces both the
  // income-tax and FICA bases (Section 125-style).
  let pretaxTotal = Money.zero();
  for (const d of deductionLines) {
    const item = itemFor(d.payrollItemId);
    if (item?.pretax) pretaxTotal = pretaxTotal.plus(Money.of(d.amount));
  }
  const taxableGross = Money.round2(
    gross.minus(pretaxTotal).greaterThan(0) ? gross.minus(pretaxTotal) : Money.zero(),
  );

  // --- Auto-compute taxes only when the caller did not pass a taxes array at all.
  // An explicit empty array means "no taxes" (contractor/reimbursement) and is respected. ---
  const callerSuppliedTaxes = Array.isArray(input.taxes);
  const callerSuppliedEmployerTaxes = Array.isArray(input.employerTaxes);

  let taxLines: PaycheckLineInput[];
  let employerTaxLines: PaycheckLineInput[] | undefined;

  if (callerSuppliedTaxes) {
    taxLines = input.taxes!;
  } else {
    // Derive taxes automatically from the TAXABLE gross (gross minus pre-tax deductions)
    // using 2024 IRS tables. The SS wage base and Additional Medicare threshold are
    // applied against ACTUAL YTD wages (not an annualized projection of this period),
    // so bonuses and wage-base crossovers withhold correctly.
    const ytdGrossBefore = await ytdGrossPaid(ctx, input.employeeId, input.payDate);
    const withholding = computeWithholding({
      grossPerPeriod: taxableGross.toNumber(),
      periodsPerYear: input.periodsPerYear ?? 26,
      filingStatus: input.filingStatus ?? 'single',
      ytdGrossBefore,
    });
    taxLines = [
      { kind: 'tax' as const, name: 'Federal Income Tax', amount: withholding.federalIncomeTax },
      { kind: 'tax' as const, name: 'Social Security',    amount: withholding.socialSecurity },
      { kind: 'tax' as const, name: 'Medicare',            amount: withholding.medicare },
    ].filter((t) => parseFloat(t.amount) > 0);

    // Employer payroll taxes (employer FICA match + FUTA) — auto-computed alongside
    // the employee withholdings unless the caller supplied them explicitly below.
    if (!callerSuppliedEmployerTaxes) {
      const employer = computeEmployerTaxes({
        grossPerPeriod: taxableGross.toNumber(),
        ytdGrossBefore,
      });
      employerTaxLines = [
        { kind: 'employer_contribution' as const, name: 'Employer Social Security',     amount: employer.socialSecurity },
        { kind: 'employer_contribution' as const, name: 'Employer Medicare',            amount: employer.medicare },
        { kind: 'employer_contribution' as const, name: 'Federal Unemployment (FUTA)',  amount: employer.futa },
      ].filter((t) => parseFloat(t.amount) > 0);
    }
  }

  // Caller-supplied employer taxes always win; explicit [] means "no employer taxes".
  // When employee taxes were supplied explicitly and employerTaxes was omitted, no
  // employer taxes are auto-derived (the caller has taken over the tax math).
  employerTaxLines ??= callerSuppliedEmployerTaxes ? input.employerTaxes! : [];

  let totalEmployerTaxes = Money.zero();
  for (const t of employerTaxLines) {
    const amt = Money.of(t.amount);
    if (amt.isNegative()) throw validation(`Employer tax line "${t.name}" cannot be negative.`);
    totalEmployerTaxes = totalEmployerTaxes.plus(amt);
  }

  let totalTaxes = Money.zero();
  for (const t of taxLines) {
    const amt = Money.of(t.amount);
    if (amt.isNegative()) throw validation(`Tax line "${t.name}" cannot be negative.`);
    totalTaxes = totalTaxes.plus(amt);
  }

  let totalDeductions = Money.zero();
  for (const d of deductionLines) {
    const amt = Money.of(d.amount);
    if (amt.isNegative()) throw validation(`Deduction line "${d.name}" cannot be negative.`);
    totalDeductions = totalDeductions.plus(amt);
  }

  const netPay = Money.round2(gross.minus(totalTaxes).minus(totalDeductions));
  if (netPay.isNegative()) {
    throw validation('Net pay cannot be negative — taxes + deductions exceed gross pay.');
  }

  // --- Resolve GL accounts ---
  const payrollExpenseId = await accountIdByCode(ctx, '6500'); // Payroll Expense
  const payrollLiabId = await accountIdByCode(ctx, '2300');    // Payroll Liabilities
  const checkingId = await accountIdByCode(ctx, '1000');       // Checking

  // Employer payroll taxes post to 6510 Payroll Tax Expense when the company has one,
  // otherwise fall back to 6500 Payroll Expense (the default COA has no 6510).
  let payrollTaxExpenseId = payrollExpenseId;
  if (totalEmployerTaxes.greaterThan(0)) {
    try {
      payrollTaxExpenseId = await accountIdByCode(ctx, '6510');
    } catch {
      payrollTaxExpenseId = payrollExpenseId;
    }
  }

  // --- Persist in a single transaction ---
  return inTransaction(ctx, async (tx) => {
    // 1) Insert paycheck header.
    const [paycheck] = await tx.db
      .insert(paychecks)
      .values({
        companyId: tx.companyId,
        employeeId: input.employeeId,
        payDate: input.payDate,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        grossPay: toAmountString(gross),
        totalTaxes: toAmountString(totalTaxes),
        totalDeductions: toAmountString(totalDeductions),
        netPay: toAmountString(netPay),
        payRunId: input.payRunId ?? null,
        // postedEntryId set below
      })
      .returning();

    // 2) Insert paycheck lines (itemized earnings + taxes + deductions).
    //    Garnishment-item lines persist as kind 'deduction' (the ITEM's kind carries
    //    the garnishment semantics) so stubs / W-2 / YTD groupings keep working.
    const lineValues: Array<{
      paycheckId: string;
      kind: string;
      name: string;
      amount: string;
      payrollItemId: string | null;
    }> = [
      ...earningLines.map((e) => ({ paycheckId: paycheck.id, ...e })),
      ...taxLines.map((t) => ({
        paycheckId: paycheck.id,
        kind: 'tax' as const,
        name: t.name,
        amount: toAmountString(Money.of(t.amount)),
        payrollItemId: t.payrollItemId ?? null,
      })),
      ...deductionLines.map((d) => ({
        paycheckId: paycheck.id,
        kind: 'deduction' as const,
        name: d.name,
        amount: toAmountString(Money.of(d.amount)),
        payrollItemId: d.payrollItemId ?? null,
      })),
      ...employerTaxLines.map((t) => ({
        paycheckId: paycheck.id,
        kind: 'employer_contribution' as const,
        name: t.name,
        amount: toAmountString(Money.of(t.amount)),
        payrollItemId: t.payrollItemId ?? null,
      })),
    ];

    if (lineValues.length > 0) {
      await tx.db.insert(paycheckLines).values(lineValues);
    }

    // 3) Build and post the balanced journal entry. Each line posts to its payroll
    //    item's mapped account when set, otherwise to the legacy defaults:
    //
    //   Dr item.expense ?? 6500       = earning amounts (sum = grossPay)
    //   Dr item.expense ?? 6510/6500  = employer taxes               (only if > 0)
    //   Cr item.liability ?? 2300     = taxes + deductions           (only if > 0)
    //   Cr item.liability ?? 2300     = employer taxes               (only if > 0)
    //   Cr 1000 Checking              = netPay
    //
    // Proof: grossPay = netPay + totalTaxes + totalDeductions, and employer taxes
    // appear once as a debit and once as a credit  ✓
    const fullName = `${employee.firstName} ${employee.lastName}`;
    const payDateStr = input.payDate.toISOString().slice(0, 10);

    // Aggregate amounts per account (insertion-ordered) so multi-line checks stay compact.
    const sumInto = (map: Map<string, ReturnType<typeof Money.zero>>, key: string, amt: ReturnType<typeof Money.zero>) =>
      map.set(key, (map.get(key) ?? Money.zero()).plus(amt));

    const wageDebits = new Map<string, ReturnType<typeof Money.zero>>();
    for (const e of earningLines) {
      const item = itemFor(e.payrollItemId);
      sumInto(wageDebits, item?.expenseAccountId ?? payrollExpenseId, Money.of(e.amount));
    }

    const withholdingCredits = new Map<string, ReturnType<typeof Money.zero>>();
    for (const t of taxLines) {
      const item = itemFor(t.payrollItemId);
      sumInto(withholdingCredits, item?.liabilityAccountId ?? payrollLiabId, Money.of(t.amount));
    }
    for (const d of deductionLines) {
      const item = itemFor(d.payrollItemId);
      sumInto(withholdingCredits, item?.liabilityAccountId ?? payrollLiabId, Money.of(d.amount));
    }

    const employerDebits = new Map<string, ReturnType<typeof Money.zero>>();
    const employerCredits = new Map<string, ReturnType<typeof Money.zero>>();
    for (const t of employerTaxLines) {
      const item = itemFor(t.payrollItemId);
      const amt = Money.of(t.amount);
      sumInto(employerDebits, item?.expenseAccountId ?? payrollTaxExpenseId, amt);
      sumInto(employerCredits, item?.liabilityAccountId ?? payrollLiabId, amt);
    }

    const postingLines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }> = [];

    for (const [accountId, amt] of wageDebits) {
      if (amt.greaterThan(0)) {
        postingLines.push({
          accountId,
          debit: toAmountString(amt),
          memo: `Payroll — ${fullName} (${payDateStr})`,
        });
      }
    }

    for (const [accountId, amt] of withholdingCredits) {
      if (amt.greaterThan(0)) {
        postingLines.push({
          accountId,
          credit: toAmountString(amt),
          memo: `Taxes & deductions — ${fullName}`,
        });
      }
    }

    for (const [accountId, amt] of employerDebits) {
      if (amt.greaterThan(0)) {
        postingLines.push({
          accountId,
          debit: toAmountString(amt),
          memo: `Employer payroll taxes — ${fullName}`,
        });
      }
    }
    for (const [accountId, amt] of employerCredits) {
      if (amt.greaterThan(0)) {
        postingLines.push({
          accountId,
          credit: toAmountString(amt),
          memo: `Employer payroll taxes payable — ${fullName}`,
        });
      }
    }

    postingLines.push({
      accountId: checkingId,
      credit: toAmountString(netPay),
      memo: `Net pay — ${fullName}`,
    });

    const entry = await postJournalEntry(tx, {
      date: input.payDate,
      description: `Payroll — ${fullName}`,
      reference: paycheck.id.slice(0, 8),
      sourceRef: `paycheck:${paycheck.id}`,
      lines: postingLines,
    });

    // 4) Stamp postedEntryId.
    const [updated] = await tx.db
      .update(paychecks)
      .set({ postedEntryId: entry.id })
      .where(eq(paychecks.id, paycheck.id))
      .returning();

    // 5) Audit trail.
    await writeAudit(tx, {
      action: 'create',
      entityType: 'paycheck',
      entityId: paycheck.id,
      newValues: {
        employeeId: input.employeeId,
        payDate: input.payDate,
        grossPay: toAmountString(gross),
        netPay: toAmountString(netPay),
        postedEntryId: entry.id,
      },
    });

    return { ...updated, lines: lineValues };
  });
}

// ---------------------------------------------------------------------------
// Time -> payroll link
// ---------------------------------------------------------------------------

/**
 * Unbilled-to-payroll time entries for an employee within a pay period.
 *
 * NOTE on "approved": the app has no time-approval workflow column, so every
 * entry of the employee in the window that has NOT already been consumed by a
 * paycheck counts. Consumption is tracked via the `[payroll:<paycheckId>]` tag
 * in the entry description (time_entries has no paycheck FK — see
 * markTimeEntriesPaidInPayroll in timeTracking.ts). Billable-to-customer status
 * is independent: time can be both billed to a customer and paid to the employee.
 */
export async function unpaidTimeForPayroll(
  ctx: ServiceContext,
  opts: { employeeId: string; periodStart: Date; periodEnd: Date },
) {
  const rows = await ctx.db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.companyId, ctx.companyId),
        eq(timeEntries.employeeId, opts.employeeId),
        gte(timeEntries.date, opts.periodStart),
        lte(timeEntries.date, opts.periodEnd),
      ),
    )
    .orderBy(timeEntries.date);

  const entries = rows.filter((r) => !(r.description ?? '').includes(PAYROLL_PAID_TAG));
  const totalHours = entries.reduce((s, e) => s.plus(Money.of(e.hours)), Money.zero());
  return { entries, totalHours: totalHours.toFixed(2) };
}

// ---------------------------------------------------------------------------
// Pay runs (batch payroll)
// ---------------------------------------------------------------------------

export interface PayRunEmployeeInput {
  employeeId: string;
  /** Hours for hourly employees (default 80 ≈ biweekly full-time). Ignored when `amount` is set. */
  hours?: string | number | null;
  /** Override gross for this check (wins over hours x rate and the salary default). */
  amount?: string | number | null;
  /** Itemized deductions; lines may carry payrollItemId (pre-tax / garnishment / GL mapping). */
  deductions?: PaycheckLineInput[];
  /**
   * Time entries pulled into this check. Hours = sum of entry hours, paid at the
   * employee's pay rate (the hourly earning line). Entries are tagged
   * `[payroll:<paycheckId>]` after the check posts so they cannot be paid twice.
   */
  timeEntryIds?: string[];
}

export interface CreatePayRunInput {
  payDate: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  memo?: string | null;
  /** Pay periods per year used for salary defaults and withholding (default 26). */
  periodsPerYear?: number;
  employees: PayRunEmployeeInput[];
}

export interface PayRunEmployeeResult {
  employeeId: string;
  employeeName: string;
  ok: boolean;
  paycheckId?: string;
  grossPay?: string;
  netPay?: string;
  error?: string;
  /** Non-fatal issue (e.g. paycheck posted but time entries could not be marked). */
  warning?: string;
}

/**
 * Batch payroll: one pay_runs row + runPaycheck per selected employee.
 * Deliberately NOT all-or-nothing — each employee posts independently; failures
 * are recorded per employee and reported in `results` (QB-style "Create Paychecks"
 * behavior, so one bad record doesn't block the whole run).
 *
 * Defaults per employee when no override is given:
 *   hourly:     hours (input.hours, or pulled time, or 80) x payRate
 *   salary:     payRate / periodsPerYear (annual salary spread per period)
 *   commission: requires an explicit amount
 * Withholding uses the employee's W-4 filing status and is auto-computed.
 */
export async function createPayRun(ctx: ServiceContext, input: CreatePayRunInput) {
  if (!(input.payDate instanceof Date) || isNaN(input.payDate.getTime())) {
    throw validation('A valid pay date is required.');
  }
  if (!input.employees || input.employees.length === 0) {
    throw validation('Select at least one employee for the pay run.');
  }
  const seen = new Set<string>();
  for (const e of input.employees) {
    if (seen.has(e.employeeId)) {
      throw validation('Each employee may appear only once per pay run.');
    }
    seen.add(e.employeeId);
  }
  const periodsPerYear = input.periodsPerYear ?? 26;

  // Header row first; per-employee checks attach via paychecks.pay_run_id.
  const [run] = await ctx.db
    .insert(payRuns)
    .values({
      companyId: ctx.companyId,
      payDate: input.payDate,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      memo: input.memo?.trim() || null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'pay_run',
    entityId: run.id,
    newValues: { payDate: input.payDate, employees: input.employees.length },
  });

  const results: PayRunEmployeeResult[] = [];

  for (const empInput of input.employees) {
    let employeeName = empInput.employeeId;
    try {
      const employee = await getEmployee(ctx, empInput.employeeId);
      employeeName = `${employee.firstName} ${employee.lastName}`;

      // --- Pulled time entries: validate ownership + unpaid, sum hours ---
      let timeHours: ReturnType<typeof Money.zero> | null = null;
      const timeEntryIds = [...new Set(empInput.timeEntryIds ?? [])];
      if (timeEntryIds.length > 0) {
        const rows = await ctx.db
          .select()
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.companyId, ctx.companyId),
              inArray(timeEntries.id, timeEntryIds),
            ),
          );
        if (rows.length !== timeEntryIds.length) throw notFound('Time entry');
        for (const r of rows) {
          if (r.employeeId !== employee.id) {
            throw validation('Time entry belongs to a different employee.');
          }
          if ((r.description ?? '').includes(PAYROLL_PAID_TAG)) {
            throw validation('Time entry was already paid on a previous paycheck.');
          }
        }
        timeHours = rows.reduce((s, r) => s.plus(Money.of(r.hours)), Money.zero());
      }

      // --- Default earnings ---
      const earnings: EarningLineInput[] = [];
      if (empInput.amount != null && empInput.amount !== '') {
        earnings.push({ kind: 'regular', amount: empInput.amount });
      } else if (employee.payType === 'hourly' || timeHours !== null) {
        const hours =
          timeHours ??
          (empInput.hours != null && empInput.hours !== ''
            ? Money.of(empInput.hours)
            : Money.of(80));
        earnings.push({
          kind: 'regular',
          hours: hours.toFixed(2),
          rate: employee.payRate,
        });
      } else if (employee.payType === 'salary') {
        const perPeriod = Money.round2(Money.div(employee.payRate, periodsPerYear));
        earnings.push({ kind: 'regular', amount: toAmountString(perPeriod) });
      } else {
        throw validation('Commission employees need an explicit amount.');
      }

      const w4 = (employee.w4 ?? {}) as { filingStatus?: string };
      const filingStatus: FilingStatus = w4.filingStatus === 'married' ? 'married' : 'single';

      const paycheck = await runPaycheck(ctx, {
        employeeId: employee.id,
        payDate: input.payDate,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        earnings,
        deductions: empInput.deductions ?? [],
        filingStatus,
        periodsPerYear,
        payRunId: run.id,
      });

      const result: PayRunEmployeeResult = {
        employeeId: employee.id,
        employeeName,
        ok: true,
        paycheckId: paycheck.id,
        grossPay: paycheck.grossPay,
        netPay: paycheck.netPay,
      };

      // Tag pulled time entries AFTER the check posts. The paycheck is already
      // committed, so a marking failure is surfaced as a warning, not a rollback.
      if (timeEntryIds.length > 0) {
        try {
          await markTimeEntriesPaidInPayroll(ctx, timeEntryIds, paycheck.id);
        } catch (err) {
          result.warning = `Paycheck posted, but time entries could not be marked: ${
            err instanceof Error ? err.message : 'unknown error'
          }`;
        }
      }

      results.push(result);
    } catch (err) {
      results.push({
        employeeId: empInput.employeeId,
        employeeName,
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return { payRun: run, results };
}

export interface PayRunPaycheckSummary {
  id: string;
  employeeId: string;
  employeeName: string;
  grossPay: string;
  netPay: string;
  isVoid: boolean;
}

export interface PayRunSummary {
  id: string;
  payDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  memo: string | null;
  createdAt: Date;
  paychecks: PayRunPaycheckSummary[];
  /** Totals over NON-VOID paychecks in the run. */
  totalGross: string;
  totalNet: string;
}

/** Past pay runs, newest first, each with its paychecks (voided ones flagged). */
export async function listPayRuns(ctx: ServiceContext): Promise<PayRunSummary[]> {
  const runs = await ctx.db
    .select()
    .from(payRuns)
    .where(eq(payRuns.companyId, ctx.companyId))
    .orderBy(desc(payRuns.payDate), desc(payRuns.createdAt));

  const checks = await ctx.db
    .select({
      paycheck: paychecks,
      jeStatus: journalEntries.status,
      firstName: employees.firstName,
      lastName: employees.lastName,
    })
    .from(paychecks)
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(and(eq(paychecks.companyId, ctx.companyId), isNotNull(paychecks.payRunId)))
    .orderBy(employees.lastName, employees.firstName);

  const byRun = new Map<string, PayRunPaycheckSummary[]>();
  for (const c of checks) {
    const runId = c.paycheck.payRunId!;
    const list = byRun.get(runId) ?? [];
    list.push({
      id: c.paycheck.id,
      employeeId: c.paycheck.employeeId,
      employeeName: `${c.firstName} ${c.lastName}`,
      grossPay: c.paycheck.grossPay,
      netPay: c.paycheck.netPay,
      isVoid:
        c.paycheck.voidedAt != null ||
        (c.paycheck.postedEntryId != null && c.jeStatus !== 'posted'),
    });
    byRun.set(runId, list);
  }

  return runs.map((r) => {
    const pcs = byRun.get(r.id) ?? [];
    const live = pcs.filter((p) => !p.isVoid);
    return {
      id: r.id,
      payDate: r.payDate,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      memo: r.memo,
      createdAt: r.createdAt,
      paychecks: pcs,
      totalGross: toAmountString(
        live.reduce((s, p) => s.plus(Money.of(p.grossPay)), Money.zero()),
      ),
      totalNet: toAmountString(live.reduce((s, p) => s.plus(Money.of(p.netPay)), Money.zero())),
    };
  });
}
