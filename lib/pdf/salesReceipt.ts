/**
 * PDF renderer for sales receipts (wave2 sales, C8). Built-in layout: lib/pdf/salesForm.ts.
 * When the company has a sales-receipt form template (B11: the selected one, else the default),
 * the receipt prints through the shared template renderer (lib/pdf/template.ts) instead, with the
 * template's title, font, colors, fields, columns, header/footer text and logo.
 */
import { type SalesFormPdfLine, type SalesShippingInfo, renderSalesFormPdf } from './salesForm';
import { renderFormPdf } from './template';
import type { PdfTemplate } from './invoice';

export interface SalesReceiptPdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  customerName: string;
  /** Customer address lines under the name (template layout only). */
  billToLines?: string[];
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

/** A `template` (a resolved form template) prints the template layout; without one, the built-in layout. */
export async function renderSalesReceiptPdf(data: SalesReceiptPdfData, template?: PdfTemplate | null): Promise<Uint8Array> {
  const method = METHOD_LABEL[data.receipt.method] ?? data.receipt.method;
  if (template) {
    const r = data.receipt;
    const tax = parseFloat(String(r.tax)) || 0;
    return renderFormPdf(
      {
        formType: 'sales_receipt',
        company: data.company,
        fields: { number: r.number, date: r.date, method, reference: r.reference ?? null },
        parties: { billTo: [data.customerName, ...(data.billToLines ?? [])] },
        lines: data.lines.map((l) => ({ ...l, description: l.description || '—' })),
        totals: [
          { label: 'Subtotal', value: r.subtotal },
          ...(tax !== 0 ? [{ label: 'Tax', value: r.tax }] : []),
          { label: 'Total paid', value: r.total, emphasis: 'total' as const },
        ],
        memo: r.memo ?? null,
      },
      template.design,
      template.logo,
    );
  }
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
