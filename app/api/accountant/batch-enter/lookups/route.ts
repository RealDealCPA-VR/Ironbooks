/**
 * GET /api/accountant/batch-enter/lookups — the company's accounts, customers, vendors, classes
 * and closing date, so the Batch Enter grid can match names / account numbers and flag problems
 * on each row while the user types or pastes (the POST re-checks everything on the server).
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { batchEnterLookups } from '@/lib/services/accountant/batchEnter';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await batchEnterLookups(ctx));
  } catch (err) {
    return routeError(err, '/api/accountant/batch-enter/lookups');
  }
}
