/**
 * POST /api/backups/run — "Back up now": save a full backup of the company file into the backup
 * folder (recorded in the history as a manual backup). Whole-file archive, so the caller must be
 * an Admin of every company in the file, like GET /api/backup.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { requireFileAdmin } from '@/lib/services/access';
import { fileLabel, getBackupStatus, runVersionedBackup } from '@/lib/services/backupSchedule';

export async function POST() {
  return withDamagedFileAccess(async () => {
    try {
      const ctx = await getServerContext();
      await requireFileAdmin(ctx);
      const result = await runVersionedBackup('manual', { force: true, companyName: await fileLabel() });
      return NextResponse.json({ ...result, backupStatus: getBackupStatus() });
    } catch (err) {
      return routeError(err, 'backups/run');
    }
  });
}
