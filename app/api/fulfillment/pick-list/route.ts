/**
 * GET /api/fulfillment/pick-list?s=<JSON selections> — printable pick list (PDF) for the
 * quantities that will ship: items aggregated across the selected sales orders.
 */
import { NextRequest } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { renderPickListPdf } from '@/lib/pdf/pickList';
import { pickRows, shipmentsFromQuery } from '@/lib/fulfillmentPrint';
import { pdfResponse, routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const shipments = await shipmentsFromQuery(ctx, req.nextUrl.searchParams.get('s'));
    const company = await getCompany(ctx);
    const date = new Date().toISOString().slice(0, 10);
    const bytes = await renderPickListPdf({ company: { name: company?.name ?? '' }, date, rows: pickRows(shipments) });
    return pdfResponse(bytes, `pick-list-${date}.pdf`);
  } catch (err) {
    return routeError(err, 'GET /api/fulfillment/pick-list');
  }
}
