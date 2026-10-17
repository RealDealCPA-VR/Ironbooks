/**
 * GET   /api/jobs/[id]  — fetch a single job, optionally with profitability.
 * PATCH /api/jobs/[id]  — update mutable fields.
 * DELETE /api/jobs/[id] — soft-deactivate (isActive = false).
 *
 * Query params for GET:
 *   ?profitability=true  — include jobProfitability breakdown in the response.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getJob, updateJob, deactivateJob, jobProfitability } from '@/lib/services/jobs';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateJobSchema } from '@/lib/validation/jobs';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/jobs/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const job = await getJob(ctx, id);

    if (searchParams.get('profitability') === 'true') {
      const profitability = await jobProfitability(ctx, id);
      return NextResponse.json({ ...job, profitability });
    }

    return NextResponse.json(job);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req, { optional: true });
    // zod strip mode keeps absent keys absent — only provided fields are updated.
    const parsed = updateJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const job = await updateJob(ctx, id, parsed.data);
    return NextResponse.json(job);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const job = await deactivateJob(ctx, id);
    return NextResponse.json(job);
  } catch (err) {
    return errorResponse(err);
  }
}
