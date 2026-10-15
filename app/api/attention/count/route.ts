/**
 * GET /api/attention/count — how many items need the signed-in person's attention (the sidebar
 * badge). Response: { count: number }
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { attentionCount } from '@/lib/services/attention';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ count: await attentionCount(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/attention/count');
  }
}
