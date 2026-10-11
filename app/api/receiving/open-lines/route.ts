/**
 * GET /api/receiving/open-lines?vendorId= — received-but-not-billed item receipt lines for a
 * vendor, with PO ordered quantity / price for variance display.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listOpenReceiptLines } from '@/lib/services/receiving';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const vendorId = req.nextUrl.searchParams.get('vendorId');
    if (!vendorId) return NextResponse.json({ error: 'vendorId is required', code: 'VALIDATION' }, { status: 400 });
    return NextResponse.json({ lines: await listOpenReceiptLines(ctx, vendorId) });
  } catch (err) {
    return routeError(err, 'GET /api/receiving/open-lines');
  }
}
