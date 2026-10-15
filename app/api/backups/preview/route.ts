/**
 * POST /api/backups/preview          — preview an uploaded .bka (raw bytes in the body)
 * POST /api/backups/preview?id=<id>  — preview a version from the backup history
 *
 * Opens the backup read-only in a temporary folder and returns its companies, transaction
 * counts, last transaction date, trial balance totals, backup date and app version, plus any
 * problem that would make the restore refuse it (lib/services/backupPreview.ts). The live company
 * file is not touched. A backup holds every company in the file, so this needs an Admin of every
 * company in the file (requireFileAdmin), the same gate as the restore it precedes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { withDamagedFileAccess } from '@/lib/db';
import { requireFileAdmin } from '@/lib/services/access';
import { readBackupVersion } from '@/lib/services/backupSchedule';
import { previewBackup } from '@/lib/services/backupPreview';

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(async () => {
    try {
      const ctx = await getServerContext();
      await requireFileAdmin(ctx);
      const id = req.nextUrl.searchParams.get('id');
      let buffer: Buffer;
      if (id) {
        buffer = readBackupVersion(id);
      } else {
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength) {
          return NextResponse.json({ error: 'Choose a backup file to preview.', code: 'VALIDATION' }, { status: 400 });
        }
        buffer = Buffer.from(bytes);
      }
      return NextResponse.json(await previewBackup(buffer));
    } catch (err) {
      return routeError(err, 'backups/preview');
    }
  });
}
