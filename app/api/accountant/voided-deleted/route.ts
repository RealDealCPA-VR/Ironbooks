/** GET /api/accountant/voided-deleted?from=&to=&detail=1 — Voided/Deleted Transactions
 * Summary (or Detail with the original values). Dates filter WHEN the void/delete happened. */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { voidedDeletedTransactions } from '@/lib/services/accountant/auditReports';
import { dayParam } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await voidedDeletedTransactions(ctx, {
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
        detail: sp.get('detail') === '1',
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/voided-deleted');
  }
}
