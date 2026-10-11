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
 * handle, and atomically swaps the data directory. The next getDb() call
 * reopens the restored data — no process restart is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { createBackup, restoreBackup } from '@/lib/services/backup';
import { ServiceError } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';

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

export async function GET(_req: NextRequest) {
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

    const { buffer, filename } = createBackup(companyName);

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

export async function POST(req: NextRequest) {
  try {
    // Auth: restore is destructive — fail closed before even reading the body.
    const ctx = await getServerContext();
    // Restore replaces every company in the file.
    await requireFileAdmin(ctx);

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.' }, { status: 400 });
    }

    const buffer = Buffer.from(arrayBuffer);
    // Validates the archive, closes the live DB handle, and swaps the data dir
    // atomically; the next getDb() reopens the restored data.
    const result = await restoreBackup(buffer);

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
