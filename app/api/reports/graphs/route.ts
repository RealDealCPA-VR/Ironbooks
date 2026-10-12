/**
 * GET /api/reports/graphs?kind=income-expense|net-worth|sales|ar|ap|budget-vs-actual&from=&to=&asOf=&budgetId=
 * Series for the QB-style graphs. Mapped 'member': the area is checked per graph kind here
 * (A/R → sales reports, A/P → purchase reports, the rest → financial reports).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requirePermission } from '@/lib/services/access';
import { GRAPH_KINDS, graphData, type GraphKind } from '@/lib/services/reportsAnalysis';
import { ServiceError } from '@/lib/services/_base';
import { parseReportParams } from '@/lib/validation/reports';
import { reportError } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const kind = (sp.get('kind') ?? 'income-expense') as GraphKind;
    if (!GRAPH_KINDS.includes(kind)) throw new ServiceError('VALIDATION', 'Unknown graph.');
    requirePermission(ctx, kind === 'ar' ? 'reports_sales' : kind === 'ap' ? 'reports_purchases' : 'reports_financial', 'view');
    const rest = new URLSearchParams(sp);
    rest.delete('kind');
    const parsed = parseReportParams(rest);
    if (!parsed.success) throw new ServiceError('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid graph options.');
    return NextResponse.json(await graphData(ctx, kind, parsed.data));
  } catch (err) {
    return reportError(err, 'graphs');
  }
}
