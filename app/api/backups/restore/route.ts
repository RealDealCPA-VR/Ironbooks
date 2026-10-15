/**
 * POST /api/backups/restore { id } — restore a version from the backup history (after the
 * person has seen its preview). Same path and safeguards as POST /api/backup: Admin of every
 * company in the file, single-user mode, a pre-restore safety copy, and restoreBackup's integrity
 * checks (a damaged backup is refused and the current file is left untouched).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { requireFileAdmin } from '@/lib/services/access';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { restoreBackup } from '@/lib/services/backup';
import { ServiceError } from '@/lib/services/_base';
import { readBackupVersion } from '@/lib/services/backupSchedule';

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(async () => {
    try {
      const ctx = await getServerContext();
      await requireFileAdmin(ctx);
      await assertExclusiveAccess(ctx, 'Restore', { scope: 'file' });
      const body = await readJsonObject(req);
      if (!body) return invalidJsonBody();
      if (typeof body.id !== 'string' || !body.id) {
        throw new ServiceError('VALIDATION', 'Choose a backup to restore.');
      }
      const result = await restoreBackup(readBackupVersion(body.id));
      return NextResponse.json(result);
    } catch (err) {
      return routeError(err, 'backups/restore');
    }
  });
}
