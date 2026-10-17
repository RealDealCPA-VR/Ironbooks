/**
 * POST /api/dashboard/auto-backup?save=1 — the Electron shell's quit-time auto-backup: the
 * server writes a versioned .bka into the configured backup folder (default userData/backups,
 * passed as BKA_BACKUP_DIR), records it in the backup history as a quit-time backup and rotates
 * the folder to the last N versions (lib/services/backupSchedule.ts). Skipped (200,
 * { status: 'unchanged' }) when nothing changed since the newest version. Never overlaps a
 * scheduled backup that is already running.
 *
 * POST /api/dashboard/auto-backup?start=1 — the Electron shell calls this at launch so the
 * in-process scheduled-backup timer runs whoever signs in (lib/services/backupSchedule.ts);
 * returns { status: 'started' } and makes no backup.
 *
 * POST /api/dashboard/auto-backup (no ?save) — legacy: returns the .bka bytes for the caller to
 * store (older shells); recorded in the history as a quit-time backup with no path.
 *
 * Auth: the Electron main process has no session cookie, so it authenticates with the
 * per-launch random internal token it generated itself and passed to this server as
 * BKA_INTERNAL_TOKEN (same trusted-local-system pattern as /api/recurring/run — the
 * server is bound to 127.0.0.1 and the token never leaves the machine). A normal
 * authenticated session is also accepted.
 *
 * NOTE: GET /api/backup is the user-facing manual download and requires a session;
 * this route exists because the desktop shell cannot present one. It reuses the exact
 * same createBackup() service, so the archive format is identical.
 */
import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { createBackup } from '@/lib/services/backup';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';
import { recordBackup } from '@/lib/services/backupHistory';
import { currentFingerprint } from '@/lib/services/backupFingerprint';
import { ensureBackupScheduler, runVersionedBackup } from '@/lib/services/backupSchedule';
import { assertNotSandbox } from '@/lib/services/sandboxState';
import { serviceErrorStatus } from '@/lib/routeErrors';

/** Constant-time check of the x-bka-internal header against BKA_INTERNAL_TOKEN. */
async function internalContext(req: NextRequest): Promise<ServiceContext | null> {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return null;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const [company] = await db
    .select({ id: companies.id, ownerId: companies.ownerId })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!company) return null;
  return { db, companyId: company.id, userId: company.ownerId };
}

export async function POST(req: NextRequest) {
  try {
    // Fail closed BEFORE producing any backup bytes.
    let ctx = await internalContext(req);
    if (!ctx) {
      // A user session gets the same whole-file archive as GET /api/backup, so it needs the
      // same gate: an active Admin of every company in the file.
      ctx = await getServerContext();
      await requireFileAdmin(ctx);
    }
    // Sandbox mode: the quit-time / scheduled auto-backup is of the REAL file only — never of a
    // practice copy (it would rotate real backups out of the backups folder). Checked before
    // every mode: ?start=1 (scheduler), ?save=1 (versioned quit-time backup) and the legacy bytes.
    assertNotSandbox('Automatic backup');

    if (req.nextUrl.searchParams.get('start') === '1') {
      ensureBackupScheduler();
      return NextResponse.json({ status: 'started' });
    }

    // Company name is cosmetic (filename slug only).
    let companyName: string | undefined;
    try {
      companyName = (await getCompany(ctx))?.name ?? undefined;
    } catch {
      /* proceed without it */
    }

    if (req.nextUrl.searchParams.get('save') === '1') {
      const result = await runVersionedBackup('quit', { companyName: companyName ?? null });
      return NextResponse.json(
        result.status === 'created'
          ? { status: 'created', filename: result.record.filename, path: result.record.path, sizeBytes: result.record.sizeBytes, pruned: result.pruned }
          : result,
      );
    }

    const fingerprint = currentFingerprint();
    const { buffer, filename } = createBackup(companyName);
    recordBackup({ source: 'quit', kind: 'full', filename, path: null, sizeBytes: buffer.byteLength, fingerprint, note: 'Automatic backup when the app closed' });
    const arrayBuf: ArrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(arrayBuf, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    // Do not leak raw error text (may contain absolute data-dir paths).
    console.error('[auto-backup] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
