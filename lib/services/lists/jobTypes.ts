/**
 * Job Type assignment (QB: a job's "Job Type" from the Job Type list). The list itself is a
 * simple list (simpleLists.ts, key 'job-types'); this sets or clears a job's type.
 */
import { and, eq } from 'drizzle-orm';
import { jobTypes, jobs } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';

export async function assignJobType(ctx: ServiceContext, jobId: string, jobTypeId: string | null) {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.companyId, ctx.companyId)));
  if (!job) throw notFound('Job');
  if (jobTypeId) {
    const [t] = await ctx.db
      .select({ id: jobTypes.id, isActive: jobTypes.isActive })
      .from(jobTypes)
      .where(and(eq(jobTypes.id, jobTypeId), eq(jobTypes.companyId, ctx.companyId)));
    if (!t) throw notFound('Job type');
    if (!t.isActive && job.jobTypeId !== jobTypeId) throw validation('That job type is inactive.');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db.update(jobs).set({ jobTypeId }).where(eq(jobs.id, jobId)).returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'job',
      entityId: jobId,
      oldValues: { jobTypeId: job.jobTypeId },
      newValues: { jobTypeId },
    });
    return row;
  });
}
