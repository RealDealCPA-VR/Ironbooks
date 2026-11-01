/**
 * Receive Payment deep link (salesar): `/payments?customerId=<uuid>&invoiceId=<uuid>` opens a NEW
 * Receive Payment for the customer with that invoice selected and its open amount filled in;
 * `/payments?customerId=<uuid>` alone opens it for the customer. Used by the Income Tracker and the
 * Collections Center ("Receive Payment" on a row). `?focus=<payment id>` (lib/useFocusParam.ts)
 * still opens an existing payment.
 *
 * Pure helpers (no React), safe to import from any page or test.
 */
import { moneyDec } from '@/lib/paymentApply';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Link that opens a new Receive Payment for a customer (and, optionally, one of its invoices). */
export function receivePaymentHref(customerId: string, invoiceId?: string | null): string {
  const qs = new URLSearchParams({ customerId });
  if (invoiceId) qs.set('invoiceId', invoiceId);
  return `/payments?${qs.toString()}`;
}

export interface ReceivePaymentLink {
  customerId: string;
  /** Null when the link names no invoice (or not a valid id): the form opens for the customer only. */
  invoiceId: string | null;
}

/** Read the link's parameters; null when there is no (valid) customer in it. */
export function parseReceivePaymentLink(params: Pick<URLSearchParams, 'get'>): ReceivePaymentLink | null {
  const customerId = params.get('customerId')?.trim() ?? '';
  if (!UUID_RE.test(customerId)) return null;
  const invoiceId = params.get('invoiceId')?.trim() ?? '';
  return { customerId, invoiceId: UUID_RE.test(invoiceId) ? invoiceId : null };
}

/**
 * The invoice the link selects, with its open amount as both the payment applied to it and the
 * amount received. Null when the invoice is not one of the customer's open invoices (paid, void,
 * another currency …) — the form then simply opens for the customer.
 */
export function prefillFromLink(
  openInvoices: ReadonlyArray<{ id: string; balanceDue: string }>,
  invoiceId: string | null | undefined,
): { applications: Record<string, string>; amount: string } | null {
  if (!invoiceId) return null;
  const inv = openInvoices.find((i) => i.id === invoiceId);
  if (!inv) return null;
  const open = moneyDec(inv.balanceDue);
  if (!open.greaterThan(0)) return null;
  const amount = open.toFixed(2);
  return { applications: { [inv.id]: amount }, amount };
}
