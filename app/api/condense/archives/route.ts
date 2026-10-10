/**
 * GET  /api/condense/archives — archive copies written before each condense of this company
 *                               file (newest first). Paths are reduced to file names.
 * POST /api/condense/archives — body { id }: restore that archive copy over the current
 *                               company file, bringing back the full pre-condense detail.
 *                               Owner/admin only; the current file is snapshotted first
 *                               (pre-op backup). Only recorded archives can be restored.
 *
 * SECURITY: middleware excludes /api from the session check, so both handlers fail closed via
 * getServerContext() before doing anything.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { listCondenseArchives, restoreCondenseArchive } from '@/lib/services/condense';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' || err.code === 'PERIOD_CLOSED' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[condense/archives] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const archives = listCondenseArchives(dataDirOf(ctx.db) ?? resolveDataDir())
      .filter((a) => a.companyId === ctx.companyId)
      .map(({ path: _path, dataDir: _dir, ...rest }) => rest);
    return NextResponse.json({ archives });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) {
      return NextResponse.json({ error: 'id is required.', code: 'VALIDATION' }, { status: 400 });
    }
    const dir = dataDirOf(ctx.db) ?? resolveDataDir();
    const archive = listCondenseArchives(dir).find((a) => a.id === id);
    if (!archive || archive.companyId !== ctx.companyId) {
      throw new ServiceError('NOT_FOUND', 'Archive copy not found.');
    }
    const result = await restoreCondenseArchive(ctx, id, dir);
    const { path: _path, dataDir: _dir, ...summary } = result.archive;
    return NextResponse.json({ restored: true, archive: summary });
  } catch (err) {
    return errorResponse(err);
  }
}
