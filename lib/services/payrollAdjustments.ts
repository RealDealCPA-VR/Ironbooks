/**
 * Payroll adjustments + employer state tax setup (wave 2, after-the-fact payroll).
 *
 *  - Mid-year YTD setup (QB "Set Up YTD Amounts"): historical paychecks or per-quarter YTD
 *    summaries per employee, stored as paychecks rows with entryType 'ytd_adjustment' and their
 *    itemized paycheck_lines. They count in W-2 / W-3 / 941 / 940, pay-stub YTD, payroll reports
 *    and the wage-base limits (SS, FUTA, SUI, SDI, Additional Medicare) — see
 *    paycheckCountsCondition in payroll.ts.
 *      affectsAccounts = false (DEFAULT): no GL entry. Use this after a General Ledger import,
 *        which already brought the wages/taxes into the books (posting again would double
 *        count). The rows are excluded from the Payroll Liability Balances report for the
 *        same reason.
 *      affectsAccounts = true: posts a balanced entry exactly like a paycheck
 *        (Dr wages/employer-tax expense, Cr liabilities, Cr bank for net pay).
 *
 *  - Adjust Payroll Liabilities (QB "Adjust Payroll Liabilities"): entryType
 *    'liability_adjustment', signed tax / deduction / employer lines (negative = decrease),
 *    gross and net 0. Optionally posts: Cr (Dr when negative) the item's liability account,
 *    offset to an expense account (default Payroll Tax Expense 6510, else 6500).
 *
 *  - Employer state payroll taxes: per company/state/year SUI employer rate + wage base and
 *    SDI employee rate + wage base (payroll_state_settings). runPaycheck auto-computes
 *    "State Unemployment (XX)" (employer) and "State Disability (XX)" (employee) lines from it.
 *
 *  - Workers' compensation class codes with a rate per $100 of wages; an employee's default
 *    code makes runPaycheck accrue "Workers Compensation (CODE)" as an employer liability.
 *
 * Adjustments are never edited in place: "edit" = void the old row (its GL entry is voided
 * through voidJournalEntry, which enforces closed periods and completed reconciliations) and
 * enter a new one, so the audit trail keeps both.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  accounts,
  employees,
  journalEntries,
  paycheckLines,
  paychecks,
  payrollStateSettings,
  workersCompCodes,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { getEmployee } from './payroll';
import { getPayrollItemsByIds, type PayrollItem } from './payrollItems';

type Dec = ReturnType<typeof Money.zero>;

export type AdjustmentLineKind = 'earning' | 'tax' | 'deduction' | 'employer_contribution';

export interface AdjustmentLineInput {
  kind: AdjustmentLineKind;
  name: string;
  amount: string | number;
  payrollItemId?: string | null;
}

export interface YtdAdjustmentInput {
  employeeId: string;
  /** Pay date (or the last day of the quarter for a quarterly summary). */
  date: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  memo?: string | null;
  lines: AdjustmentLineInput[];
  /** Post to the GL (default false — the GL import already holds these amounts). */
  affectsAccounts?: boolean;
  /** Account credited with net pay when affectsAccounts (default 1000 Checking). */
  bankAccountId?: string | null;
}

export interface LiabilityAdjustmentInput {
  employeeId: string;
  date: Date;
  memo?: string | null;
  /** Signed amounts: positive increases what is owed, negative decreases it. */
  lines: Array<Omit<AdjustmentLineInput, 'kind'> & { kind: Exclude<AdjustmentLineKind, 'earning'> }>;
  affectsAccounts?: boolean;
  /** Expense account offsetting the liability change (default 6510, else 6500). */
  offsetAccountId?: string | null;
}

const KINDS: AdjustmentLineKind[] = ['earning', 'tax', 'deduction', 'employer_contribution'];

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return row?.id ?? null;
}

async function requireAccount(ctx: ServiceContext, id: string, label: string) {
  const [row] = await ctx.db
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
  if (!row) throw notFound(label);
  return row.id;
}

