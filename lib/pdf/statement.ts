/**
 * Customer statement PDF: builds a FormDocument (date | transaction | ref | charges | credits |
 * balance) and prints it through the shared template renderer with the selected statement
 * template (default layout when none).
 */
import type { CustomerStatement } from '@/lib/services/statements';
import { renderFormPdf } from './template';
import type { PdfTemplate } from './invoice';

function fmtDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_memo: 'Credit Memo',
  // wave2 sales
  statement_charge: 'Statement Charge',
  bounced_check: 'Returned Check',
  discount: 'Discount',
  // wave2 foundation: named General Journal line on A/R
  general_journal: 'General Journal',
};

/**
 * Charges raise the balance: invoices, statement charges, returned (bounced) checks and positive
 * General Journal lines (GJ amounts are signed: + charge, − credit). Payments, discounts and
 * credit memos are credits.
 */
function isChargeLine(l: { type: string; amount: string }): boolean {
  return (
    l.type === 'invoice' ||
    l.type === 'statement_charge' ||
    l.type === 'bounced_check' ||
    (l.type === 'general_journal' && !l.amount.startsWith('-'))
  );
}

export async function renderStatementPdf(
  data: CustomerStatement,
  companyName: string,
  template?: PdfTemplate | null,
  company?: { addressLines?: string[]; phone?: string | null; email?: string | null },
): Promise<Uint8Array> {
  const today = new Date().toISOString().slice(0, 10);
  const period =
    data.from && data.to
      ? `${fmtDate(data.from)} – ${fmtDate(data.to)}`
      : data.from
        ? `From ${fmtDate(data.from)}`
        : data.to
          ? `Through ${fmtDate(data.to)}`
          : `As of ${fmtDate(today)}`;
  const lines: Array<Record<string, string | null>> = [];
  if (data.from) {
    lines.push({
      date: fmtDate(data.from),
      type: 'Balance forward',
      ref: '',
      charges: null,
      credits: null,
      balance: data.openingBalance,
    });
  }
  for (const l of data.lines) {
    const isCharge = isChargeLine(l);
    const abs = l.amount.replace(/^-/, '');
    lines.push({
      date: fmtDate(l.date),
      type: TYPE_LABEL[l.type] ?? l.type,
      ref: l.ref ?? '',
      charges: isCharge ? abs : null,
      credits: isCharge ? null : abs,
      balance: l.runningBalance,
    });
  }
  return renderFormPdf(
    {
      formType: 'statement',
      company: { name: companyName, ...(company ?? {}) },
      fields: { date: fmtDate(data.to ?? today), period },
      parties: {
        billTo: [
          data.customer.displayName,
          ...(data.customer.companyName && data.customer.companyName !== data.customer.displayName
            ? [data.customer.companyName]
            : []),
          ...(data.customer.email ? [data.customer.email] : []),
        ],
      },
      lines,
      totals: [{ label: 'Amount Due', value: data.closingBalance, emphasis: 'balance' }],
    },
    template?.design,
    template?.logo,
  );
}
