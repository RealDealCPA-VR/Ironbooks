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
 *
 * DAMAGED FILES: both handlers run with damaged-file access (lib/db/index.ts). A company file
 * whose ledger is damaged is refused everywhere else, but restoring a pre-condense archive copy
 * is one of the recovery paths the Back Up and Restore page offers, so it must still work (the
 * restored copy is verified before it goes live; restoreBackup). Permission checks are unchanged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir, withDamagedFileAccess } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { listCondenseArchives, restoreCondenseArchive } from '@/lib/services/condense';
import { ServiceError } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[condense/archives] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  return withDamagedFileAccess(() => handleGet());
}

export async function POST(req: NextRequest) {
  return withDamagedFileAccess(() => handlePost(req));
}

async function handleGet() {
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

async function handlePost(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // Restoring an archive copy replaces the whole company file (every company in it): same
    // gates as POST /api/backup — Admin of every company, and single-user mode while anyone
    // else is connected.
    await requireFileAdmin(ctx);
    await assertExclusiveAccess(ctx, 'Restore', { scope: 'file' });
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
    return NextResponse.json({
      restored: true,
      archive: summary,
      ...(result.notices?.length ? { notices: result.notices } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
