/**
 * Estimate PDF: builds a FormDocument and prints it through the shared template renderer
 * (lib/pdf/template.ts) with the selected estimate template (default layout when none).
 */
import { renderFormPdf } from './template';
import type { PdfTemplate } from './invoice';

export interface EstimatePdfLine {
  description: string;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
  item?: string | null;
}

export interface EstimatePdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  customerName: string;
  estimate: {
    number: number | string;
    date: string;
    expirationDate?: string | null;
    subtotal: string | number;
    taxAmount: string | number;
    total: string | number;
    memo?: string | null;
  };
  billToLines?: string[];
  lines: EstimatePdfLine[];
  currency?: string;
}

export async function renderEstimatePdf(data: EstimatePdfData, template?: PdfTemplate | null): Promise<Uint8Array> {
  const e = data.estimate;
  const tax = parseFloat(String(e.taxAmount)) || 0;
  return renderFormPdf(
    {
      formType: 'estimate',
      company: data.company,
      currency: data.currency,
      fields: { number: e.number, date: e.date, expirationDate: e.expirationDate },
      parties: { billTo: [data.customerName, ...(data.billToLines ?? [])] },
      lines: data.lines.map((l) => ({
        description: l.description || '—',
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        item: l.item,
      })),
      totals: [
        { label: 'Subtotal', value: e.subtotal },
        ...(tax !== 0 ? [{ label: 'Tax', value: e.taxAmount }] : []),
        { label: 'Total', value: e.total, emphasis: 'total' as const },
      ],
      memo: e.memo,
    },
    template?.design,
    template?.logo,
  );
}
