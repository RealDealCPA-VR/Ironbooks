/**
 * Copies of this company file left over from an earlier sandbox (e.g. the web server restarted
 * while in the sandbox, which brings it back on the real file).
 *
 * POST   /api/sandbox/leftovers/[id] → re-open that copy as the sandbox (same rules as starting one)
 * DELETE /api/sandbox/leftovers/[id] → delete that copy
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { discardLeftoverSandbox, resumeSandbox } from '@/lib/services/sandbox';
import { heldUnlock, reissueUnlockCookie } from '@/lib/sandboxUnlock';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Next.js hands route params already URL-decoded; decoding again would break copies of a
// company named like "50% Off LLC" (and answer 500 on a stray "%").
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const held = await heldUnlock();
    return reissueUnlockCookie(NextResponse.json(await resumeSandbox(ctx, id)), held, req.headers);
  } catch (err) {
    return routeError(err, 'sandbox/leftovers');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    await discardLeftoverSandbox(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'sandbox/leftovers');
  }
}