function validDate(d: unknown, label: string): Date {
  if (!(d instanceof Date) || isNaN(d.getTime())) throw validation(`${label} is required.`);
  return d;
}

async function resolveItems(ctx: ServiceContext, lines: AdjustmentLineInput[]) {
  const ids = lines.map((l) => l.payrollItemId).filter((x): x is string => !!x);
  const map = await getPayrollItemsByIds(ctx, ids);
  for (const l of lines) {
    if (!KINDS.includes(l.kind)) throw validation(`Unknown line kind "${l.kind}".`);
    if (!l.name?.trim()) throw validation('Every line needs a payroll item name.');
    const item = l.payrollItemId ? map.get(l.payrollItemId) : null;
    if (l.payrollItemId && !item) throw notFound('Payroll item');
    if (item) {
      const ok =
        item.kind === l.kind || (l.kind === 'deduction' && item.kind === 'garnishment');
      if (!ok) throw validation(`Line "${l.name}" uses a ${item.kind} payroll item.`);
    }
  }
  return (id: string | null | undefined): PayrollItem | null => (id ? map.get(id) ?? null : null);
}

/** Sum of signed amounts per account → balanced posting lines (zero nets dropped). */
function netLines(map: Map<string, Dec>, memo: string): PostingLine[] {
  const out: PostingLine[] = [];
  for (const [accountId, amt] of map) {
    const a = Money.round2(amt);
    if (a.isZero()) continue;
    out.push({
      accountId,
      debit: a.isPositive() ? toAmountString(a) : null,
      credit: a.isNegative() ? toAmountString(a.negated()) : null,
      memo,
    });
  }
  return out;
}

const add = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? Money.zero()).plus(v));

// ---------------------------------------------------------------------------
// YTD adjustments (mid-year setup)
// ---------------------------------------------------------------------------

/**
 * Enter historical payroll for an employee (one historical paycheck, or a quarter's summary).
 * Gross = earnings; net = gross − taxes − deductions (must not be negative).
 */
