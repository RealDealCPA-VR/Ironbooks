/**
 * GET /api/inventory/worksheet              — physical inventory count sheet (JSON)
 * GET /api/inventory/worksheet?format=csv   — printable count sheet as CSV
 *                                             (item, SKU, on-hand, blank count column)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { physicalWorksheet } from '@/lib/services/inventoryOps';
import { ServiceError } from '@/lib/services/_base';
import { csvQuoted } from '@/lib/csv';
import { serviceErrorStatus } from '@/lib/routeErrors';

/** Always-quoted, formula-safe cell (lib/csv.ts). */
function csvEscape(value: string | null | undefined): string {
  return csvQuoted(value);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const { rows } = await physicalWorksheet(ctx);

    if (req.nextUrl.searchParams.get('format') === 'csv') {
      const header = ['Item', 'SKU', 'Unit', 'Qty On Hand', 'Counted Qty', 'Notes'];
      const lines = [
        csvEscape(`Physical Inventory Worksheet — ${new Date().toLocaleDateString('en-US')}`),
        '',
        header.map(csvEscape).join(','),
        ...rows.map((r) =>
          [
            csvEscape(r.name),
            csvEscape(r.sku),
            csvEscape(r.unitOfMeasure),
            csvEscape(r.quantityOnHand),
            csvEscape(''), // blank count column to fill in by hand
            csvEscape(r.fifoTracked ? 'FIFO-tracked — count via FIFO adjustments' : ''),
          ].join(','),
        ),
      ];
      return new NextResponse(lines.join('\r\n'), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="physical-inventory-worksheet.csv"',
        },
      });
    }

    return NextResponse.json({ rows });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: serviceErrorStatus(err.code) },
      );
    }
    console.error('[GET /api/inventory/worksheet]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
