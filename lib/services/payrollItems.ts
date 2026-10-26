/**
 * Payroll Items service — QB-style payroll item definitions with GL mapping.
 *
 * A payroll item describes ONE kind of pay component and where it posts:
 *
 *   kind                   GL effect on a paycheck
 *   ---------------------- -----------------------------------------------------
 *   earning                Dr expenseAccountId (wages)
 *   tax                    Cr liabilityAccountId (employee withholding payable)
 *   deduction              Cr liabilityAccountId (401k / health ins. payable)
 *   employer_contribution  Dr expenseAccountId + Cr liabilityAccountId
 *   garnishment            Cr liabilityAccountId (always POST-tax)
 *
 * `taxTracking` is QuickBooks' "tax tracking type" (lib/services/payrollTaxTracking.ts). For
 * deductions it decides which wage bases the item reduces: 401(k)/403(b)/457(b) deferrals
 * reduce income-tax wages only, Section 125 items reduce income-tax AND Social Security /
 * Medicare / FUTA wages, after-tax items reduce nothing. For taxes it tells the W-2 / 941 /
 * 940 which box the line belongs in. `pretax` is kept in sync (true = reduces income-tax
 * wages) for older callers. `calcBasis`/`defaultRate` are UI defaults: 'fixed' is a
 * flat amount per check, 'percent' is a % of gross.
 *
 * `ensureDefaultPayrollItems` seeds a sensible QB-like starter set per company on
 * first use (Salary, Hourly, Overtime, Federal WH, SS, Medicare, employer matches,
 * FUTA, 401(k), Health Insurance, Wage Garnishment) mapped to the default COA
 * codes 6500 (Payroll Expense), 6510 (Payroll Tax Expense, falls back to 6500)
 * and 2300 (Payroll Liabilities). Seeding is idempotent and skipped when the
 * company already has any payroll items.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Money } from '@/lib/money';
import { accounts, payrollItems } from '@/lib/db/schema';
import {
  inferDeductionTracking,
  inferEmployeeTaxTracking,
  inferEmployerTracking,
  isPretaxTracking,
  isTrackingValidForKind,
  TAX_TRACKING_LABELS,
  trackingChoicesFor,
  type TaxTracking,
} from './payrollTaxTracking';
import {
  type ServiceContext,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PayrollItemKind =
  | 'earning'
  | 'tax'
  | 'deduction'
  | 'employer_contribution'
  | 'garnishment';

export type PayrollCalcBasis = 'fixed' | 'percent';

export const PAYROLL_ITEM_KINDS: PayrollItemKind[] = [
  'earning',
  'tax',
  'deduction',
  'employer_contribution',
  'garnishment',
];

export interface CreatePayrollItemInput {
  name: string;
  kind: PayrollItemKind;
  /** Deductions only: reduce the wage base before withholding is computed. */
  pretax?: boolean;
  /** Tax tracking type (payrollTaxTracking.ts). Defaults from the name / pretax flag. */
  taxTracking?: string | null;
  expenseAccountId?: string | null;
  liabilityAccountId?: string | null;
  calcBasis?: PayrollCalcBasis | null;
  /** Fixed amount per check, or percent of gross, depending on calcBasis. */
  defaultRate?: string | number | null;
}

export interface UpdatePayrollItemInput {
  name?: string;
  pretax?: boolean;
  taxTracking?: string | null;
  expenseAccountId?: string | null;
  liabilityAccountId?: string | null;
  calcBasis?: PayrollCalcBasis | null;
  defaultRate?: string | number | null;
  isActive?: boolean;
}

export type PayrollItem = typeof payrollItems.$inferSelect;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function assertAccountInCompany(ctx: ServiceContext, accountId: string, label: string) {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!row) throw validation(`${label} account does not exist in this company.`);
}

function normalizeRate(rate: string | number | null | undefined): string | null {
  if (rate === null || rate === undefined || rate === '') return null;
  const r = Money.of(rate);
  if (r.isNegative()) throw validation('Default rate cannot be negative.');
  return r.toFixed(4);
}

/** Which GL sides a kind requires. */
function requiredSides(kind: PayrollItemKind): { expense: boolean; liability: boolean } {
  switch (kind) {
    case 'earning':
      return { expense: true, liability: false };
    case 'employer_contribution':
      return { expense: true, liability: true };
    case 'tax':
    case 'deduction':
    case 'garnishment':
      return { expense: false, liability: true };
  }
}