export async function createYtdAdjustment(ctx: ServiceContext, input: YtdAdjustmentInput) {
  const employee = await getEmployee(ctx, input.employeeId);
  const date = validDate(input.date, 'Date');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Enter at least one amount.');
  }
  const itemFor = await resolveItems(ctx, input.lines);

  const totals: Record<AdjustmentLineKind, Dec> = {
    earning: Money.zero(),
    tax: Money.zero(),
    deduction: Money.zero(),
    employer_contribution: Money.zero(),
  };
  const rows = input.lines.map((l) => {
    const amt = Money.round2(l.amount);
    if (amt.isNegative()) {
      throw validation(`"${l.name}" cannot be negative in a YTD entry. Use Adjust Liabilities to reduce amounts.`);
    }
    totals[l.kind] = totals[l.kind].plus(amt);
    return { kind: l.kind, name: l.name.trim(), amount: toAmountString(amt), payrollItemId: l.payrollItemId ?? null };
  });
  const gross = totals.earning;
  const net = gross.minus(totals.tax).minus(totals.deduction);
  if (net.isNegative()) throw validation('Taxes and deductions are more than the gross pay.');

  // GL accounts (only when posting).
  let posting: PostingLine[] | null = null;
  if (input.affectsAccounts) {
    const expense = await accountIdByCode(ctx, '6500');
    const liab = await accountIdByCode(ctx, '2300');
    const bank = input.bankAccountId
      ? await requireAccount(ctx, input.bankAccountId, 'Bank account')
      : await accountIdByCode(ctx, '1000');
    if (!expense || !liab || !bank) {
      throw validation('Posting needs accounts 6500 Payroll Expense, 2300 Payroll Liabilities and a bank account.');
    }
    const taxExpense = (await accountIdByCode(ctx, '6510')) ?? expense;
    const m = new Map<string, Dec>();
    for (const r of rows) {
      const item = itemFor(r.payrollItemId);
      const a = Money.of(r.amount);
      if (r.kind === 'earning') add(m, item?.expenseAccountId ?? expense, a);
      else if (r.kind === 'employer_contribution') {
        add(m, item?.expenseAccountId ?? taxExpense, a);
        add(m, item?.liabilityAccountId ?? liab, a.negated());
      } else add(m, item?.liabilityAccountId ?? liab, a.negated());
    }
    add(m, bank, net.negated());
    posting = netLines(m, `YTD payroll — ${employee.firstName} ${employee.lastName}`);
  }

  return inTransaction(ctx, async (tx) => {
    const [pc] = await tx.db
      .insert(paychecks)
      .values({
        companyId: tx.companyId,
        employeeId: employee.id,
        payDate: date,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        grossPay: toAmountString(gross),
        totalTaxes: toAmountString(totals.tax),
        totalDeductions: toAmountString(totals.deduction),
        netPay: toAmountString(net),
        entryType: 'ytd_adjustment',
        memo: input.memo?.trim() || null,
      })
      .returning();
    await tx.db.insert(paycheckLines).values(rows.map((r) => ({ ...r, paycheckId: pc.id })));

    let postedEntryId: string | null = null;
    if (posting && posting.length >= 2) {
      const entry = await postJournalEntry(tx, {
        date,
        description: `YTD payroll adjustment — ${employee.firstName} ${employee.lastName}`,
        reference: pc.id.slice(0, 8),
        sourceRef: `paycheck:${pc.id}`,
        lines: posting,
      });
      postedEntryId = entry.id;
      await tx.db.update(paychecks).set({ postedEntryId }).where(eq(paychecks.id, pc.id));
    }

    await writeAudit(tx, {
      action: 'create',
      entityType: 'payroll_ytd_adjustment',
      entityId: pc.id,
      newValues: {
        employeeId: employee.id,
        date,
        grossPay: toAmountString(gross),
        netPay: toAmountString(net),
        affectsAccounts: !!input.affectsAccounts,
        postedEntryId,
        lines: rows,
      },
    });
    return { ...pc, postedEntryId, lines: rows };
  });
}

// ---------------------------------------------------------------------------
// Liability adjustments
// ---------------------------------------------------------------------------

