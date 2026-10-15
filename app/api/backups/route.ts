/**
 * GET /api/backups — backup history (with which versions are still on disk), the automatic
 *                    backup settings, the backup folder in use and the current status.
 * PUT /api/backups — save the automatic backup settings
 *                    { schedule: 'off'|'daily'|'hours', everyHours, keep, folder|null }.
 *
 * Backups cover the whole company file (every company in it), so changing where and how often it
 * is copied needs an Admin of every company in the file (requireFileAdmin), like backup/restore.
 * Both run with damaged-file access so a damaged file's backups can still be managed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { requireFileAdmin } from '@/lib/services/access';
import {
  backupFolder,
  defaultBackupFolder,
  readBackupSettings,
  saveBackupSettings,
} from '@/lib/services/backupHistory';
import { ensureBackupScheduler, getBackupStatus, listBackupHistory } from '@/lib/services/backupSchedule';

export async function GET() {
  return withDamagedFileAccess(async () => {
    try {
      await getServerContext();
      ensureBackupScheduler();
      const settings = readBackupSettings();
      return NextResponse.json({
        settings,
        folder: backupFolder(settings),
        defaultFolder: defaultBackupFolder(),
        status: getBackupStatus(),
        history: listBackupHistory(),
      });
    } catch (err) {
      return routeError(err, 'backups');
    }
  });
}

export async function PUT(req: NextRequest) {
  return withDamagedFileAccess(async () => {
    try {
      const ctx = await getServerContext();
      await requireFileAdmin(ctx);
      const body = await readJsonObject(req);
      if (!body) return invalidJsonBody();
      const settings = saveBackupSettings({
        schedule: body.schedule,
        everyHours: body.everyHours,
        keep: body.keep,
        folder: body.folder,
      });
      ensureBackupScheduler();
      return NextResponse.json({
        settings,
        folder: backupFolder(settings),
        defaultFolder: defaultBackupFolder(),
        status: getBackupStatus(),
      });
    } catch (err) {
      return routeError(err, 'backups');
    }
  });
}
