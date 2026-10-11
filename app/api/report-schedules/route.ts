/**
 * GET  /api/report-schedules — list scheduled reports (+ the export folder they write to)
 * POST /api/report-schedules — schedule a memorized report or group
 *   ({ name, memorizedReportId | groupId, frequency: daily|weekly|monthly, startDate?, format?, folder? })
 * Schedules write export files to the local disk, so they need the file-utilities permission.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createReportSchedule, listReportSchedules, reportExportRoot } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { reportScheduleSchema } from '@/lib/validation/reports';
import { reportError } from '../reports/_lib';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ schedules: await listReportSchedules(ctx), exportFolder: reportExportRoot() });
  } catch (e) {
    return reportError(e, 'report-schedules');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = reportScheduleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createReportSchedule(ctx, parsed.data), { status: 201 });
  } catch (e) {
    return reportError(e, 'report-schedules');
  }
}
