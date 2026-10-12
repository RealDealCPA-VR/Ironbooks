/**
 * POST /api/report-schedules/run-due — run every scheduled report that is due and save the
 * exports to the company's report-export folder. Also served at /api/reports/schedules/run-due,
 * the path the desktop shell's background timer polls (electron/main.js). Used by that timer
 * (per-launch x-bka-internal token, no cookie) and by the "Run due reports now" button.
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runDueSchedules } from '@/lib/services/memorizedReports';
import { reportError } from '../../reports/_lib';
import { internalContext } from '../_internal';

export async function POST(req: NextRequest) {
  try {
    const ctx = (await internalContext(req)) ?? (await getServerContext());
    return NextResponse.json({ results: await runDueSchedules(ctx) });
  } catch (e) {
    return reportError(e, 'report-schedules/run-due');
  }
}
