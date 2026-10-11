/**
 * GET  /api/memorized-reports  — list saved reports
 * POST /api/memorized-reports  — save one ({name, reportType, config})
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listMemorizedReports, saveMemorizedReport } from '@/lib/services/memorizedReports';
import { ServiceError } from '@/lib/services/_base';

function err(e: unknown) {
  if (e instanceof ServiceError) {
    const s =
      e.code === 'NOT_FOUND' ? 404
      : e.code === 'VALIDATION' ? 400
      : e.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: e.message, code: e.code }, { status: s });
  }
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(await listMemorizedReports(await getServerContext()));
  } catch (e) {
    return err(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await saveMemorizedReport(ctx, await req.json()), { status: 201 });
  } catch (e) {
    return err(e);
  }
}
