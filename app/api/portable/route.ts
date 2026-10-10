/**
 * GET /api/portable — download a Portable Company File (`<Company>.bkp`) of the active
 * company file: a single compressed file with every table (incl. users + password hashes),
 * preferences, attachments and the transaction log, plus a checksummed manifest.
 *
 * Owner/admin only (the file contains every user's credentials).
 *
 * SECURITY: middleware excludes /api from the session check, so this handler fails closed
 * via getServerContext() before producing any bytes.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { createPortableCompanyFile } from '@/lib/services/portableFile';
import { ServiceError } from '@/lib/services/_base';

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
  console.error('[portable] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** RFC 5987 filename* so names with spaces/accents survive the download. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const { buffer, filename } = await createPortableCompanyFile(ctx, {
      dataDir: dataDirOf(ctx.db) ?? resolveDataDir(),
    });
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(filename),
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
