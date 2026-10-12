/**
 * GET  /api/memorized-reports  — list saved reports (?withGroups=1 also returns the groups)
 * POST /api/memorized-reports  — memorize a report ({name, reportType, config, groupId?})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listMemorizedGroups, listMemorizedReports, saveMemorizedReport } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { memorizeReportSchema } from '@/lib/validation/reports';
import { reportError } from '../reports/_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const reports = await listMemorizedReports(ctx);
    // Legacy callers (report builder) expect a bare array.
    if (req.nextUrl.searchParams.get('withGroups')) {
      return NextResponse.json({ reports, groups: await listMemorizedGroups(ctx) });
    }
    return NextResponse.json(reports);
  } catch (e) {
    return reportError(e, 'memorized-reports');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = memorizeReportSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await saveMemorizedReport(ctx, parsed.data), { status: 201 });
  } catch (e) {
    return reportError(e, 'memorized-reports');
  }
}
