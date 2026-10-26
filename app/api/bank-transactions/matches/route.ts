/**
 * GET /api/bank-transactions/matches?bankAccountId=<uuid>
 *
 * Match candidates (QB Bank Feeds "Match") for every line of the bank account that is waiting for
 * review, in one request: { matches: { [bankTransactionId]: MatchCandidate[] } }. Same rules as
 * GET /api/bank-transactions/[id]/matches (posted entries on the bank's GL account for exactly the
 * line's amount, within ±14 days, not matched to another line of this feed). The review screen
 * used to make one request per line — thousands after a first import of a year of history.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { suggestMatchesForAccount } from '@/lib/services/bankCategorize';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const bankAccountId = req.nextUrl.searchParams.get('bankAccountId');
    if (!bankAccountId || !z.string().uuid().safeParse(bankAccountId).success) {
      return NextResponse.json({ error: 'bankAccountId query parameter is required.', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ matches: await suggestMatchesForAccount(ctx, bankAccountId) });
  } catch (err) {
    return routeError(err, 'GET /api/bank-transactions/matches');
  }
}
