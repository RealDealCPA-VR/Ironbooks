/**
 * GET /api/backups/status — "Last backup: 2 hours ago" for the sidebar indicator and the
 * "no backup in 7 days" banner: when the company file was last backed up, whether the books
 * changed since, and the schedule. Also starts the in-process scheduled-backup timer (idempotent):
 * the indicator calls this on every page load, so automatic backups run while the app is open.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { ensureBackupScheduler, getBackupStatus } from '@/lib/services/backupSchedule';

export async function GET() {
  return withDamagedFileAccess(async () => {
    try {
      await getServerContext();
      ensureBackupScheduler();
      return NextResponse.json(getBackupStatus());
    } catch (err) {
      return routeError(err, 'backups/status');
    }
  });
}
