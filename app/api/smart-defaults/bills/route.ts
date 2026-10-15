/**
 * GET /api/smart-defaults/bills?form=bill&vendorId=<uuid>
 * Recall the vendor's last bill (lib/services/smartDefaults.ts; query parsing in lib/smartDefaultsRoute.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getSmartDefaults } from '@/lib/services/smartDefaults';
import { parseSmartDefaultsQuery } from '@/lib/smartDefaultsRoute';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const input = parseSmartDefaultsQuery(req.nextUrl.searchParams, ['bill']);
    return NextResponse.json(await getSmartDefaults(ctx, input));
  } catch (err) {
    return routeError(err, 'GET /api/smart-defaults/bills');
  }
}
