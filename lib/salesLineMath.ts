/**
 * Live totals for the sales-form previews (sales receipts, credit memos, estimates, sales
 * orders): the same item-type rules the services apply (lib/services/salesLineKinds.ts) and the
 * invoice form uses —
 *  - income lines add to the subtotal (and the taxable base when taxable)
 *  - discount lines always subtract (qty x |rate|); a taxable one lowers the taxable base
 *  - subtotal lines show the running body sum and add nothing
 *  - sales-tax item lines add straight to the tax
 * Pure (no React), so the forms and tests share it.
 */
import Decimal from 'decimal.js';
import { Money } from '@/lib/money';
import { typedNumber } from '@/lib/invoiceLineMath';

export type PreviewLineKind = 'income' | 'discount' | 'subtotal' | 'sales_tax' | 'payment';

export function previewLineKind(itemType: string | null | undefined): PreviewLineKind {
  if (itemType === 'discount' || itemType === 'subtotal' || itemType === 'sales_tax' || itemType === 'payment') {
    return itemType;
  }
  return 'income';
}

export interface PreviewLine {
  quantity: string | number | null | undefined;
  rate: string | number | null | undefined;
  taxable?: boolean | null;
  itemType?: string | null;
}

export interface PreviewTotals {
  /** Amount shown per line (same index as the input). */
  amounts: number[];
  subtotal: number;
  taxableSubtotal: number;
  tax: number;
  total: number;
}

/** A typed number while the user is still editing (blank / not a number = 0), exact. */
function dec(v: string | number | null | undefined): Decimal {
  if (typeof v === 'number') return Number.isFinite(v) ? new Decimal(v) : Money.zero();
  return typedNumber(v);
}

/**
 * The document's live totals, rounded where the services round them (lib/services/
 * salesLineKinds.ts + salesReceipts / creditMemos / estimates / salesOrders): quantity and rate at
 * 4 decimals, each line round2(qty × rate), the tax round2(taxable base × rate) plus manual tax
 * lines (never below zero), total = subtotal + tax. The float version added unrounded lines and
 * tax, so 1.5 × 4.35 showed 6.52 where the document saves 6.53.
 */
export function previewSalesTotals(lines: PreviewLine[], taxRate: number | string = 0): PreviewTotals {
  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  let manualTax = Money.zero();
  let running = Money.zero();
  const amounts: number[] = [];
  for (const l of lines) {
    const kind = previewLineKind(l.itemType);
    if (kind === 'subtotal') {
      amounts.push(running.toNumber());
      running = Money.zero();
      continue;
    }
    const qty = dec(l.quantity).toDecimalPlaces(4);
    const rate = dec(l.rate).toDecimalPlaces(4);
    const line = Money.round2(qty.times(rate));
    const amt = kind === 'discount' ? line.abs().negated() : line;
    amounts.push(amt.toNumber());
    if (kind === 'income' || kind === 'discount') {
      subtotal = subtotal.plus(amt);
      running = running.plus(amt);
      if (l.taxable) taxableSubtotal = taxableSubtotal.plus(amt);
    } else if (kind === 'sales_tax') {
      manualTax = manualTax.plus(amt);
    }
    // payment items are refused by the server on these documents; they add nothing here.
  }
  const base = taxableSubtotal.lessThan(0) ? Money.zero() : taxableSubtotal;
  let tax = Money.round2(base.times(dec(taxRate))).plus(manualTax);
  if (tax.lessThan(0)) tax = Money.zero();
  return {
    amounts,
    subtotal: subtotal.toNumber(),
    taxableSubtotal: taxableSubtotal.toNumber(),
    tax: tax.toNumber(),
    total: subtotal.plus(tax).toNumber(),
  };
}
