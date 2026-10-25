/**
 * POST /api/company-file/close — the desktop shell, closing the company file or quitting: save
 * everything to the company file and close the database (lib/services/companyFileSave.ts
 * closeCompanyFile). On failure (file server unreachable, …) the file stays open here and the
 * answer says why, so the shell can offer Try Again / keep working.
 *
 * Internal token only: nobody else may close the file under the person using it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isInternalRequest } from '@/lib/net/internalToken';
import { closeCompanyFile, getCompanyFileSaveStatus } from '@/lib/services/companyFileSave';

export async function POST(req: NextRequest) {
  if (!isInternalRequest(req)) {
    return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    const result = await closeCompanyFile();
    return NextResponse.json({ ok: true, ...result, status: getCompanyFileSaveStatus() });
  } catch (err) {
    const status = getCompanyFileSaveStatus();
    return NextResponse.json({ ok: false, error: status.error ?? (err as Error).message, status }, { status: 503 });
  }
}
