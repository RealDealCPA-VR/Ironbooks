/**
 * GET /api/export/statements/open-item/pdf?customerId=&asOf=
 *
 * Renders an open-item customer statement as a PDF (inline, opens in browser).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { openItemStatement } from '@/lib/services/statements';
import { getCompany } from '@/lib/services/company';
import { ServiceError } from '@/lib/services/_base';
import { renderOpenItemStatementPdf } from '../../openItemPdf';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[export/statements/open-item/pdf] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId query parameter is required.' }, { status: 400 });
    }

    let asOf = new Date();
    const asOfStr = searchParams.get('asOf');
    if (asOfStr) {
      asOf = new Date(asOfStr + 'T00:00:00.000Z');
      if (isNaN(asOf.getTime())) {
        return NextResponse.json({ error: 'Invalid asOf date.' }, { status: 400 });
      }
    }

    const ctx = await getServerContext();
    const statement = await openItemStatement(ctx, customerId, asOf);
    const company = await getCompany(ctx);
    const pdfBytes = await renderOpenItemStatementPdf(statement, company?.name ?? 'Your Company');

    const buffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;

    const safeName = statement.customer.displayName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="statement-open-item-${safeName}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
