/**
 * GET    /api/memorized-reports/[id] — run the memorized report with its saved settings
 * PATCH  /api/memorized-reports/[id] — rename / move to a group / replace saved settings
 * DELETE /api/memorized-reports/[id] — delete it (and its schedules)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteMemorizedReport, runMemorizedReport, updateMemorizedReport } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateMemorizedReportSchema } from '@/lib/validation/reports';
import { reportError } from '../../reports/_lib';

type P = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await runMemorizedReport(ctx, (await params).id));
  } catch (e) {
    return reportError(e, 'memorized-reports/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const parsed = updateMemorizedReportSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateMemorizedReport(ctx, (await params).id, parsed.data));
  } catch (e) {
    return reportError(e, 'memorized-reports/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await deleteMemorizedReport(ctx, (await params).id));
  } catch (e) {
    return reportError(e, 'memorized-reports/[id]');
  }
}
