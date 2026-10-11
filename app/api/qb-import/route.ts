/**
 * POST /api/qb-import
 *
 * Import QuickBooks data into the active company.
 *
 * Body (JSON):
 *   {
 *     format:  'iif' | 'csv',
 *     kind?:   'customers' | 'vendors',   // required when format === 'csv'
 *     content: string,                     // raw file text
 *     mapping?: CsvColumnMapping,          // required when format === 'csv'
 *   }
 *
 * Response (200 JSON):
 *   { accounts: number, customers: number, vendors: number, skipped: number }
 *
 * Error responses follow the project convention:
 *   VALIDATION -> 400, NOT_FOUND -> 404, CONFLICT -> 409, FORBIDDEN -> 403, else -> 500.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { importIIF, importCustomersCSV, importVendorsCSV } from '@/lib/services/qbImport';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'CONFLICT' ? 409
      : err.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[qb-import] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // QuickBooks list/transaction import: owner/admin, single-user while others are on.
    await assertExclusiveAccess(ctx, 'Import');
    const body = await req.json() as {
      format: string;
      kind?: string;
      content: string;
      mapping?: Record<string, string>;
    };

    const { format, kind, content, mapping } = body;

    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content is required and must be a string.' }, { status: 400 });
    }

    if (format === 'iif') {
      const counts = await importIIF(ctx, content);
      return NextResponse.json(counts);
    }

    if (format === 'csv') {
      if (kind !== 'customers' && kind !== 'vendors') {
        return NextResponse.json(
          { error: 'For CSV imports, kind must be "customers" or "vendors".' },
          { status: 400 },
        );
      }

      const colMapping = (mapping ?? {}) as Record<string, string>;

      if (kind === 'customers') {
        const counts = await importCustomersCSV(ctx, content, colMapping);
        return NextResponse.json(counts);
      }

      // kind === 'vendors'
      const counts = await importVendorsCSV(ctx, content, colMapping);
      return NextResponse.json(counts);
    }

    return NextResponse.json(
      { error: 'format must be "iif" or "csv".' },
      { status: 400 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