/**
 * Resolve the tax tracking type for an item: an explicit value must fit the kind; otherwise it
 * is inferred from the name (and the legacy pre-tax flag for deductions). Returns null for a
 * tax item whose name is not a recognized payroll tax.
 */
export function resolveItemTracking(
  kind: string,
  name: string,
  explicit: string | null | undefined,
  pretax: boolean,
): TaxTracking | null {
  if (explicit) {
    if (!isTrackingValidForKind(kind, explicit)) {
      const allowed = trackingChoicesFor(kind).map((t) => TAX_TRACKING_LABELS[t]).join('; ');
      throw validation(
        allowed
          ? `That tax tracking type doesn't fit a ${kind.replace('_', ' ')} item. Choose one of: ${allowed}.`
          : `A ${kind} item has no tax tracking type.`,
      );
    }
    return explicit;
  }
  switch (kind) {
    case 'deduction':
      return inferDeductionTracking(name, pretax);
    case 'garnishment':
      return 'none';
    case 'tax':
      return inferEmployeeTaxTracking(name);
    case 'employer_contribution':
      return inferEmployerTracking(name);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listPayrollItems(
  ctx: ServiceContext,
  opts?: { includeInactive?: boolean; kind?: PayrollItemKind },
) {
  const rows = await ctx.db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.companyId, ctx.companyId))
    .orderBy(asc(payrollItems.kind), asc(payrollItems.name));

  return rows.filter((r) => {
    if (!opts?.includeInactive && !r.isActive) return false;
    if (opts?.kind && r.kind !== opts.kind) return false;
    return true;
  });
}

export async function getPayrollItem(ctx: ServiceContext, id: string): Promise<PayrollItem> {
  const [row] = await ctx.db
    .select()
    .from(payrollItems)
    .where(and(eq(payrollItems.companyId, ctx.companyId), eq(payrollItems.id, id)));
  if (!row) throw notFound('Payroll item');
  return row;
}

/** Load several payroll items at once, scoped to the company. Throws when any id is missing. */
export async function getPayrollItemsByIds(
  ctx: ServiceContext,
  ids: string[],
): Promise<Map<string, PayrollItem>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await ctx.db
    .select()
    .from(payrollItems)
    .where(and(eq(payrollItems.companyId, ctx.companyId), inArray(payrollItems.id, unique)));
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    if (!map.has(id)) throw notFound('Payroll item');
  }
  return map;
}

export async function createPayrollItem(ctx: ServiceContext, input: CreatePayrollItemInput) {
  const name = input.name?.trim();
  if (!name) throw validation('Payroll item name is required.');
  if (!PAYROLL_ITEM_KINDS.includes(input.kind)) {
    throw validation(`Payroll item kind must be one of: ${PAYROLL_ITEM_KINDS.join(', ')}.`);
  }
  if (input.calcBasis != null && input.calcBasis !== 'fixed' && input.calcBasis !== 'percent') {
    throw validation("calcBasis must be 'fixed' or 'percent'.");
  }
  // Garnishments are post-tax by definition; pretax only makes sense on deductions.
  if (input.pretax && input.kind !== 'deduction') {
    throw validation('Only deductions can be pre-tax.');
  }
  const taxTracking = resolveItemTracking(input.kind, name, input.taxTracking, input.pretax ?? false);
  if (input.kind === 'tax' && !taxTracking) {
    throw validation(
      `Choose a tax tracking type for "${name}" (federal withholding, Social Security, Medicare, state withholding, SDI or local tax) so it lands on the right W-2 and 941 lines.`,
    );
  }
  const pretax = input.kind === 'deduction' ? isPretaxTracking(taxTracking) : false;

  const sides = requiredSides(input.kind);
  if (sides.expense && !input.expenseAccountId) {
    throw validation(`A ${input.kind.replace('_', ' ')} item requires an expense account.`);
  }
  if (sides.liability && !input.liabilityAccountId) {
    throw validation(`A ${input.kind.replace('_', ' ')} item requires a liability account.`);
  }
  if (input.expenseAccountId) await assertAccountInCompany(ctx, input.expenseAccountId, 'Expense');
  if (input.liabilityAccountId) {
    await assertAccountInCompany(ctx, input.liabilityAccountId, 'Liability');
  }

  // Unique name per company (case-insensitive) so item pickers stay unambiguous.
  const existing = await ctx.db
    .select({ id: payrollItems.id, name: payrollItems.name })
    .from(payrollItems)
    .where(eq(payrollItems.companyId, ctx.companyId));
  if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    throw validation(`A payroll item named "${name}" already exists.`);
  }

  const [row] = await ctx.db
    .insert(payrollItems)
    .values({
      companyId: ctx.companyId,
      name,
      kind: input.kind,
      pretax,
      taxTracking,
      expenseAccountId: input.expenseAccountId ?? null,
      liabilityAccountId: input.liabilityAccountId ?? null,
      calcBasis: input.calcBasis ?? null,
      defaultRate: normalizeRate(input.defaultRate),
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'payroll_item',
    entityId: row.id,
    newValues: row,
  });

  return row;
}

