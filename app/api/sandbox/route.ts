/**
 * Sandbox mode ("Try it on a copy") — lib/services/sandbox.ts.
 *
 * GET  /api/sandbox  → SandboxStatus: whether the active company file is a sandbox / training
 *                      file, what it was copied from, and (in the real file) copies left over.
 * POST /api/sandbox  → make a throwaway copy of the whole company file and switch the server to
 *                      it. Admin of every company in the file, nobody else logged in.
 *                      Returns { dir, realDir, id, sourceName, createdAt }; the desktop shell then
 *                      relaunches into `dir` (window.bookkeeper.sandbox.entered).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getSandboxStatus, startSandbox } from '@/lib/services/sandbox';
import { heldUnlock, reissueUnlockCookie } from '@/lib/sandboxUnlock';

export async function GET() {
  try {
    await getServerContext();
    return NextResponse.json(getSandboxStatus());
  } catch (err) {
    return routeError(err, 'sandbox');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const held = await heldUnlock();
    const res = NextResponse.json(await startSandbox(ctx), { status: 201 });
    return reissueUnlockCookie(res, held, req.headers);
  } catch (err) {
    return routeError(err, 'sandbox');
  }
}
