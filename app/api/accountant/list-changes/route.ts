/**
 * Review List Changes.
 * GET  /api/accountant/list-changes?since=&includeReviewed=1&entityType=
 * POST /api/accountant/list-changes { auditLogIds, reviewed } → mark (un)reviewed
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listListChanges, markListChangesReviewed } from '@/lib/services/accountant/listChanges';
import { zodErrorBody } from '@/lib/validation/helpers';
import { listChangesReviewSchema } from '@/lib/validation/accountant';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listListChanges(ctx, {
        since: sp.get('since'), // a calendar day in the company's time zone
        includeReviewed: sp.get('includeReviewed') === '1',
        entityType: sp.get('entityType') || null,
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/list-changes');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = listChangesReviewSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await markListChangesReviewed(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/accountant/list-changes');
  }
}
