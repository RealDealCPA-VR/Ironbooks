/**
 * POST /api/journal-entries/:id/reverse — create a reversing journal entry.
 *
 * Body (optional):
 *   { asOfDate?: string }  ISO date for the reversal; defaults to the 1st of the
 *                          month after the original entry's date (QB behavior).
 *
 * Response 201: { entry } — the new reversing entry (reference 'REV of #<n>').
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { reverseEntry } from '@/lib/services/journal';
import { serviceErrorStatus } from '@/lib/routeErrors';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));

    let asOfDate: Date | undefined;
    if (body?.asOfDate) {
      asOfDate = new Date(body.asOfDate);
      if (isNaN(asOfDate.getTime())) {
        return NextResponse.json({ error: 'asOfDate must be a valid ISO date.' }, { status: 400 });
      }
    }

    const entry = await reverseEntry(ctx, id, asOfDate);
    return NextResponse.json({ entry }, { status: 201 });
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
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[journal-entries/[id]/reverse] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
