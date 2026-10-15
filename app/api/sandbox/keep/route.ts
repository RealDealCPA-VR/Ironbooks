/**
 * POST /api/sandbox/keep  Body: { name: string }
 * Leave the sandbox but keep the copy as a training file named `name`, next to the real file
 * (never merged back), and switch back to the real company file. Same permission model as
 * /api/sandbox/discard (Admin of the REAL file, checked by the service).
 * Returns { realDir, trainingDir, name }. When the server is already back on the real file but the
 * copy could not be moved, the leave still succeeded: 200 with { realDir, trainingDir: null, name,
 * warning } so the client still tells the desktop shell it left (the copy is listed as left over).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { keepSandboxAsTraining } from '@/lib/services/sandbox';
import { heldUnlock, reissueUnlockCookie } from '@/lib/sandboxUnlock';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const held = await heldUnlock();
    return reissueUnlockCookie(NextResponse.json(await keepSandboxAsTraining(ctx, body.name)), held, req.headers);
  } catch (err) {
    return routeError(err, 'sandbox/keep');
  }
}
