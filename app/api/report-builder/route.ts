/**
 * POST /api/report-builder
 * Body: ReportConfig { from?, to?, accountTypes?, groupBy, status? }
 * Returns: ReportResult
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runReport, type ReportConfig } from '@/lib/services/reportBuilder';
import { ServiceError } from '@/lib/services/_base';

function errResponse(e: unknown) {
  if (e instanceof ServiceError) {
    const status =
      e.code === 'NOT_FOUND' ? 404
      : e.code === 'VALIDATION' ? 400
      : e.code === 'FORBIDDEN' ? 403
      : 500;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error('[report-builder]', e);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json()) as ReportConfig;

    // Validate groupBy
    const validGroupBy = ['account', 'type', 'month'];
    if (!body.groupBy || !validGroupBy.includes(body.groupBy)) {
      return NextResponse.json(
        { error: `groupBy must be one of: ${validGroupBy.join(', ')}` },
        { status: 400 },
      );
    }

    const result = await runReport(ctx, body);
    return NextResponse.json(result);
  } catch (e) {
    return errResponse(e);
  }
}
