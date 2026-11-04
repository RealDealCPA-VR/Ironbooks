/**
 * GET /api/portable — download a Portable Company File (`<Company>.bkp`) of the active
 * company file: a single compressed file with every table (incl. users + password hashes),
 * preferences, attachments and the transaction log, plus a checksummed manifest.
 *
 * Owner/admin only (the file contains every user's credentials).
 *
 * POST /api/portable { password?: string, protect?: boolean } — the same file protected with a
 * PASSWORD (filecrypto; the screens offer it, on by default): the whole file is encrypted and
 * opening it needs the password. `protect: false` (and no password) saves it without one. GET is
 * the file without a password. A company file protected with passwords only ever gets an
 * encrypted portable file: GET and `protect: false` are refused for it (400).
 *
 * SECURITY: middleware excludes /api from the session check, so this handler fails closed
 * via getServerContext() before producing any bytes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requireFileAdmin } from '@/lib/services/access';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { createPortableCompanyFile } from '@/lib/services/portableFile';
import { assertCopyPasswordGiven } from '@/lib/services/fileProtection';
import { ServiceError } from '@/lib/services/_base';
import { readJsonObject, serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, { status });
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
  return download(null);
}

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body', code: 'VALIDATION' }, { status: 400 });
  if (body.protect === false) return download(null);
  if (typeof body.password !== 'string' || !body.password) {
    return NextResponse.json({ error: 'Enter a password for the portable file, or choose to save it without one.', code: 'VALIDATION' }, { status: 400 });
  }
  return download(body.password);
}

async function download(password: string | null) {
  try {
    const ctx = await getServerContext();
    // The portable file carries EVERY company and user of this file: like a whole-file backup it
    // needs an Admin of every company (lib/services/access requireFileAdmin).
    await requireFileAdmin(ctx);
    // A company file protected with passwords: its portable file is protected too (never plain-text
    // books on disk) — GET and `protect: false` are refused for it.
    await assertCopyPasswordGiven(ctx.db, password);
    const { buffer, filename } = await createPortableCompanyFile(ctx, {
      dataDir: dataDirOf(ctx.db) ?? resolveDataDir(),
      password,
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
