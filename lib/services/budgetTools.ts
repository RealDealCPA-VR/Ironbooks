/**
 * Budget & forecast tools (QB Set Up Budgets / Set Up Forecast):
 *  - fillBudgetFromActuals — "Create budget from previous year's actual data": a fiscal year's
 *    actual monthly amounts (P&L budgets: each month's income / expense activity; balance-sheet
 *    budgets: each month-end balance), for the whole company, one class or one Customer:Job
 *    (income named for it and costs job-costed to it, the Profit & Loss by Job rule);
 *  - copyBudget — copy a budget or forecast into another fiscal year (or as a forecast), raising
 *    or lowering every amount by a percentage;
 *  - adjustBudget — "Adjust Row Amounts": raise or lower the amounts by a percentage, from a
 *    month of the fiscal year on, for some accounts / one class / one Customer:Job.
 * Each is one transaction with one audit record (a refused audit — view-only role, Accountant's
 * Copy — changes nothing). Budget lines keep their CALENDAR month (1 = January), like the grid.
 */
import { and, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { budgetLines, budgets, classes, customers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { budgetFiscalYear, type Budget } from './budgets';
import { PL_SECTIONS, activityByAccount, fetchGlLines, isPLSection, loadAccountMeta, naturalAmount } from './reportEngine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadBudget(ctx: ServiceContext, id: string) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound('Budget');
  const [b] = await ctx.db.select().from(budgets).where(and(eq(budgets.id, id), eq(budgets.companyId, ctx.companyId)));
  if (!b) throw notFound('Budget');
  return b;
}

function checkYear(y: unknown): number {
  const n = Number(y);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw validation('The fiscal year must be a 4-digit year between 2000 and 2100.');
  return n;
}

/** "10" → ×1.10, "-20" → ×0.80; a decrease of more than 100% is refused. */
export function percentFactor(percent: unknown): Decimal {
  const s = typeof percent === 'number' ? String(percent) : typeof percent === 'string' ? percent.trim() : '';
  if (!/^[+-]?\d{1,6}(\.\d{1,4})?$/.test(s)) throw validation('Enter the change as a percentage, e.g. 5 or -10.');
  const p = Money.of(s);
  if (p.lessThan(-100)) throw validation('A decrease can be at most 100%.');
  return Money.of(1).plus(p.dividedBy(100));
}

/** A budget's criteria from its lines: by class, by Customer:Job, company-wide, or none yet. */
export async function budgetCriteria(ctx: ServiceContext, budgetId: string): Promise<'class' | 'customer' | 'company' | null> {
  const one = async (w: SQL) => (await ctx.db.select({ id: budgetLines.id }).from(budgetLines).where(and(eq(budgetLines.budgetId, budgetId), w)).limit(1)).length > 0;
  if (await one(isNotNull(budgetLines.classId))) return 'class';
  if (await one(isNotNull(budgetLines.customerId))) return 'customer';
  if (await one(isNull(budgetLines.classId))) return 'company';
  return null;
}

/** The slice of a budget's lines one class / Customer:Job / the whole company owns. */
function sliceWhere(budgetId: string, s: { classId: string | null; customerId: string | null }): SQL {
  return and(
    eq(budgetLines.budgetId, budgetId),
    s.classId ? eq(budgetLines.classId, s.classId) : isNull(budgetLines.classId),
    s.customerId ? eq(budgetLines.customerId, s.customerId) : isNull(budgetLines.customerId),
  )!;
}

async function checkDimension(ctx: ServiceContext, input: { classId?: string | null; customerId?: string | null }) {
  const classId = input.classId || null;
  const customerId = input.customerId || null;
  if (classId && customerId) throw validation('Budget by a class or by a Customer:Job, not both.');
  if (classId) {
    const [c] = await ctx.db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, classId), eq(classes.companyId, ctx.companyId)));
    if (!c) throw notFound('Class');
  }
  if (customerId) {
    const [c] = await ctx.db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, ctx.companyId)));
    if (!c) throw notFound('Customer');
  }
  return { classId, customerId };
}

