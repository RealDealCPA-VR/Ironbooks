/**
 * GET /api/company-file/info — what the sign-in screen shows before anyone signs in, like
 * QuickBooks' "QuickBooks Desktop Login" box: the company's name, the company file it lives in,
 * and whether the file has users yet (a brand-new file sets up its Admin instead).
 *
 * A company file protected with passwords that has not been decrypted yet (lib/db/sealed.ts)
 * answers from its plain manifest only (the company name and file id are all it shows): the
 * sign-in itself decrypts it. `protected` lets the screen offer the recovery key.
 *
 * Public, read-only. The file's location on disk is only shared with this computer, never with
 * teammates connecting through multi-user hosting.
 */
import path from 'node:path';
import { NextResponse } from 'next/server';
import { ne } from 'drizzle-orm';
import { getDb, resolveDataDir, sealedMode, withDamagedFileAccess, withSealedAccess } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { companyFileId } from '@/lib/auth';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { companyFilePath } from '@/lib/services/companyFileSave';
import { readProtection, sealedFileInfo } from '@/lib/services/fileProtection';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    return await withDamagedFileAccess(async () => {
      const { remote } = await getRequestOrigin();
      const file = companyFilePath();
      const location = file ?? resolveDataDir();
      const sealed = sealedMode();
      if (sealed === 'extract' || sealed === 'conflict') {
        const info = sealedFileInfo();
        return NextResponse.json({
          companyName: info?.companyName ?? null,
          fileName: path.basename(location),
          location: remote ? null : location,
          singleFile: Boolean(file),
          hasUsers: true,
          filePassword: null,
          fileId: info?.fileId ?? companyFileId(),
          remote,
          protected: true,
        });
      }
      const db = sealed === 'key' ? await withSealedAccess(() => getDb()) : await getDb();
      const lock = await getFileLockStatus(db);
      // The seeded demo user (password hash 'dev') doesn't count as a real user.
      const [realUser] = await db.select({ id: users.id }).from(users).where(ne(users.passwordHash, 'dev')).limit(1);
      return NextResponse.json({
        companyName: lock.companyName,
        fileName: path.basename(location),
        location: remote ? null : location,
        singleFile: Boolean(file),
        hasUsers: Boolean(realUser),
        filePassword: lock.enabled,
        fileId: companyFileId(),
        remote,
        protected: Boolean(await readProtection(db)),
      });
    });
  } catch (err) {
    return routeError(err, 'company-file/info');
  }
}
