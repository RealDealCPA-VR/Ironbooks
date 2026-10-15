/**
 * POST /api/attention/backup — "Back up now" from the inbox: writes a full backup (.bka) of the
 * company file to the backups folder beside it on this computer (nothing is uploaded) and
 * records it, so the stale-backup reminder clears. Same gate as File > Back Up: File Utilities
 * plus being an Admin of every company in the file (checked by the service).
 *
 * Response: { filename, folder, createdAt }
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { backupNow } from '@/lib/services/attention';

export async function POST() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await backupNow(ctx));
  } catch (err) {
    return routeError(err, 'POST /api/attention/backup');
  }
}
