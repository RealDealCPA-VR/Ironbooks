/**
 * GET /api/payroll/941?quarter=<1-4>&year=<yyyy>[&schedule=monthly|semiweekly][&deposits=<amount>][&format=json]
 *
 * Returns a Form 941 PDF (application/pdf, inline) for the specified calendar quarter and year,
 * covering all employees of the active company: lines 1-15, line 16 and (semiweekly) Schedule B.
 * `deposits` overrides line 13 (deposits made outside the app); `format=json` returns the data.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { form941Data } from '@/lib/services/payrollReports';
import { render941Pdf } from '@/lib/pdf/payrollForms';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[api/payroll/941]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const quarterStr = searchParams.get('quarter');
    const yearStr    = searchParams.get('year');

    if (!quarterStr || isNaN(Number(quarterStr))) {
      return NextResponse.json({ error: 'quarter is required (1-4)', code: 'VALIDATION' }, { status: 400 });
    }
    if (!yearStr || isNaN(Number(yearStr))) {
      return NextResponse.json({ error: 'year is required and must be a number', code: 'VALIDATION' }, { status: 400 });
    }

    const quarter = parseInt(quarterStr, 10);
    const year    = parseInt(yearStr, 10);

    if (quarter < 1 || quarter > 4) {
      return NextResponse.json({ error: 'quarter must be between 1 and 4', code: 'VALIDATION' }, { status: 400 });
    }

    const schedule = searchParams.get('schedule');
    if (schedule && schedule !== 'monthly' && schedule !== 'semiweekly') {
      return NextResponse.json({ error: 'schedule must be monthly or semiweekly', code: 'VALIDATION' }, { status: 400 });
    }
    const deposits = searchParams.get('deposits');
    if (deposits && !/^\d+(\.\d{1,2})?$/.test(deposits.trim())) {
      return NextResponse.json({ error: 'deposits must be an amount like 1234.56', code: 'VALIDATION' }, { status: 400 });
    }

    const data = await form941Data(ctx, {
      quarter: quarter as 1 | 2 | 3 | 4,
      year,
      depositSchedule: (schedule as 'monthly' | 'semiweekly' | null) ?? undefined,
      depositsOverride: deposits?.trim() || null,
    });
    if (searchParams.get('format') === 'json') return NextResponse.json(data);
    const pdfBytes = await render941Pdf(data);

    const filename = `Form941_Q${quarter}_${year}.pdf`;

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
