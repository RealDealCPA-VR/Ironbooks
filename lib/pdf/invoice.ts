/**
 * Invoice PDF: builds a FormDocument and prints it through the shared template renderer
 * (lib/pdf/template.ts) using the selected form template (lib/pdf/forms.ts loads it).
 * Without a template it prints the default invoice layout.
 */
import type { FormDesign } from './design';
import { renderFormPdf, type FormLogo } from './template';

export interface InvoicePdfLine {
  description: string;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
  item?: string | null;
  unit?: string | null;
  serviceDate?: string | null;
}

export interface InvoicePdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  customerName: string;
  invoice: {
    number: number | string;
    date: string; // ISO or any human-readable date string
    dueDate?: string | null;
    subtotal: string | number;
    discount: string | number;
    tax: string | number;
    total: string | number;
    balanceDue: string | number;
    terms?: string | null;
    poNumber?: string | null;
    shipVia?: string | null;
    fob?: string | null;
    memo?: string | null;
  };
  /** Extra address lines under the customer name. */
  billToLines?: string[];
  shipToLines?: string[];
  lines: InvoicePdfLine[];
  currency?: string;
}

/** Optional template selection: a stored design and/or a logo image. */
export interface PdfTemplate {
  design?: FormDesign | Record<string, unknown> | null;
  logo?: FormLogo | null;
}

export async function renderInvoicePdf(data: InvoicePdfData, template?: PdfTemplate | null): Promise<Uint8Array> {
  const inv = data.invoice;
  const discount = parseFloat(String(inv.discount)) || 0;
  const tax = parseFloat(String(inv.tax)) || 0;
  const balance = parseFloat(String(inv.balanceDue)) || 0;
  return renderFormPdf(
    {
      formType: 'invoice',
      company: data.company,
      currency: data.currency,
      fields: {
        number: inv.number,
        date: inv.date,
        dueDate: inv.dueDate,
        terms: inv.terms,
        poNumber: inv.poNumber,
        shipVia: inv.shipVia,
        fob: inv.fob,
      },
      parties: {
        billTo: [data.customerName, ...(data.billToLines ?? [])],
        shipTo: data.shipToLines?.length ? [data.customerName, ...data.shipToLines] : null,
      },
      lines: data.lines.map((l) => ({
        description: l.description || '—',
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        item: l.item,
        unit: l.unit,
        serviceDate: l.serviceDate,
      })),
      totals: [
        { label: 'Subtotal', value: inv.subtotal },
        ...(discount !== 0 ? [{ label: 'Discount', value: -Math.abs(discount) }] : []),
        ...(tax !== 0 ? [{ label: 'Tax', value: inv.tax }] : []),
        { label: 'Total', value: inv.total, emphasis: 'total' as const },
        ...(balance > 0 ? [{ label: 'Balance Due', value: inv.balanceDue, emphasis: 'balance' as const }] : []),
      ],
      memo: inv.memo,
    },
    template?.design,
    template?.logo,
  );
}
