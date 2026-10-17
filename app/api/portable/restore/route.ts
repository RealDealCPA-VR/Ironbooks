/**
 * POST /api/portable/restore — open/restore a Portable Company File (.bkp, raw bytes in the
 * request body) into a NEW company data directory. The active company file is never touched.
 *
 * Query:
 *   inspect=1   only validate the file (checksums) and return a summary of its manifest
 *   target=…    absolute destination folder — honored ONLY for the desktop shell, which
 *               authenticates with its per-launch internal token (x-bka-internal) after the
 *               user picked the folder in a native Save dialog. Browser/session callers always
 *               restore into a fresh sibling folder of the active company file.
 *
 * Response 201: { dataDir, companyName, companies, rowCounts, verified }.
 * The restore verifies every table hash, the trial balance of every company, attachments and
 * the transaction log against the file's manifest, and refuses (400) on any mismatch.
 *
 * SECURITY: middleware excludes /api from the session check — this handler fails closed via
 * getServerContext() (owner/admin only) unless the internal token is valid.
 */
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { withDamagedFileAccess } from '@/lib/db';
import {
  defaultPortableRestoreDir,
  readPortableManifest,
  restorePortableCompanyFile,
} from '@/lib/services/portableFile';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[portable/restore] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Constant-time check of the x-bka-internal header against BKA_INTERNAL_TOKEN. */
function isInternal(req: NextRequest): boolean {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const internal = isInternal(req);
    if (!internal) {
      // The active company file is only used to check who is asking: opening a portable file
      // into a NEW folder never touches it, so it stays possible when the active file is damaged
      // (a damaged file is refused everywhere else; lib/db/index.ts).
      const ctx = await withDamagedFileAccess(() => getServerContext());
      // Same rule as creating a portable file: only the owner/admin may open one.
      if (ctx.role !== 'owner' && ctx.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', 'Only the company owner or an admin can open a portable company file.');
      }
    }

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.', code: 'VALIDATION' }, { status: 400 });
    }
    const buffer = Buffer.from(arrayBuffer);
    const params = req.nextUrl.searchParams;

    if (params.get('inspect') === '1') {
      const m = readPortableManifest(buffer);
      return NextResponse.json({
        companyName: m.companyName,
        createdAt: m.createdAt,
        appVersion: m.appVersion,
        companies: m.companies,
        rowCounts: m.rowCounts,
        transactionLogRecords: m.transactionLog?.records ?? 0,
        files: Object.keys(m.files ?? {}).length,
      });
    }

    let target: string;
    const requested = params.get('target');
    if (internal && requested) {
      if (!path.isAbsolute(requested)) {
        throw new ServiceError('VALIDATION', 'The destination folder must be an absolute path.');
      }
      target = requested;
    } else {
      target = defaultPortableRestoreDir(readPortableManifest(buffer).companyName);
    }

    const result = await restorePortableCompanyFile(buffer, target);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
