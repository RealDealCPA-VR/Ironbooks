/**
 * GET /api/payroll/w3?year=<yyyy>[&format=json]
 *
 * Returns the W-3 transmittal worksheet — totals across all employees' W-2s for
 * the specified calendar year plus the employer EIN/name/address from company
 * settings — as an inline PDF (default) or JSON.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { w3Data } from '@/lib/services/payrollReports';
import { renderW3Pdf } from '@/lib/pdf/payrollForms';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/payroll/w3]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const yearStr = searchParams.get('year');
    if (!yearStr || isNaN(Number(yearStr))) {
      return NextResponse.json(
        { error: 'year is required and must be a number', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const data = await w3Data(ctx, { year: parseInt(yearStr, 10) });

    if (searchParams.get('format') === 'json') {
      return NextResponse.json(data);
    }

    const pdfBytes = await renderW3Pdf(data);
    const filename = `FormW3_${data.year}.pdf`;

    return new NextResponse(
      pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
