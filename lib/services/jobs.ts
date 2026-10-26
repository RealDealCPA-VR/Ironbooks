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
import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  jobs,
  invoices,
  invoiceLines,
  bills,
  billLines,
  expenses,
  expenseLines,
  customers,
  items,
  salesReceipts,
  salesReceiptLines,
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
    // Nothing to change (e.g. PATCH {}): a no-op save, not drizzle's "No values to set" → 500.
    // Still inside inTransaction, so the modify permission is enforced as for a real edit.
    if (Object.keys(patch).length === 0) return existing;

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


/*
 * Which documents count toward job revenue / cost — the same rules as the Job Profitability
 * reports (lib/services/reportsJobsTime.ts jobFacts), so the Jobs page and the reports always
 * show the same numbers for a job:
 *  - void and draft invoices, void bills and voided checks are not revenue or cost;
 *  - subtotal / payment / sales-tax item lines are not revenue (needs `items` left-joined);
 *  - an invoice line without its own job counts for the invoice's job;
 *  - an invoice's header discount reduces the revenue of the invoice's job;
 *  - amounts are in HOME currency (a foreign-currency document's amount x its exchange rate).
 */
const REVENUE_LINE_ONLY = sql`COALESCE(${items.type}::text, '') NOT IN ('subtotal', 'payment', 'sales_tax')`;
const LIVE_INVOICE = notInArray(invoices.status, ['void', 'draft']);
const LIVE_BILL = ne(bills.status, 'void');
const LIVE_EXPENSE = isNull(expenses.voidedAt);

/** Home-currency value of a document amount (same rounding as the Job reports). */
function homeOf(amount: string, rate: string | null | undefined) {
  return rate && !Money.eq(rate, 1) ? Money.round2(Money.of(amount).times(Money.of(rate))) : Money.of(amount);
}

interface JobFact {
  jobId: string;
  kind: 'revenue' | 'cost';
  line: JobProfitabilityLineItem;
}

