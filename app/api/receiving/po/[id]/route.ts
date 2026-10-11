/**
 * GET /api/receiving/po/:id — ordered / received / billed per line of a purchase order.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { poReceivingStatus } from '@/lib/services/receiving';
import { routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await poReceivingStatus(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/receiving/po/:id');
  }
}
