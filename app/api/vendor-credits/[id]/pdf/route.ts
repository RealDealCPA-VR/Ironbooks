/** GET /api/vendor-credits/:id/pdf — the vendor credit (Ref. No., Expenses + Items lines) as a PDF. */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { buildVendorCreditPdf } from '@/lib/pdf/vendorCredit';
import { pdfResponse, routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const { bytes, number } = await buildVendorCreditPdf(ctx, id);
    return pdfResponse(bytes, `vendor-credit-${number}.pdf`);
  } catch (err) {
    return routeError(err, 'GET /api/vendor-credits/[id]/pdf');
  }
}
