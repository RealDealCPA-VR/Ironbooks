/**
 * GET  /api/single-user — the current single-user-mode holder (or null).
 * POST /api/single-user { enabled: true | false } — switch to single-user mode (owner/admin;
 *      refused with 409 listing who is still connected) or back to multi-user mode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { enterSingleUserMode, exitSingleUserMode, getSingleUserMode } from '@/lib/services/sessions';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[single-user] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const holder = await getSingleUserMode(ctx.db, ctx.companyId);
    return NextResponse.json({
      singleUser: holder ? { ...holder, isYou: holder.sessionId === ctx.sessionId } : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled (boolean) is required.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (body.enabled) {
      const holder = await enterSingleUserMode(ctx);
      return NextResponse.json({ singleUser: { ...holder, isYou: true } });
    }
    await exitSingleUserMode(ctx);
    return NextResponse.json({ singleUser: null });
  } catch (err) {
    return errorResponse(err);
  }
}