/** Every revenue / cost amount (home currency) tagged to the given jobs. */
async function jobFacts(ctx: ServiceContext, jobIds: string[]): Promise<JobFact[]> {
  if (jobIds.length === 0) return [];
  const out: JobFact[] = [];
  const lineJob = sql<string | null>`COALESCE(${invoiceLines.jobId}, ${invoices.jobId})`;

  // Revenue: invoice lines tagged to the job (or untagged lines on an invoice for the job).
  const revLines = await ctx.db
    .select({
      id: invoiceLines.id,
      jobId: lineJob,
      description: invoiceLines.description,
      amount: invoiceLines.amount,
      fx: invoices.exchangeRate,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(items, and(eq(invoiceLines.itemId, items.id), eq(items.companyId, ctx.companyId)))
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        sql`${lineJob} IN (${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        LIVE_INVOICE,
        REVENUE_LINE_ONLY,
      ),
    );
  for (const l of revLines) {
    if (!l.jobId) continue;
    out.push({
      jobId: l.jobId,
      kind: 'revenue',
      line: { source: 'invoice_line', id: l.id, description: l.description, amount: toAmountString(homeOf(l.amount, l.fx)) },
    });
  }

  // Invoice header discounts reduce the revenue of the invoice's job (posted as a debit to income).
  const discounts = await ctx.db
    .select({ id: invoices.id, jobId: invoices.jobId, discount: invoices.discount, fx: invoices.exchangeRate })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoices.jobId, jobIds),
        LIVE_INVOICE,
        sql`${invoices.discount} <> 0`,
      ),
    );
  for (const r of discounts) {
    if (!r.jobId) continue;
    out.push({
      jobId: r.jobId,
      kind: 'revenue',
      line: {
        source: 'invoice_line',
        id: `discount:${r.id}`,
        description: 'Invoice discount',
        amount: toAmountString(homeOf(r.discount, r.fx).negated()),
      },
    });
  }

  // Sales receipt lines tagged to the job are revenue too.
  const receiptLines = await ctx.db
    .select({
      id: salesReceiptLines.id,
      jobId: salesReceiptLines.jobId,
      description: salesReceiptLines.description,
      amount: salesReceiptLines.amount,
    })
    .from(salesReceiptLines)
    .innerJoin(salesReceipts, eq(salesReceiptLines.salesReceiptId, salesReceipts.id))
    .leftJoin(items, and(eq(salesReceiptLines.itemId, items.id), eq(items.companyId, ctx.companyId)))
    .where(
      and(
        eq(salesReceipts.companyId, ctx.companyId),
        inArray(salesReceiptLines.jobId, jobIds),
        ne(salesReceipts.status, 'void'),
        REVENUE_LINE_ONLY,
      ),
    );
  for (const l of receiptLines) {
    if (!l.jobId) continue;
    out.push({
      jobId: l.jobId,
      kind: 'revenue',
      line: { source: 'invoice_line', id: l.id, description: l.description, amount: toAmountString(l.amount) },
    });
  }

  // Cost: bill lines and check / expense lines tagged to the job.
  const billCostLines = await ctx.db
    .select({
      id: billLines.id,
      jobId: billLines.jobId,
      description: billLines.description,
      amount: billLines.amount,
      fx: bills.exchangeRate,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(and(eq(bills.companyId, ctx.companyId), inArray(billLines.jobId, jobIds), LIVE_BILL));
  for (const l of billCostLines) {
    if (!l.jobId) continue;
    out.push({
      jobId: l.jobId,
      kind: 'cost',
      line: { source: 'bill_line', id: l.id, description: l.description, amount: toAmountString(homeOf(l.amount, l.fx)) },
    });
  }

  const expCostLines = await ctx.db
    .select({
      id: expenseLines.id,
      jobId: expenseLines.jobId,
      description: expenseLines.description,
      amount: expenseLines.amount,
      fx: expenses.exchangeRate,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(and(eq(expenses.companyId, ctx.companyId), inArray(expenseLines.jobId, jobIds), LIVE_EXPENSE));
  for (const l of expCostLines) {
    if (!l.jobId) continue;
    out.push({
      jobId: l.jobId,
      kind: 'cost',
      line: { source: 'expense_line', id: l.id, description: l.description, amount: toAmountString(homeOf(l.amount, l.fx)) },
    });
  }
  return out;
}

function totalsOf(facts: JobFact[]) {
  let revenue = Money.zero();
  let cost = Money.zero();
  for (const f of facts) {
    if (f.kind === 'revenue') revenue = revenue.plus(Money.of(f.line.amount));
    else cost = cost.plus(Money.of(f.line.amount));
  }
  return { revenue, cost, profit: revenue.minus(cost) };
}

/**
 * Compute per-job revenue (invoices, net of their discounts), cost (bills + checks / expenses)
 * and profit for a specific job, in home currency. Returns a full line-item breakdown.
 */
export async function jobProfitability(ctx: ServiceContext, jobId: string): Promise<JobProfitability> {
  const job = await getJob(ctx, jobId);
  const facts = await jobFacts(ctx, [jobId]);
  const { revenue, cost, profit } = totalsOf(facts);
  const budgetVariance = job.budget != null ? profit.minus(Money.of(job.budget)) : null;

  // Revenue lines first, then bill costs, then direct expenses (as before).
  const order = { invoice_line: 0, bill_line: 1, expense_line: 2 } as const;
  const lines = facts.map((f) => f.line).sort((a, b) => order[a.source] - order[b.source]);

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
 * Summary of all active jobs for the company — revenue, cost, profit (home currency) in one
 * query set, using the same rules as jobProfitability and the Job Profitability reports.
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

  const facts = await jobFacts(ctx, activeJobs.map((j) => j.id));
  const byJob = new Map<string, JobFact[]>();
  for (const f of facts) byJob.set(f.jobId, [...(byJob.get(f.jobId) ?? []), f]);

  return activeJobs.map((j) => {
    const { revenue, cost, profit } = totalsOf(byJob.get(j.id) ?? []);
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
