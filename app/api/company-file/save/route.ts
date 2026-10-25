/**
 * POST /api/company-file/save — save the open single-file company file now (File > Save Company
 * File, and the shell before it hands the file to someone else). Answers what happened:
 * { saved, outcome, path?, bytes?, durationMs? } plus the new status.
 *
 * Auth: any signed-in member (saving only writes what is already in the books), or the desktop
 * shell's internal token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { isInternalRequest } from '@/lib/net/internalToken';
import { getCompanyFileSaveStatus, saveCompanyFile } from '@/lib/services/companyFileSave';
import { routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest) {
  try {
    if (!isInternalRequest(req)) await getServerContext();
    try {
      const result = await saveCompanyFile({ force: true });
      return NextResponse.json({ ...result, status: getCompanyFileSaveStatus() });
    } catch (err) {
      const status = getCompanyFileSaveStatus();
      return NextResponse.json(
        { saved: false, error: status.error ?? (err as Error).message, status },
        { status: 503 },
      );
    }
  } catch (err) {
    return routeError(err, 'company-file/save');
  }
}
