/**
 * Customer:Job on document lines (QuickBooks picks a job under its customer).
 *
 * A billable / job-costing line (bills, checks and card charges, invoices, sales receipts, credit
 * memos, time) names a customer and optionally a job from the Jobs list. The job must belong to
 * that customer — or to one of its parent customers (a sub-customer working on its parent's job) —
 * otherwise job-costing and billable-expense reports attribute the cost or income to the wrong
 * customer:job. A line that names only a job takes the job's customer, as picking a job does in
 * QuickBooks. Jobs that belong to no customer go with any customer.
 *
 * Kept free of other service imports so every document service can use it without import cycles.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { customers, jobs } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation } from './_base';

export interface JobLine {
  customerId?: string | null;
  jobId?: string | null;
}

/**
 * Check the job of each line against the line's customer (or `docCustomerId`, the document's
 * customer, for lines that carry none of their own). With `fill`, a line with a job and no customer
 * gets the job's customer written onto it (the lines are mutated). Throws VALIDATION with the line
 * number for a job of another customer, NOT_FOUND for a job of another company.
 */
export async function assertLineJobs(
  ctx: ServiceContext,
  lines: JobLine[],
  opts: { docCustomerId?: string | null; fill?: boolean; what?: string } = {},
): Promise<void> {
  const jobIds = [...new Set(lines.map((l) => l.jobId).filter((x): x is string => !!x))];
  if (jobIds.length === 0) return;
  const rows = await ctx.db
    .select({ id: jobs.id, name: jobs.name, customerId: jobs.customerId })
    .from(jobs)
    .where(and(eq(jobs.companyId, ctx.companyId), inArray(jobs.id, jobIds)));
  if (rows.length !== jobIds.length) throw notFound('Job');
  const jobById = new Map(rows.map((r) => [r.id, r] as const));
  const owners = await ownersOf(ctx, [
    ...new Set([
      ...lines.map((l) => l.customerId ?? opts.docCustomerId ?? null),
      ...rows.map((r) => r.customerId),
    ].filter((x): x is string => !!x)),
  ]);
  const what = opts.what ?? 'line';
  lines.forEach((l, i) => {
    if (!l.jobId) return;
    const job = jobById.get(l.jobId)!;
    if (!job.customerId) return;
    const customerId = l.customerId ?? opts.docCustomerId ?? null;
    if (!customerId) {
      if (opts.fill) l.customerId = job.customerId;
      return;
    }
    if (customerId === job.customerId || owners.ancestorsOf(customerId).includes(job.customerId)) return;
    throw validation(
      `${lines.length > 1 ? `${capitalize(what)} ${i + 1}: the` : 'The'} job "${job.name}" belongs to ${owners.name(job.customerId)}, not to ${owners.name(customerId)}. Pick a job of that customer, or change the customer.`,
      { jobId: job.id, jobCustomerId: job.customerId, customerId },
    );
  });
}

/** A document-level job (an invoice's or credit memo's header job) against its customer. */
export async function assertDocumentJob(ctx: ServiceContext, customerId: string | null | undefined, jobId: string | null | undefined) {
  if (!jobId) return;
  await assertLineJobs(ctx, [{ customerId: customerId ?? null, jobId }], { what: 'document' });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Names and parent chains of the company's customers (only what the check needs). */
async function ownersOf(ctx: ServiceContext, ids: string[]) {
  const all = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName, parentId: customers.parentId })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const byId = new Map(all.map((c) => [c.id, c] as const));
  for (const id of ids) if (!byId.has(id)) throw notFound('Customer');
  return {
    name: (id: string) => `"${byId.get(id)?.displayName ?? 'another customer'}"`,
    ancestorsOf(id: string): string[] {
      const out: string[] = [];
      const seen = new Set<string>([id]);
      let cur = byId.get(id)?.parentId ?? null;
      while (cur && !seen.has(cur)) {
        out.push(cur);
        seen.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
      return out;
    },
  };
}
