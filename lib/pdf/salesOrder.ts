/**
 * PDF renderer for sales orders (wave2 sales, C8). Layout: lib/pdf/salesForm.ts.
 * Lines show the ordered quantity; partially invoiced lines note what is still on backorder.
 */
import { type SalesFormPdfLine, type SalesShippingInfo, renderSalesFormPdf } from './salesForm';

export interface SalesOrderPdfData {
  company: { name: string };
  customerName: string;
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

export async function renderSalesOrderPdf(data: SalesOrderPdfData): Promise<Uint8Array> {
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
