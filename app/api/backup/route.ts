/**
 * GET  /api/backup  — download a .bka backup of the active company data dir.
 * POST /api/backup  — restore from a .bka file (raw bytes in request body).
 *
 * SECURITY: middleware excludes /api from the session check, so both handlers
 * must fail closed themselves via getServerContext() (FORBIDDEN → 403) before
 * reading or writing any backup bytes.
 *
 * PERMISSIONS: both handlers act on the WHOLE data dir — every company in the file plus every
 * user's login — so beyond the route map's File Utilities check in the active company they
 * require the caller to be an active Admin of every company in the file (requireFileAdmin).
 *
 * NOTE (POST): restoreBackup validates the archive, closes the live PGlite
 * handle, swaps the data directory, then re-installs the ledger guards and verifies the
 * restored books; damaged books are refused (400, plain-language reason) and the original file
 * is rolled back. No process restart is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { createBackup, restoreBackup } from '@/lib/services/backup';
import { ServiceError } from '@/lib/services/_base';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { requireFileAdmin } from '@/lib/services/access';
import { withDamagedFileAccess } from '@/lib/db';
import { recordBackup } from '@/lib/services/attention';
import { recordBackup } from '@/lib/services/backupHistory';
import { currentFingerprint } from '@/lib/services/backupFingerprint';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[backup] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ---------------------------------------------------------------------------
// GET — download backup
// ---------------------------------------------------------------------------

// Both handlers run with damaged-file access: a company file whose ledger is damaged is refused
// everywhere else (lib/db/index.ts), but it must still be possible to back it up for support and
// to replace it by restoring a good backup.
export async function GET(req: NextRequest) {
  return withDamagedFileAccess(() => handleGet(req));
}

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handleGet(_req: NextRequest) {
  try {
    // Auth: fail closed BEFORE producing any backup bytes. A FORBIDDEN throw
    // here propagates to errorResponse() and returns 403.
    const ctx = await getServerContext();
    // The archive holds every company in the file and all password hashes.
    await requireFileAdmin(ctx);

    // Resolve the active company name for the filename (cosmetic only).
    let companyName: string | undefined;
    try {
      const company = await getCompany(ctx);
      companyName = company?.name ?? undefined;
    } catch {
      // The name lookup is cosmetic; proceed without it.
    }

    const fingerprint = currentFingerprint();
    const { buffer, filename } = createBackup(companyName);
    await recordBackup(ctx.db, { kind: 'full', userId: ctx.userId, filename }); // inbox: last backup
    // Backup history ("Last backup: …" indicator): a browser download has no path on this machine.
    recordBackup({ source: 'manual', kind: 'full', filename, path: null, sizeBytes: buffer.byteLength, fingerprint, note: 'Downloaded' });

    // NextResponse body must be a BodyInit-compatible type. Copy the Buffer
    // bytes into a fresh concrete ArrayBuffer to satisfy the type constraint.
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
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST — restore backup
// ---------------------------------------------------------------------------

async function handlePost(req: NextRequest) {
  try {
    // Auth: restore is destructive — fail closed before even reading the body. Restore replaces
    // every company in the file: Admin of every company, plus single-user mode while anyone
    // else is connected.
    const ctx = await getServerContext();
    await requireFileAdmin(ctx);
    await assertExclusiveAccess(ctx, 'Restore', { scope: 'file' });

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.' }, { status: 400 });
    }

    const buffer = Buffer.from(arrayBuffer);
    // Validates the archive, closes the live DB handle, swaps the data dir, re-installs the
    // ledger guards and verifies the books (rolls back and throws VALIDATION if damaged).
    const result = await restoreBackup(buffer);

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
