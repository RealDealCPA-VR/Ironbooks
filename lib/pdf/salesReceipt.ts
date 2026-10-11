/**
 * PDF renderer for sales receipts (wave2 sales, C8). Layout: lib/pdf/salesForm.ts.
 */
import { type SalesFormPdfLine, type SalesShippingInfo, renderSalesFormPdf } from './salesForm';

export interface SalesReceiptPdfData {
  company: { name: string };
  customerName: string;
  receipt: {
    number: number | string;
    date: string;
    method: string;
    reference?: string | null;
    subtotal: string | number;
    tax: string | number;
    total: string | number;
    memo?: string | null;
  };
  lines: SalesFormPdfLine[];
  shipping?: SalesShippingInfo | null;
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  credit_card: 'Credit card',
  ach: 'ACH',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

export async function renderSalesReceiptPdf(data: SalesReceiptPdfData): Promise<Uint8Array> {
  const method = METHOD_LABEL[data.receipt.method] ?? data.receipt.method;
  return renderSalesFormPdf({
    company: data.company,
    title: 'SALES RECEIPT',
    number: data.receipt.number,
    date: data.receipt.date,
    headerRows: [
      ['Paid by', method],
      ['Ref', data.receipt.reference ?? ''],
    ],
    billToLabel: 'SOLD TO',
    customerName: data.customerName,
    shipping: data.shipping,
    lines: data.lines,
    totals: [
      ['Subtotal', data.receipt.subtotal],
      ['Tax', data.receipt.tax],
      ['Total paid', data.receipt.total],
    ],
    note: data.receipt.memo ? `Memo: ${data.receipt.memo}` : 'Thank you for your business.',
  });
}
