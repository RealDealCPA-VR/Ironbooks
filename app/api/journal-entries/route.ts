/**
 * GET  /api/journal-entries   — paginated list of journal entries.
 * POST /api/journal-entries   — create a manual double-entry journal entry.
 *
 * Query params for GET:
 *   from    ISO date string — inclusive start date filter.
 *   to      ISO date string — inclusive end date filter.
 *   limit   number (default 100, max 500).
 *   offset  number (default 0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { serviceErrorBody } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { createManualEntry, listEntries } from '@/lib/services/journal';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createJournalEntrySchema } from '@/lib/validation/journal';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const from = sp.get('from') ? new Date(sp.get('from')!) : undefined;
    const to = sp.get('to') ? new Date(sp.get('to')!) : undefined;
    const limit = Math.min(Number(sp.get('limit') ?? 100), 500);
    const offset = Number(sp.get('offset') ?? 0);

    const entries = await listEntries(ctx, { from, to, limit, offset });
    return NextResponse.json({ entries });
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createJournalEntrySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const entry = await createManualEntry(ctx, parsed.data);

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
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED' || err.code === 'PERIOD_CLOSED'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json(serviceErrorBody(err), { status });
  }
  console.error('[journal-entries] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
