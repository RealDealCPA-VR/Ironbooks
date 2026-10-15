/**
 * POST /api/accountant-copy/cancel — remove the Accountant's Copy restriction without importing
 * (QB "Remove Restrictions"). The cancelled copy's changes file is refused from then on.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { cancelAccountantCopy } from '@/lib/services/accountantCopy/client';

export async function POST() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await cancelAccountantCopy(ctx));
  } catch (err) {
    return routeError(err, '/api/accountant-copy/cancel');
  }
}
