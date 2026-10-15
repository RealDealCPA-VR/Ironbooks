/**
 * POST /api/undo/commit { resource, kind, token?, id? } -> { token, label, kind, expiresAt, message }
 *
 * Called by the app's API client right AFTER a save / void / delete succeeded: arms the undo for
 * 30 seconds once the audit trail confirms the caller made that change (lib/services/undo.ts).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { readJsonObject, invalidJsonBody, routeError } from '@/lib/routeErrors';
import { commitUndo } from '@/lib/services/undo';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const out = await commitUndo(ctx, {
      resource: String(body.resource ?? ''),
      kind: String(body.kind ?? ''),
      token: typeof body.token === 'string' ? body.token : null,
      id: typeof body.id === 'string' ? body.id : null,
    });
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/undo/commit');
  }
}
