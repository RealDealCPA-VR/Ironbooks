/**
 * GET /api/company-file/status — is the open company file saved? (title bar indicator,
 * components/CompanyFileStatus.tsx). Any signed-in member may ask; the company file's full path
 * is only included for people working on this computer (not teammates connected through
 * multi-user hosting, who don't need the host's folders).
 *
 * The desktop shell asks with its internal token for the lock's heartbeat (electron/main.js).
 * Every call also makes sure the autosave timer runs (lib/services/companyFileSave.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isInternalRequest } from '@/lib/net/internalToken';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { ensureAutosave, getCompanyFileSaveStatus } from '@/lib/services/companyFileSave';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    // The desktop shell asks too (its heartbeat tells other workstations whether the file is saved).
    // Anyone else must be signed in: before the Admin of a new file is set up there is nothing to
    // report, and getServerContext's first-run fallback would put a demo company in the file.
    if (!isInternalRequest(req)) {
      const db = await getDb();
      const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
      if (!anyUser) return NextResponse.json({ error: 'Authentication required.', code: 'FORBIDDEN' }, { status: 401 });
      await getServerContext();
    }
    ensureAutosave();
    const status = getCompanyFileSaveStatus();
    const { remote } = await getRequestOrigin();
    return NextResponse.json(remote ? { ...status, path: null, conflictCopy: null } : status);
  } catch (err) {
    return routeError(err, 'company-file/status');
  }
}
