/**
 * GET /api/payroll/940?year=<yyyy>[&format=json]
 *
 * Returns the Form 940 (FUTA) annual worksheet for the specified calendar year:
 * total payments, exempt payments, wages over the $7,000 base, FUTA tax, and the
 * quarterly liability breakdown — as an inline PDF (default) or JSON.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { form940Data } from '@/lib/services/payrollReports';
import { render940Pdf } from '@/lib/pdf/payrollForms';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/payroll/940]', err);
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

    const deposits = searchParams.get('deposits');
    if (deposits && !/^\d+(\.\d{1,2})?$/.test(deposits.trim())) {
      return NextResponse.json({ error: 'deposits must be an amount like 1234.56', code: 'VALIDATION' }, { status: 400 });
    }
    const data = await form940Data(ctx, { year: parseInt(yearStr, 10), depositsOverride: deposits?.trim() || null });

    if (searchParams.get('format') === 'json') {
      return NextResponse.json(data);
    }

    const pdfBytes = await render940Pdf(data);
    const filename = `Form940_${data.year}.pdf`;

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
