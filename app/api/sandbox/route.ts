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
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getSandboxStatus, startSandbox } from '@/lib/services/sandbox';

export async function GET() {
  try {
    await getServerContext();
    return NextResponse.json(getSandboxStatus());
  } catch (err) {
    return routeError(err, 'sandbox');
  }
}

export async function POST() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await startSandbox(ctx), { status: 201 });
  } catch (err) {
    return routeError(err, 'sandbox');
  }
}
