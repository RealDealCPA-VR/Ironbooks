/**
 * Jobs / Projects service — job costing for Ironbooks.
 *
 * Jobs are tracking dimensions that sit across invoices, bills, and expenses,
 * letting you see per-project revenue, cost, and profit without changing the GL
 * structure (the GL remains the single source of truth for all balances).
 *
 * Revenue is aggregated from invoiceLines.amount where jobId = job.
 * Costs are aggregated from billLines.amount + expenseLines.amount where jobId = job.
 * Budget is stored on the job row for quick variance analysis.
 *
 * Conventions:
 *  - Every query is scoped by ctx.companyId.
 *  - Every mutation emits an audit_logs row via writeAudit.
 *  - name is required and non-empty.
 *  - Deactivation is soft-delete (isActive = false).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  jobs,
  invoices,
  invoiceLines,
  bills,
  billLines,
  expenses,
  expenseLines,
  customers,
} from '@/lib/db/schema';
import { toAmountString, Money } from '@/lib/money';
import {
  type ServiceContext,
  assertRefInCompany,
  notFound,
  validation,
  writeAudit,
  inTransaction,
} from './_base';
import { assertListDeleteAllowed } from './accountantCopy/guard';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  customerId?: string | null;
  name: string;
  budget?: string | number | null;
  startDate?: Date | null;
  endDate?: Date | null;
}

export type UpdateJobInput = Partial<CreateJobInput> & { status?: string };

export interface JobProfitabilityLineItem {
  source: 'invoice_line' | 'bill_line' | 'expense_line';
  id: string;
  description: string | null;
  amount: string;
}

export interface JobProfitability {
  jobId: string;
  jobName: string;
  budget: string | null;
  revenue: string;
  cost: string;
  profit: string;
  budgetVariance: string | null; /** profit - budget; negative = over budget */
  lines: JobProfitabilityLineItem[];
}

export interface JobSummaryRow {
  id: string;
  name: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  budget: string | null;
  startDate: Date | null;
  endDate: Date | null;
  revenue: string;
  cost: string;
  profit: string;
  isActive: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCreateInput(input: CreateJobInput) {
  if (!input.name?.trim()) {
    throw validation('Job name is required.');
  }
  if (input.startDate && input.endDate && input.startDate > input.endDate) {
    throw validation('startDate must be before endDate.');
  }
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

/** List jobs for the current company. Returns active jobs by default. */
export async function listJobs(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const where = opts?.includeInactive
    ? eq(jobs.companyId, ctx.companyId)
    : and(eq(jobs.companyId, ctx.companyId), eq(jobs.isActive, true));

  return ctx.db.select().from(jobs).where(where).orderBy(asc(jobs.name));
}

/** Fetch a single job (must belong to this company). */
export async function getJob(ctx: ServiceContext, id: string) {
  const [job] = await ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.companyId, ctx.companyId)));
  if (!job) throw notFound(`Job ${id}`);
  return job;
}

// ---------------------------------------------------------------------------
// Create / update / deactivate
// ---------------------------------------------------------------------------

export async function createJob(ctx: ServiceContext, input: CreateJobInput) {
  validateCreateInput(input);
  if (input.customerId) await assertRefInCompany(ctx, customers, input.customerId, 'Customer');
  return inTransaction(ctx, async (tx) => {
    const [job] = await tx.db
      .insert(jobs)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId ?? null,
        name: input.name.trim(),
        budget: input.budget != null ? toAmountString(input.budget) : null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        status: 'active',
        isActive: true,
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'job',
      entityId: job.id,
      newValues: input,
    });
    return job;
  });
}

export async function updateJob(ctx: ServiceContext, id: string, input: UpdateJobInput) {
  const existing = await getJob(ctx, id);

  // Validate merged result
  const merged: CreateJobInput = {
    name: input.name ?? existing.name,
    customerId: input.customerId !== undefined ? input.customerId : existing.customerId,
    budget: input.budget !== undefined ? input.budget : existing.budget,
    startDate: input.startDate !== undefined ? input.startDate : existing.startDate,
    endDate: input.endDate !== undefined ? input.endDate : existing.endDate,
  };
  validateCreateInput(merged);
  if (input.customerId) await assertRefInCompany(ctx, customers, input.customerId, 'Customer');

  return inTransaction(ctx, async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.customerId !== undefined) patch.customerId = input.customerId;
    if (input.budget !== undefined) patch.budget = input.budget != null ? toAmountString(input.budget) : null;
    if (input.startDate !== undefined) patch.startDate = input.startDate;
    if (input.endDate !== undefined) patch.endDate = input.endDate;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await tx.db
      .update(jobs)
      .set(patch)
      .where(and(eq(jobs.id, id), eq(jobs.companyId, tx.companyId)))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'job',
      entityId: id,
      oldValues: existing,
      newValues: patch,
    });
    return updated;
  });
}

