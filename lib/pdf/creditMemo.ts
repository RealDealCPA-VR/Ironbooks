/**
 * PDF renderer for credit memos / refunds (wave2 sales, C8). Layout: lib/pdf/salesForm.ts.
 */
import { type SalesFormPdfLine, renderSalesFormPdf } from './salesForm';

export interface CreditMemoPdfData {
  company: { name: string };
  customerName: string;
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

export async function renderCreditMemoPdf(data: CreditMemoPdfData): Promise<Uint8Array> {
  const totals: Array<[string, string | number]> = [
    ['Subtotal', data.memo.subtotal],
    ['Tax', data.memo.tax],
    ['Total credit', data.memo.total],
  ];
  if (data.memo.refunded != null && Number(data.memo.refunded) > 0) {
    totals.push(['Refunded', data.memo.refunded]);
  }
  totals.push(['Remaining credit', data.memo.remaining]);
  return renderSalesFormPdf({
    company: data.company,
    title: Number(data.memo.refunded ?? 0) > 0 ? 'CREDIT MEMO / REFUND' : 'CREDIT MEMO',
    number: data.memo.number,
    date: data.memo.date,
    billToLabel: 'CUSTOMER',
    customerName: data.customerName,
    lines: data.lines,
    totals,
    note: data.memo.memo ? `Memo: ${data.memo.memo}` : null,
  });
}
