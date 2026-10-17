/**
 * GET /api/portable/shareable?format=xlsx|pdf — "Shareable ledger": a read-only copy of the
 * books that opens without Ironbooks. xlsx = workbook (Company Info, Chart of Accounts, Trial
 * Balance, General Ledger, Journal, Customers, Vendors, Items); pdf = summary (company info,
 * Trial Balance, Balance Sheet).
 *
 * SECURITY: fails closed via getServerContext() before producing any bytes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { buildShareableLedgerPdf, buildShareableLedgerXlsx } from '@/lib/services/shareableLedger';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[portable/shareable] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const format = req.nextUrl.searchParams.get('format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'pdf') {
      return NextResponse.json({ error: 'format must be xlsx or pdf.', code: 'VALIDATION' }, { status: 400 });
    }
    const file = format === 'pdf' ? await buildShareableLedgerPdf(ctx) : await buildShareableLedgerXlsx(ctx);
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Content-Length': String(file.buffer.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