/** Adjust payroll liabilities for an employee (signed tax / deduction / employer lines). */
export async function createLiabilityAdjustment(ctx: ServiceContext, input: LiabilityAdjustmentInput) {
  const employee = await getEmployee(ctx, input.employeeId);
  const date = validDate(input.date, 'Date');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Enter at least one adjustment line.');
  }
  for (const l of input.lines) {
    if ((l.kind as string) === 'earning') throw validation('Liability adjustments cannot include wages.');
  }
  const itemFor = await resolveItems(ctx, input.lines);

  let taxes = Money.zero();
  let deductions = Money.zero();
  const rows = input.lines.map((l) => {
    const amt = Money.round2(l.amount);
    if (amt.isZero()) throw validation(`"${l.name}" has no amount.`);
    if (l.kind === 'tax') taxes = taxes.plus(amt);
    if (l.kind === 'deduction') deductions = deductions.plus(amt);
    return { kind: l.kind, name: l.name.trim(), amount: toAmountString(amt), payrollItemId: l.payrollItemId ?? null };
  });

  let posting: PostingLine[] | null = null;
  if (input.affectsAccounts) {
    const liab = await accountIdByCode(ctx, '2300');
    if (!liab) throw validation('Posting needs account 2300 Payroll Liabilities.');
    const offset = input.offsetAccountId
      ? await requireAccount(ctx, input.offsetAccountId, 'Offset account')
      : (await accountIdByCode(ctx, '6510')) ?? (await accountIdByCode(ctx, '6500'));
    if (!offset) throw validation('Choose the expense account that offsets this adjustment.');
    const m = new Map<string, Dec>();
    for (const r of rows) {
      const item = itemFor(r.payrollItemId);
      const a = Money.of(r.amount);
      add(m, item?.liabilityAccountId ?? liab, a.negated()); // + amount → credit liability
      add(m, offset, a);
    }
    posting = netLines(m, `Payroll liability adjustment — ${employee.firstName} ${employee.lastName}`);
  }

  return inTransaction(ctx, async (tx) => {
    const [pc] = await tx.db
      .insert(paychecks)
      .values({
        companyId: tx.companyId,
        employeeId: employee.id,
        payDate: date,
        grossPay: '0.00',
        totalTaxes: toAmountString(taxes),
        totalDeductions: toAmountString(deductions),
        netPay: '0.00',
        entryType: 'liability_adjustment',
        memo: input.memo?.trim() || null,
      })
      .returning();
    await tx.db.insert(paycheckLines).values(rows.map((r) => ({ ...r, paycheckId: pc.id })));

    let postedEntryId: string | null = null;
    if (posting && posting.length >= 2) {
      const entry = await postJournalEntry(tx, {
        date,
        description: `Payroll liability adjustment — ${employee.firstName} ${employee.lastName}`,
        reference: pc.id.slice(0, 8),
        sourceRef: `paycheck:${pc.id}`,
        lines: posting,
      });
      postedEntryId = entry.id;
      await tx.db.update(paychecks).set({ postedEntryId }).where(eq(paychecks.id, pc.id));
    }

    await writeAudit(tx, {
      action: 'create',
      entityType: 'payroll_liability_adjustment',
      entityId: pc.id,
      newValues: { employeeId: employee.id, date, affectsAccounts: !!input.affectsAccounts, postedEntryId, lines: rows },
    });
    return { ...pc, postedEntryId, lines: rows };
  });
}

/** YTD + liability adjustments (newest first), optionally for one employee. */
export async function listPayrollAdjustments(
  ctx: ServiceContext,
  opts: { employeeId?: string; includeVoided?: boolean } = {},
) {
  const conds = [eq(paychecks.companyId, ctx.companyId), ne(paychecks.entryType, 'paycheck')];
  if (opts.employeeId) conds.push(eq(paychecks.employeeId, opts.employeeId));
  const rows = await ctx.db
    .select({ pc: paychecks, first: employees.firstName, last: employees.lastName, jeStatus: journalEntries.status })
    .from(paychecks)
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .leftJoin(journalEntries, eq(paychecks.postedEntryId, journalEntries.id))
    .where(and(...conds))
    .orderBy(desc(paychecks.payDate), desc(paychecks.createdAt));
  const ids = rows.map((r) => r.pc.id);
  const lines = ids.length
    ? await ctx.db.select().from(paycheckLines).where(inArray(paycheckLines.paycheckId, ids))
    : [];
  const byPc = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = byPc.get(l.paycheckId) ?? [];
    arr.push(l);
    byPc.set(l.paycheckId, arr);
  }
  return rows
    .map((r) => ({
      ...r.pc,
      employeeName: `${r.first} ${r.last}`,
      affectsAccounts: r.pc.postedEntryId != null,
      isVoid: r.pc.voidedAt != null || (r.pc.postedEntryId != null && r.jeStatus !== 'posted'),
      lines: (byPc.get(r.pc.id) ?? []).map((l) => ({ kind: l.kind, name: l.name, amount: l.amount, payrollItemId: l.payrollItemId })),
    }))
    .filter((r) => opts.includeVoided || !r.isVoid);
}

