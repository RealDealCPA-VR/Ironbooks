/**
 * GET /api/backups/status — "Last backup: 2 hours ago" for the sidebar indicator and the
 * "no backup in 7 days" banner: when the company file was last backed up, whether the books
 * changed since, and the schedule. Also starts the in-process scheduled-backup timer (idempotent):
 * the indicator calls this on every page load, so automatic backups run while the app is open.
 *
 * The timer is started BEFORE the permission check: automatic backups protect the file whoever is
 * using it (a Bookkeeper without File Utilities still gets 403 for the status itself). Starting it
 * only sets a local timer; it reveals nothing and changes no data. The desktop shell also starts
 * it at launch (POST /api/dashboard/auto-backup?start=1).
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { ensureBackupScheduler, getBackupStatus } from '@/lib/services/backupSchedule';

export async function GET() {
  return withDamagedFileAccess(async () => {
    ensureBackupScheduler();
    try {
      await getServerContext();
      return NextResponse.json(getBackupStatus());
    } catch (err) {
      return routeError(err, 'backups/status');
    }
  });
}
