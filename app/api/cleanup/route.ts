/**
 * Clean Up Company Data — remove unused inactive list entries.
 * GET  /api/cleanup?lists=a,b — preview what would be removed (per list)
 * POST /api/cleanup — { lists?, ids? } remove them (re-checked; anything now in use is kept)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { CLEANUP_LIST_KEYS, type CleanupList, previewCleanup, runCleanup } from '@/lib/services/lists/cleanup';
import { cleanupSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get('lists');
    const lists = raw ? (raw.split(',').filter(Boolean) as CleanupList[]) : CLEANUP_LIST_KEYS;
    if (lists.some((l) => !CLEANUP_LIST_KEYS.includes(l))) {
      return NextResponse.json({ error: 'Unknown list', code: 'VALIDATION' }, { status: 400 });
    }
    const ctx = await getServerContext();
    return NextResponse.json(await previewCleanup(ctx, lists));
  } catch (err) {
    return routeError(err, 'GET /api/cleanup');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = cleanupSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await runCleanup(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/cleanup');
  }
}
