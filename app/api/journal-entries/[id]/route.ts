/**
 * GET    /api/journal-entries/:id   — fetch a single entry with lines + account names.
 * PATCH  /api/journal-entries/:id   — edit a posted entry (void + repost atomically).
 * DELETE /api/journal-entries/:id   — void a posted entry (reverses balances).
 */
import { NextRequest, NextResponse } from 'next/server';
import { serviceErrorBody, serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getEntry, updateEntry, voidEntry } from '@/lib/services/journal';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const entry = await getEntry(ctx, id);
    return NextResponse.json({ entry });
  } catch (err) {
    return mapError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const date = body.date ? new Date(body.date) : undefined;
    if (!date || isNaN(date.getTime())) {
      return NextResponse.json({ error: 'date is required (ISO string).' }, { status: 400 });
    }

    // Multi-user: 409 if someone else changed this entry since it was loaded.
    const entry = await withVersionCheck(ctx, 'journal_entry', id, expectedVersion(req), (c) =>
      updateEntry(c, id, {
        date,
        description: body.description ?? '',
        reference: body.reference === undefined ? undefined : (body.reference ?? null),
        lines: body.lines ?? [],
        isAdjusting: typeof body.isAdjusting === 'boolean' ? body.isAdjusting : undefined,
      }),
    );
    return NextResponse.json({ entry });
  } catch (err) {
    return mapError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const entry = await withVersionCheck(ctx, 'journal_entry', id, expectedVersion(req), (c) => voidEntry(c, id));
    return NextResponse.json({ entry });
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapper (code → HTTP status).
// ---------------------------------------------------------------------------
function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(serviceErrorBody(err), { status });
  }
  console.error('[journal-entries/[id]] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