/** Void a YTD / liability adjustment (and its GL entry when it affected accounts). */
export async function voidPayrollAdjustment(ctx: ServiceContext, id: string) {
  return inTransaction(ctx, async (tx) => {
    const [pc] = await tx.db
      .select()
      .from(paychecks)
      .where(and(eq(paychecks.id, id), eq(paychecks.companyId, tx.companyId)));
    if (!pc || pc.entryType === 'paycheck') throw notFound('Payroll adjustment');
    if (pc.voidedAt) throw validation('This adjustment is already voided.');
    if (pc.postedEntryId) await voidJournalEntry(tx, pc.postedEntryId);
    const [updated] = await tx.db
      .update(paychecks)
      .set({ voidedAt: new Date() })
      .where(eq(paychecks.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'void',
      entityType: pc.entryType === 'ytd_adjustment' ? 'payroll_ytd_adjustment' : 'payroll_liability_adjustment',
      entityId: id,
      oldValues: { voidedAt: null, postedEntryId: pc.postedEntryId },
      newValues: { voidedAt: updated.voidedAt },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Employer state payroll tax settings (SUI / SDI)
// ---------------------------------------------------------------------------

export interface StateTaxSettingInput {
  state: string;
  year: number;
  /** Rates as FRACTIONS (0.034 = 3.4%). */
  suiRate?: string | number | null;
  suiWageBase?: string | number | null;
  sdiRate?: string | number | null;
  sdiWageBase?: string | number | null;
  accountNumber?: string | null;
}

export async function listStateTaxSettings(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(payrollStateSettings)
    .where(eq(payrollStateSettings.companyId, ctx.companyId))
    .orderBy(asc(payrollStateSettings.state), desc(payrollStateSettings.year));
}

function rateOf(v: string | number | null | undefined, label: string): string {
  const d = Money.of(v ?? 0);
  if (d.isNegative() || d.greaterThanOrEqualTo('0.25')) {
    throw validation(`${label} must be between 0% and 25%.`);
  }
  return d.toFixed(6);
}

function baseOf(v: string | number | null | undefined, label: string): string {
  const d = Money.round2(v ?? 0);
  if (d.isNegative()) throw validation(`${label} cannot be negative.`);
  return toAmountString(d);
}

/** Create or replace the settings for (state, year). */
export async function upsertStateTaxSetting(ctx: ServiceContext, input: StateTaxSettingInput) {
  const state = (input.state ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw validation('State must be a two-letter code.');
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    throw validation('Year must be a four-digit year.');
  }
  const values = {
    suiRate: rateOf(input.suiRate, 'Unemployment rate'),
    suiWageBase: baseOf(input.suiWageBase, 'Unemployment wage base'),
    sdiRate: rateOf(input.sdiRate, 'Disability rate'),
    sdiWageBase: baseOf(input.sdiWageBase, 'Disability wage base'),
    accountNumber: input.accountNumber?.trim() || null,
  };
  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(payrollStateSettings)
      .where(
        and(
          eq(payrollStateSettings.companyId, tx.companyId),
          eq(payrollStateSettings.state, state),
          eq(payrollStateSettings.year, input.year),
        ),
      );
    let row;
    if (existing) {
      [row] = await tx.db
        .update(payrollStateSettings)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(payrollStateSettings.id, existing.id))
        .returning();
    } else {
      [row] = await tx.db
        .insert(payrollStateSettings)
        .values({ companyId: tx.companyId, state, year: input.year, ...values })
        .returning();
    }
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'payroll_state_setting',
      entityId: row.id,
      oldValues: existing ?? undefined,
      newValues: row,
    });
    return row;
  });
}

