/**
 * GET /api/reports/customer-statement/pdf?customerId=&from=&to=
 *
 * Renders a PDF for the customer statement and returns it inline as
 * application/pdf. Opens directly in the browser when called via window.open().
 *
 * Query params mirror /api/reports/customer-statement:
 *   customerId  — required UUID
 *   from        — optional ISO date string (YYYY-MM-DD)
 *   to          — optional ISO date string (YYYY-MM-DD)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { customerStatement } from '@/lib/services/statements';
import { buildStatementPdf } from '@/lib/pdf/forms';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[reports/customer-statement/pdf]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const customerId = searchParams.get('customerId');
    const fromStr    = searchParams.get('from');
    const toStr      = searchParams.get('to');

    if (!customerId) {
      return NextResponse.json({ error: 'Missing required query param: customerId' }, { status: 400 });
    }

    const ctx = await getServerContext();

    const range: { from?: Date; to?: Date } = {};
    if (fromStr) range.from = new Date(fromStr + 'T00:00:00.000Z');
    if (toStr)   range.to   = new Date(toStr   + 'T00:00:00.000Z');

    const statement = await customerStatement(ctx, customerId, range);

    // Printed with the statement form template (Templates) and the company letterhead.
    const pdfBytes = await buildStatementPdf(ctx, statement);

    const buffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;

    const safeName = statement.customer.displayName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const filename = `statement-${safeName}.pdf`;

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
