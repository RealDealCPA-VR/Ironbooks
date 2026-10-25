/**
 * GET /api/company-file/info — what the sign-in screen shows before anyone signs in, like
 * QuickBooks' "QuickBooks Desktop Login" box: the company's name, the company file it lives in,
 * and whether the file has users yet (a brand-new file sets up its Admin instead).
 *
 * Public, read-only. The file's location on disk is only shared with this computer, never with
 * teammates connecting through multi-user hosting.
 */
import path from 'node:path';
import { NextResponse } from 'next/server';
import { ne } from 'drizzle-orm';
import { getDb, resolveDataDir, withDamagedFileAccess } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { companyFileId } from '@/lib/auth';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { companyFilePath } from '@/lib/services/companyFileSave';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    return await withDamagedFileAccess(async () => {
      const db = await getDb();
      const lock = await getFileLockStatus(db);
      // The seeded demo user (password hash 'dev') doesn't count as a real user.
      const [realUser] = await db.select({ id: users.id }).from(users).where(ne(users.passwordHash, 'dev')).limit(1);
      const { remote } = await getRequestOrigin();
      const file = companyFilePath();
      const location = file ?? resolveDataDir();
      return NextResponse.json({
        companyName: lock.companyName,
        fileName: path.basename(location),
        location: remote ? null : location,
        singleFile: Boolean(file),
        hasUsers: Boolean(realUser),
        filePassword: lock.enabled,
        fileId: companyFileId(),
        remote,
      });
    });
  } catch (err) {
    return routeError(err, 'company-file/info');
  }
}
