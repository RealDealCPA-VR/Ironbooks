/**
 * GET  /api/backup/company?companyId=<id>  — download a per-company .bka (one tenant's rows).
 * POST /api/backup/company?name=<optional> — restore a per-company .bka as a NEW company
 *                                            (raw bytes in request body). Other companies
 *                                            in the data dir are never touched.
 *
 * SECURITY: middleware excludes /api from the session check, so both handlers fail closed
 * via getServerContext(). The route map only authorizes File Utilities in the ACTIVE company,
 * so export re-checks the TARGET company: the caller must be an active member there with
 * File Utilities 'create' (requireAccessInCompany). Sensitive fields (SSNs / tax IDs, bank and
 * account numbers) are masked in the export unless the caller's roles in that company grant the
 * matching flags. Restore requires File Utilities 'delete' in the active company (route map).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createCompanyBackup, restoreCompanyBackup } from '@/lib/services/backup';
import { ServiceError } from '@/lib/services/_base';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { requireAccessInCompany, requirePermission } from '@/lib/services/access';
import { recordBackup } from '@/lib/services/backupHistory';

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
  console.error('[backup/company] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ---------------------------------------------------------------------------
// GET — download a per-company backup
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const companyId = req.nextUrl.searchParams.get('companyId') ?? ctx.companyId;
    const access = await requireAccessInCompany(ctx, companyId, 'file_utilities', 'create');

    const { buffer, filename } = await createCompanyBackup(ctx.db, companyId, { access });
    // Backup history: a one-company copy (does not count as a backup of the whole file).
    recordBackup({ source: 'manual', kind: 'company', filename, path: null, sizeBytes: buffer.byteLength, fingerprint: null, note: 'Company backup downloaded' });
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
// POST — restore as a NEW company
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    requirePermission(ctx, 'file_utilities', 'delete');
    if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Authentication required.');
    await assertExclusiveAccess(ctx, 'Restore'); // adds a NEW company: other companies untouched

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.' }, { status: 400 });
    }

    const name = req.nextUrl.searchParams.get('name') ?? undefined;
    const result = await restoreCompanyBackup(ctx.db, Buffer.from(arrayBuffer), {
      ownerId: ctx.userId,
      name,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
