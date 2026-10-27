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
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateJournalEntrySchema } from '@/lib/validation/journal';

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
    // Same shape checks as a new entry: lines that are not an array of objects, a description
    // that is not text or a date that does not exist (Feb 30) are a 400, never a TypeError (500)
    // or a silently rolled-over date.
    const parsed = updateJournalEntrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const input = parsed.data;

    // Multi-user: 409 if someone else changed this entry since it was loaded.
    const entry = await withVersionCheck(ctx, 'journal_entry', id, expectedVersion(req), (c) =>
      updateEntry(c, id, {
        date: input.date,
        description: input.description,
        reference: body.reference === undefined ? undefined : (input.reference ?? null),
        lines: input.lines,
        isAdjusting: input.isAdjusting,
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
