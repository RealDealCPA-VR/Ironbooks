/**
 * POST /api/report-schedules/run-due — run every scheduled report that is due and save the
 * exports to the company's report-export folder. Also served at /api/reports/schedules/run-due,
 * the path the desktop shell's background timer polls (electron/main.js). Used by that timer
 * (per-launch x-bka-internal token, no cookie) and by the "Run due reports now" button.
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { reportError } from '../../reports/_lib';
import { runDueForRequest } from '../_internal';

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json({ results: await runDueForRequest(req) });
  } catch (e) {
    return reportError(e, 'report-schedules/run-due');
  }
}
