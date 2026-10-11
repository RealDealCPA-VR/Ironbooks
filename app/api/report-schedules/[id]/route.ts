/**
 * PATCH  /api/report-schedules/[id] — rename / change frequency / pause ({ name?, frequency?, isActive?, format? })
 * DELETE /api/report-schedules/[id]
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteReportSchedule, updateReportSchedule } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateReportScheduleSchema } from '@/lib/validation/reports';
import { reportError } from '../../reports/_lib';

type P = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const parsed = updateReportScheduleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateReportSchedule(ctx, (await params).id, parsed.data));
  } catch (e) {
    return reportError(e, 'report-schedules/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await deleteReportSchedule(ctx, (await params).id));
  } catch (e) {
    return reportError(e, 'report-schedules/[id]');
  }
}
