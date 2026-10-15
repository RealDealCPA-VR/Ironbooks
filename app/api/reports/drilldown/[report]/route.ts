/**
 * GET /api/reports/drilldown/[report]?row=<row id>&col=<column key>&<report options>
 *   &brief=1 — tooltip mode (count, total and largest transaction only)
 *   &limit=N — cap the transaction list (default 1,000, max 5,000)
 *
 * The transactions behind one number of a standard report, rebuilt on the report's own basis,
 * dates and filters (lib/services/reportDrilldown.ts). Mapped 'member' like /api/reports/std:
 * the service checks the report's own permission area (view) before running anything.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { drilldownCell } from '@/lib/services/reportDrilldown';
import { reportError } from '../../_lib';

export async function GET(req: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  try {
    const ctx = await getServerContext();
    const { report } = await params;
    const sp = req.nextUrl.searchParams;
    const limit = sp.get('limit');
    const result = await drilldownCell(ctx, report, sp, sp.get('row') ?? '', sp.get('col') ?? '', {
      brief: sp.get('brief') === '1',
      limit: limit && /^\d{1,5}$/.test(limit) ? Number(limit) : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return reportError(err, 'drilldown');
  }
}
