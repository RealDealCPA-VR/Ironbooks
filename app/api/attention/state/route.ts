/**
 * POST /api/attention/state — snooze, dismiss or bring back one inbox item for the signed-in
 * person only.
 *
 * Body: { key: string, action: 'snooze' | 'dismiss' | 'restore', days?: 1 | 7 }
 * Response: { key, snoozedUntil: string | null, dismissed: boolean }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { parseAttentionStateBody, setAttentionState } from '@/lib/services/attention';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    return NextResponse.json(await setAttentionState(ctx, parseAttentionStateBody(body)));
  } catch (err) {
    return routeError(err, 'POST /api/attention/state');
  }
}
