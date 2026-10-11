/**
 * GET /api/fulfillment/packing-slips?s=<JSON selections> — one packing slip per selected sales
 * order (quantities that will ship, no prices), merged into one PDF.
 */
import { NextRequest } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { renderPackingSlipsPdf } from '@/lib/pdf/pickList';
import { packingSlipData, shipmentsFromQuery } from '@/lib/fulfillmentPrint';
import { pdfResponse, routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const shipments = await shipmentsFromQuery(ctx, req.nextUrl.searchParams.get('s'));
    const company = await getCompany(ctx);
    const date = new Date().toISOString().slice(0, 10);
    const slips = await packingSlipData(ctx, company?.name ?? '', shipments, date);
    return pdfResponse(await renderPackingSlipsPdf(slips), `packing-slips-${date}.pdf`);
  } catch (err) {
    return routeError(err, 'GET /api/fulfillment/packing-slips');
  }
}
