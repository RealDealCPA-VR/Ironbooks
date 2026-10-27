/**
 * Which actions the Invoices list offers for an invoice (pure, unit-tested in
 * lib/ui.review5.test.ts).
 *
 * Edit: every invoice that is not void. QuickBooks lets you edit a partly or fully paid invoice,
 * and so does the service (lib/services/invoices.ts updateInvoice keeps the payments applied and
 * refuses an edit that would leave them over-applied). The list used to offer Edit only on open
 * and pending invoices, so a partly paid one could only be reached through Previous / Next.
 */
export type InvoiceListStatus = 'draft' | 'open' | 'partial' | 'paid' | 'void';

export function canEditInvoice(status: InvoiceListStatus): boolean {
  return status !== 'void';
}
