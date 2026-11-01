/**
 * Purchase order PDF: builds a FormDocument and prints it through the shared template renderer
 * (lib/pdf/template.ts) with the selected purchase-order template (default layout when none).
 */
import { renderFormPdf } from './template';
import type { PdfTemplate } from './invoice';

export interface PurchaseOrderPdfLine {
  description: string;
  accountCode?: string | null;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
  item?: string | null;
  /** Customer:Job the line is for (QB P.O. "Customer" column, off by default). */
  customer?: string | null;
}

export interface PurchaseOrderPdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  vendorName: string;
  po: {
    number: number | string;
    date: string;
    expectedDate?: string | null;
    total: string | number;
    status: string;
    memo?: string | null;
  };
  vendorLines?: string[];
  /** Ship To typed on the P.O. or a drop-ship customer's (none = the company's address). */
  shipToName?: string | null;
  shipToLines?: string[];
  lines: PurchaseOrderPdfLine[];
  currency?: string;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function renderPurchaseOrderPdf(
  data: PurchaseOrderPdfData,
  template?: PdfTemplate | null,
): Promise<Uint8Array> {
  const po = data.po;
  return renderFormPdf(
    {
      formType: 'purchase_order',
      company: data.company,
      currency: data.currency,
      fields: {
        number: po.number,
        date: po.date,
        expectedDate: po.expectedDate,
        status: po.status ? titleCase(po.status) : null,
      },
      parties: {
        vendor: [data.vendorName, ...(data.vendorLines ?? [])],
        shipTo: data.shipToLines
          ? [data.shipToName?.trim() || data.company.name, ...data.shipToLines]
          : [data.company.name, ...(data.company.addressLines ?? [])],
      },
      lines: data.lines.map((l) => ({
        // An item line saved without a description prints the item (the Item column is off by
        // default, so the vendor would otherwise see "—").
        description: l.description?.trim() || l.item?.trim() || '—',
        account: l.accountCode ?? '',
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        item: l.item,
        customer: l.customer ?? '',
      })),
      totals: [{ label: 'Total', value: po.total, emphasis: 'total' }],
      memo: po.memo,
    },
    template?.design,
    template?.logo,
  );
}
