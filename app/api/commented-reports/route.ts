/**
 * GET  /api/commented-reports — the commented reports the caller may see (no snapshots)
 * POST /api/commented-reports — comment on a report: { name, reportType, params, comments }.
 *       The server runs the report itself and stores what it showed with the comments.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listCommentedReports, saveCommentedReport } from '@/lib/services/commentedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { commentedReportSchema } from '@/lib/validation/reports';
import { requireJsonObject } from '@/lib/routeErrors';
import { reportError } from '../reports/_lib';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listCommentedReports(ctx));
  } catch (e) {
    return reportError(e, 'commented-reports');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = commentedReportSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await saveCommentedReport(ctx, parsed.data), { status: 201 });
  } catch (e) {
    return reportError(e, 'commented-reports');
  }
}