export async function deactivateJob(ctx: ServiceContext, id: string) {
  await assertListDeleteAllowed(ctx, 'delete', 'jobs'); // Accountant's Copy (I1)
  const existing = await getJob(ctx, id);
  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(jobs)
      .set({ isActive: false, status: 'inactive' })
      .where(and(eq(jobs.id, id), eq(jobs.companyId, tx.companyId)))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'job',
      entityId: id,
      oldValues: { isActive: existing.isActive, status: existing.status },
      newValues: { isActive: false, status: 'inactive' },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------

/**
 * Compute per-job revenue (from invoiceLines), cost (from billLines + expenseLines),
 * and profit for a specific job. Returns a full line-item breakdown.
 */
export async function jobProfitability(ctx: ServiceContext, jobId: string): Promise<JobProfitability> {
  const job = await getJob(ctx, jobId);

  // -- Revenue: all invoiceLines tagged to this job --
  // Join to invoices to ensure company scoping (invoiceLines doesn't store companyId directly).
  const revLines = await ctx.db
    .select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      amount: invoiceLines.amount,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        eq(invoiceLines.jobId, jobId),
      ),
    );

  // -- Cost (bills): all billLines tagged to this job --
  const billCostLines = await ctx.db
    .select({
      id: billLines.id,
      description: billLines.description,
      amount: billLines.amount,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        eq(billLines.jobId, jobId),
      ),
    );

  // -- Cost (direct expenses): all expenseLines tagged to this job --
  const expCostLines = await ctx.db
    .select({
      id: expenseLines.id,
      description: expenseLines.description,
      amount: expenseLines.amount,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(expenseLines.jobId, jobId),
      ),
    );

  // -- Aggregate --
  let revenue = Money.zero();
  for (const l of revLines) revenue = revenue.plus(Money.of(l.amount));

  let cost = Money.zero();
  for (const l of billCostLines) cost = cost.plus(Money.of(l.amount));
  for (const l of expCostLines) cost = cost.plus(Money.of(l.amount));

  const profit = revenue.minus(cost);
  const budgetVariance = job.budget != null ? profit.minus(Money.of(job.budget)) : null;

  const lines: JobProfitabilityLineItem[] = [
    ...revLines.map((l) => ({
      source: 'invoice_line' as const,
      id: l.id,
      description: l.description,
      amount: toAmountString(l.amount),
    })),
    ...billCostLines.map((l) => ({
      source: 'bill_line' as const,
      id: l.id,
      description: l.description,
      amount: toAmountString(l.amount),
    })),
    ...expCostLines.map((l) => ({
      source: 'expense_line' as const,
      id: l.id,
      description: l.description,
      amount: toAmountString(l.amount),
    })),
  ];

  return {
    jobId,
    jobName: job.name,
    budget: job.budget ?? null,
    revenue: toAmountString(revenue),
    cost: toAmountString(cost),
    profit: toAmountString(profit),
    budgetVariance: budgetVariance != null ? toAmountString(budgetVariance) : null,
    lines,
  };
}

/**
 * Summary of all active jobs for the company — revenue, cost, profit in one query set.
 * Uses per-row sub-aggregations so all active jobs are returned in one pass.
 */
export async function jobsSummary(ctx: ServiceContext): Promise<JobSummaryRow[]> {
  // Fetch all active jobs with optional customer name
  const activeJobs = await ctx.db
    .select({
      id: jobs.id,
      name: jobs.name,
      status: jobs.status,
      customerId: jobs.customerId,
      customerName: customers.displayName,
      budget: jobs.budget,
      startDate: jobs.startDate,
      endDate: jobs.endDate,
      isActive: jobs.isActive,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .leftJoin(
      customers,
      and(eq(jobs.customerId, customers.id), eq(customers.companyId, ctx.companyId)),
    )
    .where(and(eq(jobs.companyId, ctx.companyId), eq(jobs.isActive, true)))
    .orderBy(asc(jobs.name));

  if (activeJobs.length === 0) return [];

  const jobIds = activeJobs.map((j) => j.id);

  // Aggregate revenue per job (invoiceLines → invoices for company scoping)
  const revRows = await ctx.db
    .select({
      jobId: invoiceLines.jobId,
      total: sql<string>`COALESCE(SUM(${invoiceLines.amount}), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoiceLines.jobId, jobIds),
      ),
    )
    .groupBy(invoiceLines.jobId);

  // Aggregate cost from bills per job (billLines → bills for company scoping)
  const billCostRows = await ctx.db
    .select({
      jobId: billLines.jobId,
      total: sql<string>`COALESCE(SUM(${billLines.amount}), 0)`,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        inArray(billLines.jobId, jobIds),
      ),
    )
    .groupBy(billLines.jobId);

  // Aggregate cost from direct expenses per job (expenseLines → expenses for company scoping)
  const expCostRows = await ctx.db
    .select({
      jobId: expenseLines.jobId,
      total: sql<string>`COALESCE(SUM(${expenseLines.amount}), 0)`,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        inArray(expenseLines.jobId, jobIds),
      ),
    )
    .groupBy(expenseLines.jobId);

  // Build lookup maps
  const revMap = new Map(revRows.map((r) => [r.jobId, r.total]));
  const billCostMap = new Map(billCostRows.map((r) => [r.jobId, r.total]));
  const expCostMap = new Map(expCostRows.map((r) => [r.jobId, r.total]));

  return activeJobs.map((j) => {
    const revenue = Money.of(revMap.get(j.id) ?? 0);
    const cost = Money.of(billCostMap.get(j.id) ?? 0).plus(Money.of(expCostMap.get(j.id) ?? 0));
    const profit = revenue.minus(cost);
    return {
      id: j.id,
      name: j.name,
      status: j.status,
      customerId: j.customerId,
      customerName: j.customerName ?? null,
      budget: j.budget ?? null,
      startDate: j.startDate,
      endDate: j.endDate,
      isActive: j.isActive,
      createdAt: j.createdAt,
      revenue: toAmountString(revenue),
      cost: toAmountString(cost),
      profit: toAmountString(profit),
    };
  });
}
