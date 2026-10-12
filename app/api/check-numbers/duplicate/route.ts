/**
 * GET /api/check-numbers/duplicate?paymentAccountId=&number=&excludeSource=&excludeId=
 *   QB duplicate check number check, run by Write Checks / Pay Bills / Print Checks before
 *   saving. -> { duplicate: boolean, matches: [{ source, id, date, amount }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { findDuplicateCheckNumbers, type CheckNumberUse } from '@/lib/services/checkNumbers';
import { routeError } from '@/lib/routeErrors';

const SOURCES = ['expense', 'bill_payment', 'paycheck'];

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const q = req.nextUrl.searchParams;
    const paymentAccountId = q.get('paymentAccountId');
    if (!paymentAccountId) return NextResponse.json({ duplicate: false, matches: [] });
    const exSource = q.get('excludeSource');
    const exId = q.get('excludeId');
    const matches = await findDuplicateCheckNumbers(ctx, {
      paymentAccountId,
      number: q.get('number'),
      exclude:
        exSource && exId && SOURCES.includes(exSource)
          ? { source: exSource as CheckNumberUse['source'], id: exId }
          : undefined,
    });
    return NextResponse.json({ duplicate: matches.length > 0, matches });
  } catch (err) {
    return routeError(err, 'GET /api/check-numbers/duplicate');
  }
}
