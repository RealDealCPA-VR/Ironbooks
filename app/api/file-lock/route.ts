/**
 * Company-file password management.
 *  GET  /api/file-lock              -> { enabled, companyName }
 *  POST /api/file-lock { action: 'set' | 'remove', password?, currentPassword? }
 *
 * Requires the file to be open (getServerContext enforces the lock + any login), so only someone
 * already inside the file can set, change, or remove its password — and, via the central
 * permission map, only roles with Users & Roles 'modify'. The password locks EVERY company in
 * the file, so changing it also requires an active Admin of every company in the file
 * (requireFileAdmin). Changes are audited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  getFileLockStatus,
  setFilePassword,
  removeFilePassword,
} from '@/lib/services/fileLock';
import { ServiceError, writeAudit } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[file-lock]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getFileLockStatus(ctx.db));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    await requireFileAdmin(ctx);
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === 'set') {
      await setFilePassword(ctx.db, String(body?.password ?? ''), {
        currentPassword:
          typeof body?.currentPassword === 'string' ? body.currentPassword : undefined,
      });
    } else if (action === 'remove') {
      await removeFilePassword(ctx.db, String(body?.currentPassword ?? ''));
    } else {
      return NextResponse.json(
        { error: "action must be 'set' or 'remove'", code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const status = await getFileLockStatus(ctx.db);
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'file_password',
      entityId: ctx.companyId,
      newValues: { action, enabled: status.enabled }, // never the password itself
    });
    return NextResponse.json(status);
  } catch (err) {
    return errorResponse(err);
  }
}
