/**
 * GET /api/payroll/w2?employeeId=<uuid>&year=<yyyy>
 *
 * Returns a W-2 statement PDF (application/pdf, inline) for the specified
 * employee and calendar year.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { w2Data } from '@/lib/services/payrollReports';
import { renderW2Pdf } from '@/lib/pdf/payrollForms';
import { maskSensitive } from '@/lib/permissions/mask';
import { headerSafeFilename, serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/payroll/w2]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const employeeId = searchParams.get('employeeId');
    const yearStr    = searchParams.get('year');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!yearStr || isNaN(Number(yearStr))) {
      return NextResponse.json({ error: 'year is required and must be a number', code: 'VALIDATION' }, { status: 400 });
    }

    const year = parseInt(yearStr, 10);

    // SSN printed in full only for roles allowed to view sensitive payroll data.
    const data = maskSensitive(await w2Data(ctx, { employeeId, year }), ctx.access);
    const pdfBytes = await renderW2Pdf(data);

    // Header-safe: a non-Latin-1 name ("Trường", "O’Brien") or a quote is not a valid header value (HTTP 500).
    const filename = headerSafeFilename(`W2_${data.employee.lastName}_${data.employee.firstName}_${year}.pdf`);

    return new NextResponse(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer, {
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