export async function deleteStateTaxSetting(ctx: ServiceContext, id: string) {
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(payrollStateSettings)
      .where(and(eq(payrollStateSettings.id, id), eq(payrollStateSettings.companyId, tx.companyId)));
    if (!row) throw notFound('State tax setting');
    await tx.db.delete(payrollStateSettings).where(eq(payrollStateSettings.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'payroll_state_setting', entityId: id, oldValues: row });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Workers' compensation codes
// ---------------------------------------------------------------------------

export interface WorkersCompCodeInput {
  code: string;
  description?: string | null;
  /** Premium per $100 of wages. */
  ratePer100: string | number;
  isActive?: boolean;
}

export async function listWorkersCompCodes(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(workersCompCodes)
    .where(eq(workersCompCodes.companyId, ctx.companyId))
    .orderBy(asc(workersCompCodes.code));
}

function wcValues(input: Partial<WorkersCompCodeInput>) {
  const out: Partial<typeof workersCompCodes.$inferInsert> = {};
  if (input.code !== undefined) {
    const code = input.code.trim().toUpperCase();
    if (!code) throw validation('Class code is required.');
    if (code.length > 20) throw validation('Class code must be 20 characters or fewer.');
    out.code = code;
  }
  if (input.description !== undefined) out.description = input.description?.trim() || null;
  if (input.ratePer100 !== undefined) {
    const r = Money.of(input.ratePer100);
    if (r.isNegative() || r.greaterThan(100)) throw validation('Rate per $100 must be between 0 and 100.');
    out.ratePer100 = r.toFixed(4);
  }
  if (input.isActive !== undefined) out.isActive = input.isActive;
  return out;
}

export async function createWorkersCompCode(ctx: ServiceContext, input: WorkersCompCodeInput) {
  const v = wcValues(input);
  if (!v.code) throw validation('Class code is required.');
  if (v.ratePer100 === undefined) throw validation('Rate per $100 is required.');
  const [dup] = await ctx.db
    .select({ id: workersCompCodes.id })
    .from(workersCompCodes)
    .where(and(eq(workersCompCodes.companyId, ctx.companyId), eq(workersCompCodes.code, v.code)));
  if (dup) throw validation(`Class code ${v.code} already exists.`);
  const [row] = await ctx.db
    .insert(workersCompCodes)
    .values({ companyId: ctx.companyId, code: v.code, description: v.description ?? null, ratePer100: v.ratePer100 })
    .returning();
  await writeAudit(ctx, { action: 'create', entityType: 'workers_comp_code', entityId: row.id, newValues: row });
  return row;
}

export async function updateWorkersCompCode(ctx: ServiceContext, id: string, input: Partial<WorkersCompCodeInput>) {
  const [existing] = await ctx.db
    .select()
    .from(workersCompCodes)
    .where(and(eq(workersCompCodes.id, id), eq(workersCompCodes.companyId, ctx.companyId)));
  if (!existing) throw notFound('Workers comp code');
  const v = wcValues(input);
  if (v.code && v.code !== existing.code) {
    const [dup] = await ctx.db
      .select({ id: workersCompCodes.id })
      .from(workersCompCodes)
      .where(and(eq(workersCompCodes.companyId, ctx.companyId), eq(workersCompCodes.code, v.code)));
    if (dup) throw validation(`Class code ${v.code} already exists.`);
  }
  if (Object.keys(v).length === 0) return existing;
  const [row] = await ctx.db.update(workersCompCodes).set(v).where(eq(workersCompCodes.id, id)).returning();
  await writeAudit(ctx, { action: 'update', entityType: 'workers_comp_code', entityId: id, oldValues: existing, newValues: row });
  return row;
}

/** Set (or clear with null) an employee's default workers' comp class code. */
export async function assignWorkersCompCode(ctx: ServiceContext, employeeId: string, codeId: string | null) {
  const employee = await getEmployee(ctx, employeeId);
  if (codeId) {
    const [code] = await ctx.db
      .select({ id: workersCompCodes.id })
      .from(workersCompCodes)
      .where(and(eq(workersCompCodes.id, codeId), eq(workersCompCodes.companyId, ctx.companyId)));
    if (!code) throw notFound('Workers comp code');
  }
  await ctx.db
    .update(employees)
    .set({ workersCompCodeId: codeId, updatedAt: new Date() })
    .where(and(eq(employees.id, employeeId), eq(employees.companyId, ctx.companyId)));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'employee',
    entityId: employeeId,
    oldValues: { workersCompCodeId: employee.workersCompCodeId ?? null },
    newValues: { workersCompCodeId: codeId },
  });
  return { employeeId, workersCompCodeId: codeId };
}
