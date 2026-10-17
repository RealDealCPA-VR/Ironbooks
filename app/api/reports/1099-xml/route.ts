/**
 * GET /api/reports/1099-xml?year=YYYY
 *
 * Returns a 1099-NEC XML e-file for all eligible vendors (is_1099 = true,
 * total payments >= $600) in the requested calendar year.
 *
 * Response headers:
 *   Content-Type: application/xml
 *   Content-Disposition: attachment; filename="1099-nec-<year>.xml"
 *
 * Transmission to the IRS FIRE system is external to this endpoint.
 * Upload the downloaded file at https://fire.irs.gov using your TCC.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { generate1099NecFile } from '@/lib/services/form1099Xml';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[1099-xml] Unexpected error', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const yearParam = searchParams.get('year');
    if (!yearParam) {
      return NextResponse.json(
        { error: 'year query parameter is required.' },
        { status: 400 },
      );
    }

    const year = parseInt(yearParam, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year value.' }, { status: 400 });
    }

    const xml = await generate1099NecFile(ctx, { year });

    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="1099-nec-${year}.xml"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
