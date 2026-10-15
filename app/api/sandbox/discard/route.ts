/**
 * POST /api/sandbox/discard — leave the sandbox: delete the copy and switch back to the real
 * company file. Mapped 'member' because the copy's own users and roles do not count: the service
 * checks the caller is an Admin of every company in the REAL file (lib/services/sandbox.ts).
 * Returns { realDir }; the desktop shell then relaunches into it (window.bookkeeper.sandbox.left).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { discardSandbox } from '@/lib/services/sandbox';
import { heldUnlock, reissueUnlockCookie } from '@/lib/sandboxUnlock';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const held = await heldUnlock();
    return reissueUnlockCookie(NextResponse.json(await discardSandbox(ctx)), held, req.headers);
  } catch (err) {
    return routeError(err, 'sandbox/discard');
  }
}
