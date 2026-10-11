/**
 * GET /api/reports/std/[report] — run any standard report (lib/reports/catalog.ts) with the
 * query-string parameters (from, to, asOf, accountId, customerId, vendorId, txnType, amountMin,
 * amountMax, cleared, classId, memo, number, sortBy, sortDir, subtotalBy, columns, compare, …).
 *
 * Mapped as 'member' in the permission map because one route serves reports from several areas:
 * runStandardReport checks the report's own area (view) before running it.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runStandardReport } from '@/lib/services/reportRegistry';
import { reportError } from '../../_lib';

export async function GET(req: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  try {
    const ctx = await getServerContext();
    const { report } = await params;
    return NextResponse.json(await runStandardReport(ctx, report, req.nextUrl.searchParams));
  } catch (err) {
    return reportError(err, 'std');
  }
}
