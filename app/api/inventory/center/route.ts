/**
 * GET /api/inventory/center — Inventory Center item list (?includeInactive=true, ?search=)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { inventoryCenterList } from '@/lib/services/lists/inventoryCenter';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const ctx = await getServerContext();
    return NextResponse.json({
      items: await inventoryCenterList(ctx, {
        includeInactive: sp.get('includeInactive') === 'true',
        search: sp.get('search') ?? undefined,
      }),
    });
  } catch (err) {
    return routeError(err, 'GET /api/inventory/center');
  }
}
