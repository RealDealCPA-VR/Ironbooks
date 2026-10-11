/**
 * GET /api/inventory/stock-by-vendor — Inventory Stock Status by Vendor (grouped by preferred vendor)
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { stockStatusByVendor } from '@/lib/services/lists/itemTools';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await stockStatusByVendor(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/inventory/stock-by-vendor');
  }
}
