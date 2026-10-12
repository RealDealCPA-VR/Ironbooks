/**
 * Server-side form builders: load a document + its template, return PDF bytes.
 *
 * Every print/email path (PDF routes, emailInvoice, batch statements) goes through here so the
 * user's selected template (or the form's default template) is always honored. Other teams'
 * forms (sales receipts, credit memos, sales orders) plug in the same way: build a FormDocument,
 * `resolveFormTemplate(ctx, '<form>', templateId)`, then `renderFormPdf(doc, t.design, t.logo)`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { accounts, customers, items, vendors } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { getCompany, getPreferences } from '@/lib/services/company';
import { docRef } from '@/lib/services/docNumbers';
import { getInvoice } from '@/lib/services/invoices';
import { getEstimate } from '@/lib/services/estimates';
import { getPurchaseOrder } from '@/lib/services/purchaseOrders';
import type { CustomerStatement } from '@/lib/services/statements';
import { resolveFormTemplate } from '@/lib/services/formTemplates';
import { renderInvoicePdf } from './invoice';
import { renderEstimatePdf } from './estimate';
import { renderPurchaseOrderPdf } from './purchaseOrder';
import { renderStatementPdf } from './statement';

export interface Letterhead {
  name: string;
  addressLines: string[];
  phone: string | null;
  email: string | null;
}

/** Company name + address/phone/email from Company Information preferences. */
export async function companyLetterhead(ctx: ServiceContext): Promise<Letterhead> {
  const company = await getCompany(ctx);
  const s = (company?.settings ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  const cityLine = [str('city'), [str('state'), str('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const addressLines = [str('addressLine1'), str('addressLine2'), cityLine].filter(Boolean);
  if (addressLines.length === 0 && str('address')) addressLines.push(str('address'));
  return {
    name: company?.name ?? 'Your Company',
    addressLines,
    phone: str('phone') || null,
    email: str('email') || null,
  };
}

/** Address jsonb ({ line1, line2, city, state, zip, … }) → printable lines. */
export function addressToLines(addr: Record<string, string> | null | undefined): string[] {
  if (!addr || typeof addr !== 'object') return [];
  const g = (...keys: string[]) => keys.map((k) => addr[k]).find((v) => typeof v === 'string' && v.trim())?.trim() ?? '';
  const line1 = g('line1', 'street', 'address1', 'addressLine1');
  const line2 = g('line2', 'address2', 'addressLine2');
  const city = g('city');
  const state = g('state', 'region');
  const zip = g('zip', 'postalCode', 'postal_code');
  const country = g('country');
  const cityLine = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [line1, line2, cityLine, country].filter(Boolean);
}

function isoDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

const TERMS_LABELS: Record<string, string> = {
  due_on_receipt: 'Due on receipt',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_60: 'Net 60',
};

function isZero(v: string | number | null | undefined): boolean {
  return Number(v ?? 0) === 0;
}

async function itemNames(ctx: ServiceContext, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function buildInvoicePdf(
  ctx: ServiceContext,
  invoiceId: string,
  templateId?: string | null,
): Promise<{ bytes: Uint8Array; number: number | string; customerName: string; customerEmail: string | null }> {
  const invoice = await getInvoice(ctx, invoiceId);
  const [cust] = await ctx.db
    .select({
      displayName: customers.displayName,
      email: customers.email,
      billingAddress: customers.billingAddress,
      shippingAddress: customers.shippingAddress,
    })
    .from(customers)
    .where(and(eq(customers.id, invoice.customerId), eq(customers.companyId, ctx.companyId)));
  const [letterhead, template, prefs] = await Promise.all([
    companyLetterhead(ctx),
    resolveFormTemplate(ctx, 'invoice', templateId),
    getPreferences(ctx),
  ]);
  const names = await itemNames(ctx, invoice.lines.map((l) => l.itemId));
  const lines = invoice.lines.filter((l) => !(prefs.dontPrintZeroAmountItems && isZero(l.amount)));
  const customerName = cust?.displayName ?? 'Customer';
  const bytes = await renderInvoicePdf(
    {
      company: letterhead,
      customerName,
      currency: invoice.currency ?? undefined,
      billToLines: addressToLines(cust?.billingAddress),
      shipToLines: addressToLines(cust?.shippingAddress),
      invoice: {
        number: docRef(invoice.refNumber, invoice.invoiceNumber),
        date: isoDate(invoice.date),
        dueDate: invoice.dueDate ? isoDate(invoice.dueDate) : null,
        subtotal: invoice.subtotal,
        discount: invoice.discount,
        tax: invoice.taxAmount,
        total: invoice.total,
        balanceDue: invoice.balanceDue,
        terms: invoice.terms ? (TERMS_LABELS[invoice.terms] ?? invoice.terms) : null,
        // The invoice's own shipping fields (wave2 sales) win over the Preferences defaults.
        shipVia: invoice.shipVia || prefs.defaultShipVia || null,
        fob: invoice.fob || prefs.defaultFob || null,
        memo: invoice.memo,
      },
      shipping: {
        shipDate: invoice.shipDate ? isoDate(invoice.shipDate) : null,
        shipVia: invoice.shipVia ?? null,
        fob: invoice.fob ?? null,
        trackingNumber: invoice.trackingNumber ?? null,
        poNumber: invoice.poNumber ?? null,
        shipTo: (invoice.shipTo as Record<string, string> | null) ?? null,
      },
      lines: lines.map((l) => ({
        // Unit of measure prints as a description suffix, e.g. "Consulting (hr)".
        description: l.unitOfMeasure ? `${l.description ?? ''} (${l.unitOfMeasure})`.trim() : (l.description ?? ''),
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
        item: l.itemId ? (names.get(l.itemId) ?? null) : null,
        unit: l.unitOfMeasure ?? null,
      })),
    },
    template,
  );
  return { bytes, number: docRef(invoice.refNumber, invoice.invoiceNumber), customerName, customerEmail: cust?.email ?? null };
}

export async function buildEstimatePdf(
  ctx: ServiceContext,
  estimateId: string,
  templateId?: string | null,
): Promise<{ bytes: Uint8Array; number: number | string }> {
  const estimate = await getEstimate(ctx, estimateId);
  const [cust] = await ctx.db
    .select({ displayName: customers.displayName, billingAddress: customers.billingAddress })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, estimate.customerId)));
  const [letterhead, template, prefs] = await Promise.all([
    companyLetterhead(ctx),
    resolveFormTemplate(ctx, 'estimate', templateId),
    getPreferences(ctx),
  ]);
  const lines = estimate.lines.filter((l) => !(prefs.dontPrintZeroAmountItems && isZero(l.amount)));
  const bytes = await renderEstimatePdf(
    {
      company: letterhead,
      customerName: cust?.displayName ?? 'Customer',
      billToLines: addressToLines(cust?.billingAddress),
      estimate: {
        number: docRef(estimate.refNumber, estimate.estimateNumber),
        date: isoDate(estimate.date),
        expirationDate: estimate.expirationDate ? isoDate(estimate.expirationDate) : null,
        subtotal: estimate.subtotal,
        taxAmount: estimate.taxAmount,
        total: estimate.total,
        memo: estimate.memo ?? null,
      },
      lines: lines.map((l) => ({
        description: l.description ?? '',
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
      })),
    },
    template,
  );
  return { bytes, number: docRef(estimate.refNumber, estimate.estimateNumber) };
}

export async function buildPurchaseOrderPdf(
  ctx: ServiceContext,
  poId: string,
  templateId?: string | null,
): Promise<{ bytes: Uint8Array; number: number | string }> {
  const po = await getPurchaseOrder(ctx, poId);
  const [vendor] = await ctx.db
    .select({ displayName: vendors.displayName, address: vendors.address })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, po.vendorId)));
  const accountIds = [...new Set(po.lines.map((l) => l.accountId).filter(Boolean))] as string[];
  const accountMap = new Map<string, string>();
  if (accountIds.length > 0) {
    const rows = await ctx.db
      .select({ id: accounts.id, code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, accountIds)));
    for (const a of rows) accountMap.set(a.id, a.code);
  }
  const [letterhead, template] = await Promise.all([
    companyLetterhead(ctx),
    resolveFormTemplate(ctx, 'purchase_order', templateId),
  ]);
  const bytes = await renderPurchaseOrderPdf(
    {
      company: letterhead,
      vendorName: vendor?.displayName ?? 'Vendor',
      vendorLines: addressToLines(vendor?.address),
      po: {
        number: docRef(po.refNumber, po.poNumber),
        date: isoDate(po.date),
        expectedDate: po.expectedDate ? isoDate(po.expectedDate) : null,
        total: po.total,
        status: po.status,
        memo: po.memo ?? null,
      },
      lines: po.lines.map((l) => ({
        description: l.description ?? '',
        accountCode: l.accountId ? (accountMap.get(l.accountId) ?? null) : null,
        quantity: l.quantity,
        rate: l.rate,
        amount: l.amount,
      })),
    },
    template,
  );
  return { bytes, number: docRef(po.refNumber, po.poNumber) };
}

/** Statement PDF with the company letterhead and the selected (or default) statement template. */
export async function buildStatementPdf(
  ctx: ServiceContext,
  statement: CustomerStatement,
  templateId?: string | null,
): Promise<Uint8Array> {
  const [letterhead, template] = await Promise.all([
    companyLetterhead(ctx),
    resolveFormTemplate(ctx, 'statement', templateId),
  ]);
  return renderStatementPdf(statement, letterhead.name, template, letterhead);
}
