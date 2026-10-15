/**
 * GET /api/month-end-close?periodEnd=YYYY-MM-DD
 *   → { checklist, history } — the live month-end checklist for the period (status per step,
 *     saved review progress, whether the caller may set the closing date) plus the periods
 *     already worked on. Read-only. See lib/services/monthEndClose.ts.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getMonthEndChecklist, listMonthEndCloses } from '@/lib/services/monthEndClose';
import { validation } from '@/lib/services/_base';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const periodEnd = req.nextUrl.searchParams.get('periodEnd');
    if (!periodEnd) throw validation('periodEnd is required (YYYY-MM-DD).');
    const [checklist, history] = await Promise.all([getMonthEndChecklist(ctx, periodEnd), listMonthEndCloses(ctx)]);
    return NextResponse.json({ checklist, history });
  } catch (err) {
    return routeError(err, '/api/month-end-close');
  }
}
