/**
 * POST /api/import/qb
 *
 * Import QuickBooks data into the active company — the COMPLETE import surface
 * (supersedes /api/qb-import, which only handled IIF lists + customer/vendor CSV).
 *
 * Body (JSON):
 *   {
 *     format:  'iif' | 'csv',
 *     kind?:   'customers' | 'vendors' | 'items' | 'accounts',  // required when format === 'csv'
 *     content: string,                                          // raw file text
 *     mapping?: Record<string, string>,                         // required when format === 'csv'
 *   }
 *
 * IIF imports cover accounts, customers, vendors, classes, items (INVITEM),
 * employees (EMP), and TRNS/SPL transactions (posted as balanced journal
 * entries; unmatched accounts auto-created under "QB Import (review)").
 *
 * Response (200 JSON): ImportCounts — per-entity created counts, skipped, and a
 * per-row `issues` array explaining every skip/remap/auto-create.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import {
  importAccountsCSV,
  importCustomersCSV,
  importIIF,
  importItemsCSV,
  importVendorsCSV,
} from '@/lib/services/qbImport';
import { ServiceError } from '@/lib/services/_base';

const CSV_KINDS = ['customers', 'vendors', 'items', 'accounts'] as const;
type CsvKind = (typeof CSV_KINDS)[number];

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
  console.error('[import/qb] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // QuickBooks list/transaction import: owner/admin, single-user while others are on.
    await assertExclusiveAccess(ctx, 'Import');
    const body = (await req.json()) as {
      format: string;
      kind?: string;
      content: string;
      mapping?: Record<string, string>;
    };

    const { format, kind, content, mapping } = body;

    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'content is required and must be a string.' },
        { status: 400 },
      );
    }

    if (format === 'iif') {
      return NextResponse.json(await importIIF(ctx, content));
    }

    if (format === 'csv') {
      if (!CSV_KINDS.includes(kind as CsvKind)) {
        return NextResponse.json(
          { error: `For CSV imports, kind must be one of: ${CSV_KINDS.join(', ')}.` },
          { status: 400 },
        );
      }
      const colMapping = (mapping ?? {}) as Record<string, string>;
      switch (kind as CsvKind) {
        case 'customers':
          return NextResponse.json(await importCustomersCSV(ctx, content, colMapping));
        case 'vendors':
          return NextResponse.json(await importVendorsCSV(ctx, content, colMapping));
        case 'items':
          return NextResponse.json(await importItemsCSV(ctx, content, colMapping));
        case 'accounts':
          return NextResponse.json(await importAccountsCSV(ctx, content, colMapping));
      }
    }

    return NextResponse.json({ error: 'format must be "iif" or "csv".' }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
