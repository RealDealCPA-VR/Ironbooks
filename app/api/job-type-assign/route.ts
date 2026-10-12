/**
 * POST /api/job-type-assign — set (or clear) a job's Job Type. Body: { jobId, jobTypeId | null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { assignJobType } from '@/lib/services/lists/jobTypes';
import { zodErrorBody, zUuid } from '@/lib/validation/helpers';

const schema = z.object({ jobId: zUuid, jobTypeId: zUuid.nullable() });

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await assignJobType(ctx, parsed.data.jobId, parsed.data.jobTypeId));
  } catch (err) {
    return routeError(err, 'POST /api/job-type-assign');
  }
}
