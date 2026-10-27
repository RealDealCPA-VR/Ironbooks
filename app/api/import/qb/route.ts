/**
 * POST /api/import/qb
 *
 * Import QuickBooks data into the active company — the COMPLETE list import surface
 * (supersedes /api/qb-import, which only handled IIF lists + customer/vendor CSV).
 *
 * Body (JSON):
 *   {
 *     format:  'iif' | 'csv' | 'xlsx',
 *     kind?:   'customers' | 'vendors' | 'items' | 'accounts',  // required for csv / xlsx
 *     content?: string,                                         // raw text (iif / csv)
 *     data?:   string,                                          // base64 bytes (xlsx)
 *     mapping?: Record<string, string>,                         // required for csv / xlsx
 *     preview?: boolean,                                        // xlsx: return headers + rows only
 *     openItems?: { asDocuments: boolean, alreadyInGl?: boolean } // iif: open invoices / bills
 *   }
 *
 * IIF imports cover the account hierarchy, customers (with jobs), vendors, classes, items
 * (all QB item types, group / assembly components), employees, the other lists in the import
 * registry (deferred lists come back under `deferred`) and TRNS/SPL transactions.
 *
 * Response (200 JSON): ImportCounts — per-entity created counts, skipped, a per-row `issues`
 * array explaining every skip/remap/auto-create, and `deferred` lists.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import {
  importAccountsCSV,
  importCustomersCSV,
  importIIF,
  importItemsCSV,
  importListXlsx,
  importVendorsCSV,
  xlsxRows,
  type ListImportKind,
} from '@/lib/services/qbImport';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

const LIST_KINDS = ['customers', 'vendors', 'items', 'accounts'] as const;

function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64'));
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as {
      format?: string;
      kind?: string;
      content?: string;
      data?: string;
      mapping?: Record<string, string>;
      preview?: boolean;
      openItems?: { asDocuments?: boolean; alreadyInGl?: boolean };
    };
    const { format, kind, content, mapping } = body;

    if (format === 'xlsx') {
      if (!body.data || typeof body.data !== 'string') {
        return NextResponse.json({ error: 'data (base64 .xlsx bytes) is required.', code: 'VALIDATION' }, { status: 400 });
      }
      const bytes = decodeBase64(body.data);
      if (body.preview) {
        const { headers, rows, sheet } = xlsxRows(bytes);
        return NextResponse.json({ headers, rows: rows.slice(0, 10), total: rows.length, sheet });
      }
      if (!LIST_KINDS.includes(kind as ListImportKind)) {
        return NextResponse.json({ error: `kind must be one of: ${LIST_KINDS.join(', ')}.`, code: 'VALIDATION' }, { status: 400 });
      }
      await assertExclusiveAccess(ctx, 'Import');
      return NextResponse.json(await importListXlsx(ctx, kind as ListImportKind, bytes, mapping ?? {}));
    }

    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content is required and must be a string.', code: 'VALIDATION' }, { status: 400 });
    }

    // QuickBooks list/transaction import: owner/admin, single-user while others are on.
    await assertExclusiveAccess(ctx, 'Import');

    if (format === 'iif') {
      return NextResponse.json(
        await importIIF(ctx, content, {
          openItems: body.openItems?.asDocuments
            ? { asDocuments: true, alreadyInGl: body.openItems.alreadyInGl !== false }
            : undefined,
        }),
      );
    }

    if (format === 'csv') {
      if (!LIST_KINDS.includes(kind as ListImportKind)) {
        return NextResponse.json(
          { error: `For CSV imports, kind must be one of: ${LIST_KINDS.join(', ')}.`, code: 'VALIDATION' },
          { status: 400 },
        );
      }
      const colMapping = (mapping ?? {}) as Record<string, string>;
      switch (kind as ListImportKind) {
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

    return NextResponse.json({ error: 'format must be "iif", "csv" or "xlsx".', code: 'VALIDATION' }, { status: 400 });
  } catch (err) {
    return routeError(err, 'import/qb');
  }
}
