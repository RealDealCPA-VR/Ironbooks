/**
 * GET  /api/sessions — multi-user status for the caller's company: who is logged in
 *                      (owner/admin see everyone; others only their own session plus a head
 *                      count), the single-user-mode holder, and this request's session id.
 * POST /api/sessions { action: 'sign-out-others' } — owner/admin: sign out every other session
 *                      in this company (e.g. before switching to single-user mode).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import {
  ACTIVE_WINDOW_MS,
  getSingleUserMode,
  isAdminRole,
  listActiveSessions,
  signOutOtherSessions,
} from '@/lib/services/sessions';

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
  console.error('[sessions] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const isAdmin = isAdminRole(ctx.role);
    // Scoped to members of the caller's company — other companies in the file are never shown.
    const all = await listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId, companyId: ctx.companyId });
    const singleUser = await getSingleUserMode(ctx.db, ctx.companyId);
    return NextResponse.json({
      isAdmin,
      currentSessionId: ctx.sessionId ?? null,
      activeWindowMinutes: ACTIVE_WINDOW_MS / 60000,
      sessions: isAdmin ? all : all.filter((s) => s.isCurrent),
      connectedCount: all.length,
      singleUser: singleUser ? { ...singleUser, isYou: singleUser.sessionId === ctx.sessionId } : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (body?.action !== 'sign-out-others') {
      return NextResponse.json({ error: 'Unknown action.', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ signedOut: await signOutOtherSessions(ctx) });
  } catch (err) {
    return errorResponse(err);
  }
}
