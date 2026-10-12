/**
 * POST /api/reports/schedules/run-due — the path the desktop shell's scheduled-reports timer polls
 * (electron/main.js; a 404 there stops the timer for good). Same behaviour as
 * /api/report-schedules/run-due: run every due scheduled report into the report-export folder.
 * Used by that timer (per-launch x-bka-internal token, no cookie) and by "Run due reports now".
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runDueSchedules } from '@/lib/services/memorizedReports';
import { reportError } from '../../_lib';
import { internalContext } from '../../../report-schedules/_internal';

export async function POST(req: NextRequest) {
  try {
    const ctx = (await internalContext(req)) ?? (await getServerContext());
    return NextResponse.json({ results: await runDueSchedules(ctx) });
  } catch (e) {
    return reportError(e, 'reports/schedules/run-due');
  }
}
