/**
 * POST /api/errors/:id/apply
 *
 * Applies a pending error_corrections row: posts its correcting journal entry (only with
 * `approved: true`; through the posting engine, so the closing date applies), links it, marks the
 * correction "applied", resolves the parent error_detection, and writes an audit row. The id
 * segment is the error DETECTION id, not the correction id.
 *
 * Request body: { correctionId: string, approved?: boolean, entry?: ProposedEntry }
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { applyCorrection, type ProposedEntry } from '@/lib/services/llmCorrector';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // The URL segment (:id) is the detection id — we accept the correctionId in
    // the request body so the caller can unambiguously target a specific suggestion
    // (a detection can have multiple correction suggestions over time).
    const { id: _detectionId } = await params;

    let body: { correctionId?: string; approved?: unknown; entry?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { correctionId } = body;
    if (!correctionId) {
      return NextResponse.json(
        { error: 'correctionId is required in the request body' },
        { status: 400 },
      );
    }

    const ctx = await getServerContext();
    const entry = parseEntry(body.entry);
    if (entry === undefined) {
      return NextResponse.json({ error: 'The correcting entry is not valid.', code: 'VALIDATION' }, { status: 400 });
    }
    const correction = await applyCorrection(ctx, correctionId, { approved: body.approved === true, entry });
    return NextResponse.json({ correction });
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[POST /api/errors/:id/apply]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** The user-reviewed entry (null when not sent; undefined when malformed). */
function parseEntry(raw: unknown): ProposedEntry | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.date !== 'string' || typeof e.description !== 'string' || !Array.isArray(e.lines)) return undefined;
  const lines: ProposedEntry['lines'] = [];
  for (const l of e.lines as Array<Record<string, unknown>>) {
    if (!l || typeof l !== 'object' || typeof l.accountId !== 'string') return undefined;
    const amt = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
    lines.push({
      accountId: l.accountId,
      debit: amt(l.debit),
      credit: amt(l.credit),
      memo: typeof l.memo === 'string' ? l.memo : null,
      entityType: typeof l.entityType === 'string' ? (l.entityType as never) : null,
      entityId: typeof l.entityId === 'string' ? l.entityId : null,
    });
  }
  return { date: e.date, description: e.description, lines };
}