/**
 * Fill a budget (one slice of it: the whole company, a class or a Customer:Job) with the actual
 * amounts of a fiscal year (default: the year before the budget's). The slice's old amounts are
 * replaced; a budget kept by another criteria (company / class / Customer:Job) is refused.
 */
export async function fillBudgetFromActuals(
  ctx: ServiceContext,
  budgetId: string,
  input: { fiscalYear?: number | string | null; classId?: string | null; customerId?: string | null },
): Promise<{ lines: number; fiscalYear: number }> {
  const budget = await loadBudget(ctx, budgetId);
  const dim = await checkDimension(ctx, input);
  const isBs = budget.kind === 'balance_sheet';
  if (isBs && (dim.classId || dim.customerId)) throw validation('A balance sheet budget is for the whole company.');
  const srcYear = checkYear(input.fiscalYear ?? budget.fiscalYear - 1);

  // The budget's criteria must match (QB keeps one criteria per budget).
  const crit = await budgetCriteria(ctx, budget.id);
  const want = dim.classId ? 'class' : dim.customerId ? 'customer' : 'company';
  if (crit && crit !== want) {
    throw validation(
      crit === 'class'
        ? 'This budget is by class. Choose a class to fill, or create a separate budget.'
        : crit === 'customer'
          ? 'This budget is by Customer:Job. Choose a Customer:Job to fill, or create a separate budget.'
          : 'This budget is for the whole company. Create a separate budget by class or by Customer:Job.',
    );
  }

  const fy = await budgetFiscalYear(ctx, srcYear);
  const meta = await loadAccountMeta(ctx);
  const amounts = new Map<string, Decimal>();
  const add = (accountId: string, month: number, v: Decimal) => {
    const k = `${accountId}|${month}`;
    amounts.set(k, (amounts.get(k) ?? Money.zero()).plus(v));
  };
  if (isBs) {
    // Each month-end balance of every balance-sheet account.
    for (const m of fy.months) {
      for (const r of await activityByAccount(ctx, { to: m.to })) {
        const a = meta.get(r.accountId);
        if (!a || isPLSection(a.section)) continue;
        add(r.accountId, m.month, naturalAmount(a.section, r.debit, r.credit));
      }
    }
  } else if (dim.customerId) {
    // The Customer:Job's income and the costs job-costed to it (Profit & Loss by Job's rule).
    const { lines, truncated } = await fetchGlLines(ctx, meta, {
      from: fy.from,
      to: fy.to,
      sections: [...PL_SECTIONS],
      excludeClose: true,
      jobCustomerId: dim.customerId,
      limit: 50000,
    });
    if (truncated) throw validation('That Customer:Job has more than 50,000 ledger lines in the year; enter its budget by hand.');
    for (const l of lines) add(l.accountId, l.date.getUTCMonth() + 1, l.natural);
  } else {
    for (const r of await activityByAccount(ctx, { from: fy.from, to: fy.to, classId: dim.classId ?? undefined, excludeClose: true }, 'month')) {
      const a = meta.get(r.accountId);
      if (!a || !isPLSection(a.section)) continue;
      add(r.accountId, Number(String(r.bucket).slice(5, 7)), naturalAmount(a.section, r.debit, r.credit));
    }
  }
  const rows = [...amounts]
    .map(([k, v]) => {
      const [accountId, month] = k.split('|');
      return { budgetId: budget.id, accountId, month: Number(month), amount: toAmountString(Money.round2(v)), classId: dim.classId, customerId: dim.customerId };
    })
    .filter((r) => !Money.of(r.amount).isZero());

  return inTransaction(ctx, async (tx) => {
    await tx.db.delete(budgetLines).where(sliceWhere(budget.id, dim));
    for (let i = 0; i < rows.length; i += 500) await tx.db.insert(budgetLines).values(rows.slice(i, i + 500));
    await writeAudit(tx, {
      action: 'update',
      entityType: budget.isForecast ? 'forecast' : 'budget',
      entityId: budget.id,
      newValues: { filledFromActuals: srcYear, classId: dim.classId, customerId: dim.customerId, lines: rows.length },
    });
    return { lines: rows.length, fiscalYear: srcYear };
  });
}

