/**
 * GET /api/invoices/:id/packing-slip
 *
 * Generates a printable packing slip PDF for an invoice — ship-to address,
 * items, and quantities WITHOUT prices — and returns it inline so the browser
 * can display it directly. Filename: `packing-slip-<invoice number>.pdf`.
 * Ship-to is the invoice's own ship-to address; when the invoice has none, the customer's
 * default ship-to address (then the shipping / billing address). The invoice's Ship Via,
 * tracking number, ship date, F.O.B. and P.O. number are printed too.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getInvoice } from '@/lib/services/invoices';
import { getCompany } from '@/lib/services/company';
import { eq, and, inArray } from 'drizzle-orm';
import { customers, items, salesOrders } from '@/lib/db/schema';
import { renderPackingSlipPdf } from '@/lib/pdf/packingSlip';
import { ServiceError } from '@/lib/services/_base';
import { docRef } from '@/lib/services/docNumbers';
import { defaultShipTo } from '@/lib/shipTo';

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'VALIDATION'
          ? 400
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'CONFLICT'
              ? 409
              : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[invoices/[id]/packing-slip]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** Format a Date or timestamp string as YYYY-MM-DD. */
function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/** Flatten an address jsonb ({ line1, line2, city, state, zip, country }) to print lines. */
function addressLines(addr: Record<string, string> | null | undefined): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.line1?.trim()) lines.push(addr.line1.trim());
  if (addr.line2?.trim()) lines.push(addr.line2.trim());
  const cityStateZip = [addr.city?.trim(), addr.state?.trim(), addr.zip?.trim()]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]*)$/, ' $1'); // "City, ST 12345"
  if (cityStateZip) lines.push(cityStateZip);
  if (addr.country?.trim()) lines.push(addr.country.trim());
  return lines;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();

    // Load the invoice with its lines (scoped to company via getInvoice).
    const invoice = await getInvoice(ctx, id);

    // Load the company (for the letterhead).
    const company = await getCompany(ctx);
    if (!company) {
      return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Customer name + ship-to address (shipping, falling back to billing).
    const [customerRow] = await ctx.db
      .select({
        displayName: customers.displayName,
        shippingAddress: customers.shippingAddress,
        shipToAddresses: customers.shipToAddresses,
        billingAddress: customers.billingAddress,
      })
      .from(customers)
      .where(and(eq(customers.id, invoice.customerId), eq(customers.companyId, ctx.companyId)));

    const customerName = customerRow?.displayName ?? 'Unknown Customer';
    const ownShipTo =
      invoice.shipTo && Object.values(invoice.shipTo).some((v) => String(v ?? '').trim())
        ? invoice.shipTo
        : null;
    const shipToLines = addressLines(
      ownShipTo ??
        defaultShipTo(customerRow?.shipToAddresses) ??
        customerRow?.shippingAddress ??
        customerRow?.billingAddress,
    );

    // Item names for item-backed lines.
    const itemIds = [...new Set(invoice.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const itemNameById = new Map<string, string>();
    if (itemIds.length > 0) {
      const itemRows = await ctx.db
        .select({ id: items.id, name: items.name })
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
      for (const r of itemRows) itemNameById.set(r.id, r.name);
    }

    // If this invoice completed a sales order, reference its number on the slip.
    const [linkedOrder] = await ctx.db
      .select({ orderNumber: salesOrders.orderNumber, refNumber: salesOrders.refNumber })
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.companyId, ctx.companyId),
          eq(salesOrders.convertedInvoiceId, id),
        ),
      );

    const pdfBytes = await renderPackingSlipPdf({
      company: { name: company.name },
      customerName,
      shipToLines,
      slip: {
        invoiceNumber: docRef(invoice.refNumber, invoice.invoiceNumber),
        date: fmtDate(invoice.date),
        orderNumber: linkedOrder ? docRef(linkedOrder.refNumber, linkedOrder.orderNumber) : null,
      },
      shipping: {
        shipVia: invoice.shipVia,
        trackingNumber: invoice.trackingNumber,
        shipDate: invoice.shipDate ? fmtDate(invoice.shipDate) : null,
        fob: invoice.fob,
        poNumber: invoice.poNumber,
      },
      lines: invoice.lines.map((l) => ({
        itemName: l.itemId ? itemNameById.get(l.itemId) ?? null : null,
        description: l.description ?? '',
        quantity: l.quantity,
      })),
    });

    const filename = `packing-slip-${docRef(invoice.refNumber, invoice.invoiceNumber).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;

    // pdf-lib returns a Uint8Array; slice out an owned ArrayBuffer for NextResponse.
    const arrayBuf: ArrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;

    return new NextResponse(arrayBuf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': String(arrayBuf.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
