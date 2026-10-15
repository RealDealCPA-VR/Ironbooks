/**
 * GET /api/month-end-close/report-pack?periodEnd=YYYY-MM-DD
 *   → application/pdf download: cover page, Profit & Loss for the month, Balance Sheet, Trial
 *     Balance, A/R and A/P Aging Summaries and the reconciliation summaries for the period.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { buildMonthEndReportPack } from '@/lib/services/monthEndClose';
import { validation } from '@/lib/services/_base';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const periodEnd = req.nextUrl.searchParams.get('periodEnd');
    if (!periodEnd) throw validation('periodEnd is required (YYYY-MM-DD).');
    const pack = await buildMonthEndReportPack(ctx, periodEnd);
    const buf = pack.bytes.buffer.slice(
      pack.bytes.byteOffset,
      pack.bytes.byteOffset + pack.bytes.byteLength,
    ) as ArrayBuffer;
    const filename = pack.filename.replace(/[^A-Za-z0-9._-]+/g, '_');
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return routeError(err, '/api/month-end-close/report-pack');
  }
}
