/**
 * GET /api/items/barcode?code=<scanned> — resolve a scanned barcode (exact barcode match,
 * then a unique case-insensitive SKU) to an active item. 404 when nothing matches.
 * Used by the scan-to-add box on transaction line grids (keyboard-wedge scanners).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { findItemByBarcode } from '@/lib/services/items';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const code = req.nextUrl.searchParams.get('code') ?? '';
    if (!code.trim()) {
      return NextResponse.json({ error: 'code is required', code: 'VALIDATION' }, { status: 400 });
    }
    const item = await findItemByBarcode(ctx, code);
    if (!item) {
      return NextResponse.json({ error: `No item has barcode "${code.trim()}".`, code: 'NOT_FOUND' }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[items/barcode]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
