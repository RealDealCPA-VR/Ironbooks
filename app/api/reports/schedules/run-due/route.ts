/**
 * POST /api/reports/schedules/run-due — the path the desktop shell's scheduled-reports timer polls
 * (electron/main.js; a 404 there stops the timer for good). Same behaviour as
 * /api/report-schedules/run-due: run every due scheduled report into the report-export folder.
 * Used by that timer (per-launch x-bka-internal token, no cookie; runs every company in the file) and by "Run due reports now".
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { reportError } from '../../_lib';
import { runDueForRequest } from '../../../report-schedules/_internal';

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json({ results: await runDueForRequest(req) });
  } catch (e) {
    return reportError(e, 'reports/schedules/run-due');
  }
}