export async function updatePayrollItem(
  ctx: ServiceContext,
  id: string,
  input: UpdatePayrollItemInput,
) {
  const existing = await getPayrollItem(ctx, id);

  const updates: Partial<typeof payrollItems.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw validation('Payroll item name is required.');
    // Names stay unique per company (case-insensitive), as on create: pickers, paycheck lines and
    // liability payments find an item by its name.
    const others = await ctx.db
      .select({ id: payrollItems.id, name: payrollItems.name })
      .from(payrollItems)
      .where(eq(payrollItems.companyId, ctx.companyId));
    if (others.some((o) => o.id !== id && o.name.trim().toLowerCase() === name.toLowerCase())) {
      throw validation(`A payroll item named "${name}" already exists.`);
    }
    updates.name = name;
  }
  if (input.pretax !== undefined) {
    if (input.pretax && existing.kind !== 'deduction') {
      throw validation('Only deductions can be pre-tax.');
    }
    updates.pretax = input.pretax;
  }
  if (input.taxTracking !== undefined) {
    const t = resolveItemTracking(
      existing.kind,
      input.name ?? existing.name,
      input.taxTracking,
      input.pretax ?? existing.pretax,
    );
    if (existing.kind === 'tax' && !t) throw validation('A tax item needs a tax tracking type.');
    updates.taxTracking = t;
    if (existing.kind === 'deduction') updates.pretax = isPretaxTracking(t);
  } else if (input.pretax !== undefined && existing.kind === 'deduction') {
    // Legacy toggle: flipping pre-tax without a type re-derives the type from the name.
    const t = inferDeductionTracking(input.name ?? existing.name, input.pretax);
    updates.taxTracking = t;
    updates.pretax = isPretaxTracking(t);
  }
  if (input.expenseAccountId !== undefined) {
    if (input.expenseAccountId) {
      await assertAccountInCompany(ctx, input.expenseAccountId, 'Expense');
    } else if (requiredSides(existing.kind as PayrollItemKind).expense) {
      throw validation('This item kind requires an expense account.');
    }
    updates.expenseAccountId = input.expenseAccountId;
  }
  if (input.liabilityAccountId !== undefined) {
    if (input.liabilityAccountId) {
      await assertAccountInCompany(ctx, input.liabilityAccountId, 'Liability');
    } else if (requiredSides(existing.kind as PayrollItemKind).liability) {
      throw validation('This item kind requires a liability account.');
    }
    updates.liabilityAccountId = input.liabilityAccountId;
  }
  if (input.calcBasis !== undefined) {
    if (input.calcBasis != null && input.calcBasis !== 'fixed' && input.calcBasis !== 'percent') {
      throw validation("calcBasis must be 'fixed' or 'percent'.");
    }
    updates.calcBasis = input.calcBasis;
  }
  if (input.defaultRate !== undefined) {
    updates.defaultRate = normalizeRate(input.defaultRate);
  }
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  if (Object.keys(updates).length === 0) return existing;

  const [row] = await ctx.db
    .update(payrollItems)
    .set(updates)
    .where(and(eq(payrollItems.id, id), eq(payrollItems.companyId, ctx.companyId)))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'payroll_item',
    entityId: id,
    oldValues: existing,
    newValues: updates,
  });

  return row;
}

// ---------------------------------------------------------------------------
// Default seeding
// ---------------------------------------------------------------------------

async function accountIdByCodeOrNull(ctx: ServiceContext, code: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return row?.id ?? null;
}

/**
 * Seed the QB-like default payroll items for a company. Idempotent: a no-op when
 * the company already has ANY payroll items. Requires accounts 6500 + 2300 to
 * exist (the default COA); otherwise seeding is silently skipped so companies
 * with a custom COA can create items by hand. Returns the company's items.
 */
