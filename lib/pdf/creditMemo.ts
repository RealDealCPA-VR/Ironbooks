/**
 * PDF renderer for credit memos / refunds (wave2 sales, C8). Built-in layout: lib/pdf/salesForm.ts.
 * With a credit-memo form template (B11: the selected one, else the default) it prints through
 * the shared template renderer (lib/pdf/template.ts) instead.
 */
import { type SalesFormPdfLine, renderSalesFormPdf } from './salesForm';
import { renderFormPdf } from './template';
import type { PdfTemplate } from './invoice';

export interface CreditMemoPdfData {
  company: { name: string; addressLines?: string[]; phone?: string | null; email?: string | null };
  customerName: string;
  /** Customer address lines under the name (template layout only). */
  billToLines?: string[];
  memo: {
    number: number | string;
    date: string;
    subtotal: string | number;
    tax: string | number;
    total: string | number;
    /** Credit still available (not yet applied or refunded). */
    remaining: string | number;
    /** Portion refunded by check. */
    refunded?: string | number | null;
    memo?: string | null;
  };
  lines: SalesFormPdfLine[];
}

/** A `template` (a resolved form template) prints the template layout; without one, the built-in layout. */
export async function renderCreditMemoPdf(data: CreditMemoPdfData, template?: PdfTemplate | null): Promise<Uint8Array> {
  const refunded = data.memo.refunded != null && Number(data.memo.refunded) > 0;
  if (template) {
    const m = data.memo;
    const tax = parseFloat(String(m.tax)) || 0;
    return renderFormPdf(
      {
        formType: 'credit_memo',
        company: data.company,
        fields: { number: m.number, date: m.date },
        parties: { billTo: [data.customerName, ...(data.billToLines ?? [])] },
        lines: data.lines.map((l) => ({ ...l, description: l.description || '—' })),
        totals: [
          { label: 'Subtotal', value: m.subtotal },
          ...(tax !== 0 ? [{ label: 'Tax', value: m.tax }] : []),
          { label: 'Total credit', value: m.total, emphasis: 'total' as const },
          ...(refunded ? [{ label: 'Refunded', value: m.refunded as string | number }] : []),
          { label: 'Remaining credit', value: m.remaining, emphasis: 'balance' as const },
        ],
        memo: m.memo ?? null,
      },
      template.design,
      template.logo,
    );
  }
  const totals: Array<[string, string | number]> = [
    ['Subtotal', data.memo.subtotal],
    ['Tax', data.memo.tax],
    ['Total credit', data.memo.total],
  ];
  if (refunded) totals.push(['Refunded', data.memo.refunded as string | number]);
  totals.push(['Remaining credit', data.memo.remaining]);
  return renderSalesFormPdf({
    company: data.company,
    title: refunded ? 'CREDIT MEMO / REFUND' : 'CREDIT MEMO',
    number: data.memo.number,
    date: data.memo.date,
    billToLabel: 'CUSTOMER',
    customerName: data.customerName,
    lines: data.lines,
    totals,
    note: data.memo.memo ? `Memo: ${data.memo.memo}` : null,
  });
}