/** Copy a budget or forecast (all its lines) into a new one, every amount changed by `percent`. */
export async function copyBudget(
  ctx: ServiceContext,
  sourceId: string,
  input: { name: string; fiscalYear: number | string; isForecast?: boolean; percent?: string | number | null },
): Promise<Budget> {
  const src = await loadBudget(ctx, sourceId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw validation('Give the new budget a name.');
  if (name.length > 255) throw validation('The name is too long.');
  const fiscalYear = checkYear(input.fiscalYear);
  const factor = input.percent === undefined || input.percent === null || input.percent === '' ? Money.of(1) : percentFactor(input.percent);
  const lines = await ctx.db.select().from(budgetLines).where(eq(budgetLines.budgetId, src.id));
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(budgets)
      .values({ companyId: tx.companyId, name, fiscalYear, kind: src.kind, isForecast: input.isForecast ?? src.isForecast })
      .returning();
    const copies = lines
      .map((l) => ({ budgetId: row.id, accountId: l.accountId, month: l.month, classId: l.classId, customerId: l.customerId, amount: toAmountString(Money.round2(Money.of(l.amount).times(factor))) }))
      .filter((l) => !Money.of(l.amount).isZero());
    for (let i = 0; i < copies.length; i += 500) await tx.db.insert(budgetLines).values(copies.slice(i, i + 500));
    await writeAudit(tx, {
      action: 'create',
      entityType: row.isForecast ? 'forecast' : 'budget',
      entityId: row.id,
      newValues: { name, fiscalYear, kind: row.kind, isForecast: row.isForecast, copiedFrom: src.id, percent: input.percent ?? null, lines: copies.length },
    });
    return row;
  });
}

/**
 * Adjust Row Amounts: every amount of the chosen lines × (1 + percent / 100), cents rounded.
 * `fromMonth` (calendar month) starts the change at that month of the fiscal year; `accountIds`,
 * `classId` and `customerId` narrow the rows (none = every line of the budget).
 */
export async function adjustBudget(
  ctx: ServiceContext,
  budgetId: string,
  input: { percent: string | number; fromMonth?: number | null; accountIds?: string[] | null; classId?: string | null; customerId?: string | null },
): Promise<{ lines: number }> {
  const budget = await loadBudget(ctx, budgetId);
  const factor = percentFactor(input.percent);
  const fy = await budgetFiscalYear(ctx, budget.fiscalYear);
  let months = fy.months.map((m) => m.month);
  if (input.fromMonth !== undefined && input.fromMonth !== null) {
    const m = Number(input.fromMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw validation('Choose the month to start from.');
    months = months.slice(fy.indexOf(m));
  }
  const conds: SQL[] = [eq(budgetLines.budgetId, budget.id), inArray(budgetLines.month, months)];
  if (input.accountIds?.length) conds.push(inArray(budgetLines.accountId, input.accountIds.filter((x) => UUID_RE.test(x))));
  if (input.classId) conds.push(eq(budgetLines.classId, input.classId));
  if (input.customerId) conds.push(eq(budgetLines.customerId, input.customerId));
  const lines = await ctx.db.select().from(budgetLines).where(and(...conds));
  return inTransaction(ctx, async (tx) => {
    for (const l of lines) {
      await tx.db
        .update(budgetLines)
        .set({ amount: toAmountString(Money.round2(Money.of(l.amount).times(factor))) })
        .where(eq(budgetLines.id, l.id));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: budget.isForecast ? 'forecast' : 'budget',
      entityId: budget.id,
      newValues: { adjustedPercent: String(input.percent), fromMonth: input.fromMonth ?? null, lines: lines.length },
    });
    return { lines: lines.length };
  });
}
