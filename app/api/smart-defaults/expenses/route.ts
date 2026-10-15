/**
 * GET /api/smart-defaults/expenses?form=check|expense|credit_card&vendorId=<uuid>&paymentAccountId=<uuid>
 * Recall the vendor's last check / expense / card charge, plus the next check number for the bank account (lib/services/smartDefaults.ts; query parsing in lib/smartDefaultsRoute.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getSmartDefaults } from '@/lib/services/smartDefaults';
import { parseSmartDefaultsQuery } from '@/lib/smartDefaultsRoute';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const input = parseSmartDefaultsQuery(req.nextUrl.searchParams, ['check', 'expense', 'credit_card']);
    return NextResponse.json(await getSmartDefaults(ctx, input));
  } catch (err) {
    return routeError(err, 'GET /api/smart-defaults/expenses');
  }
}
