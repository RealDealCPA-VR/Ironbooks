/**
 * GET /api/bills/duplicate-number?vendorId=&billNumber=&excludeId=
 *   QB duplicate vendor reference number check, run by the Enter Bills form before saving.
 *   -> { duplicate: boolean, matches: [{ id, date, total, billNumber }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { findDuplicateBillNumbers } from '@/lib/services/bills';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const q = req.nextUrl.searchParams;
    const vendorId = q.get('vendorId');
    if (!vendorId) return NextResponse.json({ duplicate: false, matches: [] });
    const matches = await findDuplicateBillNumbers(ctx, {
      vendorId,
      billNumber: q.get('billNumber'),
      excludeId: q.get('excludeId') ?? undefined,
    });
    return NextResponse.json({ duplicate: matches.length > 0, matches });
  } catch (err) {
    return routeError(err, 'GET /api/bills/duplicate-number');
  }
}
