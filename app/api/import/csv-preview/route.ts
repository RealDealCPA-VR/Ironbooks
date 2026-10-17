/**
 * POST /api/import/csv-preview — dry-run a CSV mapping without committing.
 *
 * Request body:
 *   {
 *     content: string;            // raw CSV text
 *     csvMapping: CsvMapping;     // same shape POST /api/import accepts, incl.
 *                                 // debit/credit split, dateFormat, skipRows, flipSign
 *     limit?: number;             // max preview rows (default 10, capped at 50)
 *   }
 *
 * Response 200: { headers, rows, totalParsed, error }
 *   - `headers` are always returned (after skipRows) so the UI can populate
 *     column dropdowns even when the current mapping fails to parse.
 *   - Mapping/parse problems come back as `error` (still HTTP 200) — they are
 *     an expected part of the mapping workflow, not a request failure.
 *
 * Nothing is written: no fileImports row, no bank_transactions staging.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { previewCSV, type CsvMapping } from '@/lib/services/import';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    await getServerContext(); // auth: fail closed before parsing user content

    const body = await req.json().catch(() => null);
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      return NextResponse.json(
        { error: 'content (raw CSV text) is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const mapping = body.csvMapping as CsvMapping | undefined;
    if (!mapping || typeof mapping !== 'object' || mapping.dateCol === undefined) {
      return NextResponse.json(
        { error: 'csvMapping with at least dateCol is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const limit = Math.min(
      Math.max(1, typeof body.limit === 'number' ? Math.floor(body.limit) : 10),
      50,
    );
    const result = previewCSV(body.content, mapping, limit);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[import/csv-preview]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
