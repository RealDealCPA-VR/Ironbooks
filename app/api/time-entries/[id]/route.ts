/**
 * PATCH  /api/time-entries/:id  — update a time entry
 * DELETE /api/time-entries/:id  — delete a time entry
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { updateTimeEntry, deleteTimeEntry } from '@/lib/services/timeTracking';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateTimeEntrySchema } from '@/lib/validation/timeEntries';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[time-entries/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    // zod strip mode keeps absent keys absent — only provided fields are updated.
    const parsed = updateTimeEntrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const updated = await updateTimeEntry(ctx, id, parsed.data);
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const result = await deleteTimeEntry(ctx, id);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
