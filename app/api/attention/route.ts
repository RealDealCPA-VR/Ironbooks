/**
 * GET /api/attention[?hidden=1] — the "Needs attention" inbox for the signed-in person: one
 * prioritized list (most urgent first) of only the items their roles let them act on.
 * `hidden=1` also returns the items they snoozed or dismissed (to bring one back).
 *
 * Response: AttentionResult (lib/services/attention.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getAttention } from '@/lib/services/attention';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeHidden = req.nextUrl.searchParams.get('hidden') === '1';
    return NextResponse.json(await getAttention(ctx, { includeHidden }));
  } catch (err) {
    return routeError(err, 'GET /api/attention');
  }
}
