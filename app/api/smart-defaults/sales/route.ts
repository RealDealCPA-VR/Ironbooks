/**
 * GET /api/smart-defaults/sales?form=invoice|sales_receipt|estimate|sales_order&customerId=<uuid>
 * Recall the customer's last sale of that form type (lib/services/smartDefaults.ts; query parsing in lib/smartDefaultsRoute.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getSmartDefaults } from '@/lib/services/smartDefaults';
import { parseSmartDefaultsQuery } from '@/lib/smartDefaultsRoute';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const input = parseSmartDefaultsQuery(req.nextUrl.searchParams, ['invoice', 'sales_receipt', 'estimate', 'sales_order']);
    return NextResponse.json(await getSmartDefaults(ctx, input));
  } catch (err) {
    return routeError(err, 'GET /api/smart-defaults/sales');
  }
}
