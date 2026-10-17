/**
 * GET  /api/jobs  — list jobs for the active company.
 * POST /api/jobs  — create a new job/project.
 *
 * Query params for GET:
 *   ?includeInactive=true  — include deactivated jobs.
 *   ?summary=true          — return jobsSummary (revenue/cost/profit per active job).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listJobs, createJob, jobsSummary } from '@/lib/services/jobs';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createJobSchema } from '@/lib/validation/jobs';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/jobs] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    if (searchParams.get('summary') === 'true') {
      const summary = await jobsSummary(ctx);
      return NextResponse.json(summary);
    }

    const includeInactive = searchParams.get('includeInactive') === 'true';
    const list = await listJobs(ctx, { includeInactive });
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const job = await createJob(ctx, parsed.data);
    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
