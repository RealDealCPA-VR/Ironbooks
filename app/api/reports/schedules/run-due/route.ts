/**
 * POST /api/reports/schedules/run-due — the path the desktop shell's scheduled-reports timer polls
 * (electron/main.js; a 404 there stops the timer for good). Same behaviour as
 * /api/report-schedules/run-due: run every due scheduled report into the report-export folder.
 * Used by that timer (per-launch x-bka-internal token, no cookie; runs every company in the file) and by "Run due reports now".
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { reportError } from '../../_lib';
import { internalContexts, runDueForCompanies, runDueForUser } from '../../../report-schedules/_internal';

export async function POST(req: NextRequest) {
  try {
    // Desktop timer (internal token): every company in the file. Otherwise the signed-in user.
    const internal = await internalContexts(req);
    const results = internal ? await runDueForCompanies(internal) : await runDueForUser(await getServerContext());
    return NextResponse.json({ results });
  } catch (e) {
    return reportError(e, 'reports/schedules/run-due');
  }
}
