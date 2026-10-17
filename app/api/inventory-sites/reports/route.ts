/**
 * GET /api/inventory-sites/reports?report=<name>&...
 *   qoh            Quantity on Hand by Site          (?siteId= &itemId= &includeZero=1)
 *   stock-status   Inventory Stock Status by Site    (?siteId= &itemId=)
 *   reorder        Inventory Reorder Report by Site  (?siteId=)
 *   serial-lot     Serial/Lot Numbers in Stock       (?siteId= &itemId=)
 *   transactions   Transactions by Serial/Lot Number (?serialNumber= | ?lotNumber= &itemId= &includeReversed=1)
 *   item           One item across sites, bins, serials and lots (?itemId= required)
 *   invariants     Advanced Inventory self-check (sites add up, serials unique, GL == valuation)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  itemSiteDetail,
  quantityOnHandBySite,
  reorderBySite,
  serialLotInStock,
  stockStatusBySite,
  transactionsBySerialLot,
  verifySiteInvariants,
} from '@/lib/services/inventorySiteReports';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[inventory-sites/reports]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const siteId = sp.get('siteId') || null;
    const itemId = sp.get('itemId') || null;
    switch (sp.get('report')) {
      case 'qoh':
        return NextResponse.json(await quantityOnHandBySite(ctx, { siteId, itemId, includeZero: sp.get('includeZero') === '1' }));
      case 'stock-status':
        return NextResponse.json(await stockStatusBySite(ctx, { siteId, itemId }));
      case 'reorder':
        return NextResponse.json(await reorderBySite(ctx, { siteId }));
      case 'serial-lot':
        return NextResponse.json(await serialLotInStock(ctx, { siteId, itemId }));
      case 'transactions':
        return NextResponse.json(
          await transactionsBySerialLot(ctx, {
            serialNumber: sp.get('serialNumber'),
            lotNumber: sp.get('lotNumber'),
            itemId,
            includeReversed: sp.get('includeReversed') === '1',
          }),
        );
      case 'item':
        if (!itemId) {
          return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
        }
        return NextResponse.json(await itemSiteDetail(ctx, itemId));
      case 'invariants':
        return NextResponse.json(await verifySiteInvariants(ctx));
      default:
        return NextResponse.json(
          { error: 'report must be one of qoh, stock-status, reorder, serial-lot, transactions, item, invariants', code: 'VALIDATION' },
          { status: 400 },
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}
