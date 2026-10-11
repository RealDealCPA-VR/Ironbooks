/**
 * POST /api/report-schedules/run-due — run every scheduled report that is due and save the
 * exports to the company's report-export folder. Called by the desktop shell's timer (and by the
 * "Run due reports now" button). Returns what ran, the files written and any errors.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runDueSchedules } from '@/lib/services/memorizedReports';
import { reportError } from '../../reports/_lib';

export async function POST() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ results: await runDueSchedules(ctx) });
  } catch (e) {
    return reportError(e, 'report-schedules/run-due');
  }
}
