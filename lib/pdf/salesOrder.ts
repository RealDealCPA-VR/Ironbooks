/**
 * PDF renderer for sales orders (wave2 sales, C8). Built-in layout: lib/pdf/salesForm.ts.
 * Lines show the ordered quantity; partially invoiced lines note what is still on backorder.
 * With a sales-order form template (B11: the selected one, else the default) it prints through
 * the shared template renderer (lib/pdf/template.ts) instead.
 */
import { type SalesFormPdfLine, type SalesShippingInfo, renderSalesFormPdf } from './salesForm';
import { renderFormPdf } from './template';
import { shipToObjectLines, type PdfTemplate } from './invoice';

export interface SalesOrderPdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  customerName: string;
  /** Customer address lines under the name (template layout only). */
  billToLines?: string[];
  order: {
    number: number | string;
    date: string;
    status: string;
    total: string | number;
    memo?: string | null;
  };
  lines: SalesFormPdfLine[];
  shipping?: SalesShippingInfo | null;
}

/** A `template` (a resolved form template) prints the template layout; without one, the built-in layout. */
export async function renderSalesOrderPdf(data: SalesOrderPdfData, template?: PdfTemplate | null): Promise<Uint8Array> {
  if (template) {
    const o = data.order;
    const ship = data.shipping ?? null;
    const shipTo = shipToObjectLines(ship?.shipTo);
    return renderFormPdf(
      {
        formType: 'sales_order',
        company: data.company,
        fields: { number: o.number, date: o.date, poNumber: ship?.poNumber ?? null, shipVia: ship?.shipVia ?? null },
        parties: {
          billTo: [data.customerName, ...(data.billToLines ?? [])],
          shipTo: shipTo.length ? [data.customerName, ...shipTo] : null,
        },
        lines: data.lines.map((l) => ({ ...l, ordered: l.quantity, description: l.description || '—' })),
        totals: [{ label: 'Total', value: o.total, emphasis: 'total' as const }],
        memo: o.memo ?? null,
      },
      template.design,
      template.logo,
    );
  }
  return renderSalesFormPdf({
    company: data.company,
    title: 'SALES ORDER',
    number: data.order.number,
    date: data.order.date,
    headerRows: [['Status', data.order.status]],
    customerName: data.customerName,
    shipping: data.shipping,
    lines: data.lines,
    totals: [['Total', data.order.total]],
    note: data.order.memo ? `Memo: ${data.order.memo}` : null,
  });
}
