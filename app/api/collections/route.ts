/** GET /api/collections?almostDueDays=7 — Collections Center (wave2 sales C9). */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { collectionsCenter } from '@/lib/services/incomeTracker';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const n = Number(req.nextUrl.searchParams.get('almostDueDays') ?? '7');
    return NextResponse.json(await collectionsCenter(ctx, { almostDueDays: Number.isFinite(n) ? n : 7 }));
  } catch (err) {
    return routeError(err, 'GET /api/collections');
  }
}
