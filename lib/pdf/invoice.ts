/**
 * Invoice PDF: builds a FormDocument and prints it through the shared template renderer
 * (lib/pdf/template.ts) using the selected form template (lib/pdf/forms.ts loads it).
 * Without a template it prints the default invoice layout.
 */
import type { FormDesign } from './design';
import { renderFormPdf, type FormLogo } from './template';
import type { SalesShippingInfo } from './salesForm';

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
  /**
   * wave2 sales (B6): the invoice's own ship date / via / FOB / tracking # / ship-to / customer
   * P.O. No. Fills the template's header fields and Ship To block (wins over the defaults above).
   */
  shipping?: SalesShippingInfo | null;
}

/** Ship-to address object (invoices.ship_to) → printable lines. */
export function shipToObjectLines(shipTo: Record<string, string> | null | undefined): string[] {
  if (!shipTo) return [];
  const v = (k: string) => (shipTo[k] ?? '').toString().trim();
  const cityLine = [v('city'), [v('state'), v('zip') || v('postalCode')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const known = ['line1', 'line2', 'street', 'city', 'state', 'zip', 'postalCode', 'country'];
  return [
    v('line1') || v('street'),
    v('line2'),
    cityLine,
    v('country'),
    ...Object.entries(shipTo)
      .filter(([k, val]) => !known.includes(k) && String(val ?? '').trim())
      .map(([, val]) => String(val).trim()),
  ].filter(Boolean);
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
  const ship = data.shipping ?? null;
  const shipToLines = [
    ...(shipToObjectLines(ship?.shipTo).length ? shipToObjectLines(ship?.shipTo) : (data.shipToLines ?? [])),
    ...(ship?.trackingNumber ? [`Tracking #: ${ship.trackingNumber}`] : []),
  ];
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
        poNumber: ship?.poNumber || inv.poNumber,
        shipDate: ship?.shipDate || null,
        shipVia: ship?.shipVia || inv.shipVia,
        fob: ship?.fob || inv.fob,
      },
      parties: {
        billTo: [data.customerName, ...(data.billToLines ?? [])],
        shipTo: shipToLines.length ? [data.customerName, ...shipToLines] : null,
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
