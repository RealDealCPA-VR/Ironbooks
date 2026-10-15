/**
 * POST /api/undo/prepare { resource, kind, id } -> { token }
 *
 * Called by the app's API client (lib/undoClient.ts) right BEFORE it sends an update / void /
 * delete: snapshots the record so the change can be undone for 30 seconds (lib/services/undo.ts).
 * Member route: the service checks the caller may read that record type (route permission map).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { readJsonObject, invalidJsonBody, routeError } from '@/lib/routeErrors';
import { prepareUndo } from '@/lib/services/undo';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const out = await prepareUndo(ctx, {
      resource: String(body.resource ?? ''),
      kind: String(body.kind ?? ''),
      id: String(body.id ?? ''),
    });
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/undo/prepare');
  }
}
