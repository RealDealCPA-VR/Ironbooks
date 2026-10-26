/**
 * GET /api/reports/1099-pdf?vendorId=<uuid>&year=<number>
 *
 * Uses vendor1099Report to look up the total nonemployee compensation for the
 * given vendor and year, then renders a 1099-NEC PDF and returns it inline.
 *
 * Returns 404 if the vendor has no payments in that year or does not appear in
 * the 1099 report (i.e. total < $600 or is_1099 is false).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { vendor1099Report } from '@/lib/services/statements';
import { payer1099Info, recipient1099Addresses } from '@/lib/services/form1099Xml';
import { ServiceError } from '@/lib/services/_base';
import { render1099NecPdf } from '@/lib/pdf/form1099';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[reports/1099-pdf] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const vendorId = searchParams.get('vendorId');
    if (!vendorId) {
      return NextResponse.json(
        { error: 'vendorId query parameter is required.' },
        { status: 400 },
      );
    }

    const yearParam = searchParams.get('year');
    if (!yearParam) {
      return NextResponse.json(
        { error: 'year query parameter is required.' },
        { status: 400 },
      );
    }

    const year = parseInt(yearParam, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year value.' }, { status: 400 });
    }

    // Fetch the full 1099 report for the year, then find this vendor.
    const rows = await vendor1099Report(ctx, { year });
    const vendorRow = rows.find((r) => r.vendorId === vendorId);

    if (!vendorRow) {
      return NextResponse.json(
        {
          error:
            'Vendor not found in 1099 report for this year. ' +
            'The vendor may not be flagged as is_1099, or total payments may be below $600.',
          code: 'NOT_FOUND',
        },
        { status: 404 },
      );
    }

    // Payer block from Company Information (legal name, EIN, address) — a 1099 needs the payer's
    // TIN and address; the recipient's mailing address comes from the vendor.
    const payer = await payer1099Info(ctx);
    if (!payer) {
      return NextResponse.json({ error: 'Company not found.', code: 'NOT_FOUND' }, { status: 404 });
    }
    const recipientAddress = (await recipient1099Addresses(ctx, [vendorRow.vendorId])).get(vendorRow.vendorId) ?? [];

    // Render the 1099-NEC PDF.
    const pdfBytes = await render1099NecPdf({
      company: { name: payer.name, addressLines: payer.addressLines, tin: payer.tin, phone: payer.phone },
      vendor:  { name: vendorRow.vendorName, taxId: vendorRow.taxId, addressLines: recipientAddress },
      year,
      nonemployeeComp: vendorRow.total,
    });

    // Slice to owned ArrayBuffer (same pattern as invoice PDF route).
    const arrayBuf: ArrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;

    const vendorSlug = vendorRow.vendorName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    const filename = `1099-nec-${vendorSlug}-${year}.pdf`;

    return new NextResponse(arrayBuf, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length':      String(arrayBuf.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