export async function ensureDefaultPayrollItems(ctx: ServiceContext) {
  const existing = await ctx.db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.companyId, ctx.companyId));
  if (existing.length > 0) return existing;

  const wagesId = await accountIdByCodeOrNull(ctx, '6500'); // Payroll Expense
  const liabId = await accountIdByCodeOrNull(ctx, '2300');  // Payroll Liabilities
  if (!wagesId || !liabId) return existing; // custom COA — nothing to map to.
  // Employer payroll taxes prefer 6510 Payroll Tax Expense; default COA may lack it.
  const taxExpId = (await accountIdByCodeOrNull(ctx, '6510')) ?? wagesId;

  const defaults: Array<typeof payrollItems.$inferInsert> = [
    // Earnings — Dr 6500
    { companyId: ctx.companyId, name: 'Salary',            kind: 'earning', expenseAccountId: wagesId, calcBasis: 'fixed' },
    { companyId: ctx.companyId, name: 'Hourly',            kind: 'earning', expenseAccountId: wagesId, calcBasis: 'fixed' },
    { companyId: ctx.companyId, name: 'Overtime (1.5x)',   kind: 'earning', expenseAccountId: wagesId, calcBasis: 'fixed' },
    { companyId: ctx.companyId, name: 'Bonus',             kind: 'earning', expenseAccountId: wagesId, calcBasis: 'fixed' },
    // Employee tax withholdings — Cr 2300
    { companyId: ctx.companyId, name: 'Federal Withholding', kind: 'tax', taxTracking: 'federal_withholding', liabilityAccountId: liabId },
    { companyId: ctx.companyId, name: 'Social Security',     kind: 'tax', taxTracking: 'social_security', liabilityAccountId: liabId, calcBasis: 'percent', defaultRate: '6.2000' },
    { companyId: ctx.companyId, name: 'Medicare',            kind: 'tax', taxTracking: 'medicare', liabilityAccountId: liabId, calcBasis: 'percent', defaultRate: '1.4500' },
    { companyId: ctx.companyId, name: 'State Withholding',   kind: 'tax', taxTracking: 'state_withholding', liabilityAccountId: liabId },
    // Employer taxes — Dr 6510 (or 6500) / Cr 2300
    { companyId: ctx.companyId, name: 'Employer Social Security',    kind: 'employer_contribution', taxTracking: 'employer_social_security', expenseAccountId: taxExpId, liabilityAccountId: liabId, calcBasis: 'percent', defaultRate: '6.2000' },
    { companyId: ctx.companyId, name: 'Employer Medicare',           kind: 'employer_contribution', taxTracking: 'employer_medicare', expenseAccountId: taxExpId, liabilityAccountId: liabId, calcBasis: 'percent', defaultRate: '1.4500' },
    { companyId: ctx.companyId, name: 'Federal Unemployment (FUTA)', kind: 'employer_contribution', taxTracking: 'futa', expenseAccountId: taxExpId, liabilityAccountId: liabId, calcBasis: 'percent', defaultRate: '0.6000' },
    { companyId: ctx.companyId, name: 'State Unemployment (SUI)',    kind: 'employer_contribution', taxTracking: 'sui', expenseAccountId: taxExpId, liabilityAccountId: liabId, calcBasis: 'percent' },
    // Deductions — Cr 2300. 401(k) deferrals reduce income-tax wages only (they stay subject to
    // Social Security, Medicare and FUTA); Section 125 health premiums reduce both.
    { companyId: ctx.companyId, name: '401(k) Employee',            kind: 'deduction', pretax: true, taxTracking: '401k',       liabilityAccountId: liabId, calcBasis: 'percent' },
    { companyId: ctx.companyId, name: 'Health Insurance (pre-tax)', kind: 'deduction', pretax: true, taxTracking: 'section125', liabilityAccountId: liabId, calcBasis: 'fixed' },
    // Garnishment — post-tax by definition — Cr 2300
    { companyId: ctx.companyId, name: 'Wage Garnishment', kind: 'garnishment', taxTracking: 'none', liabilityAccountId: liabId, calcBasis: 'fixed' },
  ];

  return inTransaction(ctx, async (tx) => {
    // Re-check inside the transaction to keep seeding race-safe per company.
    const again = await tx.db
      .select()
      .from(payrollItems)
      .where(eq(payrollItems.companyId, tx.companyId));
    if (again.length > 0) return again;

    const rows = await tx.db.insert(payrollItems).values(defaults).returning();
    for (const row of rows) {
      await writeAudit(tx, {
        action: 'create',
        entityType: 'payroll_item',
        entityId: row.id,
        newValues: { name: row.name, kind: row.kind, seeded: true },
      });
    }
    return rows;
  });
}
