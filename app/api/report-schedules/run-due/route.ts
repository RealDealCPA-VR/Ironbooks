/**
 * POST /api/report-schedules/run-due — run every scheduled report that is due and save the
 * exports to the company's report-export folder. Also served at /api/reports/schedules/run-due,
 * the path the desktop shell's background timer polls (electron/main.js). Used by that timer
 * (per-launch x-bka-internal token, no cookie) and by the "Run due reports now" button.
 * Returns what ran, the files written and any errors.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { reportError } from '../../reports/_lib';
import { internalContexts, runDueForCompanies, runDueForUser } from '../_internal';

export async function POST(req: NextRequest) {
  try {
    // Desktop timer (internal token): every company in the file. Otherwise the signed-in user.
    const internal = await internalContexts(req);
    const results = internal ? await runDueForCompanies(internal) : await runDueForUser(await getServerContext());
    return NextResponse.json({ results });
  } catch (e) {
    return reportError(e, 'report-schedules/run-due');
  }
}
