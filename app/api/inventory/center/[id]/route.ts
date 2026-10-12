/**
 * GET /api/inventory/center/:id — one inventory item: details, stock picture and transactions
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { inventoryItemDetail } from '@/lib/services/lists/inventoryCenter';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await inventoryItemDetail(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/inventory/center/:id');
  }
}
